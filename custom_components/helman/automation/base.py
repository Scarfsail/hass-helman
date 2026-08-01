"""The write half of an optimizer, written once.

All five optimizers ended their run with the same preamble and the same
bookkeeping: deepcopy the snapshot's slots into a fresh document, skip anything
the user owns, rebuild ``ScheduleDomains`` around the one domain being touched,
stamp ``condition_met``, and record the ``blocked_user_owned`` veto for whatever
was skipped. :class:`ScheduleWriter` owns all of it, so an optimizer module
contains only its decision logic.
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
from .explain import STATE_FALSE, STATE_TRUE
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


#: The writer's own gate: whether the slot survived the user-ownership check.
GATE_BLOCKED_USER_OWNED = "blocked_user_owned"


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

    Shared by every kind that writes into an appliance domain — those whose
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

    ``pre_filters_ownership`` says the optimizer drops user-owned slots itself,
    before its ranking, and reports that as its own ``slot_available`` node. For
    those optimizers the writer's veto can only ever come out ``true``, and a
    node that cannot fail is noise in the diagram — the reader sees the same
    fact stated twice — so the ``true`` emission is suppressed. The ``false``
    branch stays wired up regardless: it costs nothing, and if a route ever does
    reach the writer with a user-owned slot the trace still says so instead of
    the slot vanishing without a reason.
    """

    def __init__(
        self,
        snapshot: "OptimizationSnapshot",
        *,
        eligibility: "Eligibility",
        trace: "OptimizerTrace | None" = None,
        domain: str = "inverter",
        pre_filters_ownership: bool = False,
    ) -> None:
        self.document = ScheduleDocument(
            execution_enabled=snapshot.schedule.execution_enabled,
            slots=deepcopy(snapshot.schedule.slots),
        )
        self._eligibility = eligibility
        self._trace = trace or NULL_TRACE
        self._domain = domain
        self._pre_filters_ownership = pre_filters_ownership
        self._blocked_slot_ids: list[str] = []
        self._written_slot_ids: list[str] = []

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
        self._written_slot_ids.append(slot_id)
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
        self._written_slot_ids.append(slot_id)
        return True

    def flush(self, *, action: dict[str, Any] | None = None) -> ScheduleDocument:
        """Emit the ownership veto and return the finished document.

        The veto is the last thing that can decide a slot, and it sits *after*
        every condition and every gate: the conditions can all pass, the
        optimizer can verdict ``execute``, and the slot still not be written
        because the user owns it. Without a node of its own that case is
        indistinguishable from a condition failure, so the writer records
        ``blocked_user_owned`` for every slot it actually reached:

        - ``false`` — reached and vetoed, nothing written (the UI's ⛨ blocked,
          distinct from ✗ not eligible, which is a condition column going false).
        - ``true`` — reached and written; the user does not own the slot.
        - *absent* — the optimizer never offered this slot to the writer, so
          the veto has nothing to say about it, or the optimizer pre-filters
          ownership and owns the node itself (``pre_filters_ownership``).

        A blocked slot keeps whatever verdict its optimizer stamped: the verdict
        is the optimizer's intent, and this node is what explains why the
        schedule does not show it.
        """
        if self._written_slot_ids and not self._pre_filters_ownership:
            self._trace.gate(
                slot_ids=self._written_slot_ids,
                key=GATE_BLOCKED_USER_OWNED,
                state=STATE_TRUE,
                params={"domain": self._domain},
            )
        if self._blocked_slot_ids:
            self._trace.gate(
                slot_ids=self._blocked_slot_ids,
                key=GATE_BLOCKED_USER_OWNED,
                state=STATE_FALSE,
                params={"domain": self._domain},
            )
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
