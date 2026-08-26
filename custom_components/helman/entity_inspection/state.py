"""What a picked entity currently reads, before anyone decides what it means.

Every evaluator starts the same way: find the entity, get its state, and either
report a number or say why there isn't one. That part carries no interpretation
at all -- a missing entity, ``unknown``, ``nan`` and "abc" are the same four
answers whether the sensor is a grid meter or an energy total -- so it lives
here rather than being written out again in each evaluator, where the second
copy would inevitably drift from the first in exactly the cases nobody tests.

What an evaluator does *with* the number is its own business, and stays in its
own module. This one only refuses to guess.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .model import Fact

#: HA's "no reading" sentinels, which are states like any other and would
#: otherwise be reported as a non-numeric value.
_ABSENT_STATES = frozenset({"unknown", "unavailable", "", "none"})


def format_value(value: float) -> str:
    """A *finite* reading as the editor should show it, without a locale opinion.

    Trailing zeros are trimmed because a sensor reporting ``1400.0`` and one
    reporting ``1400`` are saying the same thing, and a status line that changes
    width on the second decimal is hard to read at a two-second poll.

    Fixed-point rather than ``%g``, whose six significant digits would render a
    perfectly ordinary ``12345.67`` W as ``12345.7``: the point of the badge is
    to show what the sensor says.

    Callers must have ruled out ``nan`` and ``inf`` already -- ``int()`` raises
    on both, and :func:`read_numeric_state` has already turned them into a
    ``problem``.
    """
    if value == int(value):
        return str(int(value))
    return f"{value:.2f}".rstrip("0").rstrip(".")


@dataclass(frozen=True)
class StateReading:
    """One entity's state, resolved to a number or to the reason there isn't one.

    Exactly one of ``value`` and ``problem`` is set. ``value`` is already
    rounded to the two decimals the editor shows, because the *shown* value is
    what an evaluator should interpret: rounding once, up front, is what keeps a
    reading of 0.004 W from rendering the contradictory pair "0 W" and
    "Producing".

    ``text`` is the state exactly as the entity reported it, kept because a
    state that is not a number is still a reading for anyone not about to do
    arithmetic with it: a switch says ``on``, a select says its option. Only
    the fallback evaluator has any use for it -- every other evaluator needs
    the number and takes the ``problem`` instead.
    """

    value: float | None
    unit: str | None
    problem: Fact | None
    text: str = ""

    @property
    def ok(self) -> bool:
        return self.problem is None

    def text_fact(self) -> Fact:
        """The state as it stands, for a reading that need not be numeric."""
        return Fact(
            id="value",
            token="value",
            params={"value": self.text, "unit": self.unit or ""},
            severity="neutral",
        )

    def value_fact(self) -> Fact:
        """The number itself, as the fact every evaluator leads with."""
        return Fact(
            id="value",
            token="value",
            params={"value": format_value(self.value or 0.0), "unit": self.unit or ""},
            severity="neutral",
        )


def read_numeric_state(hass: Any, entity_id: str) -> StateReading:
    """The entity's state as a number, or the warning that says why not.

    Never raises. This runs on a poll against a half-edited draft, so an entity
    that does not exist, a state of ``unknown`` and a template sensor emitting
    ``nan`` because its source went away are all ordinary inputs.
    """
    state = _state_of(hass, entity_id)
    if state is None:
        return StateReading(
            value=None,
            unit=None,
            problem=Fact(id="state", token="entity_missing", severity="warn"),
        )

    raw = getattr(state, "state", None)
    text = raw.strip() if isinstance(raw, str) else ""
    attributes = getattr(state, "attributes", None) or {}
    unit = attributes.get("unit_of_measurement") if hasattr(attributes, "get") else None

    if text.lower() in _ABSENT_STATES:
        return StateReading(
            value=None,
            unit=unit,
            problem=Fact(
                id="state",
                token="state_absent",
                params={"state": text},
                severity="warn",
            ),
        )

    try:
        value = float(text)
    except (TypeError, ValueError):
        value = math.nan
    if not math.isfinite(value):
        # ``nan`` and ``inf`` parse as floats but are not readings. They belong
        # in the same warning as "abc": what must not happen is falling through
        # and formatting them, which raises and would degrade the whole row to
        # ``unsupported`` -- indistinguishable from a path the backend has
        # never heard of.
        return StateReading(
            value=None,
            unit=unit,
            text=text,
            problem=Fact(
                id="state",
                token="not_numeric",
                params={"state": text},
                severity="warn",
            ),
        )

    # ``or 0.0`` so that a rounded ``-0.0`` reads as zero rather than carrying a
    # sign no reader asked about.
    return StateReading(value=round(value, 2) or 0.0, unit=unit, problem=None, text=text)


def _state_of(hass: Any, entity_id: str) -> Any:
    """``hass.states.get`` behind a guard, for a hass that may be half-set-up."""
    states = getattr(hass, "states", None)
    getter = getattr(states, "get", None)
    if getter is None:
        return None
    try:
        return getter(entity_id)
    except Exception:  # noqa: BLE001 - a poll must never fail on a bad id
        return None
