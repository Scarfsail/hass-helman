"""``battery_hold_while_ev_charging`` optimizer.

Stop the house battery discharging while a chosen EV charger charges, so a
night charge draws from the grid rather than draining the battery into the car.

Future slots follow the plan: a selected charger has an executable action in
the slot (whoever authored it). The current slot follows only what is
physically happening — the charger's measured draw and live solar power, both
from :attr:`..snapshot.OptimizationContext.ev_hold_live` with the sensor grace
period already applied. The schedule is never consulted for the current slot:
scheduled but not drawing is no hold, drawing but not scheduled is a hold.

The optional ``when_solar_below_w`` condition limits the hold to low-solar
slots; its mask reads the forecast for future slots and live solar for the
current one, so the group :class:`..conditions.Eligibility` resolves for the
current slot is the group :func:`current_slot_group` picks.

It is an ordinary system optimizer: list order alone decides a slot it shares
with another inverter optimizer, the lower one winning.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ...const import SCHEDULE_ACTION_STOP_DISCHARGING
from ...scheduling.schedule import (
    ScheduleAction,
    ScheduleDocument,
    build_horizon_start,
    format_slot_id,
)
from ..base import ScheduleWriter
from ..conditions.evaluation import custom_met_by_group
from ..conditions.types import solar_passes
from ..explain import STATE_FALSE, STATE_TRUE
from ..rails import read_planned_appliance_slot_ids
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ..compute_inputs import EvHoldLiveState
    from ..config import OptimizerInstanceConfig
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

KIND = "battery_hold_while_ev_charging"

#: Whether a selected charger charges in the slot: planned for a future slot,
#: measured for the current one.
GATE_EV_CHARGING = "ev_charging"


@dataclass(frozen=True)
class CurrentSlotHoldBasis:
    """What the current slot's hold depends on besides live state.

    Fixed for one plan: the selected chargers, and per condition group in
    config order its ``when_solar_below_w`` threshold and ``custom`` result.
    The coordinator records it with each successful run, so a live change can
    be re-decided without rebuilding the plan.
    """

    charger_ids: tuple[str, ...]
    #: ``(threshold_w | None, custom_met)`` per condition group, in config order.
    groups: tuple[tuple[float | None, bool], ...]


def current_slot_basis(
    snapshot: "OptimizationSnapshot", config: "OptimizerInstanceConfig"
) -> CurrentSlotHoldBasis:
    """The basis this run's plan decides the current slot from."""
    return CurrentSlotHoldBasis(
        charger_ids=tuple(
            charger["controllable_id"] for charger in config.params["ev_chargers"]
        ),
        groups=tuple(
            zip(
                (
                    group.condition_values.get("when_solar_below_w")
                    for group in config.conditions
                ),
                custom_met_by_group(snapshot, config),
            )
        ),
    )


def current_slot_group(
    basis: CurrentSlotHoldBasis, live: "EvHoldLiveState"
) -> int | None:
    """The group index :class:`..conditions.Eligibility` resolves the current slot to.

    The first group whose solar check and ``custom`` result both pass, else the
    first whose solar check passes (a candidate), else ``None``.
    """
    passing = [
        index
        for index, (threshold_w, _custom_met) in enumerate(basis.groups)
        if solar_passes(threshold_w, live.solar_w)
    ]
    executable = next((index for index in passing if basis.groups[index][1]), None)
    if executable is not None:
        return executable
    return passing[0] if passing else None


def current_slot_hold(basis: CurrentSlotHoldBasis, live: "EvHoldLiveState") -> bool:
    """Whether the current slot carries an executable hold.

    ANY selected charger charging (live, grace included) and ANY group whose
    solar check and ``custom`` result both pass. The one interpretation of
    "hold now", shared by the optimizer and the watcher.
    """
    return any(
        live.charging_by_charger_id.get(charger_id, False)
        for charger_id in basis.charger_ids
    ) and any(
        custom_met and solar_passes(threshold_w, live.solar_w)
        for threshold_w, custom_met in basis.groups
    )


@dataclass(frozen=True)
class BatteryHoldWhileEvChargingOptimizer:
    id: str
    kind: str = KIND

    def optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        trace: "OptimizerTrace | None" = None,
    ) -> ScheduleDocument:
        trace = trace or NULL_TRACE
        writer = ScheduleWriter.open(snapshot, config, trace)
        basis = current_slot_basis(snapshot, config)
        live = snapshot.context.ev_hold_live
        current_slot_id = format_slot_id(build_horizon_start(snapshot.context.now))
        planned_slot_ids = frozenset().union(
            *(
                read_planned_appliance_slot_ids(snapshot, charger_id)
                for charger_id in basis.charger_ids
            )
        )
        charging_now = sorted(
            charger_id
            for charger_id in basis.charger_ids
            if live.charging_by_charger_id.get(charger_id, False)
        )
        stop_discharging = ScheduleAction(kind=SCHEDULE_ACTION_STOP_DISCHARGING)

        for resolved in writer.eligibility.iter_slots():
            slot_id = resolved.slot_id
            if slot_id == current_slot_id:
                continue
            charging = slot_id in planned_slot_ids
            trace.gate(
                role="veto",
                slot_ids=[slot_id],
                key=GATE_EV_CHARGING,
                state=STATE_TRUE if charging else STATE_FALSE,
                params={"source": "planned"},
            )
            if charging:
                writer.set(slot_id, stop_discharging)

        # The current slot is decided by the shared function the watcher
        # compares against, so the two cannot read "hold now" differently. Its
        # group is the one the eligibility walk resolves, by construction.
        if current_slot_group(basis, live) is not None:
            trace.gate(
                role="veto",
                slot_ids=[current_slot_id],
                key=GATE_EV_CHARGING,
                state=STATE_TRUE if charging_now else STATE_FALSE,
                params={
                    "source": "live",
                    "chargers": charging_now,
                    "inGrace": sorted(
                        live.in_grace_charger_ids.intersection(charging_now)
                    ),
                },
            )
            if charging_now:
                writer.set(current_slot_id, stop_discharging)
        return writer.flush()


def build_battery_hold_while_ev_charging_optimizer(
    config: "OptimizerInstanceConfig",
    **_kwargs: Any,
) -> BatteryHoldWhileEvChargingOptimizer:
    return BatteryHoldWhileEvChargingOptimizer(id=config.id)
