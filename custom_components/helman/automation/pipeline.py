from __future__ import annotations

from copy import deepcopy
import logging
from dataclasses import dataclass
from datetime import datetime
import time
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from .config import AutomationConfig
from .input_bundle import AutomationInputBundle
from .optimizers.surplus_appliance import SurplusApplianceSkip
from .ownership import (
    count_automation_owned_actions,
    is_user_owned_appliance_action,
    is_user_owned_inverter_action,
    restore_automation_owned_appliance_actions,
    strip_automation_owned_actions,
)
from .optimizer import build_optimizer
from .snapshot import OptimizationSnapshot, snapshot_to_dict
from ..scheduling.schedule import (
    ScheduleDocument,
    ScheduleDomains,
    schedule_document_to_dict,
)

if TYPE_CHECKING:
    from ..coordinator import HelmanCoordinator
    from .config import OptimizerInstanceConfig

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class AutomationCleanupSummary:
    reason: str
    actions_stripped: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "reason": self.reason,
            "actionsStripped": self.actions_stripped,
        }


@dataclass(frozen=True)
class AutomationRunFailure:
    stage: str
    message: str
    unexpected: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "message": self.message,
            "unexpected": self.unexpected,
        }


@dataclass(frozen=True)
class OptimizerRunSummary:
    id: str
    kind: str
    status: str
    slots_written: int
    duration_ms: int
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "slotsWritten": self.slots_written,
            "durationMs": self.duration_ms,
        }
        if self.error is not None:
            payload["error"] = self.error
        return payload


@dataclass(frozen=True)
class AutomationRunResult:
    ran_automation: bool
    reason: str | None = None
    snapshot: OptimizationSnapshot | None = None
    message: str | None = None
    optimizers: tuple[OptimizerRunSummary, ...] = ()
    duration_ms: int = 0
    cleanup: AutomationCleanupSummary | None = None
    failure: AutomationRunFailure | None = None

    @classmethod
    def skipped(
        cls,
        *,
        reason: str,
        message: str | None = None,
        snapshot: OptimizationSnapshot | None = None,
        optimizers: tuple[OptimizerRunSummary, ...] = (),
        duration_ms: int = 0,
        cleanup: AutomationCleanupSummary | None = None,
    ) -> "AutomationRunResult":
        return cls(
            ran_automation=False,
            reason=reason,
            snapshot=snapshot,
            message=message,
            optimizers=optimizers,
            duration_ms=duration_ms,
            cleanup=cleanup,
        )

    @classmethod
    def completed(
        cls,
        *,
        snapshot: OptimizationSnapshot,
        optimizers: tuple[OptimizerRunSummary, ...] = (),
        duration_ms: int = 0,
    ) -> "AutomationRunResult":
        return cls(
            ran_automation=True,
            reason=None,
            snapshot=snapshot,
            optimizers=optimizers,
            duration_ms=duration_ms,
        )

    @classmethod
    def failed(
        cls,
        *,
        reason: str,
        failure: AutomationRunFailure,
        ran_automation: bool = False,
        snapshot: OptimizationSnapshot | None = None,
        optimizers: tuple[OptimizerRunSummary, ...] = (),
        duration_ms: int = 0,
        cleanup: AutomationCleanupSummary | None = None,
    ) -> "AutomationRunResult":
        return cls(
            ran_automation=ran_automation,
            reason=reason,
            snapshot=snapshot,
            message=failure.message,
            optimizers=optimizers,
            duration_ms=duration_ms,
            cleanup=cleanup,
            failure=failure,
        )

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ranAutomation": self.ran_automation,
            "snapshot": (
                None if self.snapshot is None else snapshot_to_dict(self.snapshot)
            ),
            "optimizers": [optimizer.to_dict() for optimizer in self.optimizers],
            "durationMs": self.duration_ms,
        }
        if self.reason is not None:
            payload["reason"] = self.reason
        if self.message is not None:
            payload["message"] = self.message
        if self.cleanup is not None:
            payload["cleanup"] = self.cleanup.to_dict()
        if self.failure is not None:
            payload["failure"] = self.failure.to_dict()
        return payload


@dataclass(frozen=True)
class _PipelineExecutionResult:
    working_schedule_document: ScheduleDocument
    snapshot: OptimizationSnapshot
    optimizers: tuple[OptimizerRunSummary, ...]


@dataclass(frozen=True)
class _CleanupOutcome:
    changed: bool
    actions_stripped: int


