from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any


@dataclass(frozen=True)
class AutomationInputBundle:
    original_house_forecast: dict[str, Any]
    solar_forecast: dict[str, Any]
    grid_price_forecast: dict[str, Any]
    when_active_hourly_energy_kwh_by_appliance_id: dict[str, float]
    # A2 — recorder-resolved runtime hours per appliance per local calendar date,
    # covering a window back from today plus today-so-far. Optimizers read this
    # synchronously via the snapshot context; the framework never lets an
    # optimizer touch the recorder itself.
    runtime_hours_by_appliance_id_by_local_date: dict[str, dict[date, float]] = field(
        default_factory=dict
    )
