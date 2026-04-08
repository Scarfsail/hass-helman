from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, TypeAlias

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
