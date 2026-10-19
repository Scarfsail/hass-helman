"""The solar-bias fit as a training job."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from ..solar_bias_correction.service import BiasNotConfiguredError

if TYPE_CHECKING:
    from ..solar_bias_correction.service import SolarBiasCorrectionService


class SolarBiasTrainingJob:
    """Fits and persists the solar bias profile.

    Follows the training-job protocol used by :class:`.HouseConsumptionTrainingJob`
    and :class:`.ApplianceEnergyTrainingJob`: wraps the fit and store write, returns
    the recorded outcome, and notifies the caller via ``on_trained``.
    """

    def __init__(
        self,
        service: SolarBiasCorrectionService,
        *,
        on_trained: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._service = service
        self._on_trained = on_trained

    async def async_train(self) -> str:
        """Fit and store the profile. Returns the ``last_outcome``."""
        try:
            payload = await self._service.async_train()
        except BiasNotConfiguredError:
            return "skipped_disabled"

        if self._on_trained is not None:
            await self._on_trained()
        return payload["lastOutcome"]
