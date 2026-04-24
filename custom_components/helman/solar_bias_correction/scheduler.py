from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_change


class SolarBiasTrainingScheduler:
    def __init__(
        self,
        hass: HomeAssistant,
        training_callback: Callable[[], Awaitable[object]],
    ) -> None:
        self._hass = hass
        self._training_callback = training_callback
        self._unsub: Callable[[], None] | None = None

    def schedule(self, training_time: str) -> None:
        self.cancel()
        hour, minute = self._parse_training_time(training_time)

        async def _run_training(*_args) -> None:
            getattr(self._hass, "async_create_task", asyncio.create_task)(
                self._training_callback()
            )

        self._unsub = async_track_time_change(
            self._hass,
            _run_training,
            hour=hour,
            minute=minute,
            second=0,
        )

    def cancel(self) -> None:
        if self._unsub is not None:
            self._unsub()
            self._unsub = None

    @staticmethod
    def _parse_training_time(training_time: str) -> tuple[int, int]:
        hour_text, minute_text = training_time.split(":", maxsplit=1)
        hour = int(hour_text)
        minute = int(minute_text)
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError(f"Invalid training time: {training_time}")
        return hour, minute
