from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterator
from functools import partial
from copy import deepcopy
from dataclasses import asdict
from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .actuals import load_actuals_for_day, load_actuals_window
from .adjuster import adjust
from .forecast_history import load_forecast_points_for_day, load_trainer_samples
from .house_forecast_history import load_house_forecast_points_for_day
from .models import (
    BatterySocBoundsPoint,
    BatterySocPoint,
    BiasConfig,
    SolarBiasAdjustmentResult,
    SolarBiasContributionRow,
    SolarBiasExplainability,
    SolarBiasFactorPoint,
    SolarBiasImpactPoint,
    SolarBiasInspectorAvailability,
    SolarBiasInspectorDay,
    SolarBiasInspectorPoint,
    SolarBiasInspectorSeries,
    SolarBiasInspectorTotals,
    SolarBiasMetadata,
    SolarBiasProfile,
    SolarBiasSlotExplainability,
    SolarBiasTrainingExplainability,
    inspector_day_to_payload,
    training_explainability_to_payload,
)
from .trainer import compute_fingerprint, train

if TYPE_CHECKING:
    from ..storage import SolarBiasCorrectionStore

_LOGGER = logging.getLogger(__name__)


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
        *,
        canonical_solar_forecast_provider=None,
        battery_forecast_provider=None,
        battery_forecast_history=None,
        house_forecast_snapshot_provider=None,
        house_energy_entity_id_provider=None,
        battery_soc_entity_id_provider=None,
        battery_soc_bounds_provider=None,
        battery_soc_bounds_entity_id_provider=None,
        grid_import_energy_entity_id_provider=None,
        grid_export_energy_entity_id_provider=None,
        battery_charge_energy_entity_id_provider=None,
        battery_discharge_energy_entity_id_provider=None,
    ) -> None:
        self._hass = hass
        self._store = store
        self._cfg = cfg
        self._canonical_solar_forecast_provider = canonical_solar_forecast_provider
        self._battery_forecast_provider = battery_forecast_provider
        self._battery_forecast_history = battery_forecast_history
        self._house_forecast_snapshot_provider = house_forecast_snapshot_provider
        self._house_energy_entity_id_provider = house_energy_entity_id_provider
        self._battery_soc_entity_id_provider = battery_soc_entity_id_provider
        self._battery_soc_bounds_provider = battery_soc_bounds_provider
        self._battery_soc_bounds_entity_id_provider = (
            battery_soc_bounds_entity_id_provider
        )
        self._grid_import_energy_entity_id_provider = grid_import_energy_entity_id_provider
        self._grid_export_energy_entity_id_provider = grid_export_energy_entity_id_provider
        self._battery_charge_energy_entity_id_provider = (
            battery_charge_energy_entity_id_provider
        )
        self._battery_discharge_energy_entity_id_provider = (
            battery_discharge_energy_entity_id_provider
        )
        self._profile: SolarBiasProfile | None = None
        self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
        self._explainability: SolarBiasTrainingExplainability | None = None
        self._is_stale = False
        self._training_lock = asyncio.Lock()
        self._training_in_progress = False
        self._last_emitted_status: tuple[str, str] | None = None

    async def async_setup(self) -> None:
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

        previous_profile = self._profile
        previous_metadata = self._metadata
        previous_explainability = self._explainability
        previous_is_stale = self._is_stale
        self._training_in_progress = True
        await self._training_lock.acquire()
        try:
            now = dt_util.now()
            samples = await load_trainer_samples(self._hass, self._cfg, now)
            actuals = await load_actuals_window(
                self._hass,
                self._cfg,
                days=self._cfg.max_training_window_days,
            )
            outcome = train(samples, actuals, self._cfg, now=now)
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
        except Exception as err:
            preserve_profile = self._should_preserve_profile(
                previous_profile,
                previous_metadata,
            )
            failure_metadata = self._build_failure_metadata(
                previous_metadata=previous_metadata,
                error_reason=str(err) or err.__class__.__name__,
                trained_at=(
                    previous_metadata.trained_at
                    if preserve_profile
                    else dt_util.now().isoformat()
                ),
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
        return (
            self._cfg.slot_invalidation_max_battery_soc_percent is not None
            and bool(self._cfg.slot_invalidation_export_enabled_entity_id)
        )

    def get_profile_payload(self) -> dict[str, Any] | None:
        if not self._has_usable_profile():
            return None

        return {
            "trainedAt": self._trained_at,
            "factors": deepcopy(self._profile.factors),
            "omittedSlots": list(self._profile.omitted_slots),
        }

    async def async_get_inspector_day(self, raw_date: str) -> dict[str, Any]:
        target_date = date.fromisoformat(raw_date)
        local_now = dt_util.as_local(dt_util.now())
        today = local_now.date()
        previous_days = max(self._metadata.usable_days, 0)
        min_date = today - timedelta(days=previous_days)
        max_date = today + timedelta(
            days=max(len(self._cfg.daily_energy_entity_ids) - 1, 0)
        )

        status, effective_variant, _fallback_reason = self._resolve_status()
        timezone = ZoneInfo(str(self._hass.config.time_zone))

        actuals_by_slot = {}
        if target_date <= today:
            actuals_by_slot = await load_actuals_for_day(
                self._hass,
                self._cfg,
                target_date,
                local_now=local_now,
            )

        if target_date >= today:
            provider = self._canonical_solar_forecast_provider
            if provider is not None:
                canonical_snapshot = await provider(reference_time=local_now)
            else:
                canonical_snapshot = None
            if not isinstance(canonical_snapshot, dict):
                canonical_snapshot = {}
            raw_points = _filter_points_to_local_date(
                canonical_snapshot.get("rawPoints") or canonical_snapshot.get("points") or [],
                target_date,
                timezone,
            )
            canonical_corrected = canonical_snapshot.get("correctedPoints") or []
            if effective_variant == "adjusted" and canonical_corrected:
                corrected_points = _filter_points_to_local_date(
                    canonical_corrected,
                    target_date,
                    timezone,
                )
            else:
                corrected_points = _copy_points(raw_points)
        else:
            raw_points = await load_forecast_points_for_day(
                self._hass,
                self._cfg,
                target_date,
                local_now=local_now,
            )
            corrected_points = _copy_points(raw_points)
            if effective_variant == "adjusted" and self._profile is not None:
                corrected_points = adjust(raw_points, self._profile)

        has_profile = self._has_usable_profile()

        factors = _factor_points_for_profile(self._profile if has_profile else None)
        actual_points = _actual_points_for_date(
            actuals_by_slot,
            target_date,
            timezone,
        )
        invalidated_points: list[SolarBiasInspectorPoint] = []
        invalidated_slots = set(
            self._metadata.invalidated_slots_by_date.get(target_date.isoformat(), [])
        )
        if target_date < today and actual_points and invalidated_slots:
            actual_points, invalidated_points = _partition_actual_points(
                actual_points,
                invalidated_slots=invalidated_slots,
            )

        # --- House forecast ---
        # The recorder history of the house forecast sensor (W → Wh) covers every
        # slot up to and including the one in progress; the cached forecast
        # snapshot (kWh → Wh) covers the slots after it, because the recorder
        # would hold the last value flat across the rest of the day.
        # The two must meet at the next slot boundary: the snapshot's series
        # begins there (the in-progress slot sits in its "currentSlot" field, not
        # in "series"), so cutting the recorder any earlier would leave a hole.
        next_slot = _next_slot_boundary(local_now) if target_date == today else None
        need_past = target_date <= today
        need_future = target_date >= today
        actual_local_now = local_now if target_date == today else None

        # Independent recorder/snapshot reads, so overlap them rather than
        # awaiting in turn.
        past_coros = (
            [
                self._guarded_points(
                    load_house_forecast_points_for_day(self._hass, target_date),
                    "house forecast history",
                ),
                self._guarded_points(
                    self._load_house_actual_for_date(
                        target_date, timezone, local_now=actual_local_now
                    ),
                    "house actual",
                ),
                self._guarded_points(
                    self._load_battery_soc_actual_for_date(target_date, timezone),
                    "battery SoC actual",
                ),
                self._guarded_points(
                    self._load_grid_actual_for_date(
                        target_date, timezone, local_now=actual_local_now
                    ),
                    "grid actual",
                ),
                self._guarded_points(
                    self._load_battery_actual_for_date(
                        target_date, timezone, local_now=actual_local_now
                    ),
                    "battery actual",
                ),
            ]
            if need_past
            else []
        )
        future_coros = (
            [self._get_battery_forecast_snapshot()] if need_future else []
        )
        gathered = await asyncio.gather(*past_coros, *future_coros)

        house_forecast_history_points: list[dict] = []
        house_actual_points: list[dict] = []
        battery_soc_actual_points: list[dict] = []
        grid_actual_points: list[dict] = []
        battery_actual_points: list[dict] = []
        if need_past:
            (
                house_forecast_history_points,
                house_actual_points,
                battery_soc_actual_points,
                grid_actual_points,
                battery_actual_points,
            ) = gathered[:5]
        battery_snapshot = gathered[-1] if need_future else None

        house_forecast_points: list[dict] = []
        if need_past:
            house_forecast_points = _points_before(
                house_forecast_history_points, cutoff=next_slot
            )
        if need_future:
            house_forecast_points += _house_forecast_points_from_snapshot(
                self._get_house_forecast_snapshot(),
                target_date,
                next_slot=next_slot,
            )

        # --- Battery SoC, grid and battery forecast ---
        # Elapsed slots come from the archive written as each snapshot was built,
        # since none of these series is recorded anywhere else and the live
        # snapshot starts at the current slot. Slots still ahead of the clock come
        # from that live snapshot, which begins one slot boundary after now.
        battery_soc_forecast_points: list[dict] = []
        grid_forecast_points: list[dict] = []
        battery_forecast_points: list[dict] = []
        if need_past:
            (
                battery_soc_forecast_points,
                grid_forecast_points,
                battery_forecast_points,
            ) = self._recorded_battery_forecast_points(
                target_date, cutoff=next_slot, timezone=timezone
            )
        if need_future:
            battery_soc_forecast_points += _filter_battery_soc_future(
                battery_snapshot,
                target_date=target_date,
                local_now=local_now,
                timezone=timezone,
            )
            grid_forecast_points += _filter_grid_forecast_future(
                battery_snapshot,
                target_date=target_date,
                local_now=local_now,
                timezone=timezone,
            )
            battery_forecast_points += _filter_battery_forecast_future(
                battery_snapshot,
                target_date=target_date,
                local_now=local_now,
                timezone=timezone,
            )

        day = SolarBiasInspectorDay(
            date=target_date.isoformat(),
            timezone=str(self._hass.config.time_zone),
            status=status,
            effective_variant=effective_variant,
            trained_at=self._trained_at,
            min_date=min_date.isoformat(),
            max_date=max_date.isoformat(),
            series=SolarBiasInspectorSeries(
                raw=_inspector_points(raw_points),
                corrected=_inspector_points(corrected_points),
                actual=actual_points,
                invalidated=invalidated_points,
                factors=factors,
                impact=_impact_points_for_day(
                    raw_points,
                    corrected_points,
                ),
                house_forecast=_inspector_points_from_raw(house_forecast_points),
                house_actual=_inspector_points_from_raw(house_actual_points),
                battery_soc_forecast=_battery_soc_points_from_raw(battery_soc_forecast_points),
                battery_soc_actual=_battery_soc_points_from_raw(battery_soc_actual_points),
                grid_forecast=_inspector_points_from_raw(grid_forecast_points),
                grid_actual=_inspector_points_from_raw(grid_actual_points),
                battery_forecast=_inspector_points_from_raw(battery_forecast_points),
                battery_actual=_inspector_points_from_raw(battery_actual_points),
            ),
            totals=SolarBiasInspectorTotals(
                raw_wh=_sum_point_values(raw_points) if raw_points else None,
                corrected_wh=(
                    _sum_point_values(corrected_points) if corrected_points else None
                ),
                actual_wh=sum(actuals_by_slot.values()) if actuals_by_slot else None,
                house_forecast_wh=(
                    sum(p["wh"] for p in house_forecast_points)
                    if house_forecast_points
                    else None
                ),
                house_actual_wh=(
                    sum(p["wh"] for p in house_actual_points)
                    if house_actual_points
                    else None
                ),
                grid_forecast_wh=(
                    sum(p["wh"] for p in grid_forecast_points)
                    if grid_forecast_points
                    else None
                ),
                grid_actual_wh=(
                    sum(p["wh"] for p in grid_actual_points)
                    if grid_actual_points
                    else None
                ),
                battery_forecast_wh=(
                    sum(p["wh"] for p in battery_forecast_points)
                    if battery_forecast_points
                    else None
                ),
                battery_actual_wh=(
                    sum(p["wh"] for p in battery_actual_points)
                    if battery_actual_points
                    else None
                ),
            ),
            availability=SolarBiasInspectorAvailability(
                has_raw_forecast=bool(raw_points),
                has_corrected_forecast=bool(corrected_points),
                has_actuals=bool(actuals_by_slot),
                has_profile=has_profile,
                has_invalidated=bool(invalidated_points),
                has_house_forecast=bool(house_forecast_points),
                has_house_actual=bool(house_actual_points),
                has_battery_soc_forecast=bool(battery_soc_forecast_points),
                has_battery_soc_actual=bool(battery_soc_actual_points),
                has_grid_forecast=bool(grid_forecast_points),
                has_grid_actual=bool(grid_actual_points),
                has_battery_forecast=bool(battery_forecast_points),
                has_battery_actual=bool(battery_actual_points),
            ),
            is_today=target_date == today,
            is_future=target_date > today,
            training_explainability=self._explainability if has_profile else None,
            battery_soc_bounds=await self._battery_soc_bounds_for_date(
                target_date, timezone, need_past=need_past
            ),
        )
        return inspector_day_to_payload(day)

    def _live_battery_soc_bounds(self) -> tuple[float | None, float | None]:
        if self._battery_soc_bounds_provider is None:
            return (None, None)
        try:
            return self._battery_soc_bounds_provider() or (None, None)
        except Exception:
            _LOGGER.exception("Battery SoC bounds provider failed")
            return (None, None)

    def _battery_soc_bounds_entity_ids(self) -> tuple[str | None, str | None]:
        if self._battery_soc_bounds_entity_id_provider is None:
            return (None, None)
        try:
            return self._battery_soc_bounds_entity_id_provider() or (None, None)
        except Exception:
            _LOGGER.exception("Battery SoC bounds entity id provider failed")
            return (None, None)

    async def _battery_soc_bounds_for_date(
        self, target_date: date, local_tz: ZoneInfo, *, need_past: bool
    ) -> list[BatterySocBoundsPoint]:
        """The SoC window per slot: recorded where the day has elapsed.

        Slots the clock has not reached — and elapsed slots the recorder has no
        reading for — fall back to the bounds set right now, which is the only
        window the battery forecast beyond them was ever built against.
        """
        min_entity_id, max_entity_id = self._battery_soc_bounds_entity_ids()
        min_by_slot: dict[str, float] = {}
        max_by_slot: dict[str, float] = {}
        if need_past and (min_entity_id or max_entity_id):
            min_by_slot, max_by_slot = await asyncio.gather(
                self._load_numeric_history_by_slot(
                    min_entity_id, target_date, local_tz, label="battery min SoC"
                ),
                self._load_numeric_history_by_slot(
                    max_entity_id, target_date, local_tz, label="battery max SoC"
                ),
            )

        live_min, live_max = self._live_battery_soc_bounds()
        points: list[BatterySocBoundsPoint] = []
        for slot_index in range(96):
            slot = f"{slot_index // 4:02d}:{(slot_index % 4) * 15:02d}"
            min_pct = min_by_slot.get(slot, live_min)
            max_pct = max_by_slot.get(slot, live_max)
            if min_pct is None and max_pct is None:
                continue
            points.append(
                BatterySocBoundsPoint(slot=slot, min_pct=min_pct, max_pct=max_pct)
            )
        return points

    def _get_house_forecast_snapshot(self) -> dict | None:
        if self._house_forecast_snapshot_provider is None:
            return None
        try:
            return self._house_forecast_snapshot_provider()
        except Exception:
            _LOGGER.exception("House forecast snapshot provider failed")
            return None

    async def _get_battery_forecast_snapshot(self) -> dict | None:
        if self._battery_forecast_provider is None:
            return None
        try:
            return await self._battery_forecast_provider()
        except Exception:
            _LOGGER.exception("Battery forecast provider failed")
            return None

    def _recorded_battery_forecast_points(
        self, target_date: date, *, cutoff: datetime | None, timezone: ZoneInfo
    ) -> tuple[list[dict], list[dict], list[dict]]:
        """Read archived SoC, net grid and net battery forecast slots for a day.

        Returns (soc points, grid points, battery points) for slots starting
        before cutoff, or for the whole day when cutoff is None. Days archived
        before batteryNetWh existed yield no battery points.
        """
        if self._battery_forecast_history is None:
            return [], [], []
        try:
            slots = self._battery_forecast_history.slots_for_day(target_date)
        except Exception:
            _LOGGER.exception("Failed to read battery forecast history for inspector")
            return [], [], []
        cutoff_minutes = _minutes_into_day(cutoff, target_date)
        soc_points: list[dict] = []
        grid_points: list[dict] = []
        battery_points: list[dict] = []
        for slot in sorted(slots):
            minutes = _slot_to_minutes(slot)
            if minutes is None or minutes >= cutoff_minutes:
                continue
            values = slots[slot]
            if not isinstance(values, dict):
                continue
            pct = values.get("socPct")
            if pct is not None:
                soc_points.append({"slot": slot, "pct": float(pct)})
            timestamp = datetime.combine(
                target_date, time(minutes // 60, minutes % 60), tzinfo=timezone
            )
            grid_net_wh = values.get("gridNetWh")
            if grid_net_wh is not None:
                grid_points.append(
                    {"timestamp": timestamp.isoformat(), "wh": float(grid_net_wh)}
                )
            battery_net_wh = values.get("batteryNetWh")
            if battery_net_wh is not None:
                battery_points.append(
                    {"timestamp": timestamp.isoformat(), "wh": float(battery_net_wh)}
                )
        return soc_points, grid_points, battery_points

    async def _guarded_points(self, coro, description: str) -> list[dict]:
        """Await a series loader, degrading to an empty series if it fails.

        One failing series must not take down the whole inspector day, and the
        loaders run concurrently, so each needs its own error boundary.
        """
        try:
            return await coro
        except Exception:
            _LOGGER.exception("Failed to load %s for inspector", description)
            return []

    async def _load_slot_energy_kwh(
        self, entity_id: str, target_date: date, local_tz: ZoneInfo
    ) -> dict[datetime, float]:
        """Per-15-min energy deltas of a cumulative meter, keyed by UTC slot start.

        Daily-resetting meters are fine here: the query unwraps total_increasing
        resets, and a single local day never spans the midnight reset boundary.
        """
        from ..recorder_hourly_series import query_cumulative_slot_energy_changes

        local_start = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
        return await query_cumulative_slot_energy_changes(
            self._hass,
            entity_id,
            local_start=local_start,
            local_end=local_start + timedelta(days=1),
            interval_minutes=15,
        )

    async def _load_house_actual_for_date(
        self, target_date: date, local_tz: ZoneInfo, local_now: datetime | None = None
    ) -> list[dict]:
        """Load per-15-min house energy actuals for target_date."""
        if self._house_energy_entity_id_provider is None:
            return []
        entity_id = self._house_energy_entity_id_provider()
        if not entity_id:
            return []
        try:
            by_slot = await self._load_slot_energy_kwh(entity_id, target_date, local_tz)
        except Exception:
            _LOGGER.exception("Failed to load house actual for inspector")
            return []
        return _slot_energy_points(
            {slot: kwh * 1000.0 for slot, kwh in by_slot.items()},
            target_date,
            local_now=local_now,
        )

    async def _load_grid_actual_for_date(
        self, target_date: date, local_tz: ZoneInfo, local_now: datetime | None = None
    ) -> list[dict]:
        """Load per-15-min net grid energy for target_date.

        Positive is exported to the grid, negative is imported from it, matching
        the sign of the grid forecast and of gridNetKwh elsewhere in the project.

        Only one of the two meters needs to be configured; the missing side
        contributes zero, the same way a snapshot slot without one of the grid
        fields does.
        """

        def _entity_id(provider) -> str | None:
            return provider() if provider is not None else None

        import_entity = _entity_id(self._grid_import_energy_entity_id_provider)
        export_entity = _entity_id(self._grid_export_energy_entity_id_provider)
        if not import_entity and not export_entity:
            return []

        async def _load(entity_id: str | None) -> dict[datetime, float]:
            if not entity_id:
                return {}
            return await self._load_slot_energy_kwh(entity_id, target_date, local_tz)

        try:
            # The two meters are independent recorder reads; overlap them.
            imported, exported = await asyncio.gather(
                _load(import_entity), _load(export_entity)
            )
        except Exception:
            _LOGGER.exception("Failed to load grid actual for inspector")
            return []
        net_wh_by_slot = {
            slot: (exported.get(slot, 0.0) - imported.get(slot, 0.0)) * 1000.0
            for slot in imported.keys() | exported.keys()
        }
        return _slot_energy_points(net_wh_by_slot, target_date, local_now=local_now)

    async def _load_battery_actual_for_date(
        self, target_date: date, local_tz: ZoneInfo, local_now: datetime | None = None
    ) -> list[dict]:
        """Load per-15-min net battery energy for target_date.

        Positive is charged into the battery, negative is discharged out of it,
        matching the sign of the archived batteryNetWh.

        These are the inverter's own charge/discharge meters rather than a
        difference of the stored-energy level, so round-trip losses stay on the
        side of the battery that actually paid them.

        Only one of the two meters needs to be configured; the missing side
        contributes zero, the same way the grid meters behave.
        """

        def _entity_id(provider) -> str | None:
            return provider() if provider is not None else None

        charge_entity = _entity_id(self._battery_charge_energy_entity_id_provider)
        discharge_entity = _entity_id(self._battery_discharge_energy_entity_id_provider)
        if not charge_entity and not discharge_entity:
            return []

        async def _load(entity_id: str | None) -> dict[datetime, float]:
            if not entity_id:
                return {}
            return await self._load_slot_energy_kwh(entity_id, target_date, local_tz)

        try:
            # The two meters are independent recorder reads; overlap them.
            charged, discharged = await asyncio.gather(
                _load(charge_entity), _load(discharge_entity)
            )
        except Exception:
            _LOGGER.exception("Failed to load battery actual for inspector")
            return []
        net_wh_by_slot = {
            slot: (charged.get(slot, 0.0) - discharged.get(slot, 0.0)) * 1000.0
            for slot in charged.keys() | discharged.keys()
        }
        return _slot_energy_points(net_wh_by_slot, target_date, local_now=local_now)

    async def _load_battery_soc_actual_for_date(
        self, target_date: date, local_tz: ZoneInfo
    ) -> list[dict]:
        """Load per-15-min battery SoC history for target_date."""
        if self._battery_soc_entity_id_provider is None:
            return []
        by_slot = await self._load_numeric_history_by_slot(
            self._battery_soc_entity_id_provider(),
            target_date,
            local_tz,
            label="battery SoC",
        )
        return [{"slot": slot, "pct": pct} for slot, pct in by_slot.items()]

    async def _load_numeric_history_by_slot(
        self,
        entity_id: str | None,
        target_date: date,
        local_tz: ZoneInfo,
        *,
        label: str,
    ) -> dict[str, float]:
        """Sample a numeric entity's history onto the day's 15-minute slots.

        A slot takes the last value the entity held at or before its start, so
        an entity that goes unavailable holds its previous reading rather than
        leaving a hole. Slots before the entity's first reading are absent, as
        are slots the clock has not reached yet.
        """
        if not entity_id:
            return {}
        local_start = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
        local_end = local_start + timedelta(days=1)
        start_utc = dt_util.as_utc(local_start)
        end_utc = dt_util.as_utc(local_end)
        try:
            states_by_entity = await _get_significant_states_safe(
                self._hass, start_utc, end_utc, [entity_id]
            )
        except Exception:
            _LOGGER.exception("Failed to load %s history for inspector", label)
            return {}
        states = (states_by_entity or {}).get(entity_id) or []
        if not states:
            return {}
        timeline: list[tuple[datetime, float]] = []
        for state in states:
            raw = getattr(state, "state", None)
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            ts = getattr(state, "last_changed", None) or getattr(
                state, "last_updated", None
            )
            if ts is None:
                continue
            timeline.append((dt_util.as_local(ts), value))
        if not timeline:
            return {}
        timeline.sort(key=lambda pair: pair[0])
        _SLOT_MINUTES = 15
        local_now = datetime.now(local_tz)
        is_today = target_date == local_now.date()
        by_slot: dict[str, float] = {}
        cursor = 0
        current: float | None = None
        for slot_index in range(96):
            slot_start = local_start + timedelta(minutes=slot_index * _SLOT_MINUTES)
            if is_today and slot_start > local_now:
                break
            while cursor < len(timeline) and timeline[cursor][0] <= slot_start:
                current = timeline[cursor][1]
                cursor += 1
            if current is None:
                continue
            by_slot[f"{slot_start.hour:02d}:{slot_start.minute:02d}"] = current
        return by_slot

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
        self._hass.bus.async_fire(
            "helman_solar_bias_status_changed",
            {"status": status, "effectiveVariant": effective_variant},
        )

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
        training_config_fingerprint: str,
    ) -> SolarBiasMetadata:
        previous = previous_metadata
        return SolarBiasMetadata(
            trained_at=trained_at,
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

    def _should_preserve_profile(
        self,
        profile: SolarBiasProfile | None,
        metadata: SolarBiasMetadata,
    ) -> bool:
        if profile is None:
            return False

        if metadata.last_outcome not in ("profile_trained", "training_failed"):
            return False

        return metadata.usable_days >= self._cfg.min_history_days

    def _has_usable_profile(self) -> bool:
        if self._profile is None:
            return False
        if self._metadata.last_outcome == "profile_trained":
            return True
        return self._should_preserve_profile(self._profile, self._metadata)

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
        return {
            "version": 2,
            "profile": None if self._profile is None else asdict(self._profile),
            "metadata": asdict(self._metadata),
            "trainingExplainability": training_explainability_to_payload(self._explainability),
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


def _filter_points_to_local_date(
    points: list[dict[str, Any]],
    target_date: date,
    timezone: ZoneInfo,
) -> list[dict[str, Any]]:
    """Return points whose timestamp falls on `target_date` in `timezone`, preserving native granularity."""
    parse_datetime = getattr(dt_util, "parse_datetime", datetime.fromisoformat)
    filtered: list[tuple[datetime, dict[str, Any]]] = []
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str) or isinstance(value, bool):
            continue
        if not isinstance(value, (int, float)):
            continue
        parsed_timestamp = parse_datetime(timestamp)
        if parsed_timestamp is None:
            continue
        local_timestamp = dt_util.as_local(parsed_timestamp).astimezone(timezone)
        if local_timestamp.date() != target_date:
            continue
        filtered.append((local_timestamp, {"timestamp": timestamp, "value": float(value)}))
    filtered.sort(key=lambda item: item[0])
    return [point for _, point in filtered]


def _copy_points(raw_points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(point) for point in raw_points]


def _inspector_points(raw_points: list[dict[str, Any]]) -> list[SolarBiasInspectorPoint]:
    points: list[SolarBiasInspectorPoint] = []
    for point in raw_points:
        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str):
            continue
        try:
            value_wh = float(value)
        except (TypeError, ValueError):
            continue
        points.append(SolarBiasInspectorPoint(timestamp=timestamp, value_wh=value_wh))
    return points


def _sum_point_values(raw_points: list[dict[str, Any]]) -> float:
    total = 0.0
    for point in raw_points:
        try:
            total += float(point.get("value"))
        except (TypeError, ValueError):
            continue
    return total


def _partition_actual_points(
    actual_points: list[SolarBiasInspectorPoint],
    *,
    invalidated_slots: set[str],
) -> tuple[list[SolarBiasInspectorPoint], list[SolarBiasInspectorPoint]]:
    """Split actuals into kept vs invalidated using the actuals' own 15-min slot key.

    Both `actual_points` and `invalidated_slots` are at 15-minute granularity,
    so the comparison is direct. Earlier code mapped each actual to the
    *containing* forecast-published slot, which silently coarsened to hourly
    when raw forecast was hourly and dropped 15-min invalidations on the floor.
    """
    actual: list[SolarBiasInspectorPoint] = []
    invalidated: list[SolarBiasInspectorPoint] = []
    for point in actual_points:
        point_slot = point.timestamp[11:16]
        if point_slot in invalidated_slots:
            invalidated.append(point)
            continue
        actual.append(point)
    return actual, invalidated


def _factor_points_for_profile(
    profile: SolarBiasProfile | None,
) -> list[SolarBiasFactorPoint]:
    if profile is None:
        return []
    return [
        SolarBiasFactorPoint(slot=slot, factor=float(factor))
        for slot, factor in sorted(profile.factors.items())
    ]


def _impact_points_for_day(
    raw_points: list[dict[str, Any]],
    corrected_points: list[dict[str, Any]],
) -> list[SolarBiasImpactPoint]:
    corrected_by_slot: dict[str, float] = {}
    for point in corrected_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str):
            continue
        try:
            corrected_by_slot[timestamp[11:16]] = float(point.get("value"))
        except (TypeError, ValueError):
            continue

    impact: list[SolarBiasImpactPoint] = []
    for point in raw_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str):
            continue
        slot = timestamp[11:16]
        try:
            raw_wh = float(point.get("value"))
        except (TypeError, ValueError):
            continue
        corrected_wh = corrected_by_slot.get(slot)
        if corrected_wh is None:
            continue
        # Effective factor: corrected/raw. At 15-min granularity this equals
        # profile.factors[slot]; at hourly granularity (today/future buckets
        # aggregating four 15-min slots) it reflects the raw-weighted average
        # of the underlying sub-slot factors actually applied.
        effective_factor: float | None
        if raw_wh > 0.0:
            effective_factor = corrected_wh / raw_wh
        else:
            effective_factor = None
        impact.append(
            SolarBiasImpactPoint(
                slot=slot,
                raw_wh=raw_wh,
                corrected_wh=corrected_wh,
                impact_wh=corrected_wh - raw_wh,
                factor=effective_factor,
            )
        )
    return impact


