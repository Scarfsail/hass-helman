"""The charging ledger service: it follows each charger's charge power, recovers what the recorder retains, and keeps the segments.

Constructed by the coordinator, set up in its ``async_setup`` and torn down in
its ``async_unload``; it owns its listeners, its tasks and its store. Tracked
are the configured EV chargers whose hardware profile resolves a ``run_mode``
and whose config names a ``consumption.power_entity_id``, by consumer id; a
Custom charger has no run mode, and no ledger. The run mode only gates: the
segments follow the power.

**Reconciliation** is the one way anything is recorded, serialized by a lock
and idempotent: the power's recorded states are read from a little before
where the last read reached (or from the start of the segment still charging),
walked by :func:`~..node_details.ev_charger.charging_runs` with
:func:`~.ledger.charging_power` and folded into the stored segments by
:func:`~.ledger.merge_runs`. A power change that crosses charging, standby or
a gap, a periodic tick and the detail's own request each reconcile. A read
that fails raises: nothing is recorded from it and its cursor does not move.

**Backfill** reads the retained power history before the live reads began,
one local day at a time, newest first, down to the oldest day the recorder
holds; a failed day is read again on the next tick. A segment crossing a day
boundary is one segment: the newer day's part is matched by overlap.

**Energy** is the charger's cumulative meter at the segment's bounds and the
hour boundaries inside it, through the one boundary sampler
(:func:`~..recorder_slot_energy.energy_changes_at_boundaries`), with its
opening sample, staleness and a rebound lookahead after the end; segments
close together are read and unwrapped as one series. It is provisional until
the end is past the rebound and recorder settle windows, then never read
again, so recorder purge cannot touch it. A segment recorded under another
meter is never read with this one: a rebound telemetry bridges nothing.

**Attribution** asks the coordinator's cached device dataset for the slice's
local day and keeps the answer per slice; a day's answer is kept for good once
the day is complete, and a failed read never replaces a known one.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Coroutine, Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.start import async_at_started
from homeassistant.util import dt as dt_util

from ..controllables.config import iter_devices, own_meter, peek_controllable_id, peek_controllable_kind
from ..controllables.spec import CONTROLLABLE_KIND_EV_CHARGER
from ..device_reports.dataset import DeviceDataset
from ..energy_unwrap import _TRANSIENT_REBOUND_WINDOW
from ..node_details.day_stats import SEGMENT_MAX_GAP, with_live_state
from ..node_details.ev_charger import ChargingPredicate, _device_entity, charging_runs
from ..recorder_slot_energy import (
    _BOUNDARY_WRITE_SETTLE_WINDOW,
    _carry_staleness_limit,
    energy_changes_at_boundaries,
)
from ..recorder_states import read_states
from ..vendors import resolve_vendor_telemetry
from .ledger import (
    Segment,
    attribute_slice,
    charging_power,
    close_unseen,
    measured_slices,
    merge_runs,
    slice_boundaries,
)
from .store import ChargerLedger, EvSessionStore
from .summary import WINDOW, recent_segments, window_summary

_LOGGER = logging.getLogger(__name__)

RECONCILE_INTERVAL = timedelta(minutes=15)
#: How far before the last read's end the next one starts: a gap the walk
#: bridges, and states the recorder committed late, are read again.
_READ_MARGIN = SEGMENT_MAX_GAP + timedelta(minutes=5)
#: How long after a segment ended its energy can still move.
_ENERGY_SETTLE = _TRANSIENT_REBOUND_WINDOW + _BOUNDARY_WRITE_SETTLE_WINDOW
#: The meter's opening sample is read from this far before a segment, and a
#: carried reading older than this is not trusted.
_METER_LOOKBACK = _carry_staleness_limit(60)


@dataclass(frozen=True)
class TrackedCharger:
    consumer_id: str
    #: The charge power the segments follow.
    power_entity_id: str
    #: The cumulative consumption meter; ``None`` without one (no energy).
    meter_entity_id: str | None


def tracked_chargers(config: Mapping[str, Any], telemetry: Mapping[str, Any]) -> dict[str, TrackedCharger]:
    """The configured EV chargers whose profile resolves a run mode and that name their power entity, by consumer id."""
    chargers = {}
    for device, _parent in iter_devices(config):
        if peek_controllable_kind(device) != CONTROLLABLE_KIND_EV_CHARGER:
            continue
        consumer_id = peek_controllable_id(device)
        device_telemetry = telemetry.get(consumer_id) if consumer_id else None
        run_mode = device_telemetry.entities.get("run_mode") if device_telemetry else None
        power = _device_entity(device, "consumption.power_entity_id")
        if consumer_id and run_mode and power:
            chargers[consumer_id] = TrackedCharger(
                consumer_id=consumer_id,
                power_entity_id=power,
                meter_entity_id=own_meter(device),
            )
    return chargers


class EvSessionService:
    def __init__(
        self,
        hass: HomeAssistant,
        *,
        read_config: Callable[[], Mapping[str, Any]],
        day_dataset: Callable[[date], Awaitable[DeviceDataset | None]],
    ) -> None:
        self._hass = hass
        self._read_config = read_config
        self._day_dataset = day_dataset
        self.store = EvSessionStore(hass)
        self._lock = asyncio.Lock()
        self.chargers: dict[str, TrackedCharger] = {}
        self._unsubs: list[Callable[[], None]] = []
        self._tasks: set[asyncio.Task[Any]] = set()
        self._unloaded = False
        #: A power change's reconciliation is running; another change asks for one more after it.
        self._change_running = False
        self._change_again = False
        #: Why the last reconciliation or backfill of a charger fell short, by consumer id.
        self._errors: dict[str, str] = {}

    async def async_setup(self) -> None:
        await self.store.async_load()
        config = self._read_config()
        self.chargers = tracked_chargers(config, resolve_vendor_telemetry(self._hass, config))
        if not self.chargers:
            return
        self._unsubs.append(
            async_track_state_change_event(
                self._hass,
                [charger.power_entity_id for charger in self.chargers.values()],
                self._on_power_changed,
            )
        )
        self._unsubs.append(async_track_time_interval(self._hass, self._on_tick, RECONCILE_INTERVAL))
        self._unsubs.append(async_at_started(self._hass, self._on_started))

    async def async_unload(self) -> None:
        self._unloaded = True
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.store.async_flush()

    @callback
    def _on_power_changed(self, event: Any) -> None:
        old, new = event.data.get("old_state"), event.data.get("new_state")
        if old is not None and new is not None and charging_power(old) == charging_power(new):
            return  # still charging, still standing by, or still a gap: nothing to fold
        if self._change_running:
            self._change_again = True
            return
        self._change_running = True
        self._spawn(self._async_reconcile_changes(), "reconcile")

    async def _async_reconcile_changes(self) -> None:
        """Reconcile, once more if the power changed meanwhile."""
        try:
            while True:
                self._change_again = False
                await self._async_reconcile_all()
                if not self._change_again:
                    return
        finally:
            self._change_running = False

    @callback
    def _on_tick(self, _now: datetime) -> None:
        self._spawn(self._async_run(), "tick")

    @callback
    def _on_started(self, _hass: HomeAssistant) -> None:
        self._spawn(self._async_run(), "started")

    def _spawn(self, coro: Coroutine[Any, Any, Any], name: str) -> None:
        if self._unloaded:
            coro.close()
            return
        task = self._hass.async_create_background_task(coro, f"helman charging ledger {name}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _async_run(self) -> None:
        await self._async_reconcile_all()
        for consumer_id in list(self.chargers):
            await self.async_backfill(consumer_id)

    async def _async_reconcile_all(self) -> None:
        for consumer_id in list(self.chargers):
            try:
                await self.async_reconcile(consumer_id, dt_util.utcnow())
            except Exception:
                _LOGGER.exception("Charging ledger: reconciling %s failed", consumer_id)

    # --- Reconciliation -------------------------------------------------------

    async def async_reconcile(self, consumer_id: str, now: datetime) -> None:
        """Fold the power's states up to ``now`` into the ledger; raises when a read fails."""
        charger = self.chargers[consumer_id]
        async with self._lock:
            ledger = self.store.ledger(consumer_id)
            try:
                await self._reconcile(charger, ledger, dt_util.as_utc(now))
            except Exception:
                self._errors[consumer_id] = "read_failed"
                raise
            finally:
                if not self._unloaded:
                    self.store.schedule_save()

    async def _reconcile(self, charger: TrackedCharger, ledger: ChargerLedger, now: datetime) -> None:
        if ledger.live_since is None:
            ledger.live_since = ledger.backfill_before = dt_util.as_utc(
                dt_util.start_of_local_day(dt_util.as_local(now))
            )
        entity_id = charger.power_entity_id
        active_starts = [
            segment.start
            for segment in ledger.segments
            if segment.active and segment.power_entity_id == entity_id
        ]
        read_start = min([ledger.cursor or ledger.live_since, *active_starts]) - _READ_MARGIN
        states, is_charging = await self._power_states(entity_id, read_start, now)
        states = with_live_state(self._hass, entity_id, states)
        landed = merge_runs(
            ledger.segments,
            charging_runs(states, is_charging, now),
            read_end=now,
            live=True,
            power_entity_id=entity_id,
            meter_entity_id=charger.meter_entity_id,
        )
        close_unseen(ledger.segments, landed=landed)
        ledger.cursor = now
        await self._settle(charger, ledger, now)

    async def async_backfill(self, consumer_id: str) -> None:
        """Read the retained days before the live reads began, newest first, a day at a time."""
        charger = self.chargers[consumer_id]
        ledger = self.store.ledger(consumer_id)
        while not self._unloaded and not ledger.backfill_done and ledger.backfill_before is not None:
            async with self._lock:
                try:
                    await self._backfill_day(charger, ledger, dt_util.utcnow())
                except Exception:
                    _LOGGER.warning("Charging ledger: backfill of %s failed; retried later", consumer_id, exc_info=True)
                    ledger.backfill_failed = True
                    self._errors[consumer_id] = "backfill_failed"
                    return
                finally:
                    if not self._unloaded:
                        self.store.schedule_save()
            # Let the event loop breathe between days.
            await asyncio.sleep(0)

    async def _backfill_day(self, charger: TrackedCharger, ledger: ChargerLedger, now: datetime) -> None:
        from ..recorder_statistics_span import query_oldest_state_date

        local_tz = dt_util.get_default_time_zone()
        if ledger.backfill_floor is None:
            floor = await query_oldest_state_date(
                self._hass, charger.power_entity_id, local_tz=local_tz
            )
            if floor is None:
                ledger.backfill_done = True
                return
            ledger.backfill_floor = floor
        day_end = ledger.backfill_before
        day_start = dt_util.as_utc(
            dt_util.start_of_local_day(dt_util.as_local(day_end - timedelta(hours=1)))
        )
        if dt_util.as_local(day_start).date() < ledger.backfill_floor:
            ledger.backfill_done = True
            return
        read_end = min(now, day_end + _READ_MARGIN)
        states, is_charging = await self._power_states(
            charger.power_entity_id, day_start - _READ_MARGIN, read_end
        )
        landed = merge_runs(
            ledger.segments,
            charging_runs(states, is_charging, read_end),
            read_end=read_end,
            live=False,
            power_entity_id=charger.power_entity_id,
            meter_entity_id=charger.meter_entity_id,
        )
        # Only this day's segments are attributed: a day still unanswered is
        # asked again by the next reconciliation, not after every day read.
        await self._settle(charger, ledger, now, attribute=landed)
        ledger.backfill_before = day_start
        ledger.backfill_days += 1
        ledger.backfill_failed = False

    async def _power_states(
        self, entity_id: str, start: datetime, end: datetime
    ) -> tuple[list[Any], ChargingPredicate]:
        """The power's recorded states over ``[start, end]``, and what each says, in its unit."""
        live = self._hass.states.get(entity_id)
        unit = None if live is None else live.attributes.get("unit_of_measurement")
        history = await read_states(
            self._hass,
            [entity_id],
            start,
            end,
            include_start_state=True,
            # Without a live unit, each state's own attributes carry it.
            no_attributes=unit is not None,
            strict=True,
        )
        return history[entity_id], lambda state: charging_power(state, unit)

    # --- Energy and attribution ----------------------------------------------

    async def _settle(
        self, charger: TrackedCharger, ledger: ChargerLedger, now: datetime, attribute: list[Segment] | None = None
    ) -> None:
        """Measure what can still move, then attribute ``attribute`` (every segment by default)."""
        meter = charger.meter_entity_id
        pending = [
            segment
            for segment in ledger.segments
            if not segment.energy_final and meter is not None and segment.meter_entity_id == meter
        ]
        for group in _close_groups(pending):
            await self._measure(meter, group, now)
        for segment in ledger.segments:
            # No meter of this charger's reads it: final as it is, past the settle window.
            if (
                not segment.energy_final
                and not segment.active
                and segment not in pending
                and now >= segment.end + _ENERGY_SETTLE
            ):
                segment.energy_final = True
        await self._attribute(charger.consumer_id, ledger.segments if attribute is None else attribute)

    async def _measure(self, meter: str, group: list[Segment], now: datetime) -> None:
        """The group's slices from one read of the meter, unwrapped as one series."""
        live = self._hass.states.get(meter)
        unit = None if live is None else live.attributes.get("unit_of_measurement")
        read_end = min(now, max(segment.end for segment in group) + _TRANSIENT_REBOUND_WINDOW)
        history = await read_states(
            self._hass,
            [meter],
            group[0].start - _METER_LOOKBACK,
            read_end,
            include_start_state=True,
            # The unit is stable across a sensor's history: without a live one
            # the attributes are the only place it is.
            no_attributes=unit is not None,
            strict=True,
        )
        boundaries = sorted(
            {boundary for segment in group for boundary in slice_boundaries(segment.start, segment.end)}
        )
        deltas = energy_changes_at_boundaries(
            history[meter], default_unit=unit, utc_boundaries=boundaries, staleness_limit=_METER_LOOKBACK
        )
        for segment in group:
            segment.slices = measured_slices(segment, deltas)
            if not segment.active and now >= segment.end + _ENERGY_SETTLE:
                segment.energy_final = True

    async def _attribute(self, consumer_id: str, segments: list[Segment]) -> None:
        local_tz = dt_util.get_default_time_zone()
        by_day: dict[date, list[tuple[Segment, Any]]] = {}
        for segment in segments:
            for item in segment.slices:
                if item.final:
                    continue
                if item.kwh is None:
                    # Nothing to attribute: once the energy is final, it stays missing.
                    item.final = segment.energy_final
                    continue
                by_day.setdefault(item.hour.astimezone(local_tz).date(), []).append((segment, item))
        for day, items in sorted(by_day.items(), reverse=True):
            try:
                dataset = await self._day_dataset(day)
            except Exception:
                _LOGGER.debug("Charging ledger: no house dataset for %s", day, exc_info=True)
                self._errors[consumer_id] = "attribution_failed"
                continue
            if dataset is None:
                # No house to attribute in: once the energy is final, it stays unattributed.
                for segment, item in items:
                    item.final = segment.energy_final
                continue
            for segment, item in items:
                item.attribution = attribute_slice(dataset, item)
                item.final = dataset.complete and segment.energy_final

    # --- The detail -----------------------------------------------------------

    async def async_history(self, consumer_id: str, now: datetime) -> dict[str, Any]:
        """The detail's ledger figures: the last 30 days, the newest segments and the ledger's health.

        Reconciled first; when that fails, what is stored is answered with
        ``complete`` false and the failure named in ``health``.
        """
        charger = self.chargers.get(consumer_id)
        if charger is None:
            return {"unavailable": "not_tracked"}
        now = dt_util.as_utc(now)
        self._errors.pop(consumer_id, None)
        try:
            await self.async_reconcile(consumer_id, now)
        except Exception:
            _LOGGER.warning("Charging ledger: reading %s failed", consumer_id, exc_info=True)
        ledger = self.store.ledger(consumer_id)
        local_tz = dt_util.get_default_time_zone()
        summary = window_summary(
            ledger.segments, now=now, local_tz=local_tz, recorded_since=_recorded_since(ledger)
        )
        in_window = [segment for segment in ledger.segments if segment.end >= now - WINDOW]
        error = self._errors.get(consumer_id)
        return {
            "unavailable": None,
            **summary,
            "segments": recent_segments(ledger.segments, local_tz=local_tz),
            "complete": error is None
            and all(
                not segment.active
                and segment.energy_final
                and all(item.final for item in segment.slices)
                for segment in in_window
            ),
            "health": _health(charger, ledger, error, now),
        }


