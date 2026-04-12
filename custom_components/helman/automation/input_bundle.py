from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AutomationInputBundle:
    original_house_forecast: dict[str, Any]
    solar_forecast: dict[str, Any]
    grid_price_forecast: dict[str, Any]
    when_active_hourly_energy_kwh_by_appliance_id: dict[str, float]
