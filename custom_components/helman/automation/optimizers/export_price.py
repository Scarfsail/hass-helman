"""``export_price`` optimizer (use case 2).

Stop exporting while the export price is below the group's threshold. All of the
gating lives in the ``when_price_below`` condition now, so this module is the
action write plus its rationale — nothing else.

Explanation-wise that makes it the simplest kind in the pipeline: the whole
condition matrix is stamped by ``build_eligibility``, and the only gate this
module owns is the inverter capability check. There is no window, no deadline,
no capacity and no ranking to instrument — a slot's fate is its price and
whether the user owns it.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import TYPE_CHECKING, Any

from ...const import SCHEDULE_ACTION_STOP_EXPORT
from ...scheduling.schedule import ScheduleDocument, iter_horizon_slot_ids
from ..base import ScheduleWriter
from ..conditions import build_eligibility
from ..explain import (
    STATE_FALSE,
    STATE_TRUE,
    STATUS_SKIPPED,
    VERDICT_CANDIDATE,
    VERDICT_EXECUTE,
    VERDICT_SKIP,
)
from ..trace import NULL_TRACE

#: The one gate this kind owns: the inverter's `controls.mode.options.stop_export`
#: is a per-inverter capability, so a whole run can be unactionable for reasons
#: no condition can express.
GATE_STOP_EXPORT_SUPPORTED = "stop_export_supported"

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
        horizon_slot_ids = list(iter_horizon_slot_ids(snapshot.context.now))

        eligibility = build_eligibility(snapshot, config, trace)
        writer = ScheduleWriter(snapshot, eligibility=eligibility, trace=trace)
        # The baseline every slot keeps unless something below writes it: the
        # condition matrix is stamped for the whole horizon, so leaving a slot
        # verdict-less would read as "never looked at" rather than "rejected".
        trace.set_verdict(slot_ids=horizon_slot_ids, verdict=VERDICT_SKIP)
        eligible = list(eligibility.iter_slots())
        if not eligible:
            return writer.flush(action=_ACTION)

        eligible_slot_ids = [resolved.slot_id for resolved in eligible]
        if not self.stop_export_supported:
            _LOGGER.warning(
                "Automation export_price optimizer %s cannot write stop_export because "
                "the inverter's controls.mode.options.stop_export is unavailable; "
                "skipping %d slot(s)",
                self.id,
                len(eligible),
            )
            trace.note(
                code="stop_export_unsupported",
                params={"skippedSlots": len(eligible)},
            )
            trace.gate(
                slot_ids=eligible_slot_ids,
                key=GATE_STOP_EXPORT_SUPPORTED,
                state=STATE_FALSE,
                params={"skippedSlots": len(eligible)},
            )
            # Not "every slot false": the conditions matched and the inverter
            # cannot carry the action out. The step status is what keeps those
            # two apart.
            trace.set_step_status(
                status=STATUS_SKIPPED, reason="stop_export_unsupported"
            )
            return writer.flush(action=_ACTION)

        trace.gate(
            slot_ids=eligible_slot_ids,
            key=GATE_STOP_EXPORT_SUPPORTED,
            state=STATE_TRUE,
        )

        applied_by_group: dict[int, list[str]] = {}
        for resolved in eligible:
            if not writer.set_inverter(
                resolved.slot_id, kind=SCHEDULE_ACTION_STOP_EXPORT
            ):
                # User-owned: the writer vetoed it and the slot keeps its `skip`
                # baseline. `base.py` records the veto node itself.
                continue
            applied_by_group.setdefault(resolved.group.index, []).append(
                resolved.slot_id
            )
            trace.set_verdict(
                slot_ids=[resolved.slot_id],
                verdict=(
                    VERDICT_EXECUTE if resolved.condition_met else VERDICT_CANDIDATE
                ),
            )

        for group_index, slot_ids in applied_by_group.items():
            trace.decision(slot_ids=slot_ids, outcome="applied", action=_ACTION)
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
