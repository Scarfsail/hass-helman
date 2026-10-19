"""Solar bias correction service: fit, adjust and profile persistence."""

from __future__ import annotations

import logging
from collections.abc import Callable
from copy import deepcopy
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..training.schedule import next_scheduled_training_at
from .actuals import load_actuals_window
from .adjuster import adjust
from .forecast_history import load_trainer_samples
from .models import (
    BiasConfig,
    SolarBiasAdjustmentResult,
    SolarBiasContributionRow,
    SolarBiasExplainability,
    SolarBiasMetadata,
    SolarBiasProfile,
    SolarBiasSlotExplainability,
    SolarBiasTrainingExplainability,
    training_explainability_to_payload,
)
from .trainer import compute_fingerprint, train

if TYPE_CHECKING:
    from ..storage import SolarBiasCorrectionStore

_LOGGER = logging.getLogger(__name__)


class BiasNotConfiguredError(RuntimeError):
    pass


class SolarBiasCorrectionService:
    def __init__(
        self,
        hass: HomeAssistant,
        store: SolarBiasCorrectionStore,
        cfg: BiasConfig,
        *,
        on_status_changed: Callable[[], None] | None = None,
    ) -> None:
        self._hass = hass
        self._store = store
        self._cfg = cfg
        self._on_status_changed = on_status_changed
        self._profile: SolarBiasProfile | None = None
        self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
        self._explainability: SolarBiasTrainingExplainability | None = None
        self._is_stale = False
        self._last_emitted_status: tuple[str, str] | None = None
    async def async_setup(self) -> None:
        try:
            stored = self._store.profile
            current_fingerprint = self._current_fingerprint
            if not isinstance(stored, dict):
                self._profile = None
                self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
                self._explainability = None
                self._is_stale = False
                return

            raw_profile = stored.get("profile")
            if raw_profile is None:
                profile = None
            else:
                profile = _profile_from_dict(raw_profile)
                if profile is None:
                    self._profile = None
                    self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
                    self._explainability = None
                    self._is_stale = False
                    return

            metadata = _metadata_from_dict(stored.get("metadata"))
            if metadata is None:
                self._profile = None
                self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
                self._explainability = None
                self._is_stale = False
                return

            self._profile = profile
            self._metadata = metadata
            self._explainability = _training_explainability_from_dict(
                stored.get("trainingExplainability", stored.get("training_explainability"))
            )
            self._is_stale = metadata.training_config_fingerprint != current_fingerprint
        finally:
            self._sync_last_emitted_status()

    async def async_train(self) -> dict[str, Any]:
        if not self._cfg.enabled:
            raise BiasNotConfiguredError("Solar bias correction is disabled")

        previous_profile = self._profile
        previous_metadata = self._metadata
        previous_explainability = self._explainability
        previous_is_stale = self._is_stale
        # Use this service instance's configuration throughout the training run.
        cfg = self._cfg
        try:
            now = dt_util.now()
            samples = await load_trainer_samples(self._hass, cfg, now)
            actuals = await load_actuals_window(
                self._hass,
                cfg,
                days=cfg.max_training_window_days,
            )
            # The fit is pure arithmetic over a window that can run to ninety
            # days of slots, and holding the event loop for it stalls every
            # other thing Home Assistant is doing. Nothing in it touches hass.
            outcome = await self._hass.async_add_executor_job(
                train, samples, actuals, cfg, now
            )
            payload = {
                "version": 2,
                "profile": asdict(outcome.profile),
                "metadata": asdict(outcome.metadata),
                "trainingExplainability": training_explainability_to_payload(outcome.explainability),
            }
            await self._store.async_save(payload)
            self._profile = outcome.profile
            self._metadata = outcome.metadata
            self._explainability = outcome.explainability
            self._is_stale = False
        except Exception as err:  # noqa: BLE001
            preserve_profile = self.profile_is_usable(
                previous_profile,
                previous_metadata,
            )
            attempted_at = dt_util.now().isoformat()
            failure_metadata = self._build_failure_metadata(
                previous_metadata=previous_metadata,
                error_reason=str(err) or err.__class__.__name__,
                trained_at=(
                    previous_metadata.trained_at
                    if preserve_profile
                    else attempted_at
                ),
                last_attempt_at=attempted_at,
                training_config_fingerprint=(
                    previous_metadata.training_config_fingerprint
                    if preserve_profile
                    else self._current_fingerprint
                ),
            )
            self._profile = previous_profile if preserve_profile else None
            self._metadata = failure_metadata
            self._explainability = previous_explainability if preserve_profile else None
            self._is_stale = previous_is_stale
            await self._store.async_save(self._serialize_state())
        self._sync_last_emitted_status()
        return self.get_status_payload()

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
        self._emit_status_changed_if_needed(status, effective_variant)
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
            "minHistoryDays": self._cfg.min_history_days,
            "slotInvalidationEnabled": self._is_slot_invalidation_enabled(),
            "status": status,
            "effectiveVariant": effective_variant,
            "trainedAt": self._trained_at,
            "lastAttemptAt": self._metadata.last_attempt_at,
            "nextScheduledTrainingAt": self._next_scheduled_training_at(),
            "trainingConfigFingerprint": self._current_fingerprint,
            "isStale": self._is_stale,
            "lastOutcome": self._metadata.last_outcome,
            "fallbackReason": fallback_reason,
            "usableDays": self._metadata.usable_days,
            "droppedDays": deepcopy(self._metadata.dropped_days),
            "omittedSlotCount": self._metadata.omitted_slot_count,
            "invalidatedSlotCount": self._metadata.invalidated_slot_count,
            "factorSummary": {
                "min": self._metadata.factor_min,
                "max": self._metadata.factor_max,
                "median": self._metadata.factor_median,
            },
            "errorReason": self._metadata.error_reason,
        }

    def _is_slot_invalidation_enabled(self) -> bool:
        # The SoC threshold is the whole switch since curtailment stopped
        # needing an entity of its own — everything else it reads has a default
        # or comes from the power devices already configured.
        return self._cfg.slot_invalidation_max_battery_soc_percent is not None

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

    def _emit_status_changed_if_needed(
        self,
        status: str,
        effective_variant: str,
    ) -> None:
        current = (status, effective_variant)
        if self._last_emitted_status == current:
            return
        self._last_emitted_status = current
        if self._on_status_changed is not None:
            self._on_status_changed()

    def _sync_last_emitted_status(self) -> None:
        status, effective_variant, _ = self._resolve_status()
        self._last_emitted_status = (status, effective_variant)

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
        previous_metadata: SolarBiasMetadata,
        error_reason: str,
        trained_at: str,
        last_attempt_at: str,
        training_config_fingerprint: str,
    ) -> SolarBiasMetadata:
        previous = previous_metadata
        return SolarBiasMetadata(
            trained_at=trained_at,
            last_attempt_at=last_attempt_at,
            training_config_fingerprint=training_config_fingerprint,
            usable_days=previous.usable_days,
            dropped_days=deepcopy(previous.dropped_days),
            factor_min=previous.factor_min,
            factor_max=previous.factor_max,
            factor_median=previous.factor_median,
            omitted_slot_count=previous.omitted_slot_count,
            last_outcome="training_failed",
            error_reason=error_reason,
        )

    def profile_is_usable(
        self,
        profile: SolarBiasProfile | None = None,
        metadata: SolarBiasMetadata | None = None,
    ) -> bool:
        prof = self._profile if profile is None else profile
        meta = self._metadata if metadata is None else metadata
        if prof is None or meta is None:
            return False

        if meta.last_outcome not in ("profile_trained", "training_failed"):
            return False

        return meta.usable_days >= self._cfg.min_history_days

    def _has_usable_profile(self) -> bool:
        if self._profile is None:
            return False
        if self._metadata.last_outcome == "profile_trained":
            return True
        return self.profile_is_usable(self._profile, self._metadata)

    def _next_scheduled_training_at(self) -> str | None:
        if not self._cfg.enabled:
            return None
        return next_scheduled_training_at(self._cfg.training_time)

    def _serialize_state(self) -> dict[str, Any]:
        return {
            "version": 2,
            "profile": None if self._profile is None else asdict(self._profile),
            "metadata": asdict(self._metadata),
            "trainingExplainability": training_explainability_to_payload(self._explainability),
        }



