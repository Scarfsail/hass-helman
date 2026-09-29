from __future__ import annotations

import hashlib
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..appliances.climate_appliance import ClimateApplianceRuntime
from ..appliances.generic_appliance import GenericApplianceRuntime
from ..const import DEFAULT_HISTORY_LOOKBACK_DAYS
from ..controllables.config import running_active_states
from ..recorder_hourly_series import (
    estimate_average_hourly_energy_for_shared_meter,
    estimate_average_hourly_energy_when_climate_active,
    estimate_average_hourly_energy_when_switch_on,
)
from ..storage import TrainingArtifactsStore

if TYPE_CHECKING:
    from ..recorder_hourly_series import SharedMeterFit

_LOGGER = logging.getLogger(__name__)

HistoryAverageAppliance = GenericApplianceRuntime | ClimateApplianceRuntime


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
class ApplianceEnergyTrainingRequest:
    """The appliances this run resolves, read once per run.

    Only appliances on ``projection.strategy: history_average`` — every other
    appliance already answers with its configured ``hourly_energy_kwh`` and
    never touches the recorder.

    Deliberately *not* narrowed to appliances an enabled optimizer references.
    The estimate feeds the demand projection too, which runs for anything with a
    scheduled action, optimizer-driven or hand-placed; narrowing here would drop
    a manually scheduled appliance to its fixed fallback with nothing in the log
    to say why.
    """

    appliances: Sequence[HistoryAverageAppliance] = field(default_factory=tuple)
    #: Meter entity id -> the devices drawing from it without a meter of their
    #: own. Read from the device tree rather than from ``appliances``: a
    #: ``fixed`` or passive member is not in that list, yet it still counts
    #: toward the split.
    shared_meters: Mapping[str, SharedMeter] = field(default_factory=dict)

    @property
    def fingerprint(self) -> str:
        """Identity of the question these estimates answer.

        Covers what changes the answer: which appliances, which entity pair each
        one reads, and how far back. Not ``hourly_energy_kwh`` — that is only the
        fallback used when an estimate is missing, so changing it must not
        invalidate a perfectly good estimate.

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
                appliance.id,
                _resolve_activity_entity_id(appliance) or "",
                appliance.history_energy_entity_id or "",
                str(appliance.history_lookback_days),
            ))
            for appliance in sorted(self.appliances, key=lambda item: item.id)
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
    """Resolves each appliance's average hourly energy while it is running.

    The estimate is two ``state_changes_during_period`` reads over the
    appliance's ``lookback_days`` (30 by default) — the switch/climate entity to
    learn when it ran, the energy meter to learn what it drew — collapsed into a
    single kWh-per-hour figure.

    It used to run inline on job #4's quarter-hour cadence *and* inside the
    appliance projection rebuild, which sits on the ``get_forecast`` websocket
    path — so a card refresh could block on a 30-day recorder scan. A 30-day
    average does not move between 10:00 and 10:15, so it belongs here, next to
    the house consumption fit, for exactly the reasons #24 moved that one.

    A meter with devices drawing from it (a parent's meterless children) is
    read once for all of them, minus any sub-meters behind it: its history
    teaches each member's power, and its own energy is split among whichever
    were running in the ratio of those — see
    :func:`..recorder_hourly_series._estimate_shared_meter_hourly_energy_kwh`.
    Every shared meter is fitted, even one whose members all learn nothing,
    because the live share sensors split by the same weights; they are stored
    flat, by member id, under ``shared_meter_weights``.

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
        """Resolve and store every estimate. Returns the ``last_outcome``."""
        # Inside the guard: building the request reads live config and can
        # raise, and a failure there is as much a failed run as a failed read.
        try:
            request = self._read_request()
            if not request.appliances and not request.shared_meters:
                # Recorded rather than skipped silently: the stored fingerprint
                # is what tells startup that "no appliances" is the current
                # answer and not a resolve that never ran.
                outcome = "not_configured"
                await self._store.async_record_appliance_energy(
                    data={},
                    fingerprint=request.fingerprint,
                    trained_at=dt_util.now().isoformat(),
                    last_outcome=outcome,
                    failed_appliances={},
                    shared_meter_weights={},
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
        estimates: dict[str, float] = {}
        #: Appliance id -> why its estimate could not be resolved.
        failed_appliances: dict[str, str] = {}
        #: Member id -> learned kW, for every shared meter's members.
        weights: dict[str, float | None] = {}
        previous_weights = (self._store.appliance_energy or {}).get(
            "shared_meter_weights"
        ) or {}

        shared_appliances: dict[str, list[HistoryAverageAppliance]] = {}
        for appliance in request.appliances:
            if appliance.history_energy_entity_id in request.shared_meters:
                shared_appliances.setdefault(
                    appliance.history_energy_entity_id, []
                ).append(appliance)
                continue
            try:
                estimate = await self._async_estimate(
                    appliance=appliance,
                    reference_time=reference_time,
                )
            except Exception as err:
                # One appliance's bad entity must not cost every other appliance
                # its estimate, so this is swallowed per appliance rather than
                # failing the run. The id is dropped from the stored map, which
                # is what makes the reader fall back to its fixed figure.
                _LOGGER.exception(
                    "Error estimating when-active energy for %s appliance %r",
                    appliance.kind,
                    appliance.id,
                )
                failed_appliances[appliance.id] = _failure_reason(err)
                continue

            # ``None`` and non-positive both mean "the history did not answer"
            # — no active intervals, or a meter that never moved. Storing that
            # would be storing a wrong number; leaving the id out lets the
            # reader use the appliance's configured hourly energy instead.
            if estimate is not None and estimate > 0:
                estimates[appliance.id] = estimate
            else:
                failed_appliances[appliance.id] = _unusable_estimate_reason(estimate)

        for energy_entity_id, shared in request.shared_meters.items():
            appliances = shared_appliances.get(energy_entity_id, [])
            try:
                fit = await self._async_estimate_shared_meter(
                    energy_entity_id=energy_entity_id,
                    shared=shared,
                    appliances=appliances,
                    reference_time=reference_time,
                    previous_weights=previous_weights,
                )
            except Exception as err:
                # One read serves the whole meter, so its failure is every
                # learning member's failure — but still only this meter's.
                _LOGGER.exception(
                    "Error estimating when-active energy for shared meter %r",
                    energy_entity_id,
                )
                reason = _failure_reason(err)
                failed_appliances.update(
                    (appliance.id, reason) for appliance in appliances
                )
                # The section is replaced whole, so without this one transient
                # failure would drop this meter's live split back to even.
                weights.update(
                    (member.controllable_id, previous_weights[member.controllable_id])
                    for member in shared.members
                    if member.controllable_id in previous_weights
                )
                continue

            weights.update(fit.weights)
            # Only the members that learn are stored; a ``fixed`` sharer was in
            # the split for its share of the meter and nothing more.
            for appliance in appliances:
                estimate = fit.estimates.get(appliance.id)
                if estimate is not None and estimate > 0:
                    estimates[appliance.id] = estimate
                else:
                    failed_appliances[appliance.id] = _unusable_estimate_reason(
                        estimate
                    )

        if failed_appliances:
            _LOGGER.warning(
                "Appliance energy estimates unresolved for %s; they fall back to "
                "their configured hourly energy",
                ", ".join(sorted(failed_appliances)),
            )

        # A learned weight is a trained result too: a config whose shared
        # meters' members are all ``fixed`` or passive learns nothing else.
        trained = estimates or any(weight is not None for weight in weights.values())
        outcome = "estimates_trained" if trained else "no_history"
        await self._store.async_record_appliance_energy(
            data=estimates,
            fingerprint=request.fingerprint,
            trained_at=dt_util.now().isoformat(),
            last_outcome=outcome,
            failed_appliances=failed_appliances,
            shared_meter_weights=weights,
        )
        return outcome

    async def _async_estimate(
        self,
        *,
        appliance: HistoryAverageAppliance,
        reference_time: datetime,
    ) -> float | None:
        energy_entity_id = appliance.history_energy_entity_id
        if energy_entity_id is None:
            return None
        if isinstance(appliance, GenericApplianceRuntime):
            return await estimate_average_hourly_energy_when_switch_on(
                self._hass,
                switch_entity_id=appliance.switch_entity_id,
                energy_entity_id=energy_entity_id,
                reference_time=reference_time,
                lookback_days=appliance.history_lookback_days,
            )
        return await estimate_average_hourly_energy_when_climate_active(
            self._hass,
            climate_entity_id=appliance.climate_entity_id,
            energy_entity_id=energy_entity_id,
            reference_time=reference_time,
            lookback_days=appliance.history_lookback_days,
        )

    async def _async_estimate_shared_meter(
        self,
        *,
        energy_entity_id: str,
        shared: SharedMeter,
        appliances: Sequence[HistoryAverageAppliance],
        reference_time: datetime,
        previous_weights: Mapping[str, float | None],
    ) -> SharedMeterFit:
        """Every member's weight and share of one meter, from one read of it.

        The window is the longest lookback among the members that learn, else
        the default. Sharers of one meter are expected to agree on it and
        nothing enforces that, so a member with a shorter lookback is simply
        split over the longer window — accepted, since a ``fixed`` member has
        no lookback worth honouring and reading the meter once per window would
        defeat the single read.
        """
        return await estimate_average_hourly_energy_for_shared_meter(
            self._hass,
            members=[
                (member.controllable_id, member.entity_id, member.active_states)
                for member in shared.members
            ],
            energy_entity_id=energy_entity_id,
            metered_children=shared.metered_children,
            tolerance=shared.tolerance,
            previous_weights=previous_weights,
            reference_time=reference_time,
            lookback_days=max(
                (appliance.history_lookback_days for appliance in appliances),
                default=DEFAULT_HISTORY_LOOKBACK_DAYS,
            ),
        )


def _failure_reason(err: Exception) -> str:
    return str(err) or err.__class__.__name__


def _unusable_estimate_reason(estimate: float | None) -> str:
    """Explain why history did not produce a usable positive estimate."""
    if estimate is None:
        return "no usable history"
    return f"non-positive estimate: {estimate}"


def health_for(section: Mapping[str, Any] | None) -> str:
    """This job's stored outcome as ``ok | degraded | failed | idle``.

    ``not_configured`` is ``idle``: it is a freshly written, valid empty
    result, not a failure. A run that resolved some appliances but not others
    is ``degraded`` -- those appliances are on their fixed fallback.
    """
    outcome = section.get("last_outcome") if section is not None else None
    if outcome == "estimates_trained":
        return "degraded" if section.get("failed_appliances") else "ok"
    if outcome == "no_history":
        return "degraded"
    if outcome == "training_failed":
        return "failed"
    return "idle"


def _resolve_activity_entity_id(appliance: HistoryAverageAppliance) -> str | None:
    if isinstance(appliance, GenericApplianceRuntime):
        return appliance.switch_entity_id
    return appliance.climate_entity_id
