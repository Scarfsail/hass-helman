"""What a device's ``name`` and ``icon`` resolve to when the editor leaves them unset.

The Devices tab shows both as placeholders under an optional override, and the
card shows the same values. Deriving them in the editor would mean a second copy
of :func:`~..controllables.config.resolve_device_name` -- the cleaner regex
included -- so the editor asks for the field's path like any other and gets the
resolved value back as the inspection's ``placeholder``.

A device sits at any depth of the ``devices`` tree, which a fixed-depth
registry key cannot express, so the registry asks :func:`device_field` before
its keys.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from ..controllables.config import resolve_device_icon, resolve_device_name
from .context import InspectionRequest, PathSegment
from .model import Inspection

_DEVICE_FIELDS = ("name", "icon")


def device_field(path: Sequence[PathSegment]) -> str | None:
    """``name`` or ``icon`` when ``path`` is ``devices.<i>(.children.<j>)*.<field>``."""
    prefix_length = device_prefix_length(path)
    if prefix_length is None or len(path) != prefix_length + 1:
        return None
    if path[-1] not in _DEVICE_FIELDS:
        return None
    return str(path[-1])


def device_prefix_length(path: Sequence[PathSegment]) -> int | None:
    """Length of the ``devices.<i>(.children.<j>)*`` prefix, at any depth."""
    if len(path) < 2 or path[0] != "devices" or not _is_index(path[1]):
        return None
    length = 2
    while (
        length + 1 < len(path)
        and path[length] == "children"
        and _is_index(path[length + 1])
    ):
        length += 2
    return length


def evaluate_device_field(request: InspectionRequest) -> Inspection:
    """The device's name or icon as it resolves without its own override."""
    field = request.path[-1]
    device = request.value(*request.path[:-1])
    if not isinstance(device, Mapping):
        return Inspection(entity_id=None, status="unsupported")
    derived = {key: value for key, value in device.items() if key != field}
    if field == "name":
        cleaner_regex = request.value("visualization", "power_sensor_name_cleaner_regex")
        placeholder = resolve_device_name(
            derived,
            friendly_name=lambda entity_id: _attribute(request, entity_id, "friendly_name"),
            cleaner_regex=cleaner_regex if isinstance(cleaner_regex, str) else None,
        )
    else:
        placeholder = resolve_device_icon(
            derived,
            entity_icon=lambda entity_id: _attribute(request, entity_id, "icon"),
        )
    return Inspection(
        entity_id=None,
        status="ok",
        consulted=((request.path, request.target_value()),),
        placeholder=placeholder or None,
    )


def _attribute(request: InspectionRequest, entity_id: str, name: str) -> str | None:
    state = request.hass.states.get(entity_id)
    value = state.attributes.get(name) if state is not None else None
    return value if isinstance(value, str) and value else None


def _is_index(segment: PathSegment) -> bool:
    return isinstance(segment, int) and not isinstance(segment, bool)
