"""Inputs resolved by the runtime owner before serving a node detail."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from ..consumption_forecast_profiles import HouseConsumptionProfile
from ..device_reports.reports import ReportQuery
from ..vendors import DeviceTelemetry


@dataclass(frozen=True)
class NodeDetailContext:
    config: Mapping[str, Any]
    telemetry: Mapping[str, DeviceTelemetry]
    device_report: Callable[[str, ReportQuery], Awaitable[dict[str, Any]]] | None
    house_profile: tuple[HouseConsumptionProfile | None, str | None]
