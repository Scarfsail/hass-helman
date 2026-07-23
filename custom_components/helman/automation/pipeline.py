from __future__ import annotations

from copy import deepcopy
import functools
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
from .snapshot import OptimizationSnapshot, attach_day_contexts, snapshot_to_dict
from .trace import (
    OptimizerTrace,
    TraceWrite,
    aggregate_series_to_slots,
    price_points_to_slots,
)
from ..const import SCHEDULE_ACTION_EMPTY
from ..scheduling.schedule import (
    ScheduleAction,
    ScheduleDocument,
    ScheduleDomains,
    action_to_dict,
    iter_horizon_slot_ids,
    schedule_document_to_dict,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from ..coordinator import HelmanCoordinator
    from .compute_inputs import ComputeInputs
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
    trace: OptimizerTrace | None = None

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
        trace: OptimizerTrace | None = None,
    ) -> "AutomationRunResult":
        return cls(
            ran_automation=False,
            reason=reason,
            snapshot=snapshot,
            message=message,
            optimizers=optimizers,
            duration_ms=duration_ms,
            cleanup=cleanup,
            trace=trace,
        )

    @classmethod
    def completed(
        cls,
        *,
        snapshot: OptimizationSnapshot,
        optimizers: tuple[OptimizerRunSummary, ...] = (),
        duration_ms: int = 0,
        trace: OptimizerTrace | None = None,
    ) -> "AutomationRunResult":
        return cls(
            ran_automation=True,
            reason=None,
            snapshot=snapshot,
            optimizers=optimizers,
            duration_ms=duration_ms,
            trace=trace,
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
        trace: OptimizerTrace | None = None,
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
            trace=trace,
        )

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ranAutomation": self.ran_automation,
            "snapshot": (
                None if self.snapshot is None else snapshot_to_dict(self.snapshot)
            ),
            "dayContexts": _summarize_day_contexts(self.snapshot),
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
        if self.trace is not None:
            payload["trace"] = self.trace.to_dict()
        return payload


def _summarize_day_contexts(
    snapshot: OptimizationSnapshot | None,
) -> list[dict[str, Any]]:
    """Concise per-day summary (classification + day-min window) for the UI.

    Surfaces the frozen classification beside the run result so the frontend can
    show "today: surplus day" and why the schedule is shaped as it is, without
    digging into the full serialized snapshot.
    """
    if snapshot is None:
        return []
    summaries: list[dict[str, Any]] = []
    for local_date, day_context in sorted(snapshot.context.day_contexts.items()):
        day_min_window = day_context.day_min_window
        summaries.append(
            {
                "localDate": local_date.isoformat(),
                "classification": day_context.classification,
                "dayMinWindow": (
                    None
                    if day_min_window is None
                    else {
                        "start": day_min_window.start.isoformat(),
                        "end": day_min_window.end.isoformat(),
                    }
                ),
            }
        )
    return summaries


