"""Which automations drive each controllable, as the schedule band badges it.

Read off the parsed :class:`.config.AutomationConfig` rather than the raw
document: :attr:`.config.OptimizerInstanceConfig.controllable_ids` already
resolves both target shapes (a group's members, or the flat id with the spec's
reserved default), so the badge and the pipeline cannot disagree about which
lane an optimizer drives.
"""

from __future__ import annotations

from typing import Literal, TypedDict

from .config import AutomationConfig

#: ``active`` -- at least one enabled optimizer drives it, under an enabled
#: master switch. ``disabled_only`` -- optimizers target it, but none of them
#: runs. A controllable no optimizer targets is simply absent.
CoverageState = Literal["active", "disabled_only"]


class ControllableCoverageDict(TypedDict):
    state: CoverageState
    #: Every optimizer targeting it, enabled or not, appliance bucket first and
    #: document order within each: the badge opens them, and the dialog it
    #: opens is where a disabled one gets switched back on.
    optimizerIds: list[str]


class AutomationCoverageDict(TypedDict):
    masterEnabled: bool
    controllables: dict[str, ControllableCoverageDict]


def build_automation_coverage(config: AutomationConfig) -> AutomationCoverageDict:
    """Coverage by controllable id -- the schedule lane's own key.

    The master switch overrides every optimizer: with automation off nothing
    in the pipeline runs, so a controllable whose optimizers are all enabled is
    still not being driven.
    """
    controllables: dict[str, ControllableCoverageDict] = {}
    for optimizer in config.all_optimizers:
        running = config.enabled and optimizer.enabled
        # A group lists its id under every member.
        for controllable_id in optimizer.controllable_ids:
            coverage = controllables.setdefault(
                controllable_id, {"state": "disabled_only", "optimizerIds": []}
            )
            coverage["optimizerIds"].append(optimizer.id)
            if running:
                coverage["state"] = "active"
    return {"masterEnabled": config.enabled, "controllables": controllables}
