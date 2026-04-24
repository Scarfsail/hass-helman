from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import asdict
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .actuals import load_actuals_window
from .adjuster import adjust
from .forecast_history import load_trainer_samples
from .models import (
    BiasConfig,
    SolarBiasAdjustmentResult,
    SolarBiasExplainability,
    SolarBiasMetadata,
    SolarBiasProfile,
)
from .trainer import compute_fingerprint, train

if TYPE_CHECKING:
    from ..storage import SolarBiasCorrectionStore

_TRAINING_LOOKBACK_DAYS = 90


class TrainingInProgressError(RuntimeError):
    pass


class BiasNotConfiguredError(RuntimeError):
    pass


class SolarBiasCorrectionService:
    def __init__(
        self,
        hass: HomeAssistant,
        store: SolarBiasCorrectionStore,
        cfg: BiasConfig,
    ) -> None:
        self._hass = hass
        self._store = store
        self._cfg = cfg
        self._profile: SolarBiasProfile | None = None
        self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
        self._is_stale = False
        self._training_lock = asyncio.Lock()
        self._training_in_progress = False

    async def async_setup(self) -> None:
        stored = self._store.profile
        current_fingerprint = self._current_fingerprint
        if not isinstance(stored, dict):
            self._profile = None
            self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
            self._is_stale = False
            return

        profile = _profile_from_dict(stored.get("profile"))
        metadata = _metadata_from_dict(stored.get("metadata"))
        if profile is None or metadata is None:
            self._profile = None
            self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
            self._is_stale = False
            return

        self._profile = profile
        self._metadata = metadata
        self._is_stale = metadata.training_config_fingerprint != current_fingerprint

    def update_config(self, cfg: BiasConfig) -> None:
        self._cfg = cfg
        if self._metadata.last_outcome == "no_training_yet" and self._profile is None:
            self._is_stale = False
            return
        self._is_stale = (
            self._metadata.training_config_fingerprint != self._current_fingerprint
        )

    async def async_train(self) -> dict[str, Any]:
        if self._training_in_progress:
            raise TrainingInProgressError("Solar bias training already in progress")
        if not self._cfg.enabled:
            raise BiasNotConfiguredError("Solar bias correction is disabled")

        self._training_in_progress = True
        await self._training_lock.acquire()
        try:
            now = dt_util.now()
            samples = await load_trainer_samples(self._hass, self._cfg, now)
            actuals = await load_actuals_window(
                self._hass,
                self._cfg,
                days=_TRAINING_LOOKBACK_DAYS,
            )
            outcome = train(samples, actuals, self._cfg, now=now)
            self._profile = outcome.profile
            self._metadata = outcome.metadata
            self._is_stale = False
            await self._store.async_save(self._serialize_state())
        except Exception as err:
            self._metadata = self._build_failure_metadata(
                error_reason=str(err) or err.__class__.__name__,
                trained_at=dt_util.now().isoformat(),
            )
            await self._store.async_save(self._serialize_state())
        finally:
            self._training_lock.release()
            self._training_in_progress = False

        payload = self.get_status_payload()
        self._hass.bus.async_fire("helman_solar_bias_trained", payload)
        return payload

    def build_adjustment_result(
        self,
        raw_points: list[dict[str, Any]],
        now,
    ) -> SolarBiasAdjustmentResult:
        del now
        status, effective_variant, fallback_reason = self._resolve_status()
        adjusted_points = _copy_points(raw_points)
        if effective_variant == "adjusted" and self._profile is not None:
            adjusted_points = adjust(raw_points, self._profile)

        explainability = SolarBiasExplainability(
            fallback_reason=fallback_reason,
            trained_at=self._trained_at,
            usable_days=self._metadata.usable_days,
            dropped_days=len(self._metadata.dropped_days),
            omitted_slot_count=self._metadata.omitted_slot_count,
            factor_min=self._metadata.factor_min,
            factor_max=self._metadata.factor_max,
            factor_median=self._metadata.factor_median,
            error=self._metadata.error_reason,
        )
        return SolarBiasAdjustmentResult(
            status=status,
            effective_variant=effective_variant,
            adjusted_points=adjusted_points,
            explainability=explainability,
        )

    def get_status_payload(self) -> dict[str, Any]:
        status, effective_variant, fallback_reason = self._resolve_status()
        return {
            "enabled": self._cfg.enabled,
            "status": status,
            "effectiveVariant": effective_variant,
            "trainedAt": self._trained_at,
            "nextScheduledTrainingAt": self._next_scheduled_training_at(),
            "trainingConfigFingerprint": self._current_fingerprint,
            "isStale": self._is_stale,
            "lastOutcome": self._metadata.last_outcome,
            "fallbackReason": fallback_reason,
            "usableDays": self._metadata.usable_days,
            "droppedDays": deepcopy(self._metadata.dropped_days),
            "omittedSlotCount": self._metadata.omitted_slot_count,
            "factorSummary": {
                "min": self._metadata.factor_min,
                "max": self._metadata.factor_max,
                "median": self._metadata.factor_median,
            },
            "errorReason": self._metadata.error_reason,
        }

    @property
    def _current_fingerprint(self) -> str:
        return compute_fingerprint(self._cfg)

    @property
    def _trained_at(self) -> str | None:
        return self._metadata.trained_at or None

    def _resolve_status(self) -> tuple[str, str, str | None]:
        if not self._cfg.enabled:
            return ("disabled", "raw", "disabled")
        if self._is_stale:
            return (
                "config_changed_pending_retrain",
                "raw",
                "config_changed_pending_retrain",
            )
        if self._metadata.last_outcome == "profile_trained" and self._profile is not None:
            return ("applied", "adjusted", None)
        if self._metadata.last_outcome == "insufficient_history":
            return ("insufficient_history", "raw", "insufficient_history")
        if self._metadata.last_outcome == "training_failed":
            if self._profile is not None:
                return ("training_failed", "adjusted", None)
            return ("training_failed", "raw", "training_failed")
        return ("no_training_yet", "raw", "no_training_yet")

    def _build_default_metadata(self, *, last_outcome: str) -> SolarBiasMetadata:
        return SolarBiasMetadata(
            trained_at="",
            training_config_fingerprint=self._current_fingerprint,
            usable_days=0,
            dropped_days=[],
            factor_min=None,
            factor_max=None,
            factor_median=None,
            omitted_slot_count=0,
            last_outcome=last_outcome,
            error_reason=None,
        )

    def _build_failure_metadata(
        self,
        *,
        error_reason: str,
        trained_at: str,
    ) -> SolarBiasMetadata:
        previous = self._metadata
        return SolarBiasMetadata(
            trained_at=trained_at,
            training_config_fingerprint=self._current_fingerprint,
            usable_days=previous.usable_days,
            dropped_days=deepcopy(previous.dropped_days),
            factor_min=previous.factor_min,
            factor_max=previous.factor_max,
            factor_median=previous.factor_median,
            omitted_slot_count=previous.omitted_slot_count,
            last_outcome="training_failed",
            error_reason=error_reason,
        )

    def _next_scheduled_training_at(self) -> str | None:
        if not self._cfg.enabled:
            return None
        try:
            hour_text, minute_text = self._cfg.training_time.split(":", maxsplit=1)
            hour = int(hour_text)
            minute = int(minute_text)
        except (AttributeError, ValueError):
            return None

        local_now = dt_util.as_local(dt_util.now())
        next_run = local_now.replace(
            hour=hour,
            minute=minute,
            second=0,
            microsecond=0,
        )
        if next_run <= local_now:
            next_run += timedelta(days=1)
        return next_run.isoformat()

    def _serialize_state(self) -> dict[str, Any]:
        profile = self._profile or SolarBiasProfile(factors={}, omitted_slots=[])
        return {
            "version": 1,
            "profile": asdict(profile),
            "metadata": asdict(self._metadata),
        }