class _OptimizerExecutionError(RuntimeError):
    def __init__(
        self,
        *,
        summary: OptimizerRunSummary,
        completed_optimizers: tuple[OptimizerRunSummary, ...] = (),
        snapshot: OptimizationSnapshot | None = None,
    ) -> None:
        super().__init__(summary.error or "")
        self.summary = summary
        self.completed_optimizers = completed_optimizers
        self.snapshot = snapshot


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
        run_reason: str | None = None,
    ) -> AutomationRunResult:
        active_reference_time = reference_time or dt_util.now()
        run_started_at = time.perf_counter()
        result: AutomationRunResult
        run_post_write_side_effects = False
        last_result: AutomationRunResult | None = None
        latest_snapshot: OptimizationSnapshot | None = None
        latest_optimizers: tuple[OptimizerRunSummary, ...] = ()
        current_stage = "baseline_schedule"
        try:
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
                    result = AutomationRunResult.skipped(reason="execution_disabled")
                    return self._finalize_result(
                        result=result,
                        run_reason=run_reason,
                        run_started_at=run_started_at,
                    )

                if not self._automation_config.enabled:
                    current_stage = "cleanup_persist"
                    cleanup_outcome = await self._async_persist_cleanup_only_locked(
                        baseline_schedule_document=baseline_schedule_document,
                        cleaned_schedule_document=schedule_document,
                    )
                    run_post_write_side_effects = cleanup_outcome.changed
                    result = _build_cleanup_only_or_skipped_result(
                        cleanup_reason="automation_disabled",
                        cleanup_outcome=cleanup_outcome,
                    )
                    last_result = result
                elif not self._automation_config.execution_optimizers:
                    current_stage = "cleanup_persist"
                    cleanup_outcome = await self._async_persist_cleanup_only_locked(
                        baseline_schedule_document=baseline_schedule_document,
                        cleaned_schedule_document=schedule_document,
                    )
                    run_post_write_side_effects = cleanup_outcome.changed
                    result = _build_cleanup_only_or_skipped_result(
                        cleanup_reason="no_enabled_optimizers",
                        cleanup_outcome=cleanup_outcome,
                    )
                    last_result = result
                else:
                    input_bundle = self._coordinator.get_automation_input_bundle()
                    if input_bundle is None:
                        result = AutomationRunResult.skipped(reason="inputs_unavailable")
                        return self._finalize_result(
                            result=result,
                            run_reason=run_reason,
                            run_started_at=run_started_at,
                        )
                    current_stage = "initial_snapshot"
                    initial_snapshot = (
                        await self._coordinator._build_automation_snapshot_from_schedule_locked(
                            schedule_document=schedule_document,
                            input_bundle=input_bundle,
                            reference_time=active_reference_time,
                        )
                    )
                    latest_snapshot = initial_snapshot
                    try:
                        current_stage = "optimizer_loop"
                        execution_result = await self._async_execute_optimizer_loop_locked(
                            baseline_schedule_document=baseline_schedule_document,
                            schedule_document=schedule_document,
                            input_bundle=input_bundle,
                            reference_time=active_reference_time,
                            initial_snapshot=initial_snapshot,
                        )
                    except _OptimizerExecutionError as err:
                        result = AutomationRunResult.skipped(
                            reason="optimizer_failed",
                            message=err.summary.error,
                            snapshot=err.snapshot,
                            optimizers=err.completed_optimizers + (err.summary,),
                        )
                        last_result = result
                    else:
                        latest_snapshot = execution_result.snapshot
                        latest_optimizers = execution_result.optimizers
                        current_stage = "final_persist"
                        run_post_write_side_effects = (
                            await self._coordinator._persist_automation_result_locked(
                                automation_result=execution_result.working_schedule_document,
                                reference_time=active_reference_time,
                            )
                        )
                        result = AutomationRunResult.completed(
                            snapshot=execution_result.snapshot,
                            optimizers=execution_result.optimizers,
                        )
                        last_result = result
            if run_post_write_side_effects:
                current_stage = "post_write_side_effects"
                await self._coordinator._async_run_post_schedule_write_side_effects(
                    reason="automation_updated",
                    reference_time=active_reference_time,
                )
            return self._finalize_result(
                result=result,
                run_reason=run_reason,
                run_started_at=run_started_at,
            )
        except Exception as err:
            _LOGGER.exception(
                "Automation runner failed unexpectedly during %s",
                current_stage,
            )
            return self._finalize_result(
                result=_build_runner_failed_result(
                    stage=current_stage,
                    error=err,
                    snapshot=(
                        latest_snapshot
                        if last_result is None
                        else last_result.snapshot
                    ),
                    optimizers=(
                        latest_optimizers
                        if last_result is None
                        else last_result.optimizers
                    ),
                    ran_automation=False if last_result is None else last_result.ran_automation,
                    cleanup=None if last_result is None else last_result.cleanup,
                ),
                run_reason=run_reason,
                run_started_at=run_started_at,
            )

    async def _async_execute_optimizer_loop_locked(
        self,
        *,
        baseline_schedule_document: ScheduleDocument,
        schedule_document: ScheduleDocument,
        input_bundle: AutomationInputBundle,
        reference_time: datetime,
        initial_snapshot: OptimizationSnapshot,
    ) -> _PipelineExecutionResult:
        working_schedule_document = schedule_document
        snapshot = initial_snapshot
        control_config = self._coordinator._read_schedule_control_config()
        optimizer_summaries: list[OptimizerRunSummary] = []
        for optimizer_config in self._automation_config.execution_optimizers:
            optimizer_started_at = time.perf_counter()
            try:
                optimizer = build_optimizer(
                    optimizer_config,
                    control_config=control_config,
                    appliance_registry=self._coordinator._appliances_registry,
                )
                candidate_schedule_document = optimizer.optimize(
                    snapshot,
                    optimizer_config,
                )
            except SurplusApplianceSkip as err:
                try:
                    working_schedule_document = restore_automation_owned_appliance_actions(
                        baseline=baseline_schedule_document,
                        current=working_schedule_document,
                        appliance_id=err.appliance_id,
                    )
                    snapshot = (
                        await self._coordinator._build_automation_snapshot_from_schedule_locked(
                            schedule_document=working_schedule_document,
                            input_bundle=input_bundle,
                            reference_time=reference_time,
                        )
                    )
                except Exception as rebuild_err:
                    raise _build_optimizer_error(
                        config=optimizer_config,
                        duration_ms=_elapsed_ms(optimizer_started_at),
                        error=str(rebuild_err),
                        completed_optimizers=tuple(optimizer_summaries),
                        snapshot=snapshot,
                    ) from rebuild_err
                optimizer_summaries.append(
                    _build_optimizer_summary(
                        optimizer_id=optimizer_config.id,
                        optimizer_kind=optimizer_config.kind,
                        status="skipped",
                        slots_written=0,
                        duration_ms=_elapsed_ms(optimizer_started_at),
                        error=str(err),
                    )
                )
                continue
            except Exception as err:
                raise _build_optimizer_error(
                    config=optimizer_config,
                    duration_ms=_elapsed_ms(optimizer_started_at),
                    error=str(err),
                    completed_optimizers=tuple(optimizer_summaries),
                    snapshot=snapshot,
                ) from err

            previous_schedule_document = working_schedule_document
            try:
                working_schedule_document = _coerce_optimizer_result_schedule_document(
                    candidate_document=candidate_schedule_document,
                    execution_enabled=working_schedule_document.execution_enabled,
                )
                snapshot = await self._coordinator._build_automation_snapshot_from_schedule_locked(
                    schedule_document=working_schedule_document,
                    input_bundle=input_bundle,
                    reference_time=reference_time,
                )
            except Exception as err:
                raise _build_optimizer_error(
                    config=optimizer_config,
                    duration_ms=_elapsed_ms(optimizer_started_at),
                    error=str(err),
                    completed_optimizers=tuple(optimizer_summaries),
                    snapshot=snapshot,
                ) from err
            optimizer_summaries.append(
                _build_optimizer_summary(
                    optimizer_id=optimizer_config.id,
                    optimizer_kind=optimizer_config.kind,
                    status="ok",
                    slots_written=_count_changed_writable_action_positions(
                        before_document=previous_schedule_document,
                        after_document=working_schedule_document,
                    ),
                    duration_ms=_elapsed_ms(optimizer_started_at),
                )
            )
        return _PipelineExecutionResult(
            working_schedule_document=working_schedule_document,
            snapshot=snapshot,
            optimizers=tuple(optimizer_summaries),
        )

    async def _async_persist_cleanup_only_locked(
        self,
        *,
        baseline_schedule_document: ScheduleDocument,
        cleaned_schedule_document: ScheduleDocument,
    ) -> _CleanupOutcome:
        actions_stripped = count_automation_owned_actions(baseline_schedule_document)
        if schedule_document_to_dict(
            cleaned_schedule_document
        ) == schedule_document_to_dict(baseline_schedule_document):
            return _CleanupOutcome(
                changed=False,
                actions_stripped=actions_stripped,
            )
        await self._coordinator._save_schedule_document(cleaned_schedule_document)
        return _CleanupOutcome(
            changed=True,
            actions_stripped=actions_stripped,
        )

    def _finalize_result(
        self,
        *,
        result: AutomationRunResult,
        run_reason: str | None,
        run_started_at: float,
    ) -> AutomationRunResult:
        finalized = AutomationRunResult(
            ran_automation=result.ran_automation,
            reason=result.reason,
            snapshot=result.snapshot,
            message=result.message,
            optimizers=result.optimizers,
            duration_ms=_elapsed_ms(run_started_at),
            cleanup=result.cleanup,
            failure=result.failure,
        )
        _log_run_result(result=finalized, run_reason=run_reason)
        return finalized


