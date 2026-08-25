"""Which sign a power sensor uses to carry its quantity, per power device.

Helman's own convention is **positive = flowing into the consumer side**: a
positive grid reading is an export, a positive battery reading is a charge. It
is not the only convention in circulation -- the Home Assistant energy
convention is its mirror image, and vendor-supplied aggregate sensors
increasingly follow that one instead. Before this module the convention was
hard-coded at every node the tree builder constructed, so a user whose sensor
disagreed had no way to say so; the workaround was a template helper whose only
job was to negate a sensor that already existed.

The setting is deliberately *not* an ``inverted`` boolean. A boolean states that
something is backwards without saying backwards from what, and to set it
correctly a user would already have to know the internal convention this module
exists to hide. Each device instead names what a positive reading *means*, in
its own vocabulary: a grid sensor is asked whether positive is import or export,
a battery sensor whether positive is charging or discharging. Those are
questions a user can answer by looking at their inverter.

House and solar carry a single quantity each, so their two options are simply
which sign carries it. They exist for uniformity rather than for a known sensor:
a power device that cannot state its own convention is the gap the next vendor's
sensor set will find.

Everything downstream keeps working on ``value_type``, whose three literals and
their meanings are unchanged. This module is the only place that knows a
polarity setting exists; it collapses one into the ``value_type`` the tree
builder would otherwise have hard-coded. The single exception is the battery ETA
in the coordinator, which reads the raw history buffer rather than a tree node
and therefore has to ask :func:`is_power_inverted` directly.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

ValueType = Literal["default", "positive", "negative"]

#: The config key, under ``power_devices.<device>.entities``.
POWER_POLARITY_KEY = "power_polarity"

#: Allowed values per device, **upright option first**. The first entry is the
#: default, and every default is exactly the convention that was hard-coded
#: before this setting existed -- an absent key must reproduce today's tree byte
#: for byte, because a silent polarity flip would swap Import and Export on
#: every dashboard of a released integration.
POWER_POLARITY_OPTIONS: dict[str, tuple[str, str]] = {
    "solar": ("positive_is_production", "negative_is_production"),
    "house": ("positive_is_consumption", "negative_is_consumption"),
    "battery": ("positive_is_charging", "positive_is_discharging"),
    "grid": ("positive_is_export", "positive_is_import"),
}

#: ``value_type`` for a device's *source* node, upright then inverted. Devices
#: absent here have no source node.
_SOURCE_VALUE_TYPES: dict[str, tuple[ValueType, ValueType]] = {
    "solar": ("default", "negative"),
    "battery": ("negative", "positive"),
    "grid": ("negative", "positive"),
}

#: ``value_type`` for a device's *consumer* node, upright then inverted. Devices
#: absent here have no consumer node.
_CONSUMER_VALUE_TYPES: dict[str, tuple[ValueType, ValueType]] = {
    "house": ("default", "negative"),
    "battery": ("positive", "negative"),
    "grid": ("positive", "negative"),
}


def default_polarity(device: str) -> str:
    """The polarity a device falls back to when the config does not say."""
    return POWER_POLARITY_OPTIONS[device][0]


def is_power_inverted(device_config: Mapping[str, Any] | None, device: str) -> bool:
    """Whether ``device``'s power sensor runs against Helman's convention.

    Anything other than the device's non-default option -- absent, empty, or a
    value from another device's vocabulary -- reads as upright. Validation is
    what reports a bad value; this path is on every tree build and every
    coordinator tick, and must never raise on a config it dislikes.
    """
    options = POWER_POLARITY_OPTIONS.get(device)
    if options is None or not isinstance(device_config, Mapping):
        return False
    entities = device_config.get("entities")
    if not isinstance(entities, Mapping):
        return False
    return entities.get(POWER_POLARITY_KEY) == options[1]


def source_value_type(device_config: Mapping[str, Any] | None, device: str) -> ValueType:
    """``value_type`` for ``device``'s source node, honouring its polarity."""
    return _SOURCE_VALUE_TYPES[device][is_power_inverted(device_config, device)]


def consumer_value_type(device_config: Mapping[str, Any] | None, device: str) -> ValueType:
    """``value_type`` for ``device``'s consumer node, honouring its polarity."""
    return _CONSUMER_VALUE_TYPES[device][is_power_inverted(device_config, device)]