@dataclass(frozen=True)
class _PipelineExecutionResult:
    working_schedule_document: ScheduleDocument
    snapshot: OptimizationSnapshot
    optimizers: tuple[OptimizerRunSummary, ...]
    trace: OptimizerTrace


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
        trace: OptimizerTrace | None = None,
    ) -> None:
        super().__init__(summary.error or "")
        self.summary = summary
        self.completed_optimizers = completed_optimizers
        self.snapshot = snapshot
        self.trace = trace


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
        latest_trace: OptimizerTrace | None = None
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
                    # Gather the run-invariant live values once; every snapshot
                    # rebuild in this run reuses them instead of re-reading
                    # hass.states / the recorder per optimizer iteration.
                    compute_inputs = (
                        await self._coordinator._async_gather_compute_inputs(
                            started_at=active_reference_time,
                            include_condition_flags=True,
                        )
                    )
                    initial_snapshot = (
                        await self._coordinator._build_automation_snapshot_from_schedule_locked(
                            schedule_document=schedule_document,
                            input_bundle=input_bundle,
                            reference_time=active_reference_time,
                            compute_inputs=compute_inputs,
                        )
                    )
                    current_stage = "day_context"
                    day_contexts = await self._coordinator.async_resolve_day_contexts(
                        snapshot=initial_snapshot,
                        reference_time=active_reference_time,
                    )
                    initial_snapshot = attach_day_contexts(
                        initial_snapshot, day_contexts
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
                            day_contexts=day_contexts,
                            compute_inputs=compute_inputs,
                        )
                    except _OptimizerExecutionError as err:
                        latest_trace = err.trace
                        result = AutomationRunResult.skipped(
                            reason="optimizer_failed",
                            message=err.summary.error,
                            snapshot=err.snapshot,
                            optimizers=err.completed_optimizers + (err.summary,),
                            trace=err.trace,
                        )
                        last_result = result
                    else:
                        latest_snapshot = execution_result.snapshot
                        latest_optimizers = execution_result.optimizers
                        latest_trace = execution_result.trace
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
                            trace=execution_result.trace,
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
                    trace=(
                        latest_trace
                        if last_result is None
                        else last_result.trace
                    ),
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
        day_contexts: dict,
        compute_inputs: ComputeInputs | None = None,
    ) -> _PipelineExecutionResult:
        """Run the optimizer loop off the event loop.

        The loop is pure CPU (optimizer decisions + per-iteration snapshot
        rebuilds). The live values it needs are pre-gathered into
        ``compute_inputs`` on the loop, so the whole loop runs in a single
        executor hop and never blocks the event loop. I/O (recorder/states and
        persistence) stays on the loop, before and after this call.
        """
        if compute_inputs is None:
            compute_inputs = await self._coordinator._async_gather_compute_inputs(
                started_at=reference_time,
                include_condition_flags=True,
            )
        control_config = self._coordinator._read_schedule_control_config()

        def build_snapshot(doc: ScheduleDocument) -> OptimizationSnapshot:
            # Pure, hass-free: every live value comes from ``compute_inputs``.
            return self._coordinator._build_automation_snapshot_from_schedule_pure(
                schedule_document=doc,
                input_bundle=input_bundle,
                reference_time=reference_time,
                day_contexts=day_contexts,
                compute_inputs=compute_inputs,
            )

        return await self._coordinator._hass.async_add_executor_job(
            functools.partial(
                run_optimizer_loop_pure,
                execution_optimizers=self._automation_config.execution_optimizers,
                baseline_schedule_document=baseline_schedule_document,
                schedule_document=schedule_document,
                initial_snapshot=initial_snapshot,
                reference_time=reference_time,
                control_config=control_config,
                appliance_registry=self._coordinator._appliances_registry,
                build_snapshot=build_snapshot,
            )
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
            trace=result.trace,
        )
        _log_run_result(result=finalized, run_reason=run_reason)
        return finalized


