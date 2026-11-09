"""Live charger and solar readings for ``battery_hold_while_ev_charging``.

The optimizer decides the current slot from what is physically happening, so
the plan goes stale the moment a charger starts or stops, or solar crosses a
threshold. Re-planning on every sensor update would rebuild the whole plan
every few seconds for nothing; this watcher re-plans only when the current
slot's *effective* hold decision flips.

It keeps, in memory only:

* per charger, whether its last reading was charging
  (:func:`..ev_sessions.ledger.charging_power`) and when it last stopped -- a
  falling edge is any change from charging to anything else, a reading at or
  below 1 kW, ``unavailable`` or not a number. After a falling edge the
  charger still counts as charging for ``sensor_grace_seconds`` from the
  edge's own timestamp, so a short dip or outage changes nothing;
* the last numeric solar power in W, kept for the grace period after the
  sensor becomes unavailable, and unknown after that.

On setup each entity is read once: a charger charging at startup counts as
charging, an unavailable sensor as not charging (or solar unknown), with no
grace. Grace does not survive a restart.

**Recording.** After each successful run the coordinator hands over the run's
snapshot, and the watcher stores per hold optimizer the plan's
:class:`~.optimizers.battery_hold_while_ev_charging.CurrentSlotHoldBasis` and
the decision computed from that run's frozen live inputs.

**Evaluation**, on each state event and each executor tick (which is what
catches a grace period running out): re-decide the current slot from the
recorded basis and the live state, and request the coalesced re-plan only
when that differs from both the recorded decision and the one last requested.
Events that change nothing, or that repeat a decision a pending re-plan
already carries, cost one pure-function call and a comparison.

**Completion check**, after every run, successful or not: forget what was
requested. After a successful run, evaluate again: a sensor change that landed
after the run read its inputs and before it published -- including one that
flipped straight back to the old recorded value -- is caught here. A failed
or skipped run is not re-requested from here, which would start the next run
at once and loop while it keeps failing; the next executor tick retries it.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event

from ..config_read import read_entity_id, read_mapping
from ..controllables.config import ev_charger_power_entity_ids
from ..ev_sessions.ledger import charging_power
from ..power_polarity import source_value_type
from ..power_reading import state_watts
from .compute_inputs import EvHoldLiveState
from .optimizers.battery_hold_while_ev_charging import (
    KIND,
    CurrentSlotHoldBasis,
    current_slot_basis,
    current_slot_hold,
)

if TYPE_CHECKING:
    from .config import AutomationConfig, OptimizerInstanceConfig
    from .snapshot import OptimizationSnapshot

REPLAN_REASON = "ev_hold_changed"


def solar_power_entity_id(config: Mapping[str, Any]) -> str | None:
    """The live solar power sensor the current slot's solar check reads, if any."""
    solar_config = read_mapping(read_mapping(config.get("energy_nodes")).get("solar"))
    return read_entity_id(read_mapping(solar_config.get("entities")).get("power"))


def _is_charging(state: Any) -> bool:
    """Charging strictly above 1 kW; a missing or non-numeric state is not."""
    return state is not None and charging_power(state) is True


@dataclass
class _ChargerState:
    entity_id: str
    grace: timedelta
    #: Whether the last reading was charging.
    charging: bool = False
    #: When it last stopped charging; ``None`` while charging or never seen to stop.
    stopped_at: datetime | None = None

    def is_charging(self, now: datetime) -> bool:
        return self.charging or self.in_grace(now)

    def in_grace(self, now: datetime) -> bool:
        return (
            not self.charging
            and self.stopped_at is not None
            and now < self.stopped_at + self.grace
        )


