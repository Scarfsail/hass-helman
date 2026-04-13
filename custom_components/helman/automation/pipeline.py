from __future__ import annotations

from copy import deepcopy
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from .config import AutomationConfig
from .input_bundle import AutomationInputBundle
from .optimizers.surplus_appliance import SurplusApplianceSkip
from .ownership import (
    restore_automation_owned_appliance_actions,
    strip_automation_owned_actions,
)
from .optimizer import build_optimizer
from .snapshot import OptimizationSnapshot, snapshot_to_dict
from ..scheduling.schedule import ScheduleDocument, schedule_document_to_dict

if TYPE_CHECKING:
    from ..coordinator import HelmanCoordinator
    from .config import OptimizerInstanceConfig
    from .optimizer import Optimizer

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class AutomationRunResult:
    ran_automation: bool
    reason: str | None = None
    snapshot: OptimizationSnapshot | None = None
    message: str | None = None

    @classmethod
    def skipped(
        cls,
        *,
        reason: str,
        message: str | None = None,
    ) -> "AutomationRunResult":
        return cls(
            ran_automation=False,
            reason=reason,
            snapshot=None,
            message=message,
        )

    @classmethod
    def completed(
        cls,
        *,
        snapshot: OptimizationSnapshot,
    ) -> "AutomationRunResult":
        return cls(ran_automation=True, reason=None, snapshot=snapshot)

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ranAutomation": self.ran_automation,
            "snapshot": (
                None if self.snapshot is None else snapshot_to_dict(self.snapshot)
            ),
        }
        if self.reason is not None:
            payload["reason"] = self.reason
        if self.message is not None:
            payload["message"] = self.message
        return payload


@dataclass(frozen=True)
class _ResolvedOptimizerStep:
    config: "OptimizerInstanceConfig"
    optimizer: "Optimizer"


@dataclass(frozen=True)
class _PipelineExecutionResult:
    working_schedule_document: ScheduleDocument
    snapshot: OptimizationSnapshot


class _OptimizerExecutionError(RuntimeError):
    def __init__(
        self,
        *,
        optimizer_id: str,
        optimizer_kind: str,
        cause: Exception,
    ) -> None:
        super().__init__(str(cause))
        self.optimizer_id = optimizer_id
        self.optimizer_kind = optimizer_kind