def run_optimizer_loop_pure(
    *,
    execution_optimizers: "Sequence[OptimizerInstanceConfig]",
    baseline_schedule_document: ScheduleDocument,
    schedule_document: ScheduleDocument,
    initial_snapshot: OptimizationSnapshot,
    reference_time: datetime,
    control_config: Any,
    appliance_registry: Any,
    build_snapshot: "Callable[[ScheduleDocument], OptimizationSnapshot]",
) -> _PipelineExecutionResult:
    """Pure, synchronous optimizer loop — safe to run in an executor.

    Contains no ``hass`` access and no ``await``. ``build_snapshot`` rebuilds the
    optimization snapshot from a schedule document using the pre-gathered
    (hass-free) compute inputs, so every per-iteration rebuild stays pure too.
    """
    working_schedule_document = schedule_document
    snapshot = initial_snapshot
    optimizer_summaries: list[OptimizerRunSummary] = []
    trace = OptimizerTrace(slot_ids=iter_horizon_slot_ids(reference_time))
    trace.set_static_rails(
        _safe_capture(_capture_static_rails, initial_snapshot, trace.slot_ids)
    )
    for optimizer_config in execution_optimizers:
        optimizer_started_at = time.perf_counter()
        trace.begin_step(optimizer_config.id, optimizer_config.kind)
        # Stamp the step with its execution-condition state so the run
        # explanation can present this optimizer's placements as candidates
        # (tentative, won't execute) rather than as planned-for-execution.
        trace.set_condition_met(
            snapshot.context.condition_met_by_optimizer_id.get(
                optimizer_config.id, True
            )
        )
        # railsIn is the rail segment the optimizer received (pre-rebuild).
        trace.set_rails_in(
            _safe_capture(_capture_step_rails, snapshot, trace.slot_ids)
        )
        try:
            optimizer = build_optimizer(
                optimizer_config,
                control_config=control_config,
                appliance_registry=appliance_registry,
            )
            candidate_schedule_document = optimizer.optimize(
                snapshot,
                optimizer_config,
                trace,
            )
        except SurplusApplianceSkip as err:
            try:
                working_schedule_document = restore_automation_owned_appliance_actions(
                    baseline=baseline_schedule_document,
                    current=working_schedule_document,
                    appliance_id=err.appliance_id,
                )
                snapshot = build_snapshot(working_schedule_document)
            except Exception as rebuild_err:
                trace.end_step(status="failed")
                raise _build_optimizer_error(
                    config=optimizer_config,
                    duration_ms=_elapsed_ms(optimizer_started_at),
                    error=str(rebuild_err),
                    completed_optimizers=tuple(optimizer_summaries),
                    snapshot=snapshot,
                    trace=trace,
                ) from rebuild_err
            # Skip discards partial decisions and collapses the column to a
            # single horizon-wide `skipped` note; the validator exempts it.
            trace.discard_step_decisions()
            trace.note_horizon(
                code="optimizer_skipped",
                params={"applianceId": err.appliance_id, "reason": str(err)},
            )
            trace.end_step(status="skipped")
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
            trace.end_step(status="failed")
            raise _build_optimizer_error(
                config=optimizer_config,
                duration_ms=_elapsed_ms(optimizer_started_at),
                error=str(err),
                completed_optimizers=tuple(optimizer_summaries),
                snapshot=snapshot,
                trace=trace,
            ) from err

        previous_schedule_document = working_schedule_document
        try:
            working_schedule_document = _coerce_optimizer_result_schedule_document(
                candidate_document=candidate_schedule_document,
                execution_enabled=working_schedule_document.execution_enabled,
            )
            snapshot = build_snapshot(working_schedule_document)
        except Exception as err:
            trace.end_step(status="failed")
            raise _build_optimizer_error(
                config=optimizer_config,
                duration_ms=_elapsed_ms(optimizer_started_at),
                error=str(err),
                completed_optimizers=tuple(optimizer_summaries),
                snapshot=snapshot,
                trace=trace,
            ) from err
        write_records = _collect_changed_writable_action_records(
            before_document=previous_schedule_document,
            after_document=working_schedule_document,
        )
        trace.record_writes(write_records)
        trace.end_step(status="ok")
        optimizer_summaries.append(
            _build_optimizer_summary(
                optimizer_id=optimizer_config.id,
                optimizer_kind=optimizer_config.kind,
                status="ok",
                slots_written=len(write_records),
                duration_ms=_elapsed_ms(optimizer_started_at),
            )
        )
    trace.set_rails_final(
        _safe_capture(_capture_step_rails, snapshot, trace.slot_ids)
    )
    return _PipelineExecutionResult(
        working_schedule_document=working_schedule_document,
        snapshot=snapshot,
        optimizers=tuple(optimizer_summaries),
        trace=trace,
    )


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
    trace: OptimizerTrace | None = None,
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
        trace=trace,
    )


def _safe_capture(
    capture,
    snapshot: OptimizationSnapshot,
    slot_ids: tuple[str, ...],
) -> dict[str, list[float | None]]:
    """Run a rail-capture helper without ever failing the run."""
    try:
        return capture(snapshot, slot_ids)
    except Exception:  # pragma: no cover - observability must not fail runs
        _LOGGER.exception("trace rail capture failed; run continues")
        return {}


