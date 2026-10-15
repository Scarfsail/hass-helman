"""The day's energy flows between the nodes, the ``flows`` section of every energy node.

Each node detail draws the same flow diagram, and its Today view reads the
same edges, so they are worked out here once, from the ranking device report
the other "today so far" answers already read (:func:`.battery.today_ranking_report`).
Every edge is kWh over today so far, and an edge whose meters are not
configured is ``None``, never a zero.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from .battery import charge_origin_kwh, today_ranking_report
from .context import NodeDetailContext
from .day_stats import day_window
from .solar import solar_destinations

#: The section every energy node answers with :func:`async_flows_section`.
FLOWS_SECTION = "flows"


def today_flows(report: Mapping[str, Any]) -> dict[str, Any]:
    """The edges between solar, grid, battery and house over a report's period, kWh.

    * solar → house, battery and grid, and the solar the meters do not explain
      (``solarUnresolved``), from :func:`.solar.solar_destinations`;
    * grid → battery and the charge of unknown origin (``unknownToBattery``),
      from :func:`.battery.charge_origin_kwh`, with the paid cost of the grid
      charge, an estimate;
    * battery → house and grid → house from the house node's sources, with the
      house energy whose source is not known (``unknownToHouse``);
    * battery → grid as the export the solar does not explain, less what the
      solar left unresolved in the same hours (:func:`_battery_export_kwh`).

    Unresolved energy stays its own figure and is never forced into a
    destination. An edge needs the meters at both of its ends: without them it
    is ``None``.
    """
    meters = report.get("meters") or {}
    solar_meter = bool(meters.get("solar"))
    grid_meter = bool(meters.get("grid"))
    battery_meter = bool(meters.get("battery"))
    solar = solar_destinations(report) if solar_meter else None
    charge = charge_origin_kwh(report.get("charge_origin") or {}) if battery_meter else None
    nodes = report.get("nodes") or []
    sources = (nodes[0].get("sources") or {}) if nodes else None

    def edge(value: Any, *needs: bool) -> float | None:
        if value is None or not all(needs):
            return None
        return round(max(0.0, float(value or 0.0)), 3)

    return {
        "solarToHouse": edge(solar and solar["houseKwh"], solar_meter),
        "solarToBattery": edge(solar and solar["batteryKwh"], solar_meter, battery_meter),
        "solarToGrid": edge(solar and solar["exportKwh"], solar_meter, grid_meter),
        "solarUnresolved": edge(solar and solar["unresolvedKwh"], solar_meter),
        "gridToBattery": edge(charge and charge["gridKwh"], grid_meter, battery_meter),
        "unknownToBattery": edge(charge and charge["unknownKwh"], battery_meter),
        "gridToBatteryCost": None if charge is None or not grid_meter else charge["paidCost"],
        "batteryToHouse": edge(sources and sources.get("battery"), battery_meter),
        "gridToHouse": edge(sources and sources.get("grid"), grid_meter),
        "unknownToHouse": edge(sources and sources.get("unattributed"), sources is not None),
        "batteryToGrid": edge(
            solar and _battery_export_kwh(solar), solar_meter, grid_meter, battery_meter
        ),
    }


def _battery_export_kwh(solar: Mapping[str, Any]) -> float:
    """The export the battery is known to account for, kWh.

    ``otherExportKwh`` is all export in mixed hours that the solar does not
    explain. In hours where the solar is itself unresolved, that export may be
    the unresolved solar, so only the export beyond it is the battery's; the
    rest stays in ``solarUnresolved`` rather than being forced onto the battery.
    """
    unresolved_in_mixed_hours = max(0.0, solar["unresolvedKwh"] - solar["unattributedKwh"])
    return max(0.0, solar["otherExportKwh"] - unresolved_in_mixed_hours)


async def async_flows_section(hass: Any, ctx: NodeDetailContext, node: str, now: datetime) -> dict[str, Any]:
    """Today's flows for ``node``'s detail, or why there are none.

    The period, currency and ``complete`` are carried as the other "today so
    far" sections carry them. ``flows`` is ``None`` with an ``unavailable``
    reason when the reports cannot be built.
    """
    local_now = dt_util.as_local(now)
    start, end = day_window(local_now)
    payload: dict[str, Any] = {
        "node": node,
        "section": FLOWS_SECTION,
        "asOf": local_now.isoformat(),
        "period": {
            "start": dt_util.as_local(start).isoformat(),
            "end": dt_util.as_local(end).isoformat(),
        },
        "currency": None,
        "complete": False,
        "unavailable": None,
        "flows": None,
    }
    report = await today_ranking_report(ctx, local_now)
    if "unavailable" in report:
        return {**payload, "unavailable": report["unavailable"]}
    return {
        **payload,
        # The report's dataset can be a few minutes older than the request.
        **({"asOf": report["as_of"]} if report.get("as_of") else {}),
        "currency": report.get("currency"),
        "complete": bool(report.get("complete")),
        "flows": today_flows(report),
    }
