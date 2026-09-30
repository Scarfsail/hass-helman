from __future__ import annotations

import hashlib
import logging
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, tzinfo
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..const import DEFAULT_HISTORY_LOOKBACK_DAYS
from ..controllables.config import running_active_states
from .. import recorder_hourly_series as recorder
from ..storage import TrainingArtifactsStore
from .device_stats import local_midnights, member_record, metered_record

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class SharedMeterMember:
    """One device behind a shared meter, as the split needs to see it.

    Whatever its projection strategy, and whether or not it is schedulable: a
    ``fixed`` or passive member learns nothing, but it still runs, so it still
    takes its share of the meter while it does.
    """

    controllable_id: str
    entity_id: str
    active_states: tuple[str, ...]

    @classmethod
    def for_signal(
        cls, controllable_id: str, entity_id: str, activity: str
    ) -> SharedMeterMember:
        """A member from its running signal: a ``switch`` or a ``climate``."""
        return cls(controllable_id, entity_id, running_active_states(activity))


@dataclass(frozen=True)
class SharedMeter:
    """A meter owner's meterless children, and the sub-meters beside them."""

    members: tuple[SharedMeterMember, ...]
    #: The owner's children with a meter of their own. The members split what
    #: is left of the meter once these are subtracted — its own energy.
    metered_children: tuple[str, ...] = ()
    #: The owner's ``children_tolerance_percent`` as a fraction, or ``None``
    #: to hand the members all own energy — see ``read_shared_meters``.
    tolerance: float | None = None


@dataclass(frozen=True)
class DeviceSubject:
    """One consumer device the job learns a usage record for.

    Every device with its own meter, and every meterless child its parent's
    meter is split among, schedulable or not: each is routed by what it is,
    never by which appliance list it happens to be on.
    """

    #: The card's ``deviceKey``: the meter for a metered device, the device id
    #: for a meterless child.
    device_key: str
    #: Its own meter, or for a meterless child the meter it shares.
    meter: str
    meterless: bool = False
    controllable_id: str | None = None
    power_entity_id: str | None = None
    power_value_type: str = "default"
    #: ``(entity id, "switch" | "climate")`` — see ``running_signal``.
    running_signal: tuple[str, str] | None = None
    lookback_days: int = DEFAULT_HISTORY_LOOKBACK_DAYS
    #: Whether its forecast uses the learned figure, which then goes into
    #: ``data`` under its controllable id.
    history_average: bool = False


@dataclass(frozen=True)
class ApplianceEnergyTrainingRequest:
    """The devices this run learns from, read once per run.

    Every consumer device, not only the ``history_average`` appliances: each
    gets a usage record, and ``history_average`` only decides whether its
    forecast uses the learned figure. Deliberately *not* narrowed to appliances
    an enabled optimizer references either: the estimate feeds the demand
    projection too, which runs for anything with a scheduled action.
    """

    subjects: Sequence[DeviceSubject] = field(default_factory=tuple)
    #: Meter entity id -> the devices drawing from it without a meter of their
    #: own, ``fixed`` and passive ones included: they still count toward the
    #: split.
    shared_meters: Mapping[str, SharedMeter] = field(default_factory=dict)

    @property
    def fingerprint(self) -> str:
        """Identity of the question these records answer.

        Covers what changes the answer: which devices, which entities each one
        reads, how far back, and whether it is on ``history_average``. Not
        ``hourly_energy_kwh`` — that is only the fallback used when an estimate
        is missing, so changing it must not invalidate a perfectly good one.

        Who shares a meter changes the answer too: adding a fourth air
        conditioner to a breaker shrinks the other three's share, even though
        none of their own entities moved. So does a sub-meter added behind it,
        which takes its reading out of what the members split, and the owner's
        tolerance, which caps what they are handed. The tolerance is always
        part of it, so a shared meter fingerprinted before the split learned
        weights is refitted once rather than staying even until the nightly
        run.
        """
        parts = [
            "|".join((
                subject.device_key,
                subject.meter,
                "meterless" if subject.meterless else "",
                subject.controllable_id or "",
                subject.power_entity_id or "",
                subject.power_value_type,
                *(subject.running_signal or ("", "")),
                str(subject.lookback_days),
                "history_average" if subject.history_average else "",
            ))
            for subject in sorted(self.subjects, key=lambda item: item.device_key)
        ]
        parts.extend(
            "shared|"
            + energy_entity_id
            + "|"
            + ",".join(
                f"{member.controllable_id}={member.entity_id}"
                for member in sorted(
                    shared.members,
                    key=lambda item: (item.controllable_id, item.entity_id),
                )
            )
            + (
                "|minus|" + ",".join(sorted(shared.metered_children))
                if shared.metered_children
                else ""
            )
            + f"|tolerance|{shared.tolerance!r}"
            for energy_entity_id, shared in sorted(self.shared_meters.items())
        )
        return hashlib.sha256("\n".join(parts).encode()).hexdigest()


