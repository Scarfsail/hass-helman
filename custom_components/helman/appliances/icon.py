from __future__ import annotations

from ..const import DEFAULT_APPLIANCE_ICON


def resolve_appliance_icon(icon: str | None) -> str:
    return icon or DEFAULT_APPLIANCE_ICON