def health_for(status: dict[str, Any]) -> str:
    """This job's outcome as ``ok | degraded | failed | idle``.

    Read from :meth:`SolarBiasCorrectionService.get_status_payload`, the one
    place bias status is assembled. Disabled is ``idle`` whatever the last run
    said: nothing is being trained or served.
    """
    if not status["enabled"]:
        return "idle"
    outcome = status["lastOutcome"]
    if outcome == "profile_trained":
        return "ok"
    if outcome == "insufficient_history":
        return "degraded"
    if outcome == "training_failed":
        return "failed"
    return "idle"


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

    raw_invalidated_slots_by_date = raw_value.get("invalidated_slots_by_date", {})
    invalidated_slots_by_date: dict[str, list[str]] = {}
    if isinstance(raw_invalidated_slots_by_date, dict):
        for day, slots in raw_invalidated_slots_by_date.items():
            if not isinstance(day, str) or not isinstance(slots, list):
                continue
            invalidated_slots_by_date[day] = [
                slot for slot in slots if isinstance(slot, str)
            ]

    raw_invalidated_slot_count = raw_value.get("invalidated_slot_count", 0)
    invalidated_slot_count = (
        raw_invalidated_slot_count
        if isinstance(raw_invalidated_slot_count, int)
        else 0
    )

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
        invalidated_slots_by_date=invalidated_slots_by_date,
        invalidated_slot_count=invalidated_slot_count,
        error_reason=raw_value.get("error_reason") if isinstance(raw_value.get("error_reason"), str) else None,
        last_attempt_at=(
            raw_value.get("last_attempt_at")
            if isinstance(raw_value.get("last_attempt_at"), str)
            else None
        ),
    )


