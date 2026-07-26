"""The write half of an optimizer, written once.

All five optimizers ended their run with the same preamble and the same
bookkeeping: deepcopy the snapshot's slots into a fresh document, skip anything
the user owns, rebuild ``ScheduleDomains`` around the one domain being touched,
stamp ``condition_met``, and emit a ``blocked_user_owned`` decision for whatever
was skipped. :class:`ScheduleWriter` owns all of it, so an optimizer module
contains only its decision logic and its own reason codes.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..appliances.climate_appliance import ClimateApplianceRuntime
from ..appliances.generic_appliance import GenericApplianceRuntime
from ..scheduling.schedule import (
    ScheduleAction,
    ScheduleDocument,
    ScheduleDomains,
    is_default_domains,
)
from .fields import OptimizerConfigError
from .ownership import (
    is_user_owned_appliance_action,
    is_user_owned_inverter_action,
    stamp_automation_appliance_action,
)
from .trace import NULL_TRACE

if TYPE_CHECKING:
    from ..appliances import AppliancesRuntimeRegistry
    from .conditions import Eligibility
    from .config import OptimizerInstanceConfig
    from .snapshot import OptimizationSnapshot
    from .trace import OptimizerTrace


@dataclass(frozen=True)
class ApplianceTarget:
    """An appliance runtime plus the action its ``climate_mode`` authors."""

    appliance: GenericApplianceRuntime | ClimateApplianceRuntime
    authored_action: dict[str, object]


def resolve_appliance_target(
    config: "OptimizerInstanceConfig",
    *,
    appliance_registry: "AppliancesRuntimeRegistry",
    path: str,
) -> ApplianceTarget:
    """Turn ``target.appliance_id`` + ``target.climate_mode`` into a live target.

    Shared by ``surplus_appliance`` and ``daily_runtime`` — the two kinds whose
    target is an appliance. The field *shapes* come from the spec; only the
    registry lookup and the generic/climate split live here, because only they
    need runtime state the schema cannot express.
    """
    appliance_id = str(config.target.get("appliance_id"))
    appliance = appliance_registry.get_appliance(appliance_id)
    if appliance is None:
        raise OptimizerConfigError(
            path=f"{path}.target.appliance_id",
            code="invalid_value",
            message=f"unknown appliance_id {appliance_id!r}",
        )

    climate_mode = config.target.get("climate_mode")
    if isinstance(appliance, GenericApplianceRuntime):
        if climate_mode is not None:
            raise OptimizerConfigError(
                path=f"{path}.target.climate_mode",
                code="invalid_value",
                message=(
                    f"climate_mode is not allowed for generic appliance "
                    f"{appliance_id!r}"
                ),
            )
        return ApplianceTarget(appliance=appliance, authored_action={"on": True})
    if isinstance(appliance, ClimateApplianceRuntime):
        if climate_mode is None:
            raise OptimizerConfigError(
                path=f"{path}.target.climate_mode",
                code="required",
                message=(
                    f"climate_mode is required for climate appliance {appliance_id!r}"
                ),
            )
        if climate_mode not in appliance.authorable_modes:
            raise OptimizerConfigError(
                path=f"{path}.target.climate_mode",
                code="invalid_value",
                message=(
                    f"climate_mode {climate_mode!r} is not supported for appliance "
                    f"{appliance_id!r}"
                ),
            )
        return ApplianceTarget(
            appliance=appliance, authored_action={"mode": climate_mode}
        )
    raise OptimizerConfigError(
        path=f"{path}.target.appliance_id",
        code="invalid_value",
        message=f"appliance {appliance_id!r} must be generic or climate",
    )


class ScheduleWriter:
    """Applies one optimizer's actions to a copy of the snapshot's schedule.

    ``condition_met`` is taken per slot from the matched group, so a group whose
    ``custom`` conditions failed places candidates while a sibling group that
    matched fully places real actions — in the same run, on the same optimizer.
    """

    def __init__(
        self,
        snapshot: "OptimizationSnapshot",
        *,
        eligibility: "Eligibility",
        trace: "OptimizerTrace | None" = None,
        domain: str = "inverter",
    ) -> None:
        self.document = ScheduleDocument(
            execution_enabled=snapshot.schedule.execution_enabled,
            slots=deepcopy(snapshot.schedule.slots),
        )
        self._eligibility = eligibility
        self._trace = trace or NULL_TRACE
        self._domain = domain
        self._blocked_slot_ids: list[str] = []

    @property
    def blocked_slot_ids(self) -> list[str]:
        return list(self._blocked_slot_ids)

    def _condition_met(self, slot_id: str) -> bool:
        resolved = self._eligibility.at(slot_id)
        # A slot no group covers is only reachable when an optimizer writes
        # outside its own eligibility, which none do; treat it as met so the
        # fallback can never silently downgrade a real action to a candidate.
        return True if resolved is None else resolved.condition_met

    def set_inverter(
        self,
        slot_id: str,
        *,
        kind: str,
        target_soc: int | None = None,
    ) -> bool:
        """Write an inverter action. ``False`` when the user owns the slot."""
        current = self.document.slots.get(slot_id, ScheduleDomains())
        if is_user_owned_inverter_action(current.inverter):
            self._blocked_slot_ids.append(slot_id)
            return False
        action = ScheduleAction(
            kind=kind,
            set_by="automation",
            condition_met=self._condition_met(slot_id),
            **({} if target_soc is None else {"target_soc": target_soc}),
        )
        self.document.slots[slot_id] = ScheduleDomains(
            inverter=action,
            appliances=dict(current.appliances),
        )
        return True

    def set_appliance(
        self,
        slot_id: str,
        *,
        appliance_id: str,
        action: dict[str, Any],
    ) -> bool:
        """Write an appliance action. ``False`` when the user owns the slot."""
        current = self.document.slots.get(slot_id, ScheduleDomains())
        if is_user_owned_appliance_action(current.appliances.get(appliance_id)):
            self._blocked_slot_ids.append(slot_id)
            return False
        appliances = dict(current.appliances)
        appliances[appliance_id] = stamp_automation_appliance_action(
            action, condition_met=self._condition_met(slot_id)
        )
        self.document.slots[slot_id] = ScheduleDomains(
            inverter=current.inverter,
            appliances=appliances,
        )
        return True

    def repaint_appliance(self, appliance_id: str) -> None:
        """Drop this appliance's automation-owned actions before rewriting them.

        ``surplus_appliance`` fully repaints its appliance's domain each run
        rather than adding to it, so a slot that stopped qualifying is cleared
        instead of lingering from a previous plan. The other four only append —
        this is a real behavioural difference, not a preamble to flatten away.
        """
        for slot_id in list(self.document.slots):
            domains = self.document.slots[slot_id]
            if appliance_id not in domains.appliances:
                continue
            if is_user_owned_appliance_action(domains.appliances.get(appliance_id)):
                continue
            appliances = dict(domains.appliances)
            appliances.pop(appliance_id, None)
            updated = ScheduleDomains(
                inverter=domains.inverter,
                appliances=appliances,
            )
            if is_default_domains(updated):
                del self.document.slots[slot_id]
            else:
                self.document.slots[slot_id] = updated

    def flush(self, *, action: dict[str, Any] | None = None) -> ScheduleDocument:
        """Emit the blocked-slot decision and return the finished document."""
        if self._blocked_slot_ids:
            self._trace.decision(
                slot_ids=self._blocked_slot_ids,
                outcome="blocked",
                action=action,
                reason={
                    "code": "blocked_user_owned",
                    "params": {"domain": self._domain},
                },
            )
        return self.document
