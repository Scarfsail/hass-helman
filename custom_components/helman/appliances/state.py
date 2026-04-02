from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .ev_charger import EvChargerApplianceRuntime


@dataclass(frozen=True)
class AppliancesRuntimeRegistry:
    appliances: tuple["EvChargerApplianceRuntime", ...] = ()

    @classmethod
    def from_appliances(
        cls,
        appliances: Iterable["EvChargerApplianceRuntime"],
    ) -> "AppliancesRuntimeRegistry":
        return cls(appliances=tuple(appliances))

    @property
    def appliances_by_id(self) -> dict[str, "EvChargerApplianceRuntime"]:
        return {appliance.id: appliance for appliance in self.appliances}
