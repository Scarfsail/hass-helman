"""The pure half of the appliance/battery forecast pipeline.

Every function here takes what it reads as a parameter -- the active config,
the pinned appliance registry, the live values gathered on the event loop into
``ComputeInputs`` -- and touches neither ``hass`` nor the recorder, so the
rebuild and the automation snapshot can run in an executor. The coordinator
gathers the inputs and owns the cache.
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from ..appliances.forecast_integration import build_adjusted_house_forecast
from ..appliances.projection_builder import (
    ApplianceProjectionPlan,
    build_appliance_projection_plan,
    build_projection_input_bundle,
)
from ..appliances.state import AppliancesRuntimeRegistry
from ..automation.compute_inputs import ComputeInputs
from ..automation.config import AutomationConfig
from ..automation.day_context import DayContext
from ..automation.input_bundle import AutomationInputBundle
from ..automation.snapshot import OptimizationContext, OptimizationSnapshot
from ..battery_capacity_forecast_builder import BatteryCapacityForecastBuilder
from ..battery_state import read_battery_forecast_settings
from ..const import (
    MAX_FORECAST_DAYS,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
)
from ..controllables.spec import spec_for
from ..grid_flow_forecast_builder import build_grid_flow_forecast_snapshot
from ..scheduling.action_resolution import resolve_executed_schedule_action
from ..scheduling.forecast_overlay import (
    ScheduleForecastOverlay,
    build_schedule_forecast_overlay,
)
from ..scheduling.schedule import (
    ScheduleControlConfig,
    ScheduleDocument,
    appliance_actions,
    build_horizon_start,
    format_slot_id,
    inverter_action,
    strip_candidate_actions,
)

#: The inverter action of every slot. Built from the forecast schedule document,
#: which is already empty when execution is off, so an execution toggle moves
#: this signature without it having to carry the flag itself.
BatteryScheduleSignature = tuple[tuple[str, str, int | None], ...]
#: Every slot's appliance actions, as sorted items.
ApplianceScheduleSignature = tuple[
    tuple[str, tuple[tuple[str, tuple[tuple[str, object], ...]], ...]],
    ...,
]
#: The active slot's target action and what it resolves to against the live
#: battery; None when the active slot holds no target action.
EffectiveScheduleSignature = tuple[str, str, int | None, str, str] | None
#: The solar status and its normalised points.
SolarSignature = tuple[Any, ...]


@dataclass(frozen=True)
class ForecastScheduleDocuments:
    forecast_schedule_document: ScheduleDocument
    projection_schedule_document: ScheduleDocument


@dataclass(frozen=True)
class ForecastRebuildSnapshot:
    adjusted_house_forecast: dict[str, Any]
    battery_forecast: dict[str, Any]
    projection_plan: ApplianceProjectionPlan
    grid_forecast: dict[str, Any] | None = None
    #: The overlay ``battery_forecast`` was simulated from, kept so the
    #: optimization snapshot can carry it. Re-deriving it downstream is not
    #: possible: the snapshot's schedule document is the unstripped original.
    schedule_overlay: ScheduleForecastOverlay | None = None


def build_battery_forecast_schedule_signature(
    schedule_document: ScheduleDocument,
) -> BatteryScheduleSignature:
    return tuple(
        (
            slot_id,
            inverter_action(actions).kind,
            inverter_action(actions).target_soc,
        )
        for slot_id, actions in sorted(schedule_document.slots.items())
    )


def build_appliance_projection_schedule_signature(
    schedule_document: ScheduleDocument,
) -> ApplianceScheduleSignature:
    return tuple(
        (
            slot_id,
            tuple(
                (
                    appliance_id,
                    tuple(sorted(action.items())),
                )
                for appliance_id, action in sorted(
                    appliance_actions(actions).items()
                )
            ),
        )
        for slot_id, actions in sorted(schedule_document.slots.items())
    )


def build_battery_forecast_schedule_document(
    schedule_document: ScheduleDocument,
    control_config: ScheduleControlConfig | None,
) -> ScheduleDocument:
    if control_config is None:
        return schedule_document

    forecast_slots = {
        slot_id: actions
        for slot_id, actions in schedule_document.slots.items()
        if not (
            inverter_action(actions).kind == SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC
            and SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC not in control_config.options
        )
        and not (
            inverter_action(actions).kind == SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC
            and SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC not in control_config.options
        )
    }
    return ScheduleDocument(
        execution_enabled=schedule_document.execution_enabled,
        slots=forecast_slots,
    )


def build_forecast_schedule_documents(
    schedule_document: ScheduleDocument,
    control_config: ScheduleControlConfig | None,
) -> ForecastScheduleDocuments:
    # The single place ``execution_enabled`` gates the forecast, for both
    # domains at once.
    #
    # With execution off Helman actuates nothing — the executor returns
    # before it touches either the inverter or an appliance -- so the
    # forecast projects the unmanaged house: no scheduled inverter action,
    # and no scheduled appliance run either. The card's schedule strips go
    # on showing the plan; the curves show what will happen while it is not
    # being executed, and the two are read as plan against reality.
    #
    # Gating both documents here rather than deeper down is what keeps that
    # honest. Emptying only the inverter side — which is what the overlay
    # builder used to do on its own -- left the battery unmanaged while the
    # house forecast still carried appliance runs that could not happen, a
    # trajectory that was neither the plan nor the reality. It also keeps
    # both forecast cache signatures correct for free: they are derived from
    # these documents, so an execution toggle changes them without either
    # signature having to know the flag exists.
    if not schedule_document.execution_enabled:
        unmanaged = ScheduleDocument(execution_enabled=False, slots={})
        return ForecastScheduleDocuments(
            forecast_schedule_document=unmanaged,
            projection_schedule_document=unmanaged,
        )
    return ForecastScheduleDocuments(
        forecast_schedule_document=build_battery_forecast_schedule_document(
            schedule_document, control_config
        ),
        projection_schedule_document=schedule_document,
    )


def build_battery_forecast_schedule_effective_signature(
    schedule_document: ScheduleDocument,
    *,
    reference_time: datetime,
    battery_entity_config: Any,
    live_state: Any,
) -> EffectiveScheduleSignature:
    active_slot_id = format_slot_id(build_horizon_start(reference_time))
    active_actions = schedule_document.slots.get(active_slot_id)
    active_action = (
        None if active_actions is None else inverter_action(active_actions)
    )
    if active_action is None or active_action.kind not in {
        SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
        SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    }:
        return None

    if battery_entity_config is None:
        return (
            active_slot_id,
            active_action.kind,
            active_action.target_soc,
            "not_configured",
            "not_configured",
        )

    if live_state is None:
        return (
            active_slot_id,
            active_action.kind,
            active_action.target_soc,
            "unavailable",
            "execution_unavailable",
        )

    resolution = resolve_executed_schedule_action(
        action=active_action,
        current_soc=live_state.current_soc,
    )
    return (
        active_slot_id,
        active_action.kind,
        active_action.target_soc,
        resolution.executed_action.kind,
        resolution.reason,
    )


def build_battery_forecast_solar_signature(
    solar_forecast: dict[str, Any],
) -> SolarSignature:
    points = solar_forecast.get("adjustedPoints")
    if not isinstance(points, list):
        points = solar_forecast.get("correctedPoints")
    if not isinstance(points, list):
        points = solar_forecast.get("points")
    if not isinstance(points, list):
        points = []

    normalized_points: list[tuple[str, float]] = []
    for point in points:
        if not isinstance(point, dict):
            continue

        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str):
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        normalized_points.append((timestamp, round(float(value), 4)))

    return (
        solar_forecast.get("status"),
        tuple(normalized_points),
    )


def build_forecast_rebuild(
    *,
    config: Mapping[str, Any],
    appliances_registry: AppliancesRuntimeRegistry,
    solar_forecast: dict[str, Any],
    original_house_forecast: dict[str, Any],
    started_at: datetime,
    forecast_schedule_document: ScheduleDocument,
    projection_schedule_document: ScheduleDocument,
    when_active_hourly_energy_kwh_by_appliance_id: dict[str, float | None] | None,
    compute_inputs: ComputeInputs,
    grid_price_forecast: dict[str, Any] | None = None,
) -> ForecastRebuildSnapshot:
    """The appliance projection plus the whole battery/grid simulation.

    Every live value comes from ``compute_inputs``, so it is safe to run in an
    executor.
    """
    input_bundle = build_projection_input_bundle(
        solar_forecast=solar_forecast,
        house_forecast=original_house_forecast,
        reference_time=started_at,
    )
    projection_plan = build_appliance_projection_plan(
        generated_at=started_at.isoformat(),
        registry=appliances_registry,
        schedule_document=projection_schedule_document,
        inputs=input_bundle,
        hass=None,
        reference_time=started_at,
        when_active_hourly_energy_kwh_by_appliance_id=(
            when_active_hourly_energy_kwh_by_appliance_id
        ),
        vehicle_remaining_capacity_kwh_by_vehicle_id=(
            compute_inputs.vehicle_remaining_capacity_kwh_by_vehicle_id
        ),
    )
    adjusted_house_forecast = build_adjusted_house_forecast(
        house_forecast=original_house_forecast,
        demand_points=projection_plan.demand_points,
    )
    schedule_overlay = build_schedule_forecast_overlay(
        schedule_document=forecast_schedule_document,
        reference_time=started_at,
    )
    battery_forecast = BatteryCapacityForecastBuilder(config).build_with_history(
        solar_forecast=solar_forecast,
        house_forecast=adjusted_house_forecast,
        started_at=started_at,
        forecast_days=MAX_FORECAST_DAYS,
        schedule_overlay=schedule_overlay,
        live_state=compute_inputs.battery_live_state,
        actual_history=compute_inputs.battery_actual_history,
    )
    grid_forecast = (
        None
        if grid_price_forecast is None
        else build_grid_flow_forecast_snapshot(battery_forecast)
    )
    return ForecastRebuildSnapshot(
        adjusted_house_forecast=adjusted_house_forecast,
        battery_forecast=battery_forecast,
        projection_plan=projection_plan,
        grid_forecast=grid_forecast,
        schedule_overlay=schedule_overlay,
    )


def build_automation_snapshot(
    *,
    config: Mapping[str, Any],
    control_config: ScheduleControlConfig | None,
    appliances_registry: AppliancesRuntimeRegistry,
    schedule_document: ScheduleDocument,
    input_bundle: AutomationInputBundle,
    reference_time: datetime,
    compute_inputs: ComputeInputs,
    day_contexts: dict[date, DayContext] | None = None,
) -> OptimizationSnapshot:
    """The optimization snapshot for one schedule document.

    Every live value comes from ``compute_inputs``, so it is safe to run in an
    executor.
    """
    # Resource accounting sees only committed actions: candidate actions
    # (placed by optimizers whose execution condition is not met) are
    # stripped here so their demand/battery draw frees up for downstream
    # optimizers. They remain in ``snapshot.schedule`` for display and
    # execution/promotion.
    schedule_documents = build_forecast_schedule_documents(
        strip_candidate_actions(schedule_document), control_config
    )
    # #272 (P2 of #270): the phased run rebuilds the snapshot from
    # ``working_schedule_document`` alone after every step — there is no
    # more pending-lane restoration concept, so the projection always
    # comes from this same document's own schedule documents.
    rebuild = build_forecast_rebuild(
        config=config,
        appliances_registry=appliances_registry,
        solar_forecast=input_bundle.solar_forecast,
        original_house_forecast=input_bundle.original_house_forecast,
        started_at=reference_time,
        forecast_schedule_document=schedule_documents.forecast_schedule_document,
        projection_schedule_document=schedule_documents.projection_schedule_document,
        when_active_hourly_energy_kwh_by_appliance_id=(
            input_bundle.when_active_hourly_energy_kwh_by_appliance_id
        ),
        grid_price_forecast=input_bundle.grid_price_forecast,
        compute_inputs=compute_inputs,
    )
    if rebuild.grid_forecast is None:
        raise RuntimeError("Automation snapshot rebuild is missing grid forecast")
    battery_status = rebuild.battery_forecast.get("status")
    if battery_status not in {"available", "partial"}:
        # Do not let optimizers skip unusable battery rails and persist an
        # incomplete plan. The runner reports this as a snapshot failure.
        house_anchor = rebuild.adjusted_house_forecast.get("currentSlot")
        house_anchor_timestamp = (
            house_anchor.get("timestamp")
            if isinstance(house_anchor, dict)
            else None
        )
        raise RuntimeError(
            "Automation snapshot rebuild has unusable battery forecast: "
            f"status={battery_status!r}, house_anchor={house_anchor_timestamp!r}"
        )

    return OptimizationSnapshot(
        schedule=deepcopy(schedule_document),
        adjusted_house_forecast=deepcopy(rebuild.adjusted_house_forecast),
        battery_forecast=deepcopy(rebuild.battery_forecast),
        grid_forecast=deepcopy(rebuild.grid_forecast),
        # Not deepcopied: a frozen dataclass of frozen slots, and the
        # optimizers only read it.
        schedule_overlay=rebuild.schedule_overlay,
        # The run's inputs by reference: the optimizers only read them.
        context=OptimizationContext(
            now=reference_time,
            inputs=input_bundle,
            live=compute_inputs,
            battery=read_battery_forecast_settings(config),
            appliance_registry=appliances_registry,
            day_contexts=dict(day_contexts) if day_contexts else {},
        ),
    )


def resolve_runtime_history_requirements(
    automation_config: AutomationConfig,
) -> dict[str, int] | None:
    """Return ``{appliance id: lookback days}`` for appliance_runtime rules.

    The keys are the appliances referenced by an enabled
    ``appliance_runtime`` optimizer — the only appliances whose recorder
    history needs resolving. The value is that appliance's own requirement:
    the largest ``max_consecutive_skips`` among the optimizers targeting it,
    plus one day, which is what ``_prior_consecutive_skips`` can walk back
    over before the answer stops mattering. Returns ``None`` when no such
    optimizer references a valid appliance.

    **The appliance lives on ``target``, not on ``params``.** It is identity,
    which a condition group may never override, and every other reader takes
    it from there (``config.controllable_ids``, ``base.py``,
    ``conditions/types.py``). Reading ``params`` found nothing, so this
    returned ``None``, the runtime map came back empty, and every appliance's
    ``delivered_hours`` was 0 for every day — a daily minimum that never
    counted what had already run, and a consecutive-skip guard walking back
    over days that all looked idle.
    """
    if not automation_config.enabled:
        return None
    lookback_days_by_appliance_id: dict[str, int] = {}
    for optimizer in automation_config.enabled_appliance_optimizers:
        max_consecutive_skips = 0
        # ``params.daily_minimum.max_consecutive_skips``, which is where the
        # consumer reads it (``optimizers/appliance_runtime.py``). The old
        # ``params.skip`` mapping is in ``RELOCATED_OPTIMIZER_KEYS`` and the
        # loader migrates it away, so reading it found nothing and every
        # appliance silently fell back to a one-day lookback -- the same
        # class of miss as ``appliance_id`` below.
        daily_minimum = optimizer.params.get("daily_minimum")
        if isinstance(daily_minimum, Mapping):
            raw = daily_minimum.get("max_consecutive_skips")
            if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 0:
                max_consecutive_skips = raw
        # Every member of a group runs its own daily-minimum chain against
        # the optimizer's shared ``max_consecutive_skips``.
        for appliance_id in optimizer.controllable_ids:
            if not appliance_id:
                continue
            lookback_days_by_appliance_id[appliance_id] = max(
                lookback_days_by_appliance_id.get(appliance_id, 0),
                max_consecutive_skips + 1,
            )
    if not lookback_days_by_appliance_id:
        return None
    return lookback_days_by_appliance_id


def is_projected_history_action_active(
    *,
    appliance,
    action: Mapping[str, Any] | None,
) -> bool:
    if appliance is None or action is None:
        return False
    spec = spec_for(appliance.kind)
    projection = spec.projection(appliance)
    return (
        projection is not None
        and projection.uses_history_average
        and spec.is_running(action)
    )
