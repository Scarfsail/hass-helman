from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from ..appliances.state import AppliancesRuntimeRegistry
from ..scheduling.schedule import (
    ScheduleDocument,
)

if TYPE_CHECKING:
    from ..battery_state import BatteryForecastSettings, BatteryLiveState
    from .compute_inputs import ComputeInputs, CustomConditionGroupResult
    from .input_bundle import AutomationInputBundle
    from ..scheduling.forecast_overlay import ScheduleForecastOverlay
    from .day_context import DayContext


@dataclass(frozen=True)
class OptimizationContext:
    """What an optimizer reads besides the schedule and the forecasts.

    Holds the run's three input containers by reference -- the forecast bundle,
    the live values gathered on the loop and the battery settings -- and derives
    every flat field the optimizers read from them, so nothing is re-plumbed or
    copied field by field per snapshot rebuild. Read-only for optimizers.
    """

    now: datetime
    inputs: AutomationInputBundle
    live: ComputeInputs
    battery: BatteryForecastSettings
    appliance_registry: AppliancesRuntimeRegistry
    # A3/A4 — frozen per-calendar-day context, keyed by local date. Attached by
    # the runner once per optimizer. Read-only for optimizers.
    day_contexts: dict[date, "DayContext"] = field(default_factory=dict)

    @property
    def battery_state(self) -> BatteryLiveState | None:
        return self.live.battery_live_state

    @property
    def solar_forecast(self) -> dict[str, Any]:
        return self.inputs.solar_forecast

    @property
    def import_price_forecast(self) -> dict[str, Any]:
        return self.inputs.grid_price_forecast.get("import", {})

    @property
    def export_price_forecast(self) -> dict[str, Any]:
        return self.inputs.grid_price_forecast.get("export", {})

    @property
    def when_active_hourly_energy_kwh_by_appliance_id(self) -> dict[str, float]:
        return self.inputs.when_active_hourly_energy_kwh_by_appliance_id

    # A1 — battery parameters surfaced from the battery config/live state so
    # single-pass rules (charge_hold) can size charge energy without touching
    # the forecast builder. The discharge half serves an optimizer that
    # re-simulates the battery to see what its own placement costs.
    @property
    def battery_max_charge_power_kw(self) -> float | None:
        return _w_to_kw(self.battery.max_charge_power_w)

    @property
    def battery_max_discharge_power_kw(self) -> float | None:
        return _w_to_kw(self.battery.max_discharge_power_w)

    @property
    def battery_usable_capacity_kwh(self) -> float | None:
        state = self.battery_state
        return None if state is None else state.nominal_capacity_kwh

    @property
    def battery_charge_efficiency(self) -> float | None:
        return self.battery.charge_efficiency

    @property
    def battery_discharge_efficiency(self) -> float | None:
        return self.battery.discharge_efficiency

    @property
    def runtime_hours_by_appliance_id_by_local_date(
        self,
    ) -> dict[str, dict[date, float]]:
        """A2 — recorder-derived runtime hours per appliance per local day."""
        return self.inputs.runtime_hours_by_appliance_id_by_local_date

    @property
    def condition_met_by_optimizer_id(self) -> dict[str, tuple[bool, ...]]:
        """Per-optimizer, per-condition-group ``custom`` result, in config order.

        True == met. An optimizer id absent from the map means its conditions
        were not evaluated on this path and every group counts as met. Derived
        from :attr:`custom_condition_results_by_optimizer_id`, so the two can
        never disagree.
        """
        return self.live.condition_met_by_optimizer_id

    @property
    def custom_condition_results_by_optimizer_id(
        self,
    ) -> dict[str, tuple["CustomConditionGroupResult", ...]]:
        """The per-entry breakdown behind :attr:`condition_met_by_optimizer_id`.

        One ``CustomConditionGroupResult`` per condition group, each carrying
        one result per configured ``custom`` entry plus an ``errored`` flag.
        Empty on paths that did not evaluate conditions; a group with no custom
        conditions carries no entries.
        """
        return self.live.custom_condition_results_by_optimizer_id

    @property
    def appliance_active_by_id(self) -> dict[str, bool]:
        """A5 — which appliances are physically running right now.

        The one thing a stateless optimizer cannot derive from the schedule it
        is about to rewrite: the plan for the slot in progress is a commitment,
        not a free variable, so an optimizer that would otherwise re-rank an
        in-flight run out of its own plan can decline to.
        """
        return self.live.appliance_active_by_id


def _w_to_kw(value_w: float | None) -> float | None:
    return None if value_w is None else value_w / 1000


@dataclass(frozen=True)
class OptimizationSnapshot:
    schedule: ScheduleDocument
    adjusted_house_forecast: dict[str, Any]
    battery_forecast: dict[str, Any]
    grid_forecast: dict[str, Any]
    context: OptimizationContext
    #: The inverter overlay ``battery_forecast`` was actually simulated from.
    #:
    #: Carried rather than re-derived, because it is *not* reconstructible from
    #: ``schedule``. That field is the unstripped original document, while the
    #: forecast ran on one that had candidate actions blanked and target-SoC
    #: actions dropped where the inverter control config offers no matching
    #: option. An optimizer rebuilding an overlay from ``schedule`` would apply
    #: actions the forecast excluded and produce a trajectory that disagrees
    #: with every rail, the inspector and ``min_soc_pct`` — and the control
    #: config it would need is not reachable from an optimizer anyway.
    #:
    #: ``None`` on snapshots built without one. Note that the overlay is empty
    #: when execution is disabled — by design, not by accident: the forecast
    #: then projects the unmanaged house, so a re-simulation sees no inverter
    #: actions, matching the ``battery_forecast`` it has to agree with. The
    #: appliance projection is emptied by the same gate, so the two halves of
    #: that trajectory stay consistent. See
    #: ``forecast.assembly.build_forecast_schedule_documents``.
    #:
    #: Internal simulation input at canonical resolution.
    schedule_overlay: "ScheduleForecastOverlay | None" = None


def attach_day_contexts(
    snapshot: OptimizationSnapshot,
    day_contexts: dict[date, "DayContext"],
) -> OptimizationSnapshot:
    """Return a copy of ``snapshot`` with day contexts on its context."""
    return replace(
        snapshot,
        context=replace(snapshot.context, day_contexts=day_contexts),
    )
