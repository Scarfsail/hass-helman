"""``export_price`` optimizer (use case 2).

Stop exporting while the export price is below the group's threshold. All of the
gating lives in the ``when_price_below`` condition now, so this module is the
action write plus its rationale — nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import TYPE_CHECKING, Any

from ...const import SCHEDULE_ACTION_STOP_EXPORT
from ...scheduling.schedule import ScheduleDocument, iter_horizon_slot_ids
from ..base import ScheduleWriter
from ..conditions import build_eligibility
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ..config import OptimizerInstanceConfig
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

_LOGGER = logging.getLogger(__name__)
_ACTION = {"domain": "inverter", "kind": SCHEDULE_ACTION_STOP_EXPORT}


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
        # `price_not_below_threshold` (rejected) is a frontend derivation rule
        # (D) over the exportPrice rail + the groups' thresholds; leave those
        # slots to it and only emit applied/blocked/notes here.
        trace.declare_derivable(iter_horizon_slot_ids(snapshot.context.now))

        eligibility = build_eligibility(snapshot, config)
        writer = ScheduleWriter(snapshot, eligibility=eligibility, trace=trace)
        eligible = list(eligibility.iter_slots())
        if not eligible:
            return writer.flush(action=_ACTION)

        if not self.stop_export_supported:
            _LOGGER.warning(
                "Automation export_price optimizer %s cannot write stop_export because "
                "scheduler.control.action_option_map.stop_export is unavailable; "
                "skipping %d slot(s)",
                self.id,
                len(eligible),
            )
            trace.note(
                code="stop_export_unsupported",
                params={"skippedSlots": len(eligible)},
            )
            trace.decision(
                slot_ids=[resolved.slot_id for resolved in eligible],
                outcome="out_of_scope",
                reason={
                    "code": "stop_export_unsupported",
                    "params": {"skippedSlots": len(eligible)},
                },
            )
            return writer.flush(action=_ACTION)

        applied_by_group: dict[int, list[str]] = {}
        for resolved in eligible:
            if writer.set_inverter(resolved.slot_id, kind=SCHEDULE_ACTION_STOP_EXPORT):
                applied_by_group.setdefault(resolved.group.index, []).append(
                    resolved.slot_id
                )

        for group_index, slot_ids in applied_by_group.items():
            group = eligibility.groups[group_index]
            trace.decision(
                slot_ids=slot_ids,
                outcome="applied",
                action=_ACTION,
                reason={
                    "code": "price_below_threshold",
                    "params": {
                        "threshold": group.condition_values["when_price_below"],
                        "matchedGroup": group.label,
                    },
                    "signals": ["exportPrice"],
                },
            )
        return writer.flush(action=_ACTION)


def build_export_price_optimizer(
    config: "OptimizerInstanceConfig",
    *,
    stop_export_supported: bool,
    **_kwargs: Any,
) -> ExportPriceOptimizer:
    return ExportPriceOptimizer(
        id=config.id,
        stop_export_supported=stop_export_supported,
    )
