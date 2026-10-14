"""Test-only snapshot capture and classification for reserve-floor scenarios."""

from dataclasses import dataclass
import logging
from typing import Any

from custom_components.helman.automation.pipeline import run_optimizer_loop_pure as _run_loop

from reserve_floor_classifier import (
    ReserveFloorBoundary,
    ReserveFloorResult,
    classify_reserve_floor_observations,
)

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class DiagnosticRunResult:
    run: Any
    reserve_floor_results: tuple[ReserveFloorResult, ...]

    def __getattr__(self, name: str) -> Any:
        return getattr(self.run, name)


def _safe_build_snapshot(build_snapshot, document):
    try:
        return build_snapshot(document)
    except Exception:
        _LOGGER.debug("reserve floor control snapshot capture failed", exc_info=True)
        return None


def _safe_build_reserve_floor_boundary(*, build_snapshot, working_schedule_document):
    try:
        return ReserveFloorBoundary(
            snapshot=build_snapshot(working_schedule_document),
            demand_document=working_schedule_document,
        )
    except Exception:
        _LOGGER.debug("reserve floor boundary capture failed", exc_info=True)
        return None


def _safe_classify_reserve_floor(observations, **kwargs):
    try:
        return classify_reserve_floor_observations(observations, **kwargs)
    except Exception:
        _LOGGER.debug("reserve floor classification batch failed", exc_info=True)
        return tuple(
            ReserveFloorResult(
                optimizer_id=observation.optimizer_id,
                group_index=observation.group_index,
                window=observation.window,
                status="failed",
            )
            for observation in observations
        )


def run_optimizer_loop_pure(*, capture_reserve_floor_diagnostics=False, **kwargs):
    if not capture_reserve_floor_diagnostics or not any(
        optimizer.kind == "charge_from_grid" for optimizer in kwargs["system_optimizers"]
    ):
        return DiagnosticRunResult(_run_loop(**kwargs), ())

    build_snapshot = kwargs["build_snapshot"]
    control_snapshot = _safe_build_snapshot(build_snapshot, kwargs["schedule_document"])
    boundaries = {}
    observed_count = 0

    def on_step_end(working_document, trace):
        nonlocal observed_count
        observations = trace.reserve_floor_observations[observed_count:]
        observed_count = len(trace.reserve_floor_observations)
        if observations:
            boundary = _safe_build_reserve_floor_boundary(
                build_snapshot=build_snapshot,
                working_schedule_document=working_document,
            )
            if boundary is not None:
                for observation in observations:
                    boundaries[observation.optimizer_id] = boundary

    run = _run_loop(**kwargs, on_step_end=on_step_end)
    observations = run.trace.reserve_floor_observations
    results = (
        _safe_classify_reserve_floor(
            observations,
            control_snapshot=control_snapshot,
            boundaries=boundaries,
            final_snapshot=run.snapshot,
            final_document=run.working_schedule_document,
        )
        if observations
        else ()
    )
    return DiagnosticRunResult(run, results)