def _close_groups(segments: list[Segment]) -> list[list[Segment]]:
    """``segments`` by start, in runs whose gaps are within the meter lookback: each run is one read."""
    groups: list[list[Segment]] = []
    for segment in sorted(segments, key=lambda item: item.start):
        if groups and segment.start - groups[-1][-1].end <= _METER_LOOKBACK:
            groups[-1].append(segment)
        else:
            groups.append([segment])
    return groups


def _recorded_since(ledger: ChargerLedger) -> datetime | None:
    """Since when the ledger has read the power: backfill's reach, or its oldest segment."""
    starts = [segment.start for segment in ledger.segments]
    covered = [at for at in (ledger.backfill_before, *starts[:1]) if at is not None]
    return min(covered) if covered else None


def _health(charger: TrackedCharger, ledger: ChargerLedger, error: str | None, now: datetime) -> dict[str, Any]:
    recorded_since = _recorded_since(ledger)
    unsettled = [
        segment.start
        for segment in ledger.segments
        if segment.active or not segment.energy_final or not all(item.final for item in segment.slices)
    ]
    return {
        "recordedSince": None if recorded_since is None else recorded_since.isoformat(),
        "segmentsStored": len(ledger.segments),
        "backfill": {
            "status": (
                "done" if ledger.backfill_done else "failed" if ledger.backfill_failed else "running"
            ),
            "recoveredDays": ledger.backfill_days,
        },
        "settledThrough": (min(unsettled) if unsettled else ledger.cursor or now).isoformat(),
        "powerEntityId": charger.power_entity_id,
        "meterEntityId": charger.meter_entity_id,
        "error": error,
    }
