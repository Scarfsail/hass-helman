from __future__ import annotations

from ..const import DEFAULT_APPLIANCE_ICON


def read_optional_appliance_icon(
    value: object,
    *,
    path: str,
    error_type: type[Exception] = ValueError,
) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise error_type(f"{path} must be a non-empty string")
    return value.strip()


def resolve_appliance_icon(icon: str | None) -> str:
    return icon or DEFAULT_APPLIANCE_ICON
