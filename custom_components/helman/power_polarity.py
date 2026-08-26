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

Everything that reads a power sensor *through a tree node* keeps working on
``value_type``, whose three literals and their meanings are unchanged: this
module collapses a polarity into the ``value_type`` the tree builder would
otherwise have hard-coded, and nothing downstream of that has to change.

The exceptions are the readers that never see a tree node, and each has to ask
here directly:

* the battery ETA in the coordinator, which splits the raw history buffer by
  sign, and where a wrong answer is silent -- time-to-full and time-to-empty
  simply report each other's value;
* solar bias correction's curtailment filter, which loads grid power straight
  from the recorder and whose ``InvalidationInputs`` contract is
  positive-is-export;
* the simple card, which needs battery power *signed* rather than as the
  magnitude ``value_type`` yields;
* the config editor's entity inspection, which reports what a picked sensor
  currently reads, through :func:`interpret_power_reading` below.

A new reader of a raw power sensor belongs on that list, not outside it.
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


#: The gerund each option's quantity is *reported* as, keyed by the noun the
#: option names. Options are written as ``<sign>_is_<quantity>``, and the
#: quantity there is a noun because the option is a statement about the sensor
#: ("positive is export"); a reading is a statement about the house right now
#: ("exporting"), so it wants the verb. Adding a device to
#: ``POWER_POLARITY_OPTIONS`` with a new quantity means adding it here too --
#: and the absence is not silent, because :func:`interpret_power_reading`
#: answers ``idle`` rather than inventing a token no locale can translate.
_DIRECTION_TOKENS: dict[str, str] = {
    "production": "producing",
    "consumption": "consuming",
    "charging": "charging",
    "discharging": "discharging",
    "export": "exporting",
    "import": "importing",
}

#: What a reading of exactly zero -- or one whose sign the device's vocabulary
#: has no word for -- is reported as.
IDLE_DIRECTION = "idle"


def _split_option(option: str) -> tuple[str, str]:
    """``"positive_is_export"`` -> ``("positive", "export")``."""
    sign, _, quantity = option.partition("_is_")
    return sign, quantity


def interpret_power_reading(
    device: str,
    polarity: str | None,
    value: float,
) -> dict[str, Any]:
    """What ``value`` on ``device``'s power sensor means, under ``polarity``.

    The one place a *reading* is put into words, so that the editor's live
    status and any later consumer agree with the tree by construction rather
    than by two people remembering the same convention. Everything is derived
    from :data:`POWER_POLARITY_OPTIONS`: a device added to that table gets a
    reading for free, without a second table to keep in step.

    Returns ``{"direction": <token>, "inverted": <bool>}``. ``direction`` is a
    stable token the caller localizes -- never a sentence, and never a value
    that depends on the reader's locale.

    Two shapes of device vocabulary, and the rule covers both:

    * **Two quantities on one axis** (grid, battery). Both options name the
      *positive* sign, so the option in force says what a positive reading is
      and the other option's quantity is what a negative one is. A grid sensor
      set to ``positive_is_export`` reads ``exporting`` above zero and
      ``importing`` below it; set to ``positive_is_import`` the two swap.
    * **One quantity, two signs** (solar, house). The option in force names
      which sign carries the single quantity, and the *other* sign has no
      meaning in that vocabulary -- a solar sensor cannot consume. Such a
      reading answers ``idle``, which is what a small negative overnight
      figure from an inverter's own draw honestly is.

    Never raises. ``polarity`` may be absent, empty, or a value from another
    device's vocabulary; anything that is not the device's non-default option
    reads upright, exactly as :func:`is_power_inverted` resolves it, because
    that is what the runtime actually does with such a config. An unknown
    device answers ``idle`` rather than guessing.
    """
    options = POWER_POLARITY_OPTIONS.get(device)
    if options is None:
        return {"direction": IDLE_DIRECTION, "inverted": False}

    inverted = polarity == options[1]
    effective_sign, effective_quantity = _split_option(options[inverted])

    if not value:
        return {"direction": IDLE_DIRECTION, "inverted": inverted}

    reading_sign = "positive" if value > 0 else "negative"
    if reading_sign == effective_sign:
        return {
            "direction": _DIRECTION_TOKENS.get(effective_quantity, IDLE_DIRECTION),
            "inverted": inverted,
        }

    quantities = {_split_option(option)[1] for option in options}
    if len(quantities) == 2:
        opposite = next(quantity for quantity in quantities if quantity != effective_quantity)
        return {
            "direction": _DIRECTION_TOKENS.get(opposite, IDLE_DIRECTION),
            "inverted": inverted,
        }

    return {"direction": IDLE_DIRECTION, "inverted": inverted}