class EvHoldWatcher:
    """Owned by the coordinator; set up and unloaded with it."""

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        read_config: Callable[[], Mapping[str, Any]],
        read_automation_config: Callable[[], "AutomationConfig"],
        request_replan: Callable[..., Coroutine[Any, Any, None]],
    ) -> None:
        self._hass = hass
        self._read_config = read_config
        self._read_automation_config = read_automation_config
        self._request_replan = request_replan
        self._unsubs: list[Callable[[], None]] = []
        self._optimizers: tuple["OptimizerInstanceConfig", ...] = ()
        self._chargers: dict[str, _ChargerState] = {}
        self._solar_entity_id: str | None = None
        self._solar_value_type = "default"
        self._solar_grace = timedelta(0)
        self._solar_w: float | None = None
        self._solar_lost_at: datetime | None = None
        #: Per hold optimizer id: the recorded plan's basis and decision.
        self._recorded: dict[str, tuple[CurrentSlotHoldBasis, bool]] = {}
        #: Per hold optimizer id: the decision a re-plan was last requested for.
        self._last_requested: dict[str, bool] = {}

    async def async_setup(self) -> None:
        config = self._read_config()
        self._optimizers = tuple(
            optimizer
            for optimizer in self._read_automation_config().enabled_system_optimizers
            if optimizer.kind == KIND
        )
        if not self._optimizers:
            return
        power_entity_by_id = ev_charger_power_entity_ids(config)
        grace_by_charger: dict[str, timedelta] = {}
        for optimizer in self._optimizers:
            grace = timedelta(seconds=optimizer.params["sensor_grace_seconds"])
            for charger in optimizer.params["ev_chargers"]:
                charger_id = charger["controllable_id"]
                # A charger two hold optimizers share keeps the longer grace.
                grace_by_charger[charger_id] = max(
                    grace, grace_by_charger.get(charger_id, grace)
                )
            self._solar_grace = max(self._solar_grace, grace)
        self._chargers = {
            charger_id: _ChargerState(
                entity_id=power_entity_by_id[charger_id],
                grace=grace,
                charging=_is_charging(
                    self._hass.states.get(power_entity_by_id[charger_id])
                ),
            )
            for charger_id, grace in grace_by_charger.items()
            if charger_id in power_entity_by_id
        }
        solar_config = (config.get("energy_nodes") or {}).get("solar") or {}
        self._solar_entity_id = solar_power_entity_id(config)
        self._solar_value_type = source_value_type(solar_config, "solar")
        if self._solar_entity_id:
            self._solar_w = state_watts(
                self._hass.states.get(self._solar_entity_id), self._solar_value_type
            )
        entity_ids = [charger.entity_id for charger in self._chargers.values()]
        if self._solar_entity_id:
            entity_ids.append(self._solar_entity_id)
        if entity_ids:
            self._unsubs.append(
                async_track_state_change_event(
                    self._hass, entity_ids, self._on_state_changed
                )
            )

    def async_unload(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        self._optimizers = ()
        self._chargers.clear()
        self._solar_entity_id = None
        self._solar_w = None
        self._solar_lost_at = None
        self._recorded.clear()
        self._last_requested.clear()

    def snapshot(self, now: datetime) -> EvHoldLiveState:
        """The live state at ``now``, grace applied, frozen for one run."""
        solar_known = self._solar_lost_at is None or now < (
            self._solar_lost_at + self._solar_grace
        )
        return EvHoldLiveState(
            charging_by_charger_id={
                charger_id: charger.is_charging(now)
                for charger_id, charger in self._chargers.items()
            },
            solar_w=self._solar_w if solar_known else None,
            in_grace_charger_ids=frozenset(
                charger_id
                for charger_id, charger in self._chargers.items()
                if charger.in_grace(now)
            ),
        )

    def record_plan(self, snapshot: "OptimizationSnapshot") -> None:
        """Store what a successful run's plan decided for the current slot.

        Decided from the run's own frozen live inputs, not from the state at
        completion: a change since then is the completion check's to find.
        """
        live = snapshot.context.ev_hold_live
        self._recorded = {}
        for optimizer in self._optimizers:
            basis = current_slot_basis(snapshot, optimizer)
            self._recorded[optimizer.id] = (basis, current_slot_hold(basis, live))

    async def async_check_after_run(self, now: datetime, *, recorded: bool) -> None:
        """After every run: forget what was requested; after a recorded one, evaluate again."""
        self._last_requested.clear()
        if recorded:
            await self.async_evaluate(now)

    async def async_evaluate(self, now: datetime) -> None:
        if self._decision_changed(now):
            await self._request_replan(reason=REPLAN_REASON)

    def _decision_changed(self, now: datetime) -> bool:
        live = self.snapshot(now)
        changed = False
        for optimizer_id, (basis, recorded) in self._recorded.items():
            decision = current_slot_hold(basis, live)
            if decision != recorded and decision != self._last_requested.get(
                optimizer_id
            ):
                self._last_requested[optimizer_id] = decision
                changed = True
        return changed

    @callback
    def _on_state_changed(self, event: Any) -> None:
        entity_id = event.data["entity_id"]
        new_state = event.data.get("new_state")
        # A removed entity is not charging, and its solar reading is lost.
        now = new_state.last_updated if new_state is not None else event.time_fired
        if entity_id == self._solar_entity_id:
            self._on_solar(new_state, now)
        for charger in self._chargers.values():
            if charger.entity_id == entity_id:
                charging = _is_charging(new_state)
                if charger.charging and not charging:
                    charger.stopped_at = now
                elif charging:
                    charger.stopped_at = None
                charger.charging = charging
        if self._decision_changed(now):
            self._hass.async_create_task(self._request_replan(reason=REPLAN_REASON))

    def _on_solar(self, state: Any, now: datetime) -> None:
        solar_w = state_watts(state, self._solar_value_type)
        if solar_w is not None:
            self._solar_w = solar_w
            self._solar_lost_at = None
        elif self._solar_lost_at is None and self._solar_w is not None:
            self._solar_lost_at = now
