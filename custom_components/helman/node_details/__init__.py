"""The payloads behind the card's node detail dialogs: ``helman/get_node_detail``.

Each node registers an overview builder and the history sections it answers.
A request without ``section`` gets the overview: the entity ids the card reads
live, and the facts only the backend can tell (resolved telemetry, the
configuration agreement). A request with a ``section`` gets only that section's
history-derived figures, so a closed answer never costs a recorder read.
Every energy node also answers ``flows``, today's edges between the nodes,
from the one function in :mod:`.flows`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..controllables.config import iter_devices, peek_controllable_id, peek_controllable_kind
from ..controllables.spec import CONTROLLABLE_KIND_EV_CHARGER
from .battery import async_battery_section, build_battery_overview
from .ev_charger import async_ev_charger_section, build_ev_charger_overview
from .flows import FLOWS_SECTION, async_flows_section
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
    """One node's detail: its overview, and the sections it answers.

    A device node's builders also take the device's config.
    """

    overview: Callable[..., dict[str, Any]]
    section: Callable[..., Awaitable[dict[str, Any]]]
    sections: frozenset[str]
    #: The kind of consumer the node is one of, named by ``device_id``;
    #: ``None`` for a node that is not a device.
    device_kind: str | None = None


NODE_DETAILS: dict[str, NodeDetail] = {
    "inverter": NodeDetail(
        overview=build_inverter_overview,
        section=async_inverter_section,
        sections=frozenset({"temperature", "modes", FLOWS_SECTION}),
    ),
    "grid": NodeDetail(
        overview=build_grid_overview,
        section=async_grid_section,
        sections=frozenset({"voltage", FLOWS_SECTION}),
    ),
    "battery": NodeDetail(
        overview=build_battery_overview,
        section=async_battery_section,
        sections=frozenset({"charge", FLOWS_SECTION}),
    ),
    "solar": NodeDetail(
        overview=build_solar_overview,
        section=async_solar_section,
        sections=frozenset({"production", "strings", "destinations", FLOWS_SECTION}),
    ),
    "house": NodeDetail(
        overview=build_house_overview,
        section=async_house_section,
        sections=frozenset({"today", "pattern", FLOWS_SECTION}),
    ),
    "ev_charger": NodeDetail(
        overview=build_ev_charger_overview,
        section=async_ev_charger_section,
        sections=frozenset({"today", "segment"}),
        device_kind=CONTROLLABLE_KIND_EV_CHARGER,
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
    if detail.device_kind is None:
        if device_id is not None:
            raise NodeDetailError(
                "invalid_device", f"The {node} detail does not take a device_id"
            )
        device_args: tuple[Mapping[str, Any], ...] = ()
    else:
        device = _find_device(config, device_id, detail.device_kind)
        if device is None:
            raise NodeDetailError(
                "invalid_device",
                f"No {detail.device_kind} device with id {device_id!r}",
            )
        device_args = (device,)
    if section is None:
        return detail.overview(hass, config, now, *device_args)
    if section not in detail.sections:
        raise NodeDetailError(
            "unknown_section", f"The {node} detail has no section {section!r}"
        )
    if section == FLOWS_SECTION:
        return await async_flows_section(hass, node, now)
    return await detail.section(hass, config, section, now, *device_args)


def _find_device(
    config: Mapping[str, Any], device_id: str | None, kind: str
) -> Mapping[str, Any] | None:
    """The configured consumer of ``kind`` whose id is ``device_id``, at any depth."""
    if device_id is None:
        return None
    return next(
        (
            device
            for device, _parent in iter_devices(config)
            if peek_controllable_id(device) == device_id
            and peek_controllable_kind(device) == kind
        ),
        None,
    )