class ApplianceEnergyTrainingJob:
    """Learns every consumer device's usage record, and the estimates from it.

    One pass over every device: each entity -- meter, power sensor, running
    signal -- is read once, over the longest window any device needs it for,
    and sliced per device. Each device's record goes under ``devices`` by its
    ``deviceKey`` (see :mod:`.device_stats`); a ``history_average`` device's
    ``on_kwh_per_hour`` is also its forecast estimate, stored in ``data`` by
    controllable id.

    It used to run inline on job #4's quarter-hour cadence *and* inside the
    appliance projection rebuild, which sits on the ``get_forecast`` websocket
    path — so a card refresh could block on a 30-day recorder scan. A 30-day
    average does not move between 10:00 and 10:15, so it belongs here, next to
    the house consumption fit, for exactly the reasons #24 moved that one.

    A meter with devices drawing from it (a parent's meterless children) is
    fitted once for all of them, minus any sub-meters behind it: its history
    teaches each member's power, and its own energy is split among whichever
    were running in the ratio of those — see
    :func:`..recorder_hourly_series._estimate_shared_meter_hourly_energy_kwh`.
    Every shared meter is fitted, because the live share sensors split by the
    same weights; they are stored flat, by member id, under
    ``shared_meter_weights``. A device with its own meter is the same
    estimator with itself as the only member.

    Never raises for a resolve failure: it records the outcome itself, and the
    failure record is what keeps the previous estimates alive.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        store: TrainingArtifactsStore,
        *,
        read_request: Callable[[], ApplianceEnergyTrainingRequest],
        on_trained: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._hass = hass
        self._store = store
        self._read_request = read_request
        self._on_trained = on_trained

    async def async_train(self) -> str:
        """Resolve and store every record. Returns the ``last_outcome``."""
        # Inside the guard: building the request reads live config and can
        # raise, and a failure there is as much a failed run as a failed read.
        try:
            request = self._read_request()
            if not request.subjects:
                # Recorded rather than skipped silently: the stored fingerprint
                # is what tells startup that "no devices" is the current
                # answer and not a resolve that never ran.
                outcome = "not_configured"
                await self._store.async_record_appliance_energy(
                    data={},
                    fingerprint=request.fingerprint,
                    trained_at=dt_util.now().isoformat(),
                    last_outcome=outcome,
                    failed_appliances={},
                    shared_meter_weights={},
                    devices={},
                )
            else:
                outcome = await self._async_resolve_and_store(request)
        except Exception as err:  # noqa: BLE001 - recorded, not propagated
            _LOGGER.exception("Appliance energy estimate training failed")
            outcome = "training_failed"
            await self._store.async_record_appliance_energy_failure(
                last_outcome=outcome,
                error_reason=str(err) or err.__class__.__name__,
                attempted_at=dt_util.now().isoformat(),
            )

        if self._on_trained is not None:
            await self._on_trained()
        return outcome

    async def _async_resolve_and_store(
        self,
        request: ApplianceEnergyTrainingRequest,
    ) -> str:
        reference_time = dt_util.now()
        local_tz = dt_util.as_local(reference_time).tzinfo
        previous = self._store.appliance_energy or {}
        previous_weights = previous.get("shared_meter_weights") or {}
        previous_devices = previous.get("devices") or {}

        window_end = dt_util.as_utc(reference_time)

        def window_start(lookback_days: int) -> datetime:
            return recorder._lookback_window(reference_time, lookback_days)[0]

        # A shared meter's window is the longest lookback among its members
        # that learn, else the default. Sharers of one meter are expected to
        # agree on it and nothing enforces that; a member with a shorter one is
        # simply split over the longer window, since the meter is fitted once.
        meter_starts = {
            meter: window_start(
                max(
                    (
                        subject.lookback_days
                        for subject in request.subjects
                        if subject.meterless
                        and subject.meter == meter
                        and subject.history_average
                    ),
                    default=DEFAULT_HISTORY_LOOKBACK_DAYS,
                )
            )
            for meter in request.shared_meters
        }
        starts = {
            subject.device_key: (
                meter_starts[subject.meter]
                if subject.meterless
                else window_start(subject.lookback_days)
            )
            for subject in request.subjects
        }
        histories = _Histories(window_end)
        await histories.async_read(self._hass, _reads(request, starts, meter_starts))

        #: Appliance id (else device key) -> why it learned nothing.
        failed_appliances: dict[str, str] = {}
        #: Member id -> learned kW, for every shared meter's members.
        weights: dict[str, float | None] = {}
        fits: dict[str, recorder.SharedMeterFit] = {}
        for meter, shared in request.shared_meters.items():
            start = meter_starts[meter]
            try:
                fits[meter] = recorder._estimate_shared_meter_hourly_energy_kwh(
                    {
                        member.controllable_id: (
                            histories.states(member.entity_id, start),
                            member.active_states,
                        )
                        for member in shared.members
                    },
                    histories.states(meter, start),
                    start,
                    window_end,
                    histories.unit(meter),
                    metered_children=[
                        (histories.states(child, start), histories.unit(child))
                        for child in shared.metered_children
                    ],
                    tolerance=shared.tolerance,
                    previous_weights=previous_weights,
                )
            except Exception as err:
                # One read serves the whole meter, so its failure is each
                # member's -- recorded under its deviceKey, its id, so the run
                # is not reported healthy while it keeps stale weights -- but
                # still only this meter's.
                _LOGGER.exception("Error learning shared meter %r", meter)
                reason = _failure_reason(err)
                failed_appliances.update(
                    (member.controllable_id, reason) for member in shared.members
                )
                # The section is replaced whole, so without this one transient
                # failure would drop this meter's live split back to even.
                _carry_over(
                    weights,
                    previous_weights,
                    (member.controllable_id for member in shared.members),
                )
                continue
            weights.update(fits[meter].weights)

        #: Device key -> its usage record.
        devices: dict[str, dict[str, Any]] = {}
        estimates: dict[str, float] = {}
        learned = False
        for subject in request.subjects:
            start = starts[subject.device_key]
            try:
                if subject.meterless:
                    if subject.meter not in fits:
                        # Its meter's failure is already recorded above.
                        _carry_over(devices, previous_devices, (subject.device_key,))
                        continue
                    fit = fits[subject.meter]
                    meter_states = histories.states(subject.meter, start)
                    # A meter with no rows is no evidence the child idled:
                    # without this, every day would be recorded as a zero day.
                    # Nor is a signal with no rows yet: the record starts where
                    # both its meter's and its signal's history do.
                    signal_states = histories.states(subject.running_signal[0], start)
                    record = (
                        member_record(
                            window_start=max(
                                _covered_start(meter_states, start),
                                _covered_start(signal_states, start),
                            ),
                            window_end=window_end,
                            local_tz=local_tz,
                            member_energy=fit.member_energy[subject.device_key],
                            on_kwh_per_hour=fit.estimates[subject.device_key],
                        )
                        if meter_states and signal_states
                        else None
                    )
                else:
                    record = _metered_record(
                        subject, histories, start, window_end, local_tz
                    )
            except Exception as err:
                # One device's bad entity must not cost every other device its
                # record, so this is swallowed per device. It keeps its
                # previous record, and a learner is dropped from ``data``,
                # which puts it on its fixed figure.
                _LOGGER.exception(
                    "Error learning the energy use of device %r", subject.device_key
                )
                failed_appliances[_failure_key(subject)] = _failure_reason(err)
                _carry_over(devices, previous_devices, (subject.device_key,))
                continue

            if record is not None:
                devices[subject.device_key] = record
                learned = True
            else:
                # History that answered nothing is no evidence the previous
                # record became wrong -- but the run is not healthy either.
                _carry_over(devices, previous_devices, (subject.device_key,))
                if not subject.history_average:
                    failed_appliances[subject.device_key] = "no usable history"
            if subject.history_average:
                estimate = (record or {}).get("on_kwh_per_hour")
                # ``None`` means the history did not answer -- no active
                # intervals, or a meter that never moved. Leaving the id out is
                # what makes the reader use its configured hourly energy.
                if estimate is not None and estimate > 0:
                    estimates[subject.controllable_id] = estimate
                elif estimate is None:
                    failed_appliances[subject.controllable_id] = "no usable history"
                else:
                    # Rounds to nothing: storing it would be storing a wrong
                    # number, which adoption drops without a word.
                    failed_appliances[subject.controllable_id] = (
                        f"non-positive estimate: {estimate}"
                    )

        if failed_appliances:
            _LOGGER.warning(
                "Device energy unresolved for %s; appliances among them fall back "
                "to their configured hourly energy",
                ", ".join(sorted(failed_appliances)),
            )

        # A learned weight is a trained result too: it drives the live split.
        trained = learned or any(weight is not None for weight in weights.values())
        outcome = "estimates_trained" if trained else "no_history"
        await self._store.async_record_appliance_energy(
            data=estimates,
            fingerprint=request.fingerprint,
            trained_at=dt_util.now().isoformat(),
            last_outcome=outcome,
            failed_appliances=failed_appliances,
            shared_meter_weights=weights,
            devices=devices,
        )
        return outcome


class _Histories:
    """Each entity's one read, sliced per device window.

    A read that failed is kept as its error and raised again by every slice of
    it, so it costs exactly the devices and meters that read that entity.
    """

    def __init__(self, window_end: datetime) -> None:
        self._window_end = window_end
        #: Entity id -> (states, their UTC instants, unit, read start), or the
        #: error the read raised.
        self._reads: dict[str, tuple[list[Any], list[datetime], Any, datetime] | Exception] = {}

    async def async_read(
        self, hass: HomeAssistant, reads: Mapping[str, tuple[datetime, bool]]
    ) -> None:
        """Read each entity once, from its earliest start, one after another.

        Sequential on purpose: the batch runs on the recorder executor under a
        single flight, so this slows only the nightly run, never a card.
        """
        for entity_id, (start, meter) in reads.items():
            try:
                states, unit = await recorder.read_entity_history(
                    hass, entity_id, start, self._window_end, meter=meter
                )
            except Exception as err:  # noqa: BLE001 - raised again per slice
                self._reads[entity_id] = err
                continue
            states = [
                state
                for state in states
                if getattr(state, "last_updated", None) is not None
            ]
            instants = [dt_util.as_utc(state.last_updated) for state in states]
            self._reads[entity_id] = (states, instants, unit, start)

    def states(self, entity_id: str, start: datetime) -> list[Any]:
        """The rows a read of ``entity_id`` from ``start`` alone would return."""
        states, instants, _unit, read_start = self._read(entity_id)
        return recorder._states_within(
            states, instants, start, self._window_end, query_start=read_start
        )

    def unit(self, entity_id: str) -> Any:
        return self._read(entity_id)[2]

    def _read(self, entity_id: str) -> tuple[list[Any], list[datetime], Any, datetime]:
        read = self._reads[entity_id]
        if isinstance(read, Exception):
            raise read
        return read


def _reads(
    request: ApplianceEnergyTrainingRequest,
    starts: Mapping[str, datetime],
    meter_starts: Mapping[str, datetime],
) -> dict[str, tuple[datetime, bool]]:
    """Entity id -> (the earliest start any device reads it from, is a meter).

    Over every subject's meter, power sensor and running signal, and every
    shared meter's own entities, its metered children included: a meter a
    parent subtracts is often a device of its own too, and is still read once.
    """
    reads: dict[str, tuple[datetime, bool]] = {}

    def need(entity_id: str | None, start: datetime, *, meter: bool = False) -> None:
        if entity_id is None:
            return
        earliest, is_meter = reads.get(entity_id, (start, meter))
        reads[entity_id] = (min(earliest, start), is_meter or meter)

    for subject in request.subjects:
        if subject.meterless:
            continue
        start = starts[subject.device_key]
        need(subject.meter, start, meter=True)
        need(subject.power_entity_id, start)
        if subject.running_signal is not None:
            need(subject.running_signal[0], start)
    for meter, shared in request.shared_meters.items():
        start = meter_starts[meter]
        need(meter, start, meter=True)
        for child in shared.metered_children:
            need(child, start, meter=True)
        for member in shared.members:
            need(member.entity_id, start)
    return reads


def _metered_record(
    subject: DeviceSubject,
    histories: _Histories,
    window_start: datetime,
    window_end: datetime,
    local_tz: tzinfo,
) -> dict[str, Any] | None:
    """A device with its own meter: its total energy, children included.

    Its daily energy is the meter's change at local midnights, and its
    ``on_kwh_per_hour`` the shared estimator with itself as the only member --
    exactly the lone-device figure its forecast always used.
    """
    meter_states = histories.states(subject.meter, window_start)
    unit = histories.unit(subject.meter)
    observations = recorder._parse_energy_observations(meter_states, default_unit=unit)
    daily = recorder.own_energy_observations(
        recorder._observation_pairs(observations),
        [],
        local_midnights(window_start, window_end, local_tz),
    )
    on_kwh_per_hour = None
    running = None
    if subject.running_signal is not None:
        entity_id, activity = subject.running_signal
        active_states = running_active_states(activity)
        signal_states = histories.states(entity_id, window_start)
        on_kwh_per_hour = recorder._estimate_shared_meter_hourly_energy_kwh(
            {subject.device_key: (signal_states, active_states)},
            meter_states,
            window_start,
            window_end,
            unit,
        ).estimates[subject.device_key]
        running = recorder._build_active_state_intervals(
            states=signal_states,
            window_start=window_start,
            window_end=window_end,
            active_states=active_states,
        )
    return metered_record(
        window_start=window_start,
        window_end=window_end,
        daily_kwh=list(daily.values()),
        power_states=(
            histories.states(subject.power_entity_id, window_start)
            if subject.power_entity_id is not None
            else None
        ),
        power_value_type=subject.power_value_type,
        running=running,
        on_kwh_per_hour=on_kwh_per_hour,
    )


def _covered_start(states: Sequence[Any], window_start: datetime) -> datetime:
    """Where an entity's history begins within the window.

    The recorder purges state history (after 10 days by default), so a 30-day
    window can begin long before the first row it still holds.
    """
    if not states:
        return window_start
    return max(window_start, dt_util.as_utc(states[0].last_updated))


def _carry_over(
    target: dict[str, Any], previous: Mapping[str, Any], keys: Iterable[str]
) -> None:
    """Keep each key's previous entry, where it had one.

    The section is replaced whole, so a device or meter whose read failed
    would otherwise lose what it learned before. One rule for the weights and
    the records alike: a read that could not run does not make them wrong.
    """
    target.update((key, previous[key]) for key in keys if key in previous)


def _failure_key(subject: DeviceSubject) -> str:
    """An appliance's failure is listed by its id, as its fallback is; any
    other device's by its deviceKey."""
    if subject.history_average and subject.controllable_id is not None:
        return subject.controllable_id
    return subject.device_key


def _failure_reason(err: Exception) -> str:
    return str(err) or err.__class__.__name__


def health_for(section: Mapping[str, Any] | None) -> str:
    """This job's stored outcome as ``ok | degraded | failed | idle``.

    ``not_configured`` is ``idle``: it is a freshly written, valid empty
    result, not a failure. A run that resolved some devices but not others is
    ``degraded`` -- the appliances among them are on their fixed fallback.
    """
    outcome = section.get("last_outcome") if section is not None else None
    if outcome == "estimates_trained":
        return "degraded" if section.get("failed_appliances") else "ok"
    if outcome == "no_history":
        return "degraded"
    if outcome == "training_failed":
        return "failed"
    return "idle"
