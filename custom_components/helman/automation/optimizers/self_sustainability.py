"""Re-simulating the battery with an appliance's own placements folded in.

Every other condition asks something about the house as it *would be* without
the appliance. ``ensure_self_sustainability`` asks what running the appliance
*does* to the house, which no rail can answer: the rails are the trajectory the
appliance is absent from.

So the horizon is re-simulated. Not with a second copy of the battery physics —
:mod:`...battery_slot_simulation` holds the one implementation the forecast
itself runs — but by feeding that simulator the same bucket inputs the forecast
used, with the candidate placements' demand added to the house.

**Why this cannot be a mask.** Placing at 09:00 changes whether 20:00 is
feasible, and ``system_mask &= mask`` assumes slots are independent. The
condition is therefore self-gating: it contributes an all-true mask and the
optimizer does the work, exactly as ``reserve_floor_soc`` does for
``charge_from_grid``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

from ...battery_slot_simulation import (
    is_supported_schedule_action,
    simulate_schedule_action_slot,
)
from ...battery_state import BatteryForecastSettings, BatteryLiveState
from ...scheduling.schedule import (
    EMPTY_SCHEDULE_ACTION,
    ScheduleAction,
    build_horizon_end,
    format_slot_id,
    parse_slot_id,
)
from ..conditions.types import ConditionRailsUnavailable
from ..rails import (
    canonical_bucket_start,
    forecast_covers_horizon,
    parse_timestamp,
    read_optional_float,
)

if TYPE_CHECKING:
    from ..snapshot import OptimizationSnapshot

_INFINITE_SOC = float("inf")


@dataclass(frozen=True)
class Trajectory:
    """What a re-simulated horizon says about the battery."""

    #: The lowest projected SoC anywhere in the simulated horizon.
    min_soc_pct: float
    #: The bucket that low point falls in, as a slot id — so a rejection can
    #: name *where* the floor would break, not just that it would.
    min_soc_at: str | None


@dataclass(frozen=True)
class _Bucket:
    """One forecast bucket, as the simulator wants it."""

    #: The raw series timestamp. The first bucket of a run is stamped with the
    #: run instant rather than a bucket start, and covers only the remainder of
    #: the bucket in progress.
    start: datetime
    #: The floored bucket start — the only key an overlay or a demand slice can
    #: be looked up by.
    key: datetime
    duration_hours: float
    solar_kwh: float
    baseline_house_kwh: float
    action: ScheduleAction


class HorizonSimulator:
    """Replays the schedule horizon with extra appliance demand folded in.

    Construct once per optimizer run (see :func:`build_horizon_simulator`), then
    call :meth:`simulate` per candidate placement set.
    """

    def __init__(
        self,
        *,
        buckets: tuple[_Bucket, ...],
        live_state: BatteryLiveState,
        settings: BatteryForecastSettings,
    ) -> None:
        self._buckets = buckets
        self._live_state = live_state
        self._settings = settings
        self._index_by_key = {bucket.key: index for index, bucket in enumerate(buckets)}
        self._energy_before, self._prefix_min = self._simulate_baseline()

    @property
    def baseline(self) -> Trajectory:
        """The no-appliance trajectory, simulated once at construction.

        What ``soc_floor_already_breached`` is decided from. It must not be
        derived by re-testing "the accepted set minus the candidate": for the
        first candidate that set is empty, the test passes trivially, and the
        first candidate is blamed for a dip it had nothing to do with.
        """
        return self._prefix_min[len(self._buckets)]

    def simulate(self, extra_demand_by_bucket: dict[datetime, float]) -> Trajectory:
        """The trajectory with ``extra_demand_by_bucket`` added to the house.

        Resumes from the earliest bucket the extra demand touches rather than
        from ``now``: everything before it is by definition the baseline, whose
        trajectory and running minimum are already known.
        """
        start = self._first_touched_index(extra_demand_by_bucket)
        if start is None:
            return self.baseline

        prefix = self._prefix_min[start]
        min_soc_pct = prefix.min_soc_pct
        min_soc_at = prefix.min_soc_at
        remaining_energy_kwh = self._energy_before[start]

        for bucket in self._buckets[start:]:
            result = simulate_schedule_action_slot(
                slot_start=bucket.start,
                duration_hours=bucket.duration_hours,
                solar_kwh=bucket.solar_kwh,
                baseline_house_kwh=(
                    bucket.baseline_house_kwh
                    + extra_demand_by_bucket.get(bucket.key, 0.0)
                ),
                remaining_energy_kwh=remaining_energy_kwh,
                live_state=self._live_state,
                settings=self._settings,
                action=bucket.action,
            )
            remaining_energy_kwh = result.remaining_energy_kwh
            soc_pct = result.slot["socPct"]
            if soc_pct < min_soc_pct:
                min_soc_pct = soc_pct
                min_soc_at = format_slot_id(bucket.key)

        return Trajectory(min_soc_pct=min_soc_pct, min_soc_at=min_soc_at)

    def _first_touched_index(
        self, extra_demand_by_bucket: dict[datetime, float]
    ) -> int | None:
        indices = [
            index
            for key in extra_demand_by_bucket
            if (index := self._index_by_key.get(key)) is not None
        ]
        return min(indices) if indices else None

    def _simulate_baseline(self) -> tuple[list[float], list[Trajectory]]:
        """Energy entering each bucket, and the running minimum SoC before it.

        ``energy_before[i]`` and ``prefix_min[i]`` describe the state *entering*
        bucket ``i``, so both lists carry one more entry than there are buckets;
        the last describes the end of the horizon.
        """
        energy_before = [self._live_state.current_remaining_energy_kwh]
        prefix_min = [Trajectory(min_soc_pct=_INFINITE_SOC, min_soc_at=None)]

        remaining_energy_kwh = self._live_state.current_remaining_energy_kwh
        min_soc_pct = _INFINITE_SOC
        min_soc_at: str | None = None
        for bucket in self._buckets:
            result = simulate_schedule_action_slot(
                slot_start=bucket.start,
                duration_hours=bucket.duration_hours,
                solar_kwh=bucket.solar_kwh,
                baseline_house_kwh=bucket.baseline_house_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                live_state=self._live_state,
                settings=self._settings,
                action=bucket.action,
            )
            remaining_energy_kwh = result.remaining_energy_kwh
            soc_pct = result.slot["socPct"]
            if soc_pct < min_soc_pct:
                min_soc_pct = soc_pct
                min_soc_at = format_slot_id(bucket.key)
            energy_before.append(remaining_energy_kwh)
            prefix_min.append(
                Trajectory(min_soc_pct=min_soc_pct, min_soc_at=min_soc_at)
            )
        return energy_before, prefix_min


def build_horizon_simulator(
    snapshot: "OptimizationSnapshot",
    *,
    appliance_id: str,
) -> HorizonSimulator:
    """Assemble the simulator from the snapshot, or refuse to answer.

    Every failure here raises: the condition gates placement, so "I could not
    simulate" must collapse the optimizer's column rather than read as "every
    slot breaks the floor".
    """
    context = snapshot.context
    live_state = context.battery_state
    if live_state is None:
        raise ConditionRailsUnavailable(
            appliance_id, "the live battery state is unavailable"
        )
    settings = _read_settings(snapshot)
    if settings is None:
        raise ConditionRailsUnavailable(
            appliance_id, "the battery charge/discharge parameters are unavailable"
        )

    horizon_end = build_horizon_end(context.now)
    if not forecast_covers_horizon(
        snapshot.battery_forecast, required_coverage_until=horizon_end
    ):
        raise ConditionRailsUnavailable(
            appliance_id, "the battery forecast does not cover the horizon"
        )

    action_by_key = _index_overlay(snapshot)
    buckets = _read_buckets(
        snapshot,
        appliance_id=appliance_id,
        horizon_end=horizon_end,
        action_by_key=action_by_key,
    )
    if not buckets:
        raise ConditionRailsUnavailable(
            appliance_id, "the battery forecast carries no usable series"
        )
    return HorizonSimulator(
        buckets=buckets, live_state=live_state, settings=settings
    )


def _read_buckets(
    snapshot: "OptimizationSnapshot",
    *,
    appliance_id: str,
    horizon_end: datetime,
    action_by_key: dict[datetime, ScheduleAction],
) -> tuple[_Bucket, ...]:
    raw_series = snapshot.battery_forecast.get("series")
    if not isinstance(raw_series, list):
        return ()

    buckets: list[_Bucket] = []
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        timestamp = parse_timestamp(point.get("timestamp"))
        if timestamp is None:
            continue
        key = canonical_bucket_start(timestamp)
        # Clipped to the 48 h schedule horizon. The series itself runs to
        # MAX_FORECAST_DAYS, and nothing can be placed past the horizon anyway.
        if key >= horizon_end:
            break
        solar_kwh = read_optional_float(point.get("solarKwh"))
        baseline_house_kwh = read_optional_float(point.get("baselineHouseKwh"))
        duration_hours = read_optional_float(point.get("durationHours"))
        if solar_kwh is None or baseline_house_kwh is None or not duration_hours:
            raise ConditionRailsUnavailable(
                appliance_id,
                "the battery forecast series is missing simulation inputs",
            )
        action = action_by_key.get(key, EMPTY_SCHEDULE_ACTION)
        if not is_supported_schedule_action(action.kind):
            # The forecast gave up on this action and fell back to its baseline
            # from here on, so its trajectory is not one this simulator can
            # reproduce. Refusing beats answering from a different model.
            raise ConditionRailsUnavailable(
                appliance_id,
                f"the schedule carries an action the simulator cannot model: "
                f"{action.kind}",
            )
        buckets.append(
            _Bucket(
                start=timestamp,
                key=key,
                duration_hours=duration_hours,
                solar_kwh=solar_kwh,
                baseline_house_kwh=baseline_house_kwh,
                action=action,
            )
        )
    return tuple(buckets)


def _index_overlay(
    snapshot: "OptimizationSnapshot",
) -> dict[datetime, ScheduleAction]:
    """The overlay's actions keyed by bucket start.

    ``lookup_slot`` is a linear scan, which would make the re-simulation
    O(buckets x slots) per candidate. Indexing it once is the whole fix.
    """
    overlay = snapshot.schedule_overlay
    if overlay is None:
        return {}
    return {
        parse_slot_id(slot.id): slot.action
        for slot in overlay.slots
        if parse_slot_id(slot.id) < overlay.horizon_end
    }


def _read_settings(
    snapshot: "OptimizationSnapshot",
) -> BatteryForecastSettings | None:
    context = snapshot.context
    if (
        context.battery_max_charge_power_kw is None
        or context.battery_max_discharge_power_kw is None
        or context.battery_charge_efficiency is None
        or context.battery_discharge_efficiency is None
    ):
        return None
    return BatteryForecastSettings(
        charge_efficiency=context.battery_charge_efficiency,
        discharge_efficiency=context.battery_discharge_efficiency,
        max_charge_power_w=context.battery_max_charge_power_kw * 1000,
        max_discharge_power_w=context.battery_max_discharge_power_kw * 1000,
    )
