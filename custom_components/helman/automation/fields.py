"""Declarative field schema for optimizer ``target`` / ``params`` / condition values.

A field is *declared*, not hand-parsed: the same declaration drives the config
reader, the group-override validator and the schema served to the visual editor,
so the editor can never offer a field the reader rejects. The five per-kind
``<Kind>ValidationError`` classes and their ~40 bespoke readers collapse onto
:func:`read_field`.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Any

from ..const import DAY_CLASSIFICATIONS

MISSING: Any = object()
"""Sentinel for "the key was absent", distinct from an explicit ``None``."""


class AutomationConfigError(ValueError):
    """Raised when the automation config block is invalid.

    ``path`` addresses the offending key inside the config document (e.g.
    ``automation.optimizers[1].conditions[0].params.window.end``) so the editor
    can point at the field the user has to fix.
    """

    def __init__(self, *, path: str, code: str, message: str) -> None:
        super().__init__(message)
        self.path = path
        self.code = code


class OptimizerConfigError(AutomationConfigError):
    """An :class:`AutomationConfigError` raised from inside one optimizer.

    One class replaces the four per-kind ``<Kind>ValidationError`` types (and
    export_price's bare ``ValueError``), so every caller handles config failure
    the same way and every error carries a full path instead of a bare field
    name the caller had to re-prefix.
    """


@dataclass(frozen=True)
class Field:
    """One config key: its type, its bounds and (for objects) its children."""

    key: str
    type: str  # number | integer | time | string | day_classifications | object
    required: bool = True
    default: Any = MISSING
    minimum: float | None = None
    minimum_exclusive: bool = False
    maximum: float | None = None
    choices: tuple[str, ...] | None = None
    fields: tuple["Field", ...] = ()

    def to_dict(self) -> dict[str, Any]:
        """Serialise for ``helman/get_optimizer_schema``. Omits absent facets."""
        payload: dict[str, Any] = {"key": self.key, "type": self.type}
        if not self.required:
            payload["required"] = False
        if self.default is not MISSING:
            payload["default"] = self.default
        if self.minimum is not None:
            payload["minimum"] = self.minimum
            if self.minimum_exclusive:
                payload["minimumExclusive"] = True
        if self.maximum is not None:
            payload["maximum"] = self.maximum
        if self.choices is not None:
            payload["choices"] = list(self.choices)
        if self.fields:
            payload["fields"] = [child.to_dict() for child in self.fields]
        return payload


# --- constructors -----------------------------------------------------------
#
# Named after the *meaning* of the value, not its JSON type, so a declaration
# reads as domain vocabulary and shared semantics (an SoC is always 0..100)
# cannot drift between kinds.


def time_hhmm(key: str, **kwargs: Any) -> Field:
    return Field(key=key, type="time", **kwargs)


def soc(key: str, **kwargs: Any) -> Field:
    return Field(key=key, type="number", minimum=0, maximum=100, **kwargs)


def margin_pct(key: str, *, default: Any = 0) -> Field:
    return Field(key=key, type="number", minimum=0, default=default)


def positive_number(key: str, **kwargs: Any) -> Field:
    return Field(key=key, type="number", minimum=0, minimum_exclusive=True, **kwargs)


def number(key: str, **kwargs: Any) -> Field:
    return Field(key=key, type="number", **kwargs)


def non_negative_int(key: str, **kwargs: Any) -> Field:
    return Field(key=key, type="integer", minimum=0, **kwargs)


def day_classifications(key: str, **kwargs: Any) -> Field:
    return Field(
        key=key,
        type="day_classifications",
        choices=DAY_CLASSIFICATIONS,
        **kwargs,
    )


def string(key: str, **kwargs: Any) -> Field:
    return Field(key=key, type="string", **kwargs)


def obj(key: str, *fields: Field, **kwargs: Any) -> Field:
    return Field(key=key, type="object", fields=fields, **kwargs)


# --- reading ----------------------------------------------------------------


def read_fields(
    fields: tuple[Field, ...],
    value: object,
    *,
    path: str,
    partial: bool = False,
) -> dict[str, Any]:
    """Validate ``value`` against ``fields`` and return the resolved mapping.

    ``partial=True`` reads a condition group's ``params`` override: every key
    becomes optional (including inside nested objects) and defaults are not
    filled in, but unknown keys are still rejected — ``battery_first: {typo: 1}``
    must fail loudly rather than merge silently.
    """
    if value is MISSING or value is None:
        data: Mapping[str, Any] = {}
    elif isinstance(value, Mapping):
        data = {str(key): item for key, item in value.items()}
    else:
        raise AutomationConfigError(
            path=path, code="invalid_type", message=f"{path} must be an object"
        )

    known = {field.key for field in fields}
    for key in data:
        if key not in known:
            raise AutomationConfigError(
                path=f"{path}.{key}",
                code="unknown_key",
                message=(
                    f"{path}.{key} is not a valid key"
                    + (f"; expected one of {', '.join(sorted(known))}" if known else "")
                ),
            )

    resolved: dict[str, Any] = {}
    for field in fields:
        raw = data.get(field.key, MISSING)
        if partial and raw is MISSING:
            continue
        read = read_field(field, raw, path=f"{path}.{field.key}", partial=partial)
        if read is not MISSING:
            resolved[field.key] = read
    return resolved


def read_field(
    field: Field,
    value: object,
    *,
    path: str,
    partial: bool = False,
) -> Any:
    """Validate one field's value. Returns :data:`MISSING` for an absent optional."""
    if value is MISSING or value is None:
        if partial:
            return MISSING
        if field.default is not MISSING:
            value = field.default
        elif field.required:
            raise AutomationConfigError(
                path=path, code="required", message=f"{path} is required"
            )
        else:
            return MISSING

    if field.type == "object":
        return read_fields(field.fields, value, path=path, partial=partial)
    if field.type == "time":
        return _read_time(value, path=path)
    if field.type == "day_classifications":
        return _read_day_classifications(value, path=path, field=field)
    if field.type == "string":
        return _read_string(value, path=path, field=field)
    if field.type == "integer":
        return _read_bounded(value, path=path, field=field, integer=True)
    if field.type == "number":
        return _read_bounded(value, path=path, field=field, integer=False)
    raise AssertionError(f"unsupported field type {field.type!r}")


def _read_time(value: object, *, path: str) -> str:
    """Normalise an ``"HH:MM"`` string; kept as a string so it round-trips to YAML."""
    if isinstance(value, str):
        parts = value.split(":")
        if len(parts) == 2:
            try:
                hour, minute = int(parts[0]), int(parts[1])
            except ValueError:
                hour = minute = -1
            if 0 <= hour <= 23 and 0 <= minute <= 59:
                return f"{hour:02d}:{minute:02d}"
    raise AutomationConfigError(
        path=path, code="invalid_value", message=f"{path} must be an 'HH:MM' time"
    )


def _read_day_classifications(
    value: object, *, path: str, field: Field
) -> tuple[str, ...]:
    # An empty list is allowed and means "no classification qualifies" — the
    # faithful migration of a `skip.on_days` covering every classification.
    if not isinstance(value, (list, tuple)):
        raise AutomationConfigError(
            path=path, code="invalid_type", message=f"{path} must be a list"
        )
    allowed = field.choices or DAY_CLASSIFICATIONS
    for item in value:
        if item not in allowed:
            raise AutomationConfigError(
                path=path,
                code="invalid_value",
                message=f"{path} entries must be one of {', '.join(allowed)}",
            )
    return tuple(value)


def _read_string(value: object, *, path: str, field: Field) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AutomationConfigError(
            path=path,
            code="invalid_type",
            message=f"{path} must be a non-empty string",
        )
    text = value.strip()
    if field.choices is not None and text not in field.choices:
        raise AutomationConfigError(
            path=path,
            code="invalid_value",
            message=f"{path} must be one of {', '.join(field.choices)}",
        )
    return text


def _read_bounded(value: object, *, path: str, field: Field, integer: bool) -> Any:
    expected = "an integer" if integer else "a number"
    # bool is an int subclass; `true` is never a valid number here.
    if isinstance(value, bool) or not isinstance(value, int if integer else (int, float)):
        raise AutomationConfigError(
            path=path, code="invalid_type", message=f"{path} must be {expected}"
        )
    resolved: Any = value if integer else float(value)

    if field.minimum is not None:
        if field.minimum_exclusive and not resolved > field.minimum:
            raise AutomationConfigError(
                path=path,
                code="invalid_value",
                message=f"{path} must be > {field.minimum:g}",
            )
        if not field.minimum_exclusive and resolved < field.minimum:
            raise AutomationConfigError(
                path=path,
                code="invalid_value",
                message=f"{path} must be >= {field.minimum:g}",
            )
    if field.maximum is not None and resolved > field.maximum:
        raise AutomationConfigError(
            path=path,
            code="invalid_value",
            message=f"{path} must be <= {field.maximum:g}",
        )
    return resolved


def time_on(hhmm: str, local_date: "date", *, tzinfo: Any) -> "datetime":
    """Resolve an ``"HH:MM"`` field to a concrete local datetime on ``local_date``."""
    hour, _, minute = hhmm.partition(":")
    return datetime.combine(
        local_date, time(int(hour), int(minute)), tzinfo=tzinfo
    )


def merge_params(
    master: Mapping[str, Any], override: Mapping[str, Any]
) -> dict[str, Any]:
    """Merge a group's ``params`` override onto the master, one level deep.

    Objects merge key-by-key so a group can move ``window.end`` and inherit
    ``window.start``; scalars and lists replace wholesale. Current param schemas
    are at most two levels deep, so one level of nesting covers every kind.
    """
    merged = dict(master)
    for key, value in override.items():
        current = merged.get(key)
        if isinstance(value, Mapping) and isinstance(current, Mapping):
            merged[key] = {**current, **value}
        else:
            merged[key] = value
    return merged