def _actual_points_for_date(
    actuals_by_slot: dict[str, float],
    target_date: date,
    local_tz: ZoneInfo,
) -> list[SolarBiasInspectorPoint]:
    points: list[SolarBiasInspectorPoint] = []
    for slot, value in sorted(actuals_by_slot.items()):
        try:
            hour, minute = [int(part) for part in slot.split(":", 1)]
            timestamp = datetime.combine(
                target_date,
                time(hour=hour, minute=minute),
                tzinfo=local_tz,
            )
            points.append(
                SolarBiasInspectorPoint(
                    timestamp=timestamp.isoformat(),
                    value_wh=float(value),
                )
            )
        except (TypeError, ValueError):
            continue
    return points


async def _get_significant_states_safe(hass, start_utc, end_utc, entity_ids):
    """Wrapper around get_significant_states that handles import failures."""
    try:
        from homeassistant.components.recorder import get_instance
        from homeassistant.components.recorder.history import get_significant_states
    except Exception:
        return {}
    return await get_instance(hass).async_add_executor_job(
        partial(
            get_significant_states,
            hass,
            start_utc,
            end_utc,
            entity_ids,
            significant_changes_only=False,
        )
    )


def _house_forecast_points_from_snapshot(
    snapshot: dict | None,
    target_date: date,
    *,
    next_slot: datetime | None = None,
) -> list[dict]:
    """Extract 15-min house forecast Wh points for target_date from a cached snapshot.

    The snapshot series values are in kWh per canonical slot; convert to Wh.
    Pass next_slot for today so past slots are excluded and forecast starts
    seamlessly after the last actual slot.
    """
    if not isinstance(snapshot, dict):
        return []
    if snapshot.get("status") != "available":
        return []
    points: list[dict] = []
    for entry in snapshot.get("series") or []:
        if not isinstance(entry, dict):
            continue
        ts_raw = entry.get("timestamp")
        if not isinstance(ts_raw, str):
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=next_slot.tzinfo if next_slot else None)
        if ts.date() != target_date:
            continue
        if next_slot is not None and ts < next_slot:
            continue
        nd = entry.get("nonDeferrable") or {}
        nd_kwh = nd.get("value") if isinstance(nd, dict) else None
        if nd_kwh is None:
            continue
        try:
            nd_kwh = float(nd_kwh)
        except (TypeError, ValueError):
            continue
        deferrable_kwh = sum(
            float(c.get("value", 0))
            for c in (entry.get("deferrableConsumers") or [])
            if isinstance(c, dict) and isinstance(c.get("value"), (int, float))
        )
        total_wh = (nd_kwh + deferrable_kwh) * 1000
        points.append({"timestamp": ts_raw, "wh": total_wh})
    return points