class AutomationRunner:
    def __init__(
        self,
        *,
        coordinator: "HelmanCoordinator",
        automation_config: AutomationConfig,
    ) -> None:
        self._coordinator = coordinator
        self._automation_config = automation_config

    async def run(
        self,
        *,
        reference_time: datetime | None = None,
    ) -> AutomationRunResult:
        active_reference_time = reference_time or dt_util.now()
        result: AutomationRunResult
        run_post_write_side_effects = False
        async with self._coordinator._schedule_lock:
            baseline_schedule_document = (
                self._coordinator._build_automation_working_schedule_document_locked(
                    reference_time=active_reference_time
                )
            )
            schedule_document = strip_automation_owned_actions(
                baseline_schedule_document
            )
            if not baseline_schedule_document.execution_enabled:
                return AutomationRunResult.skipped(reason="execution_disabled")

            if not self._automation_config.enabled:
                run_post_write_side_effects = await self._async_persist_cleanup_only_locked(
                    reference_time=active_reference_time,
                    cleaned_schedule_document=schedule_document,
                )
                result = AutomationRunResult.skipped(reason="automation_disabled")
            elif not self._automation_config.execution_optimizers:
                run_post_write_side_effects = await self._async_persist_cleanup_only_locked(
                    reference_time=active_reference_time,
                    cleaned_schedule_document=schedule_document,
                )
                result = AutomationRunResult.skipped(reason="no_enabled_optimizers")
            else:
                input_bundle = self._coordinator.get_automation_input_bundle()
                if input_bundle is None:
                    return AutomationRunResult.skipped(reason="inputs_unavailable")
                try:
                    execution_result = await self._async_execute_optimizer_loop_locked(
                        baseline_schedule_document=baseline_schedule_document,
                        schedule_document=schedule_document,
                        input_bundle=input_bundle,
                        reference_time=active_reference_time,
                    )
                except _OptimizerExecutionError as err:
                    _LOGGER.warning(
                        "Automation optimizer %s (%s) failed: %s",
                        err.optimizer_id,
                        err.optimizer_kind,
                        err,
                    )
                    return AutomationRunResult.skipped(
                        reason="optimizer_failed",
                        message=str(err),
                    )
                run_post_write_side_effects = (
                    await self._coordinator._persist_automation_result_locked(
                        automation_result=execution_result.working_schedule_document,
                        reference_time=active_reference_time,
                    )
                )
                result = AutomationRunResult.completed(snapshot=execution_result.snapshot)
        if run_post_write_side_effects:
            await self._coordinator._async_run_post_schedule_write_side_effects(
                reason="automation_updated",
                reference_time=active_reference_time,
            )
        return result

    def _resolve_optimizer_steps(self) -> tuple[_ResolvedOptimizerStep, ...]:
        control_config = self._coordinator._read_schedule_control_config()
        steps: list[_ResolvedOptimizerStep] = []
        for optimizer_config in self._automation_config.execution_optimizers:
            try:
                optimizer = build_optimizer(
                    optimizer_config,
                    control_config=control_config,
                    appliance_registry=self._coordinator._appliances_registry,
                )
            except Exception as err:
                raise _OptimizerExecutionError(
                    optimizer_id=optimizer_config.id,
                    optimizer_kind=optimizer_config.kind,
                    cause=err,
                ) from err
            steps.append(
                _ResolvedOptimizerStep(
                    config=optimizer_config,
                    optimizer=optimizer,
                )
            )
        return tuple(steps)

    async def _async_execute_optimizer_loop_locked(
        self,
        *,
        baseline_schedule_document: ScheduleDocument,
        schedule_document: ScheduleDocument,
        input_bundle: AutomationInputBundle,
        reference_time: datetime,
    ) -> _PipelineExecutionResult:
        steps = self._resolve_optimizer_steps()
        working_schedule_document = schedule_document
        snapshot = await self._coordinator._build_automation_snapshot_from_schedule_locked(
            schedule_document=working_schedule_document,
            input_bundle=input_bundle,
            reference_time=reference_time,
        )
        for step in steps:
            try:
                candidate_schedule_document = step.optimizer.optimize(
                    snapshot,
                    step.config,
                )
            except SurplusApplianceSkip as err:
                _LOGGER.warning(
                    "Automation optimizer %s (%s) is skipping because %s",
                    step.config.id,
                    step.config.kind,
                    err,
                )
                working_schedule_document = restore_automation_owned_appliance_actions(
                    baseline=baseline_schedule_document,
                    current=working_schedule_document,
                    appliance_id=err.appliance_id,
                )
                snapshot = await self._coordinator._build_automation_snapshot_from_schedule_locked(
                    schedule_document=working_schedule_document,
                    input_bundle=input_bundle,
                    reference_time=reference_time,
                )
                continue
            except Exception as err:
                raise _OptimizerExecutionError(
                    optimizer_id=step.config.id,
                    optimizer_kind=step.config.kind,
                    cause=err,
                ) from err
            working_schedule_document = _coerce_optimizer_result_schedule_document(
                candidate_document=candidate_schedule_document,
                execution_enabled=working_schedule_document.execution_enabled,
            )
            snapshot = await self._coordinator._build_automation_snapshot_from_schedule_locked(
                schedule_document=working_schedule_document,
                input_bundle=input_bundle,
                reference_time=reference_time,
            )
        return _PipelineExecutionResult(
            working_schedule_document=working_schedule_document,
            snapshot=snapshot,
        )

    async def _async_persist_cleanup_only_locked(
        self,
        *,
        reference_time: datetime,
        cleaned_schedule_document,
    ) -> bool:
        baseline_schedule_document = (
            await self._coordinator._load_pruned_schedule_document_locked(
                reference_time=reference_time
            )
        )
        if schedule_document_to_dict(
            cleaned_schedule_document
        ) == schedule_document_to_dict(baseline_schedule_document):
            return False
        await self._coordinator._save_schedule_document(cleaned_schedule_document)
        return True


def _coerce_optimizer_result_schedule_document(
    *,
    candidate_document: ScheduleDocument,
    execution_enabled: bool,
) -> ScheduleDocument:
    return ScheduleDocument(
        execution_enabled=execution_enabled,
        slots=deepcopy(candidate_document.slots),
    )
