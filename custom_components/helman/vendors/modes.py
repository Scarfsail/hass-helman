"""The writes a profile's inverter mode applies, and whether the hardware shows them.

One definition of "the hardware is in this mode", shared by Helman's mode select
(which skips a write already in place and, with nothing to restore, starts on
the option the hardware already shows) and by the inverter detail (which
compares the last command with the observed configuration).

"Matches" means the mode-related registers read what the command writes; it is
a configuration check, not proof of the inverter's physical response. A
register without a readable state makes the comparison *unknown*, never a
mismatch: only a fully observed configuration that differs is one.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from ..const import SCHEDULE_ACTION_STOP_EXPORT
from .profile import EntityTemplate, VendorProfile

#: States that say nothing about what a register holds.
_UNREADABLE_STATES = frozenset({"unknown", "unavailable", "none"})

ModeWrite = tuple[EntityTemplate, Any]
BoundWrite = tuple[str, Any]


class _NonZero:
    """The export limit of every mode but ``stop_export``, as a recorded history reads it."""

    def __repr__(self) -> str:
        return "non-zero"


#: A target any non-zero reading holds. A past mode is told apart by the export
#: limit being zero or not, never by today's ``max_allowed_export_power``, so
#: editing that setting does not rewrite what the inverter did earlier.
NON_ZERO = _NonZero()


class ModeWritesError(Exception):
    """An option's writes cannot be put together: a setting or entity is missing."""


def mode_write_templates(
    profile: VendorProfile, option: str, config: Mapping[str, Any], *, history: bool = False
) -> list[ModeWrite]:
    """The vendor writes for ``option``, in order, as ``(template, target)``.

    The export limit follows every mode: ``0`` for ``stop_export``, the grid's
    ``max_allowed_export_power`` otherwise, which then has to be configured.
    With ``history`` it is :data:`NON_ZERO` otherwise, read from no config.
    """
    if option == SCHEDULE_ACTION_STOP_EXPORT:
        export_limit: Any = 0
    elif history:
        export_limit = NON_ZERO
    else:
        export_limit = (
            config.get("energy_nodes", {}).get("grid", {}).get("max_allowed_export_power")
        )
        if export_limit is None:
            raise ModeWritesError(
                "energy_nodes.grid.max_allowed_export_power is not configured; "
                f"the {profile.label} profile restores the export limit to it"
            )
    writes: list[ModeWrite] = [*profile.modes[option]]
    if profile.export_limit is not None:
        writes.append((profile.export_limit, export_limit))
    return writes


def bind_mode_writes(
    profile: VendorProfile,
    option: str,
    writes: list[ModeWrite],
    entity_ids: Mapping[EntityTemplate, str | None],
) -> list[BoundWrite]:
    """``writes`` with each template replaced by the entity id it resolved to.

    Everything is bound before the first write, so a missing entity fails the
    option without applying half of it.
    """
    missing = sorted(
        {
            f"{domain} {template}"
            for (domain, template), _ in writes
            if entity_ids.get((domain, template)) is None
        }
    )
    if missing:
        raise ModeWritesError(
            f"The {profile.label} profile cannot apply {option!r}: no "
            f"{profile.platform} entity for {', '.join(missing)}"
        )
    return [(entity_ids[template], target) for template, target in writes]


def register_matches(state: Any, entity_id: str, target: Any) -> bool | None:
    """Whether a register's ``state`` holds ``target``; ``None`` when unreadable.

    A number compares as a float, so ``9900.0`` holds ``9900``; any non-zero
    number holds :data:`NON_ZERO`.
    """
    if state is None or state.state.strip().lower() in _UNREADABLE_STATES:
        return None
    if target is NON_ZERO:
        value = _as_float(state.state)
        return None if value is None else value != 0
    if entity_id.startswith("number."):
        return _as_float(state.state) == float(target)
    return state.state == target


def first_matching_option(
    bound_writes: Mapping[str, list[BoundWrite] | None],
    get_state: Callable[[str], Any],
) -> str | None:
    """The first option whose every write the registers already hold.

    An option whose writes could not be bound (``None``) never matches.
    """
    for option, writes in bound_writes.items():
        if writes is not None and all(
            register_matches(get_state(entity_id), entity_id, target) is True
            for entity_id, target in writes
        ):
            return option
    return None


def bound_mode_writes(
    hass: Any,
    profile: VendorProfile,
    entry: Any,
    config: Mapping[str, Any],
    *,
    history: bool = False,
) -> dict[str, list[BoundWrite] | None]:
    """Each of the profile's options → its writes bound to entity ids, in profile order.

    ``None`` for an option whose writes cannot be put together or bound (a
    setting or vendor entity is missing). ``history`` binds them for reading
    a recorded history, as :func:`mode_write_templates` does.
    """
    from . import resolve_unique_ids

    templates: dict[str, list[ModeWrite] | None] = {}
    for option in profile.modes:
        try:
            templates[option] = mode_write_templates(profile, option, config, history=history)
        except ModeWritesError:
            templates[option] = None
    # One registry read for every option's registers.
    entity_ids = resolve_unique_ids(
        hass,
        profile,
        entry,
        {template for writes in templates.values() for template, _ in writes or ()},
    )

    def _bind(option: str) -> list[BoundWrite] | None:
        writes = templates[option]
        if writes is None:
            return None
        try:
            return bind_mode_writes(profile, option, writes, entity_ids)
        except ModeWritesError:
            return None

    return {option: _bind(option) for option in profile.modes}


def mode_agreement(
    hass: Any,
    profile: VendorProfile,
    entry: Any,
    config: Mapping[str, Any],
    commanded: str | None,
) -> dict[str, Any]:
    """Whether the hardware's mode registers hold the last commanded option.

    ``status`` is ``match``, ``mismatch`` or ``unknown``; an unknown carries a
    ``reason``: ``no_command`` (no commanded option to compare), ``not_bound``
    (a setting or vendor entity is missing) or ``unavailable`` (a register has
    no readable state). ``registers`` lists every write of the command with
    what it reads, and ``observedOption`` the option the registers hold, if
    any, whatever was commanded. ``observedFrom`` lists every register any
    option binds: the states ``observedOption`` is read from.
    """
    bound = bound_mode_writes(hass, profile, entry, config)
    observed = first_matching_option(bound, hass.states.get)
    result: dict[str, Any] = {
        "commanded": commanded,
        "observedOption": observed,
        "observedFrom": sorted(
            {entity_id for writes in bound.values() for entity_id, _ in writes or ()}
        ),
        "registers": [],
    }
    if commanded not in profile.modes:
        return {**result, "status": "unknown", "reason": "no_command"}
    writes = bound[commanded]
    if writes is None:
        return {**result, "status": "unknown", "reason": "not_bound"}
    registers = []
    for entity_id, target in writes:
        state = hass.states.get(entity_id)
        registers.append(
            {
                "entityId": entity_id,
                "expected": target,
                "actual": None if state is None else state.state,
                "matches": register_matches(state, entity_id, target),
            }
        )
    result["registers"] = registers
    if any(register["matches"] is None for register in registers):
        return {**result, "status": "unknown", "reason": "unavailable"}
    if all(register["matches"] for register in registers):
        return {**result, "status": "match", "reason": None}
    return {**result, "status": "mismatch", "reason": None}


def _as_float(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None