def _current_slot_start(local_now: datetime) -> datetime:
    """Return the start of the 15-min slot containing local_now.

    Imported lazily, like the other recorder_hourly_series helpers here, because
    that module imports the recorder integration at module scope.
    """
    from ..recorder_hourly_series import get_local_current_slot_start

    return get_local_current_slot_start(local_now, interval_minutes=15)


def _next_slot_boundary(local_now: datetime) -> datetime:
    """Return the start of the first 15-min slot that begins after the slot containing now."""
    return _current_slot_start(local_now) + timedelta(minutes=15)


def _slot_to_minutes(slot: str) -> int | None:
    """Turn an "HH:MM" slot label into minutes past midnight."""
    hour_text, _, minute_text = slot.partition(":")
    try:
        hour = int(hour_text)
        minute = int(minute_text)
    except ValueError:
        return None
    if not (0 <= hour < 24 and 0 <= minute < 60):
        return None
    return hour * 60 + minute


def _minutes_into_day(cutoff: datetime | None, target_date: date) -> int:
    """Minutes past midnight of target_date at cutoff, or the full day.

    A cutoff on a later date (the 23:45 slot rolls over) covers the whole day.
    """
    if cutoff is None or cutoff.date() > target_date:
        return 24 * 60
    return cutoff.hour * 60 + cutoff.minute


