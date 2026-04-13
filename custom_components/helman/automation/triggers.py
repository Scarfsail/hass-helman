from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Awaitable, Callable

_LOGGER = logging.getLogger(__name__)
AUTOMATION_REFRESH_DEBOUNCE_SECONDS = 0.5


@dataclass(frozen=True)
class AutomationTriggerRequest:
    reason: str
    reference_time: datetime | None = None


class AutomationTriggerCoordinator:
    def __init__(
        self,
        *,
        create_task: Callable[[Awaitable[None]], asyncio.Task[None]],
        run_callback: Callable[[AutomationTriggerRequest], Awaitable[None]],
        debounce_seconds: float = AUTOMATION_REFRESH_DEBOUNCE_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._create_task = create_task
        self._run_callback = run_callback
        self._debounce_seconds = debounce_seconds
        self._sleep = sleep
        self._closed = False
        self._lock = asyncio.Lock()
        self._pending_request: AutomationTriggerRequest | None = None
        self._follow_up_request: AutomationTriggerRequest | None = None
        self._debounce_task: asyncio.Task[None] | None = None
        self._active_run_task: asyncio.Task[None] | None = None

    async def request_immediate(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        request = AutomationTriggerRequest(
            reason=reason,
            reference_time=reference_time,
        )
        async with self._lock:
            if self._closed:
                return
            self._cancel_debounce_locked()
            self._pending_request = None
            if self._active_run_task is None:
                self._start_active_run_locked(request)
                return
            self._follow_up_request = request

    async def request_debounced(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        request = AutomationTriggerRequest(
            reason=reason,
            reference_time=reference_time,
        )
        async with self._lock:
            if self._closed:
                return
            if self._active_run_task is not None:
                self._cancel_debounce_locked()
                self._pending_request = None
                self._follow_up_request = request
                return
            self._pending_request = request
            if self._debounce_task is None:
                self._debounce_task = self._create_task(self._async_debounce_then_dispatch())

    async def async_shutdown(self) -> None:
        async with self._lock:
            self._closed = True
            debounce_task = self._debounce_task
            active_run_task = self._active_run_task
            self._debounce_task = None
            self._active_run_task = None
            self._pending_request = None
            self._follow_up_request = None
            if debounce_task is not None:
                debounce_task.cancel()
            if active_run_task is not None:
                active_run_task.cancel()

        tasks = tuple(
            task for task in (debounce_task, active_run_task) if task is not None
        )
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _async_debounce_then_dispatch(self) -> None:
        try:
            await self._sleep(self._debounce_seconds)
            async with self._lock:
                if self._closed:
                    self._debounce_task = None
                    self._pending_request = None
                    return
                self._debounce_task = None
                request = self._pending_request
                self._pending_request = None
                if request is None:
                    return
                if self._active_run_task is None:
                    self._start_active_run_locked(request)
                    return
                self._follow_up_request = request
        except asyncio.CancelledError:
            raise

    async def _async_run_loop(self, initial_request: AutomationTriggerRequest) -> None:
        request = initial_request
        while True:
            try:
                await self._run_callback(request)
            except asyncio.CancelledError:
                raise
            except Exception:
                _LOGGER.exception(
                    "Automation trigger run failed, reason=%s",
                    request.reason,
                )

            async with self._lock:
                next_request = self._follow_up_request
                if next_request is None:
                    self._active_run_task = None
                    return
                self._follow_up_request = None
                request = next_request

    def _start_active_run_locked(self, request: AutomationTriggerRequest) -> None:
        self._active_run_task = self._create_task(self._async_run_loop(request))

    def _cancel_debounce_locked(self) -> None:
        if self._debounce_task is not None:
            self._debounce_task.cancel()
            self._debounce_task = None