def _training_explainability_from_dict(
    raw_value: Any,
) -> SolarBiasTrainingExplainability | None:
    if not isinstance(raw_value, dict):
        return None
    trained_at = raw_value.get("trainedAt", raw_value.get("trained_at"))
    aggregation_method = raw_value.get(
        "aggregationMethod", raw_value.get("aggregation_method")
    )
    raw_slots = raw_value.get("slots")
    if not isinstance(trained_at, str) or not isinstance(aggregation_method, str):
        return None
    if not isinstance(raw_slots, dict):
        return None

    slots: dict[str, SolarBiasSlotExplainability] = {}
    for slot, raw_slot in raw_slots.items():
        if not isinstance(slot, str) or not isinstance(raw_slot, dict):
            continue
        raw_rows = raw_slot.get("rows")
        if not isinstance(raw_rows, list):
            continue
        rows: list[SolarBiasContributionRow] = []
        for raw_row in raw_rows:
            if not isinstance(raw_row, dict):
                continue
            date_value = raw_row.get("date")
            status = raw_row.get("status")
            if not isinstance(date_value, str) or not isinstance(status, str):
                continue
            reason = raw_row.get("reason")
            rows.append(
                SolarBiasContributionRow(
                    date=date_value,
                    forecast_wh=_optional_float(raw_row.get("forecastWh", raw_row.get("forecast_wh"))),
                    actual_wh=_optional_float(raw_row.get("actualWh", raw_row.get("actual_wh"))),
                    ratio=_optional_float(raw_row.get("ratio")),
                    status=status,
                    reason=reason if isinstance(reason, str) else None,
                )
            )
        raw_anchors = raw_slot.get(
            "interpolationAnchors", raw_slot.get("interpolation_anchors")
        )
        anchors: tuple[str | None, str | None] | None = None
        if isinstance(raw_anchors, dict):
            left = raw_anchors.get("left")
            right = raw_anchors.get("right")
            anchors = (
                left if isinstance(left, str) else None,
                right if isinstance(right, str) else None,
            )
        slots[slot] = SolarBiasSlotExplainability(
            factor=_optional_float(raw_slot.get("factor")),
            raw_ratio=_optional_float(raw_slot.get("rawRatio", raw_slot.get("raw_ratio"))),
            clamped=bool(raw_slot.get("clamped", False)),
            forecast_sum_wh=_optional_float(raw_slot.get("forecastSumWh", raw_slot.get("forecast_sum_wh"))) or 0.0,
            actual_sum_wh=_optional_float(raw_slot.get("actualSumWh", raw_slot.get("actual_sum_wh"))) or 0.0,
            rows=rows,
            interpolated=bool(raw_slot.get("interpolated", False)),
            interpolation_anchors=anchors,
        )

    return SolarBiasTrainingExplainability(
        trained_at=trained_at,
        aggregation_method=aggregation_method,
        slots=slots,
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