def _coerce_optimizer_result_schedule_document(
    *,
    candidate_document: ScheduleDocument,
    execution_enabled: bool,
) -> ScheduleDocument:
    return ScheduleDocument(
        execution_enabled=execution_enabled,
        slots=deepcopy(candidate_document.slots),
    )


def _build_cleanup_only_or_skipped_result(
    *,
    cleanup_reason: str,
    cleanup_outcome: _CleanupOutcome,
) -> AutomationRunResult:
    if not cleanup_outcome.changed:
        return AutomationRunResult.skipped(reason=cleanup_reason)
    return AutomationRunResult.skipped(
        reason="cleanup_only",
        cleanup=AutomationCleanupSummary(
            reason=cleanup_reason,
            actions_stripped=cleanup_outcome.actions_stripped,
        ),
    )


def _build_runner_failed_result(
    *,
    stage: str,
    error: Exception,
    snapshot: OptimizationSnapshot | None = None,
    optimizers: tuple[OptimizerRunSummary, ...] = (),
    ran_automation: bool = False,
    cleanup: AutomationCleanupSummary | None = None,
) -> AutomationRunResult:
    message = _format_exception_message(error)
    return AutomationRunResult.failed(
        reason="runner_failed",
        failure=AutomationRunFailure(
            stage=stage,
            message=message,
        ),
        ran_automation=ran_automation,
        snapshot=snapshot,
        optimizers=optimizers,
        cleanup=cleanup,
    )


