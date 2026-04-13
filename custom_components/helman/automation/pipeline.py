from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from .config import AutomationConfig
from .ownership import strip_automation_owned_actions
from .optimizer import build_optimizer
from .snapshot import OptimizationSnapshot, snapshot_to_dict
from ..scheduling.schedule import schedule_document_to_dict

if TYPE_CHECKING:
    from ..coordinator import HelmanCoordinator

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
                if len(self._automation_config.execution_optimizers) != 1:
                    return AutomationRunResult.skipped(
                        reason="multiple_enabled_optimizers",
                        message=(
                            "Phase 5 supports exactly one enabled optimizer instance; "
                            "multi-optimizer composition lands in Phase 6"
                        ),
                    )

                input_bundle = self._coordinator.get_automation_input_bundle()
                if input_bundle is None:
                    return AutomationRunResult.skipped(reason="inputs_unavailable")

                optimizer_config = self._automation_config.execution_optimizers[0]
                snapshot = await self._coordinator._build_automation_snapshot_from_schedule_locked(
                    schedule_document=schedule_document,
                    input_bundle=input_bundle,
                    reference_time=active_reference_time,
                )
                optimizer = build_optimizer(
                    optimizer_config,
                    control_config=self._coordinator._read_schedule_control_config(),
                )
                try:
                    optimized_schedule_document = optimizer.optimize(
                        snapshot,
                        optimizer_config,
                    )
                except Exception as err:
                    _LOGGER.warning(
                        "Automation optimizer %s (%s) failed: %s",
                        optimizer_config.id,
                        optimizer_config.kind,
                        err,
                    )
                    return AutomationRunResult.skipped(
                        reason="optimizer_failed",
                        message=str(err),
                    )

                result_snapshot = await self._coordinator._build_automation_snapshot_from_schedule_locked(
                    schedule_document=optimized_schedule_document,
                    input_bundle=input_bundle,
                    reference_time=active_reference_time,
                )
                run_post_write_side_effects = (
                    await self._coordinator._persist_automation_result_locked(
                        automation_result=optimized_schedule_document,
                        reference_time=active_reference_time,
                    )
                )
                result = AutomationRunResult.completed(snapshot=result_snapshot)
        if run_post_write_side_effects:
            await self._coordinator._async_run_post_schedule_write_side_effects(
                reason="automation_updated",
                reference_time=active_reference_time,
            )
        return result

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
