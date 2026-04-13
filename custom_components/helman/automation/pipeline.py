from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from .config import AutomationConfig
from .ownership import strip_automation_owned_actions
from .snapshot import OptimizationSnapshot, snapshot_to_dict

if TYPE_CHECKING:
    from ..coordinator import HelmanCoordinator


@dataclass(frozen=True)
class AutomationRunResult:
    ran_automation: bool
    reason: str | None = None
    snapshot: OptimizationSnapshot | None = None

    @classmethod
    def skipped(cls, *, reason: str) -> "AutomationRunResult":
        return cls(ran_automation=False, reason=reason, snapshot=None)

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
        return payload


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
                return AutomationRunResult.skipped(reason="automation_disabled")

            input_bundle = self._coordinator.get_automation_input_bundle()
            if input_bundle is None:
                return AutomationRunResult.skipped(reason="inputs_unavailable")

            snapshot = await self._coordinator._build_automation_snapshot_from_schedule_locked(
                schedule_document=schedule_document,
                input_bundle=input_bundle,
                reference_time=active_reference_time,
            )
        return AutomationRunResult.completed(snapshot=snapshot)
