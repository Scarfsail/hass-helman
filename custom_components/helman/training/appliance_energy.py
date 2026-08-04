from __future__ import annotations

import hashlib
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..appliances.climate_appliance import ClimateApplianceRuntime
from ..appliances.generic_appliance import GenericApplianceRuntime
from ..recorder_hourly_series import (
    estimate_average_hourly_energy_when_climate_active,
    estimate_average_hourly_energy_when_switch_on,
)
from ..storage import TrainingArtifactsStore

_LOGGER = logging.getLogger(__name__)

HistoryAverageAppliance = GenericApplianceRuntime | ClimateApplianceRuntime


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

    @property
    def fingerprint(self) -> str:
        """Identity of the question these estimates answer.

        Covers what changes the answer: which appliances, which entity pair each
        one reads, and how far back. Not ``hourly_energy_kwh`` — that is only the
        fallback used when an estimate is missing, so changing it must not
        invalidate a perfectly good estimate.
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
        request = self._read_request()
        if not request.appliances:
            # Recorded rather than skipped silently: the stored fingerprint is
            # what tells startup that "no appliances" is the current answer and
            # not a resolve that never ran.
            outcome = "not_configured"
            await self._store.async_record_appliance_energy(
                data={},
                fingerprint=request.fingerprint,
                trained_at=dt_util.now().isoformat(),
                last_outcome=outcome,
            )
        else:
            try:
                outcome = await self._async_resolve_and_store(request)
            except Exception as err:  # noqa: BLE001 - recorded, not propagated
                _LOGGER.exception("Appliance energy estimate training failed")
                outcome = "training_failed"
                await self._store.async_record_appliance_energy_failure(
                    last_outcome=outcome,
                    error_reason=str(err) or err.__class__.__name__,
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
        failed_appliance_ids: list[str] = []

        for appliance in request.appliances:
            try:
                estimate = await self._async_estimate(
                    appliance=appliance,
                    reference_time=reference_time,
                )
            except Exception:
                # One appliance's bad entity must not cost every other appliance
                # its estimate, so this is swallowed per appliance rather than
                # failing the run. The id is dropped from the stored map, which
                # is what makes the reader fall back to its fixed figure.
                _LOGGER.exception(
                    "Error estimating when-active energy for %s appliance %r",
                    appliance.kind,
                    appliance.id,
                )
                failed_appliance_ids.append(appliance.id)
                continue

            # ``None`` and non-positive both mean "the history did not answer"
            # — no active intervals, or a meter that never moved. Storing that
            # would be storing a wrong number; leaving the id out lets the
            # reader use the appliance's configured hourly energy instead.
            if estimate is not None and estimate > 0:
                estimates[appliance.id] = estimate

        if failed_appliance_ids:
            _LOGGER.warning(
                "Appliance energy estimates unresolved for %s; they fall back to "
                "their configured hourly energy",
                ", ".join(sorted(failed_appliance_ids)),
            )

        outcome = "estimates_trained" if estimates else "no_history"
        await self._store.async_record_appliance_energy(
            data=estimates,
            fingerprint=request.fingerprint,
            trained_at=dt_util.now().isoformat(),
            last_outcome=outcome,
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


def _resolve_activity_entity_id(appliance: HistoryAverageAppliance) -> str | None:
    if isinstance(appliance, GenericApplianceRuntime):
        return appliance.switch_entity_id
    return appliance.climate_entity_id
