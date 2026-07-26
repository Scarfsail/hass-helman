from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
import logging
from typing import TYPE_CHECKING, Any

from ...const import SCHEDULE_ACTION_STOP_EXPORT
from ...scheduling.schedule import (
    ScheduleAction,
    ScheduleDocument,
    ScheduleDomains,
    build_horizon_start,
    format_slot_id,
    iter_horizon_slot_ids,
)
from ..ownership import is_user_owned_inverter_action
from ..rails import canonical_bucket_start, parse_timestamp, read_optional_float
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ..config import OptimizerInstanceConfig
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

_LOGGER = logging.getLogger(__name__)
@dataclass(frozen=True)
class ExportPriceOptimizer:
    id: str
    stop_export_supported: bool
    kind: str = "export_price"

    def optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        trace: "OptimizerTrace | None" = None,
    ) -> ScheduleDocument:
        trace = trace or NULL_TRACE
        condition_met = snapshot.context.condition_met_by_optimizer_id.get(
            self.id, True
        )
        threshold = _read_threshold(config)
        action = _read_action(config)
        # `price_not_below_threshold` (rejected) is a frontend derivation rule
        # (D) over the exportPrice rail + threshold config; leave those slots to
        # it and only emit applied/blocked/notes here.
        trace.declare_derivable(iter_horizon_slot_ids(snapshot.context.now))
        candidate_slot_ids = _find_candidate_slot_ids(
            snapshot=snapshot,
            threshold=threshold,
        )

        updated_schedule_document = ScheduleDocument(
            execution_enabled=snapshot.schedule.execution_enabled,
            slots=deepcopy(snapshot.schedule.slots),
        )
        if not candidate_slot_ids:
            return updated_schedule_document

        if action != SCHEDULE_ACTION_STOP_EXPORT:
            raise ValueError(f"Unsupported export_price action: {action}")

        if not self.stop_export_supported:
            _LOGGER.warning(
                "Automation export_price optimizer %s cannot write stop_export because "
                "scheduler.control.action_option_map.stop_export is unavailable; "
                "skipping %d slot(s)",
                self.id,
                len(candidate_slot_ids),
            )
            trace.note(
                code="stop_export_unsupported",
                params={"skippedSlots": len(candidate_slot_ids)},
            )
            trace.decision(
                slot_ids=list(candidate_slot_ids),
                outcome="out_of_scope",
                reason={
                    "code": "stop_export_unsupported",
                    "params": {"skippedSlots": len(candidate_slot_ids)},
                },
            )
            return updated_schedule_document

        applied_slot_ids: list[str] = []
        blocked_slot_ids: list[str] = []
        for slot_id in candidate_slot_ids:
            current_domains = updated_schedule_document.slots.get(slot_id, ScheduleDomains())
            if is_user_owned_inverter_action(current_domains.inverter):
                blocked_slot_ids.append(slot_id)
                continue
            updated_schedule_document.slots[slot_id] = ScheduleDomains(
                inverter=ScheduleAction(
                    kind=SCHEDULE_ACTION_STOP_EXPORT,
                    set_by="automation",
                    condition_met=condition_met,
                ),
                appliances=dict(current_domains.appliances),
            )
            applied_slot_ids.append(slot_id)

        if applied_slot_ids:
            trace.decision(
                slot_ids=applied_slot_ids,
                outcome="applied",
                action={"domain": "inverter", "kind": SCHEDULE_ACTION_STOP_EXPORT},
                reason={
                    "code": "price_below_threshold",
                    "params": {"threshold": threshold},
                    "signals": ["exportPrice"],
                },
            )
        if blocked_slot_ids:
            trace.decision(
                slot_ids=blocked_slot_ids,
                outcome="blocked",
                action={"domain": "inverter", "kind": SCHEDULE_ACTION_STOP_EXPORT},
                reason={"code": "blocked_user_owned", "params": {"domain": "inverter"}},
            )

        return updated_schedule_document


def _find_candidate_slot_ids(
    *,
    snapshot: "OptimizationSnapshot",
    threshold: float,
) -> tuple[str, ...]:
    horizon_slot_ids = tuple(iter_horizon_slot_ids(snapshot.context.now))
    horizon_slot_id_set = set(horizon_slot_ids)
    negative_price_bucket_starts = _find_negative_price_bucket_starts(
        export_price_forecast=snapshot.context.export_price_forecast,
        threshold=threshold,
        reference_time=snapshot.context.now,
    )
    candidate_slot_id_set = {
        format_slot_id(build_horizon_start(bucket_start))
        for bucket_start in negative_price_bucket_starts
    }
    return tuple(
        slot_id
        for slot_id in horizon_slot_ids
        if slot_id in candidate_slot_id_set and slot_id in horizon_slot_id_set
    )


def _find_negative_price_bucket_starts(
    *,
    export_price_forecast: dict[str, Any],
    threshold: float,
    reference_time: datetime,
    ) -> set[datetime]:
    negative_bucket_starts: set[datetime] = set()

    current_price = read_optional_float(export_price_forecast.get("currentPrice"))
    if current_price is not None and current_price < threshold:
        negative_bucket_starts.add(canonical_bucket_start(reference_time))

    raw_points = export_price_forecast.get("points", [])
    if not isinstance(raw_points, list):
        return negative_bucket_starts

    for point in raw_points:
        if not isinstance(point, dict):
            continue
        timestamp = parse_timestamp(point.get("timestamp"))
        value = read_optional_float(point.get("value"))
        if timestamp is None or value is None or value >= threshold:
            continue
        negative_bucket_starts.add(canonical_bucket_start(timestamp))

    return negative_bucket_starts
def _read_threshold(config: "OptimizerInstanceConfig") -> float:
    threshold = read_optional_float(config.params.get("when_price_below"))
    if threshold is None:
        raise ValueError(
            f"Optimizer {config.id!r} is missing a numeric when_price_below parameter"
        )
    return threshold


def _read_action(config: "OptimizerInstanceConfig") -> str:
    action = config.params.get("action")
    if not isinstance(action, str) or not action:
        raise ValueError(f"Optimizer {config.id!r} is missing an action parameter")
    return action
