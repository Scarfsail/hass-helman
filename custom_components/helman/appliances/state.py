from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeAlias

from ..controllables.config import is_active_state, running_active_states
from ..controllables.controllers import _UNAVAILABLE_STATES
from ..controllables.spec import spec_for

if TYPE_CHECKING:
    from .climate_appliance import ClimateApplianceRuntime
    from .ev_charger import EvChargerApplianceRuntime
    from .generic_appliance import GenericApplianceRuntime

    ApplianceRuntime: TypeAlias = (
        ClimateApplianceRuntime | EvChargerApplianceRuntime | GenericApplianceRuntime
    )
else:
    ApplianceRuntime: TypeAlias = object


@dataclass(frozen=True)
class AppliancesRuntimeRegistry:
    appliances: tuple[ApplianceRuntime, ...] = ()

    @classmethod
    def from_appliances(
        cls,
        appliances: Iterable[ApplianceRuntime],
    ) -> "AppliancesRuntimeRegistry":
        return cls(appliances=tuple(appliances))

    @property
    def appliances_by_id(self) -> dict[str, ApplianceRuntime]:
        return {appliance.id: appliance for appliance in self.appliances}

    def get_appliance(self, appliance_id: str) -> ApplianceRuntime | None:
        return self.appliances_by_id.get(appliance_id)


def resolve_running_entity_and_states(
    appliance: ApplianceRuntime,
) -> tuple[str | None, tuple[str, ...]]:
    """Return the entity id and active-state set defining "on" runtime.

    The kind's running signal and its active states — a switch being ``on``, a
    climate entity heating or cooling — the same pair the recorder runtime
    query and a meterless child's share split use.
    """
    signal = spec_for(appliance.kind).running_signal(appliance)
    if signal is None:
        return None, ()
    entity_id, activity = signal
    return entity_id, running_active_states(activity)


def read_appliance_running(
    read_state: Callable[[str], Any],
    appliance: ApplianceRuntime,
) -> bool | None:
    """Whether ``appliance`` is running right now, or ``None`` when unknown.

    A missing entity or an unknown/unavailable state reads as ``None``; no
    running signal reads as not running.
    """
    entity_id, active_states = resolve_running_entity_and_states(appliance)
    if entity_id is None:
        return False
    value = getattr(read_state(entity_id), "state", None)
    if (
        not isinstance(value, str)
        or not value.strip()
        or value.strip().lower() in _UNAVAILABLE_STATES
    ):
        return None
    return is_active_state(value, active_states)


def is_appliance_running(
    read_state: Callable[[str], Any],
    appliance: ApplianceRuntime,
) -> bool:
    """Whether ``appliance`` is running right now, from its live state.

    A missing entity, an unavailable state or no running signal counts as not
    running.
    """
    return read_appliance_running(read_state, appliance) is True