def _points_before(points: list[dict], *, cutoff: datetime | None) -> list[dict]:
    """Drop timestamped points that start at or after cutoff."""
    if cutoff is None:
        return points
    kept: list[dict] = []
    for point in points:
        try:
            ts = datetime.fromisoformat(point["timestamp"])
        except (KeyError, TypeError, ValueError):
            continue
        if ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)
        if ts < cutoff.replace(tzinfo=None):
            kept.append(point)
    return kept


def _slot_energy_points(
    wh_by_slot_utc: dict[datetime, float],
    target_date: date,
    *,
    local_now: datetime | None,
) -> list[dict]:
    """Turn UTC-keyed slot energies into local per-slot inspector points.

    When local_now is given the still-running slot is dropped, since its energy
    delta only covers part of the slot.
    """
    running_slot_start = _current_slot_start(local_now) if local_now is not None else None
    points: list[dict] = []
    for slot_start_utc, wh in sorted(wh_by_slot_utc.items()):
        slot_local = dt_util.as_local(slot_start_utc)
        if slot_local.date() != target_date:
            continue
        if running_slot_start is not None and slot_local >= running_slot_start:
            continue
        points.append({"timestamp": slot_local.isoformat(), "wh": wh})
    return points


def _iter_future_snapshot_entries(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> Iterator[tuple[datetime, dict]]:
    """Yield (local timestamp, entry) for snapshot slots on target_date not yet started."""
    if not isinstance(snapshot, dict):
        return
    next_slot = _next_slot_boundary(local_now)
    for entry in snapshot.get("series") or []:
        if not isinstance(entry, dict):
            continue
        ts_raw = entry.get("timestamp")
        if not isinstance(ts_raw, str):
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except ValueError:
            continue
        ts_local = ts.astimezone(timezone) if ts.tzinfo else ts.replace(tzinfo=timezone)
        if ts_local.date() != target_date:
            continue
        if ts_local < next_slot:
            continue
        yield ts_local, entry


def _filter_battery_soc_future(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> list[dict]:
    """Extract future battery SoC forecast slots for target_date from the snapshot."""
    points: list[dict] = []
    for ts_local, entry in _iter_future_snapshot_entries(
        snapshot, target_date=target_date, local_now=local_now, timezone=timezone
    ):
        pct = entry.get("socPct")
        if pct is None:
            continue
        slot = f"{ts_local.hour:02d}:{ts_local.minute:02d}"
        points.append({"slot": slot, "pct": float(pct)})
    return points


def _filter_grid_forecast_future(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> list[dict]:
    """Extract future net grid energy slots for target_date from the snapshot.

    Positive is exported to the grid, negative is imported from it, matching
    gridNetKwh in the scheduling and forecast cards.
    """
    points: list[dict] = []
    for ts_local, entry in _iter_future_snapshot_entries(
        snapshot, target_date=target_date, local_now=local_now, timezone=timezone
    ):
        imported = entry.get("importedFromGridKwh")
        exported = entry.get("exportedToGridKwh")
        if imported is None and exported is None:
            continue
        net_kwh = float(exported or 0.0) - float(imported or 0.0)
        points.append({"timestamp": ts_local.isoformat(), "wh": net_kwh * 1000.0})
    return points


def _filter_battery_forecast_future(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> list[dict]:
    """Extract future net battery energy slots for target_date from the snapshot.

    Positive is charging, negative is discharging, matching the sign of the
    archived batteryNetWh.
    """
    points: list[dict] = []
    for ts_local, entry in _iter_future_snapshot_entries(
        snapshot, target_date=target_date, local_now=local_now, timezone=timezone
    ):
        charged = entry.get("chargedKwh")
        discharged = entry.get("dischargedKwh")
        if charged is None and discharged is None:
            continue
        net_kwh = float(charged or 0.0) - float(discharged or 0.0)
        points.append({"timestamp": ts_local.isoformat(), "wh": net_kwh * 1000.0})
    return points


def _inspector_points_from_raw(raw: list[dict]) -> list[SolarBiasInspectorPoint]:
    return [
        SolarBiasInspectorPoint(timestamp=p["timestamp"], value_wh=float(p["wh"]))
        for p in raw
        if "timestamp" in p and "wh" in p
    ]


def _battery_soc_points_from_raw(raw: list[dict]) -> list[BatterySocPoint]:
    return [
        BatterySocPoint(slot=p["slot"], pct=float(p["pct"]))
        for p in raw
        if "slot" in p and "pct" in p
    ]
