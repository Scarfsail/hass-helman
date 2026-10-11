"""The payloads behind the card's node detail dialogs: ``helman/get_node_detail``.

Each node registers an overview builder and the history sections it answers.
A request without ``section`` gets the overview: the entity ids the card reads
live, and the facts only the backend can tell (resolved telemetry, the
configuration agreement). A request with a ``section`` gets only that section's
history-derived figures, so a closed answer never costs a recorder read.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .battery import async_battery_section, build_battery_overview
from .grid import async_grid_section, build_grid_overview
from .house import async_house_section, build_house_overview
from .inverter import async_inverter_section, build_inverter_overview
from .solar import async_solar_section, build_solar_overview


class NodeDetailError(Exception):
    """A request the registry refuses, with the websocket error code to send."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class NodeDetail:
    """One node's detail: its overview, and the sections it answers."""

    overview: Callable[[Any, Mapping[str, Any], datetime], dict[str, Any]]
    section: Callable[[Any, Mapping[str, Any], str, datetime], Awaitable[dict[str, Any]]]
    sections: frozenset[str]
    #: Whether the node is one of several devices, named by ``device_id``.
    takes_device: bool = False


NODE_DETAILS: dict[str, NodeDetail] = {
    "inverter": NodeDetail(
        overview=build_inverter_overview,
        section=async_inverter_section,
        sections=frozenset({"temperature"}),
    ),
    "grid": NodeDetail(
        overview=build_grid_overview,
        section=async_grid_section,
        sections=frozenset({"voltage"}),
    ),
    "battery": NodeDetail(
        overview=build_battery_overview,
        section=async_battery_section,
        sections=frozenset({"charge"}),
    ),
    "solar": NodeDetail(
        overview=build_solar_overview,
        section=async_solar_section,
        sections=frozenset({"production", "strings", "destinations"}),
    ),
    "house": NodeDetail(
        overview=build_house_overview,
        section=async_house_section,
        sections=frozenset({"today", "pattern"}),
    ),
}


async def async_get_node_detail(
    hass: Any,
    config: Mapping[str, Any],
    *,
    node: str,
    device_id: str | None,
    section: str | None,
    now: datetime,
) -> dict[str, Any]:
    """The overview of ``node``, or its ``section``; :class:`NodeDetailError` when refused."""
    detail = NODE_DETAILS.get(node)
    if detail is None:
        raise NodeDetailError("unknown_node", f"No node detail for {node!r}")
    if device_id is not None and not detail.takes_device:
        raise NodeDetailError(
            "invalid_device", f"The {node} detail does not take a device_id"
        )
    if section is None:
        return detail.overview(hass, config, now)
    if section not in detail.sections:
        raise NodeDetailError(
            "unknown_section", f"The {node} detail has no section {section!r}"
        )
    return await detail.section(hass, config, section, now)
