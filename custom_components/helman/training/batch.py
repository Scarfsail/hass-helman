from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_change

from ..solar_bias_correction.service import (
    BiasNotConfiguredError,
    TrainingInProgressError,
)
from .appliance_energy import ApplianceEnergyTrainingJob
from .house_consumption import HouseConsumptionTrainingJob

if TYPE_CHECKING:
    from ..solar_bias_correction.service import SolarBiasCorrectionService

_LOGGER = logging.getLogger(__name__)


class TrainingBatch:
    """The nightly batch: every job that reads a lot of recorder history.

    Started unconditionally, not behind the solar-bias enable gate that used to
    guard the old training scheduler: with bias correction off, a gated batch
    would never fit the house consumption profile and the house forecast would
    sit at ``unavailable`` forever. The bias sub-job skips itself instead.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        solar_bias_service: SolarBiasCorrectionService,
        house_consumption_job: HouseConsumptionTrainingJob,
        appliance_energy_job: ApplianceEnergyTrainingJob,
    ) -> None:
        self._hass = hass
        self._solar_bias_service = solar_bias_service
        self._house_consumption_job = house_consumption_job
        self._appliance_energy_job = appliance_energy_job
        self._create_task = getattr(hass, "async_create_task", asyncio.create_task)
        self._unsub: Callable[[], None] | None = None
        #: The run currently in flight, if any, so a second trigger joins it
        #: instead of starting a competing set of recorder scans.
        self._run_task: asyncio.Task[Any] | None = None
        #: What each sub-job last reported, for the log line and for tests.
        self.last_outcomes: dict[str, str] = {}

    def schedule(self, training_time: str) -> None:
        """(Re)register the daily trigger. Raises ValueError on a bad time."""
        self.cancel()
        hour, minute = self._parse_training_time(training_time)

        def _run_batch(*_args) -> None:
            self._create_task(self.async_run(reason="scheduled"))

        self._unsub = async_track_time_change(
            self._hass,
            _run_batch,
            hour=hour,
            minute=minute,
            second=0,
        )

    def cancel(self) -> None:
        if self._unsub is not None:
            self._unsub()
            self._unsub = None

    async def async_run(self, *, reason: str) -> None:
        """Run every sub-job. The nightly entry point."""
        await self._async_single_flight(reason, self._async_run_all)

    async def async_run_house_consumption(self, *, reason: str) -> None:
        """Run only the house consumption fit.

        Startup and config-save refits want the profile, not a bias re-train:
        the bias fingerprint is untouched by a forecast config change, so
        re-training it on every reload would be pure cost. It shares the
        batch's single flight all the same — the two jobs read the same
        recorder on the same executor thread and must never overlap.
        """
        await self._async_single_flight(reason, self._async_run_house_consumption)

    async def async_run_appliance_energy(self, *, reason: str) -> None:
        """Run only the per-appliance when-active energy estimates.

        Same rationale as ``async_run_house_consumption``: a startup or
        config-save refit wants the estimates refreshed, not the bias profile
        re-trained. Shares the batch's single flight — these reads queue on the
        same recorder executor thread as every other sub-job.
        """
        await self._async_single_flight(reason, self._async_run_appliance_energy)

    async def _async_single_flight(
        self,
        reason: str,
        run: Callable[[str], Awaitable[None]],
    ) -> None:
        """Join the run in flight, or start one. Same shape as the forecast
        refresh: the triggers — the daily timer, startup, a config save — fire
        independently of each other and must not stack up recorder scans."""
        in_flight = self._run_task
        if in_flight is not None and not in_flight.done():
            await asyncio.wait({in_flight})
            return

        task = self._create_task(run(reason))
        self._run_task = task
        try:
            await task
        finally:
            if self._run_task is task:
                self._run_task = None

    async def _async_run_all(self, reason: str) -> None:
        # Sequential, never gathered: both sub-jobs queue their reads on the
        # recorder's single executor thread, so running them together would
        # recreate at 03:00 exactly the stall this batch exists to remove.
        _LOGGER.debug("Training batch starting (%s)", reason)
        await self._run_subjob("solar_bias", self._async_train_solar_bias())
        await self._run_subjob(
            "house_consumption", self._house_consumption_job.async_train()
        )
        await self._run_subjob(
            "appliance_energy", self._appliance_energy_job.async_train()
        )
        _LOGGER.info("Training batch finished (%s): %s", reason, self.last_outcomes)

    async def _async_run_house_consumption(self, reason: str) -> None:
        _LOGGER.debug("House consumption training starting (%s)", reason)
        await self._run_subjob(
            "house_consumption", self._house_consumption_job.async_train()
        )

    async def _async_run_appliance_energy(self, reason: str) -> None:
        _LOGGER.debug("Appliance energy training starting (%s)", reason)
        await self._run_subjob(
            "appliance_energy", self._appliance_energy_job.async_train()
        )

    async def _run_subjob(self, name: str, coro: Awaitable[str]) -> None:
        """Run one sub-job and swallow its failure.

        Isolation is the whole point: a sub-job that blows up must not take the
        rest of the batch with it. Each writes its own artifacts as it finishes
        rather than at the end, so a crash midway cannot lose a section that
        already succeeded.
        """
        try:
            self.last_outcomes[name] = await coro
        except Exception:
            _LOGGER.exception("Training sub-job %s failed", name)
            self.last_outcomes[name] = "training_failed"

    async def _async_train_solar_bias(self) -> str:
        try:
            await self._solar_bias_service.async_train()
        except BiasNotConfiguredError:
            return "skipped_disabled"
        except TrainingInProgressError:
            # `helman/train_solar_bias_now` bypasses this batch's lock, so a
            # manual train can be under way. That is a skip, not a failure.
            _LOGGER.debug("Solar bias training already in progress; skipping")
            return "skipped_in_progress"
        return "profile_trained"

    @staticmethod
    def _parse_training_time(training_time: str) -> tuple[int, int]:
        hour_text, minute_text = training_time.split(":", maxsplit=1)
        hour = int(hour_text)
        minute = int(minute_text)
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError(f"Invalid training time: {training_time}")
        return hour, minute
