"""``surplus_appliance`` optimizer.

Run an appliance wherever the forecast solar surplus covers its when-active
demand with the group's buffer to spare. The surplus test itself is now the
``min_surplus_buffer_pct`` condition, so two groups over one optimizer express
"0% buffer on surplus days, 15% otherwise" — what used to need two instances.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ...scheduling.schedule import ScheduleDocument, iter_horizon_slot_ids
from ..base import ApplianceTarget, ScheduleWriter, resolve_appliance_target
from ..conditions import build_eligibility
from ..conditions.types import ConditionRailsUnavailable
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ...appliances import AppliancesRuntimeRegistry
    from ..config import OptimizerInstanceConfig
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

__all__ = [
    "SurplusApplianceOptimizer",
    "ConditionRailsUnavailable",
    "build_surplus_appliance_optimizer",
]


@dataclass(frozen=True)
class SurplusApplianceOptimizer:
    id: str
    target: ApplianceTarget
    kind: str = "surplus_appliance"

    def optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        trace: "OptimizerTrace | None" = None,
    ) -> ScheduleDocument:
        trace = trace or NULL_TRACE
        # `surplus_insufficient` (rejected) is a frontend derivation rule (D)
        # over the availableSurplusKwh rail vs demand; leave those slots to it.
        trace.declare_derivable(iter_horizon_slot_ids(snapshot.context.now))

        appliance_id = self.target.appliance.id
        appliance_domain = f"appliance:{appliance_id}"
        action = {"domain": appliance_domain, **self.target.authored_action}

        # The mask raises ConditionRailsUnavailable when the demand or surplus rails
        # are unavailable; the pipeline then restores this appliance's baseline
        # actions rather than letting an empty plan clear it.
        eligibility = build_eligibility(snapshot, config, trace)
        writer = ScheduleWriter(
            snapshot,
            eligibility=eligibility,
            trace=trace,
            domain=appliance_domain,
        )
        # Repaint: a slot that stopped qualifying must be cleared, not inherited.
        writer.repaint_appliance(appliance_id)

        applied_by_group: dict[int, list[str]] = {}
        for resolved in eligibility.iter_slots():
            if writer.set_appliance(
                resolved.slot_id,
                appliance_id=appliance_id,
                action=self.target.authored_action,
            ):
                applied_by_group.setdefault(resolved.group.index, []).append(
                    resolved.slot_id
                )

        for group_index, slot_ids in applied_by_group.items():
            group = eligibility.groups[group_index]
            trace.decision(
                slot_ids=slot_ids,
                outcome="applied",
                action=action,
                reason={
                    "code": "surplus_covers_demand",
                    "params": {
                        "bufferPct": group.condition_values["min_surplus_buffer_pct"],
                        "matchedGroup": group.label,
                    },
                    "signals": ["availableSurplusKwh"],
                },
            )
        return writer.flush(action=action)


def build_surplus_appliance_optimizer(
    config: "OptimizerInstanceConfig",
    *,
    appliance_registry: "AppliancesRuntimeRegistry",
    path: str = "automation.optimizers[?]",
    **_kwargs: Any,
) -> SurplusApplianceOptimizer:
    return SurplusApplianceOptimizer(
        id=config.id,
        target=resolve_appliance_target(
            config, appliance_registry=appliance_registry, path=path
        ),
    )