def _count_changed_writable_action_positions(
    *,
    before_document: ScheduleDocument,
    after_document: ScheduleDocument,
) -> int:
    changed_positions = 0
    for slot_id in sorted(set(before_document.slots) | set(after_document.slots)):
        before_domains = before_document.slots.get(slot_id, ScheduleDomains())
        after_domains = after_document.slots.get(slot_id, ScheduleDomains())
        if (
            before_domains.inverter != after_domains.inverter
            and not is_user_owned_inverter_action(before_domains.inverter)
            and not is_user_owned_inverter_action(after_domains.inverter)
        ):
            changed_positions += 1
        for appliance_id in sorted(
            set(before_domains.appliances) | set(after_domains.appliances)
        ):
            before_action = before_domains.appliances.get(appliance_id)
            after_action = after_domains.appliances.get(appliance_id)
            if before_action == after_action:
                continue
            if is_user_owned_appliance_action(
                before_action
            ) or is_user_owned_appliance_action(after_action):
                continue
            changed_positions += 1
    return changed_positions


def _build_optimizer_summary(
    *,
    optimizer_id: str,
    optimizer_kind: str,
    status: str,
    slots_written: int,
    duration_ms: int,
    error: str | None = None,
) -> OptimizerRunSummary:
    return OptimizerRunSummary(
        id=optimizer_id,
        kind=optimizer_kind,
        status=status,
        slots_written=slots_written,
        duration_ms=duration_ms,
        error=error,
    )


def _build_optimizer_error(
    *,
    config: "OptimizerInstanceConfig",
    duration_ms: int,
    error: str,
    completed_optimizers: tuple[OptimizerRunSummary, ...],
    snapshot: OptimizationSnapshot | None,
) -> _OptimizerExecutionError:
    return _OptimizerExecutionError(
        summary=_build_optimizer_summary(
            optimizer_id=config.id,
            optimizer_kind=config.kind,
            status="failed",
            slots_written=0,
            duration_ms=duration_ms,
            error=error,
        ),
        completed_optimizers=completed_optimizers,
        snapshot=snapshot,
    )


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.perf_counter() - started_at) * 1000))


def _format_exception_message(error: Exception) -> str:
    return str(error) or error.__class__.__name__


def _log_run_result(
    *,
    result: AutomationRunResult,
    run_reason: str | None,
) -> None:
    cleanup_reason = None if result.cleanup is None else result.cleanup.reason
    cleanup_actions = 0 if result.cleanup is None else result.cleanup.actions_stripped
    failure_stage = None if result.failure is None else result.failure.stage
    _LOGGER.info(
        "automation run result trigger=%s outcome=%s ran=%s optimizers=%s duration_ms=%s cleanup_reason=%s cleanup_actions=%s failure_stage=%s",
        run_reason or "manual",
        result.reason or "completed",
        result.ran_automation,
        len(result.optimizers),
        result.duration_ms,
        cleanup_reason,
        cleanup_actions,
        failure_stage,
    )
    for optimizer in result.optimizers:
        _LOGGER.debug(
            "automation optimizer result id=%s kind=%s status=%s slots_written=%s duration_ms=%s error=%s",
            optimizer.id,
            optimizer.kind,
            optimizer.status,
            optimizer.slots_written,
            optimizer.duration_ms,
            optimizer.error,
        )
