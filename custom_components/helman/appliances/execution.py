from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..controllables.spec import CONTROLLABLE_SPECS
from ..scheduling.actuation import ScheduleActuator
from ..scheduling.runtime_status import ApplianceRuntimeStatus
from ..scheduling.slots import ScheduleError, ScheduleExecutionUnavailableError
from .drivers import (
    CHARGE_POLL_INTERVAL_SECONDS,
    ApplianceActionDriver,
    ApplianceDriverOptions,
    build_runtime_status,
)
from .schedule import ApplianceScheduleActionDict
from .state import AppliancesRuntimeRegistry


@dataclass(frozen=True)
class ApplianceExecutionMemory:
    last_active_slot_id: str
    last_action_signature: tuple[object, ...] | None
    last_enabled: bool
    last_runtime_action_kind: str | None = None


@dataclass(frozen=True)
class AppliancesExecutionResult:
    runtimes: dict[str, ApplianceRuntimeStatus]
    memories: dict[str, ApplianceExecutionMemory]
    first_error: ScheduleError | None = None


class ApplianceExecutor:
    """The decision sequence every appliance kind shares.

    Slot stop, signature comparison, noop, apply, memory — written once, with
    the per-kind differences behind :class:`ApplianceActionDriver`. Memory is
    only advanced on a successful apply, so a failed actuation is retried on the
    next reconcile instead of being remembered as done.
    """

    def __init__(
        self,
        actuator: ScheduleActuator,
        driver: ApplianceActionDriver,
    ) -> None:
        self._actuator = actuator
        self._driver = driver

    async def async_execute(
        self,
        *,
        appliance: Any,
        action: ApplianceScheduleActionDict | None,
        last_scheduled_action: ApplianceScheduleActionDict | None,
        memory: ApplianceExecutionMemory | None,
        active_slot_id: str,
        reference_time: datetime,
    ) -> tuple[ApplianceRuntimeStatus | None, ApplianceExecutionMemory | None]:
        if action is None:
            if (
                memory is not None
                and memory.last_active_slot_id == active_slot_id
                and memory.last_runtime_action_kind == "slot_stop"
            ):
                return None, memory
            if memory is not None and not memory.last_enabled:
                return None, memory
            if memory is None and not (
                last_scheduled_action is not None
                and self._driver.is_enabled(appliance, last_scheduled_action)
            ):
                return None, None
            runtime = await self._driver.async_apply(
                self._actuator,
                appliance=appliance,
                action=None,
                action_kind="slot_stop",
                reference_time=reference_time,
            )
            if runtime.outcome != "success":
                return runtime, memory
            return (
                None,
                ApplianceExecutionMemory(
                    last_active_slot_id=active_slot_id,
                    last_action_signature=None,
                    last_enabled=False,
                    last_runtime_action_kind="slot_stop",
                ),
            )

        signature = self._driver.signature(action)
        enabled = self._driver.is_enabled(appliance, action)
        if (
            memory is not None
            and memory.last_active_slot_id == active_slot_id
            and memory.last_action_signature == signature
        ):
            return (
                build_runtime_status(
                    action_kind="noop",
                    outcome="skipped",
                    reference_time=reference_time,
                ),
                ApplianceExecutionMemory(
                    last_active_slot_id=active_slot_id,
                    last_action_signature=signature,
                    last_enabled=enabled,
                    last_runtime_action_kind="noop",
                ),
            )

        runtime = await self._driver.async_apply(
            self._actuator,
            appliance=appliance,
            action=action,
            action_kind="apply",
            reference_time=reference_time,
        )
        if runtime.outcome != "success":
            return runtime, memory
        return (
            runtime,
            ApplianceExecutionMemory(
                last_active_slot_id=active_slot_id,
                last_action_signature=signature,
                last_enabled=enabled,
                last_runtime_action_kind="apply",
            ),
        )

    async def async_disable_active_action(
        self,
        *,
        appliance: Any,
        action: ApplianceScheduleActionDict | None,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus | None:
        if action is None or not self._driver.is_enabled(appliance, action):
            return None
        return await self._driver.async_apply(
            self._actuator,
            appliance=appliance,
            action=None,
            action_kind="slot_stop",
            reference_time=reference_time,
        )


class AppliancesExecutor:
    def __init__(
        self,
        actuator: ScheduleActuator,
        *,
        charge_on_wait_seconds: float = 30.0,
        poll_interval_seconds: float = CHARGE_POLL_INTERVAL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        options = ApplianceDriverOptions(
            charge_on_wait_seconds=charge_on_wait_seconds,
            poll_interval_seconds=poll_interval_seconds,
            sleep=sleep,
        )
        self._executors: dict[str, ApplianceExecutor] = {
            spec.kind: ApplianceExecutor(actuator, spec.driver(options))
            for spec in CONTROLLABLE_SPECS.values()
            if spec.driver is not None
        }

    async def async_execute(
        self,
        *,
        registry: AppliancesRuntimeRegistry,
        active_slot_id: str,
        active_actions: Mapping[str, ApplianceScheduleActionDict],
        last_scheduled_actions: Mapping[str, ApplianceScheduleActionDict],
        previous_memories: Mapping[str, ApplianceExecutionMemory],
        reference_time: datetime,
    ) -> AppliancesExecutionResult:
        runtimes: dict[str, ApplianceRuntimeStatus] = {}
        memories: dict[str, ApplianceExecutionMemory] = {}
        first_error: ScheduleError | None = None

        for appliance in registry.appliances:
            runtime, memory = await self._executor_for(appliance).async_execute(
                appliance=appliance,
                action=active_actions.get(appliance.id),
                last_scheduled_action=last_scheduled_actions.get(appliance.id),
                memory=previous_memories.get(appliance.id),
                active_slot_id=active_slot_id,
                reference_time=reference_time,
            )
            if runtime is not None:
                runtimes[appliance.id] = runtime
                if runtime.outcome == "failed" and first_error is None:
                    first_error = ScheduleExecutionUnavailableError(
                        runtime.message or f"Appliance {appliance.id!r} execution failed"
                    )
            if memory is not None:
                memories[appliance.id] = memory

        return AppliancesExecutionResult(
            runtimes=runtimes,
            memories=memories,
            first_error=first_error,
        )

    async def async_restore_active_slot(
        self,
        *,
        registry: AppliancesRuntimeRegistry,
        active_actions: Mapping[str, ApplianceScheduleActionDict],
        reference_time: datetime,
    ) -> AppliancesExecutionResult:
        runtimes: dict[str, ApplianceRuntimeStatus] = {}
        first_error: ScheduleError | None = None

        for appliance in registry.appliances:
            executor = self._executor_for(appliance)
            runtime = await executor.async_disable_active_action(
                appliance=appliance,
                action=active_actions.get(appliance.id),
                reference_time=reference_time,
            )
            if runtime is None:
                continue
            runtimes[appliance.id] = runtime
            if runtime.outcome == "failed" and first_error is None:
                first_error = ScheduleExecutionUnavailableError(
                    runtime.message or f"Appliance {appliance.id!r} restore failed"
                )

        return AppliancesExecutionResult(
            runtimes=runtimes,
            memories={},
            first_error=first_error,
        )

    def _executor_for(self, appliance: Any) -> ApplianceExecutor:
        return self._executors[appliance.kind]