def _capture_static_rails(
    snapshot: OptimizationSnapshot,
    slot_ids: tuple[str, ...],
) -> dict[str, list[float | None]]:
    """Per-run rails identical at every step: prices + solar/baseline house."""
    battery_series = snapshot.battery_forecast.get("series")
    energy = aggregate_series_to_slots(
        battery_series,
        slot_ids,
        sum_fields=("solarKwh", "baselineHouseKwh"),
    )
    return {
        "importPrice": price_points_to_slots(
            snapshot.context.import_price_forecast.get("points"), slot_ids
        ),
        "exportPrice": price_points_to_slots(
            snapshot.context.export_price_forecast.get("points"), slot_ids
        ),
        "solarKwh": energy["solarKwh"],
        "houseKwh": energy["baselineHouseKwh"],
    }


def _capture_step_rails(
    snapshot: OptimizationSnapshot,
    slot_ids: tuple[str, ...],
) -> dict[str, list[float | None]]:
    """Step-sensitive rails: the system parameters an optimizer can move.

    Captured before each step and after the last one, so the frontend can show
    every decision's effect as a before->after delta (this step's rail vs the
    next step's). Surplus is the redirectable solar; SoC is the projected
    trajectory; import/export energy are the effective grid flows after the
    battery schedule the step just changed.
    """
    surplus = aggregate_series_to_slots(
        snapshot.grid_forecast.get("series"),
        slot_ids,
        sum_fields=("availableSurplusKwh",),
    )
    battery = aggregate_series_to_slots(
        snapshot.battery_forecast.get("series"),
        slot_ids,
        sum_fields=("importedFromGridKwh", "exportedToGridKwh"),
        last_fields=("socPct",),
    )
    return {
        "availableSurplusKwh": surplus["availableSurplusKwh"],
        "batterySocPct": battery["socPct"],
        "importedFromGridKwh": battery["importedFromGridKwh"],
        "exportedToGridKwh": battery["exportedToGridKwh"],
    }


def _write_action_to_dict(action: Any) -> dict[str, Any] | None:
    """Serialize a schedule action for the trace, treating empty as ``None``.

    Inverter actions are ``ScheduleAction`` objects; appliance actions are plain
    serializable dicts (``{"on": True, "setBy": ...}``).
    """
    if action is None:
        return None
    if isinstance(action, ScheduleAction):
        if action.kind == SCHEDULE_ACTION_EMPTY:
            return None
        return action_to_dict(action)
    if isinstance(action, dict):
        return dict(action)
    return None


def _collect_changed_writable_action_records(
    *,
    before_document: ScheduleDocument,
    after_document: ScheduleDocument,
) -> list[TraceWrite]:
    """Ground-truth committed writes (layer 1): the schedule positions the
    optimizer actually changed, excluding user-owned positions."""
    records: list[TraceWrite] = []
    for slot_id in sorted(set(before_document.slots) | set(after_document.slots)):
        before_domains = before_document.slots.get(slot_id, ScheduleDomains())
        after_domains = after_document.slots.get(slot_id, ScheduleDomains())
        if (
            before_domains.inverter != after_domains.inverter
            and not is_user_owned_inverter_action(before_domains.inverter)
            and not is_user_owned_inverter_action(after_domains.inverter)
        ):
            records.append(
                TraceWrite(
                    slot_id=slot_id,
                    domain="inverter",
                    before=_write_action_to_dict(before_domains.inverter),
                    after=_write_action_to_dict(after_domains.inverter),
                )
            )
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
            records.append(
                TraceWrite(
                    slot_id=slot_id,
                    domain=f"appliance:{appliance_id}",
                    before=_write_action_to_dict(before_action),
                    after=_write_action_to_dict(after_action),
                )
            )
    return records


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
    trace: OptimizerTrace | None = None,
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
        trace=trace,
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
