from __future__ import annotations

import hashlib
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..appliances.climate_appliance import ClimateApplianceRuntime
from ..appliances.generic_appliance import GenericApplianceRuntime
from ..recorder_hourly_series import (
    CLIMATE_ACTIVE_STATES,
    SWITCH_ACTIVE_STATES,
    estimate_average_hourly_energy_for_shared_meter,
    estimate_average_hourly_energy_when_climate_active,
    estimate_average_hourly_energy_when_switch_on,
)
from ..storage import TrainingArtifactsStore

_LOGGER = logging.getLogger(__name__)

HistoryAverageAppliance = GenericApplianceRuntime | ClimateApplianceRuntime


@dataclass(frozen=True)
class SharedMeterMember:
    """One device behind a shared meter, as the split needs to see it.

    Whatever its projection strategy: a ``fixed`` sharer learns nothing, but it
    still runs, so it still takes its share of the meter while it does.
    """

    controllable_id: str
    entity_id: str
    active_states: tuple[str, ...]

    @classmethod
    def for_appliance(cls, appliance: HistoryAverageAppliance) -> SharedMeterMember:
        if isinstance(appliance, GenericApplianceRuntime):
            return cls(appliance.id, appliance.switch_entity_id, SWITCH_ACTIVE_STATES)
        return cls(appliance.id, appliance.climate_entity_id, CLIMATE_ACTIVE_STATES)


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
    #: Meter entity id -> every device behind it, for meters two or more
    #: controllables share. Read from config rather than from ``appliances``:
    #: a ``fixed`` sharer is not in that list and has no meter on its runtime,
    #: yet it still counts toward the divisor.
    shared_meters: Mapping[str, tuple[SharedMeterMember, ...]] = field(
        default_factory=dict
    )

    @property
    def fingerprint(self) -> str:
        """Identity of the question these estimates answer.

        Covers what changes the answer: which appliances, which entity pair each
        one reads, and how far back. Not ``hourly_energy_kwh`` — that is only the
        fallback used when an estimate is missing, so changing it must not
        invalidate a perfectly good estimate.

        Who shares a meter changes the answer too: adding a fourth air
        conditioner to a breaker shrinks the other three's share, even though
        none of their own entities moved.
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
                    members, key=lambda item: (item.controllable_id, item.entity_id)
                )
            )
            for energy_entity_id, members in sorted(self.shared_meters.items())
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

    A meter several devices share is read once for all of them and split
    evenly among whichever were running — see
    :func:`..recorder_hourly_series._estimate_shared_meter_hourly_energy_kwh`.

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
            if not request.appliances:
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

        for energy_entity_id, appliances in shared_appliances.items():
            try:
                shared_estimates = await self._async_estimate_shared_meter(
                    energy_entity_id=energy_entity_id,
                    members=request.shared_meters[energy_entity_id],
                    appliances=appliances,
                    reference_time=reference_time,
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
                continue

            # Only the members that learn are stored; a ``fixed`` sharer was in
            # the split for its share of the divisor and nothing more.
            for appliance in appliances:
                estimate = shared_estimates.get(appliance.id)
                if estimate is not None and estimate > 0:
                    estimates[appliance.id] = estimate

        if failed_appliances:
            _LOGGER.warning(
                "Appliance energy estimates unresolved for %s; they fall back to "
                "their configured hourly energy",
                ", ".join(sorted(failed_appliances)),
            )

        outcome = "estimates_trained" if estimates else "no_history"
        await self._store.async_record_appliance_energy(
            data=estimates,
            fingerprint=request.fingerprint,
            trained_at=dt_util.now().isoformat(),
            last_outcome=outcome,
            failed_appliances=failed_appliances,
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
        members: Sequence[SharedMeterMember],
        appliances: Sequence[HistoryAverageAppliance],
        reference_time: datetime,
    ) -> dict[str, float | None]:
        """Every member's share of one meter, from one read of it.

        The window is the longest lookback among the members that learn. Sharers
        of one meter are expected to agree on it and nothing enforces that, so a
        member with a shorter lookback is simply split over the longer window —
        accepted, since a ``fixed`` member has no lookback worth honouring and
        reading the meter once per window would defeat the single read.
        """
        return await estimate_average_hourly_energy_for_shared_meter(
            self._hass,
            members=[
                (member.controllable_id, member.entity_id, member.active_states)
                for member in members
            ],
            energy_entity_id=energy_entity_id,
            reference_time=reference_time,
            lookback_days=max(
                appliance.history_lookback_days for appliance in appliances
            ),
        )


def _failure_reason(err: Exception) -> str:
    return str(err) or err.__class__.__name__


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