def _profile_from_dict(raw_value: Any) -> SolarBiasProfile | None:
    if not isinstance(raw_value, dict):
        return None

    raw_factors = raw_value.get("factors", raw_value)
    if not isinstance(raw_factors, dict):
        return None

    factors: dict[str, float] = {}
    for slot, value in raw_factors.items():
        if not isinstance(slot, str):
            continue
        try:
            factors[slot] = float(value)
        except (TypeError, ValueError):
            continue

    raw_omitted = raw_value.get("omitted_slots", raw_value.get("omittedSlots", []))
    omitted_slots = [slot for slot in raw_omitted if isinstance(slot, str)] if isinstance(raw_omitted, list) else []
    return SolarBiasProfile(factors=factors, omitted_slots=omitted_slots)


def _metadata_from_dict(raw_value: Any) -> SolarBiasMetadata | None:
    if not isinstance(raw_value, dict):
        return None

    trained_at = raw_value.get("trained_at")
    training_config_fingerprint = raw_value.get("training_config_fingerprint")
    usable_days = raw_value.get("usable_days")
    dropped_days = raw_value.get("dropped_days")
    omitted_slot_count = raw_value.get("omitted_slot_count")
    last_outcome = raw_value.get("last_outcome")

    if not isinstance(trained_at, str):
        return None
    if not isinstance(training_config_fingerprint, str):
        return None
    if not isinstance(usable_days, int):
        return None
    if not isinstance(dropped_days, list):
        return None
    if not isinstance(omitted_slot_count, int):
        return None
    if not isinstance(last_outcome, str):
        return None

    return SolarBiasMetadata(
        trained_at=trained_at,
        training_config_fingerprint=training_config_fingerprint,
        usable_days=usable_days,
        dropped_days=deepcopy(dropped_days),
        factor_min=_optional_float(raw_value.get("factor_min")),
        factor_max=_optional_float(raw_value.get("factor_max")),
        factor_median=_optional_float(raw_value.get("factor_median")),
        omitted_slot_count=omitted_slot_count,
        last_outcome=last_outcome,
        error_reason=raw_value.get("error_reason") if isinstance(raw_value.get("error_reason"), str) else None,
    )


def _optional_float(raw_value: Any) -> float | None:
    if raw_value is None:
        return None
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def _copy_points(raw_points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(point) for point in raw_points]
