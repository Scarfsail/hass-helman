"""One-way migration of stored automation configs to the unified shape.

Pure ``dict -> dict``: no Home Assistant and no storage, so its tests run on the
host and every rule is table-checkable. What a step needs from Home Assistant —
Energy preferences, for v20 -> v21, entity suggestions, for v22 -> v23, and
device labels, for v25 -> v26 — is an argument. The only side effects are the
log lines of the v20 and v22 steps.

Runs on **load only**. The save path rejects the old shape instead of rewriting
it (see ``validate_config_document``): hand-editing is a save-path concern, and
silently rewriting a user's YAML under them is worse than refusing it.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Callable, Iterator, Mapping, Sequence
from copy import deepcopy
from functools import partial
from typing import Any

from ..const import CONFIG_DOCUMENT_VERSION, DAY_CLASSIFICATIONS
from ..controllables.config import (
    CONTROLLABLE_KIND_GENERIC,
    CONTROLLABLE_KIND_INVERTER,
    iter_devices,
    own_meter,
    peek_controllable_kind,
    running_signal,
)
from ..controllables.energy_import import import_energy_preferences, meter_device_id

#: ``(anchor entity ids, document) -> {"energy" | "power" | "switch": ranked
#: candidates}`` — the shape of
#: :func:`..controllables.suggestions.suggest_entities` with ``hass`` bound.
EntitySuggestions = Callable[
    [Sequence[str], Mapping[str, Any]], Mapping[str, list[Mapping[str, Any]]]
]

#: ``entity id -> label names on that entity's HA device`` — what the v25 ->
#: v26 step reads a device's Home Assistant labels through.
DeviceLabels = Callable[[str], list[str]]

_LOGGER = logging.getLogger(__name__)

#: Keys no reader has ever read: each carried exactly one legal value, or (for
#: `release`) named a decision the optimizer computes rather than takes as
#: config. Moving them would move no information, so they are dropped silently
#: here; the reader rejects them from now on.
_DROPPED_PARAMS = ("action", "hold_action", "release")

#: ``old params key -> condition key``. All of these were system conditions
#: living in ``params``; the point of the unification is that they are visibly
#: conditions now.
_PARAM_TO_CONDITION = {
    "charge_hold": {"only_on_days": "run_when"},
    "export_price": {"when_price_below": "when_price_below"},
    "surplus_appliance": {"min_surplus_buffer_pct": "min_surplus_buffer_pct"},
    "charge_from_grid": {"reserve_floor_soc": "reserve_floor_soc"},
}

#: ``params`` keys that describe *what* the optimizer acts on, not how.
_PARAM_TO_TARGET = ("appliance_id", "climate_mode")


def needs_migration(document: Mapping[str, Any] | None) -> bool:
    """A plain version check — deliberately not gated on ``automation``.

    Every step up to v5 was optimizer-shaped, so skipping automation-less
    documents was harmless. v5->v6 moves a *solar* key, and that gate would
    have dropped it silently for any config without an automation block. The
    cost is that such documents now get ``config_version`` stamped and
    rewritten once.
    """
    if not isinstance(document, Mapping):
        return False
    return _document_version(document) < CONFIG_DOCUMENT_VERSION


def migrate_config_document(
    document: Mapping[str, Any] | None,
    energy_preferences: Mapping[str, Any] | None = None,
    entity_suggestions: EntitySuggestions | None = None,
    device_labels: DeviceLabels | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Return ``(migrated_document, migrated_optimizer_ids)``.

    ``energy_preferences`` are Home Assistant's Energy preferences, which the
    v20 -> v21 step imports into ``devices``; ``None`` imports nothing.
    ``entity_suggestions`` ranks a meter's sibling entities for the v22 -> v23
    power and switch backfill; ``None`` backfills nothing. ``device_labels``
    names the HA labels the v25 -> v26 step turns into group membership;
    ``None`` assigns nothing.

    The document is returned unchanged (and the id list empty) when it is
    already at the current version. Optimizer order is preserved verbatim —
    later optimizers overwrite earlier ones, and ``charge_hold`` documents that
    it must precede ``export_price``.

    Steps compose: a version-1 document runs through every step in turn. Each
    step must therefore read exactly the shape its predecessor wrote, which is
    why they are separate functions rather than one accumulated transform — the
    version-1 rules would silently wipe the ``conditions`` a version-2 document
    already has.
    """
    if not isinstance(document, Mapping):
        return ({} if document is None else dict(document), [])
    migrated = deepcopy(dict(document))
    version = _document_version(document)
    migrated["config_version"] = CONFIG_DOCUMENT_VERSION
    if version >= CONFIG_DOCUMENT_VERSION:
        return (migrated, [])

    # The steps that take an argument are bound here; the table holds the
    # pure document-to-document steps.
    migrations = {
        **_MIGRATIONS,
        20: partial(_migrate_v20_to_v21, energy_preferences=energy_preferences),
        22: partial(_migrate_v22_to_v23, entity_suggestions=entity_suggestions),
        25: partial(_migrate_v25_to_v26, device_labels=device_labels),
    }
    migrated_ids: list[str] = []
    while version < CONFIG_DOCUMENT_VERSION:
        migrated, ids = migrations[version](migrated)
        migrated_ids = ids or migrated_ids
        version += 1
    return (migrated, migrated_ids)


def _migrate_optimizers(
    document: dict[str, Any],
    migrate: Any,
    *,
    bucket: str = "optimizers",
) -> tuple[dict[str, Any], list[str]]:
    """Apply ``migrate`` to every optimizer, dropping the ones it returns ``None`` for.

    ``bucket`` names the list to walk: ``optimizers`` up to version 14, then
    ``appliance_optimizers`` / ``system_optimizers`` after the split.
    """
    automation = document.get("automation")
    if not isinstance(automation, Mapping):
        return (document, [])
    optimizers = automation.get(bucket)
    if not isinstance(optimizers, list):
        return (document, [])

    migrated_ids: list[str] = []
    rebuilt: list[Any] = []
    for raw in optimizers:
        if not isinstance(raw, Mapping):
            rebuilt.append(raw)
            continue
        replacement = migrate(dict(raw))
        if replacement is not None:
            rebuilt.append(replacement)
        migrated_ids.append(str(raw.get("id", "?")))
    document["automation"] = {**automation, bucket: rebuilt}
    return (document, migrated_ids)


def _migrate_v1_to_v2(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    return _migrate_optimizers(document, _migrate_optimizer)


def _migrate_v2_to_v3(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    return _migrate_optimizers(document, _nest_daily_minimum)


def _nest_daily_minimum(optimizer: dict[str, Any]) -> dict[str, Any]:
    """``min_hours_per_day`` + ``max_consecutive_skips`` -> ``daily_minimum``.

    They are one concept — a floor and how long it may go unmet — and nesting
    them makes "skips without a minimum" unrepresentable. Absence of the object
    now means uncapped, so a v2 optimizer that omitted ``max_consecutive_skips``
    and relied on its ``default=0`` must have the 0 written out: absent used to
    mean "force after the first short day", and now means "never force".
    """
    if optimizer.get("kind") != "daily_runtime":
        return optimizer

    def nest(params: dict[str, Any], *, fill_default: bool) -> dict[str, Any]:
        daily_minimum = {
            key: params.pop(key)
            for key in ("min_hours_per_day", "max_consecutive_skips")
            if key in params
        }
        if fill_default and "min_hours_per_day" in daily_minimum:
            daily_minimum.setdefault("max_consecutive_skips", 0)
        if daily_minimum:
            params["daily_minimum"] = daily_minimum
        return params

    migrated = dict(optimizer)
    migrated["params"] = nest(dict(optimizer.get("params") or {}), fill_default=True)
    conditions = optimizer.get("conditions")
    if isinstance(conditions, list):
        migrated["conditions"] = [
            (
                {**group, "params": nest(dict(group["params"]), fill_default=False)}
                if isinstance(group, Mapping) and isinstance(group.get("params"), Mapping)
                else group
            )
            for group in conditions
        ]
    return migrated


def _migrate_v3_to_v4(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    return _migrate_optimizers(document, _merge_appliance_kinds)


def _merge_appliance_kinds(optimizer: dict[str, Any]) -> dict[str, Any]:
    """Both retired appliance kinds -> ``appliance_runtime``.

    They differed only in whether placement was capped, which is now
    ``daily_minimum``'s presence: ``daily_runtime`` keeps its params and is
    capped, ``surplus_appliance`` has none and is uncapped.

    ``enabled`` is carried over untouched — a disabled rule stays disabled, and
    the user's optimizer list keeps the entries and appliance targets they
    authored.
    """
    kind = optimizer.get("kind")
    if kind == "surplus_appliance":
        return {
            **optimizer,
            "kind": "appliance_runtime",
            "conditions": _translate_surplus_groups(optimizer.get("conditions")),
        }
    if kind == "daily_runtime":
        return {**optimizer, "kind": "appliance_runtime"}
    return optimizer


def _migrate_v4_to_v5(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    return _migrate_optimizers(document, _rename_appliance_runtime_price_condition)


def _rename_appliance_runtime_price_condition(optimizer: dict[str, Any]) -> dict[str, Any]:
    """``appliance_runtime``'s ``when_price_below`` -> ``max_run_price``.

    Issue #5: the two kinds sharing ``when_price_below`` needed opposite
    aggregation over a slot's forecast buckets (any-bucket for ``export_price``,
    all-bucket for permission-to-consume), so ``appliance_runtime`` gets its own
    condition key rather than a hidden branch on a shared one.
    ``export_price``'s ``when_price_below`` is untouched — this only renames
    the key inside ``appliance_runtime`` groups.
    """
    if optimizer.get("kind") != "appliance_runtime":
        return optimizer
    conditions = optimizer.get("conditions")
    if not isinstance(conditions, list):
        return optimizer
    renamed: list[Any] = []
    for group in conditions:
        if isinstance(group, Mapping) and "when_price_below" in group:
            group = dict(group)
            group["max_run_price"] = group.pop("when_price_below")
        renamed.append(group)
    return {**optimizer, "conditions": renamed}


def _translate_surplus_groups(conditions: Any) -> list[Any]:
    """Drop the retired buffer and give each group ``run_when: [surplus]``.

    An uncapped optimizer whose group narrows nothing means "on for the whole
    horizon", which the reader rejects — so removing ``min_surplus_buffer_pct``
    cannot simply leave a hole. ``run_when: ["surplus"]`` is the closest honest
    reading of what the kind meant (run when the day has solar to spare) and
    invents no threshold, unlike seeding a window or an SoC floor. It is a
    starting point the user is expected to refine — most will want
    ``min_soc_pct`` — not a faithful reproduction of the buffer test, which
    cannot be expressed any more.
    """
    if not isinstance(conditions, list):
        return [{"run_when": ["surplus"], "custom": []}]
    translated: list[Any] = []
    for group in conditions:
        if not isinstance(group, Mapping):
            translated.append(group)
            continue
        rewritten = {
            key: value
            for key, value in group.items()
            if key != "min_surplus_buffer_pct"
        }
        rewritten.setdefault("run_when", ["surplus"])
        translated.append(rewritten)
    return translated or [{"run_when": ["surplus"], "custom": []}]


def _migrate_v5_to_v6(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Solar bias ``training_time`` -> top-level ``training_time``.

    The nightly training batch runs more than solar bias training, so the
    schedule stops belonging to the bias section. First step that touches no
    optimizer, hence the empty id list.

    An existing top-level value wins: it was authored against the new location,
    while the bias key is the leftover being retired.
    """
    power_devices = document.get("power_devices")
    if not isinstance(power_devices, Mapping):
        return (document, [])
    solar = power_devices.get("solar")
    if not isinstance(solar, Mapping):
        return (document, [])
    solar_forecast = solar.get("forecast")
    if not isinstance(solar_forecast, Mapping):
        return (document, [])
    bias = solar_forecast.get("bias_correction")
    if not isinstance(bias, Mapping) or "training_time" not in bias:
        return (document, [])

    bias = dict(bias)
    training_time = bias.pop("training_time")
    document["power_devices"] = {
        **power_devices,
        "solar": {
            **solar,
            "forecast": {**solar_forecast, "bias_correction": bias},
        },
    }
    document.setdefault("training_time", training_time)
    return (document, [])


def _migrate_v6_to_v7(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``appliances`` + ``scheduler.control`` -> one ``controllables`` list.

    The two keys held the same category of information — which entity Helman
    drives, and how — split only by the accident that the inverter arrived
    first and got a section of its own. ``scheduler`` held nothing else: no
    horizon, no slot grid, no policy, just that one control block.

    Mechanical in both halves. Appliance entries move verbatim: same ``kind``,
    same per-kind fields, same ``controls`` sub-shape. The inverter becomes a
    ``kind: inverter`` entry with the reserved id ``inverter``, where
    ``mode_entity_id`` and ``action_option_map`` become
    ``controls.mode.entity_id`` and ``controls.mode.options`` — which is what
    makes it visibly the same category as an appliance's
    ``controls.switch.entity_id``.

    The inverter goes first because it is the singleton every installation has
    and the one the schedule lanes lead with; appliance order is preserved
    after it. Any key ``scheduler.control`` carried beyond those two is copied
    onto the inverter entry rather than dropped, so a config written against a
    later shape survives the move. ``scheduler`` itself is then dropped: after
    this step nothing reads it, and the save path rejects it.

    An ``appliances`` value that is not a list is moved across unchanged rather
    than discarded — the information survives, and the reader and validator
    report the type error in the new vocabulary.
    """
    if "appliances" not in document and "scheduler" not in document:
        return (document, [])

    appliances = document.pop("appliances", None)
    scheduler = document.pop("scheduler", None)

    if appliances is not None and not isinstance(appliances, list):
        document["controllables"] = appliances
        return (document, [])

    controllables: list[Any] = []
    inverter = _inverter_controllable(scheduler)
    if inverter is not None:
        controllables.append(inverter)
    existing = document.get("controllables")
    if isinstance(existing, list):
        controllables.extend(existing)
    controllables.extend(appliances or [])
    document["controllables"] = controllables
    return (document, [])


def _inverter_controllable(scheduler: Any) -> dict[str, Any] | None:
    """The ``kind: inverter`` entry ``scheduler.control`` becomes, if any.

    An installation that never wired the inverter up has no control block, and
    gets no entry — an empty inverter card would only invite the user to fill
    in a device they do not have.
    """
    if not isinstance(scheduler, Mapping):
        return None
    control = scheduler.get("control")
    if not isinstance(control, Mapping) or not control:
        return None

    mode: dict[str, Any] = {}
    entity_id = control.get("mode_entity_id")
    if entity_id is not None:
        mode["entity_id"] = entity_id
    options = control.get("action_option_map")
    if options is not None:
        mode["options"] = deepcopy(options)

    extra = {
        key: deepcopy(value)
        for key, value in control.items()
        if key not in ("mode_entity_id", "action_option_map")
    }
    return {
        "kind": "inverter",
        "id": "inverter",
        "name": "Inverter",
        "controls": {"mode": mode},
        **extra,
    }


#: The three kinds that hit the inverter implicitly, by virtue of being
#: themselves, up to version 7. Spelled out rather than read from
#: ``OPTIMIZER_SPECS``: a migration describes a moment in history, and must keep
#: describing it when the registry gains a fourth inverter-driving kind — that
#: kind will arrive with ``controllable_id`` already written.
_V7_INVERTER_OPTIMIZER_KINDS = ("charge_hold", "export_price", "charge_from_grid")


def _migrate_v7_to_v8(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    return _migrate_optimizers(document, _target_controllable_id)


def _target_controllable_id(optimizer: dict[str, Any]) -> dict[str, Any]:
    """Every optimizer names its target by controllable id, uniformly.

    Two halves of one move. ``appliance_runtime`` had the field already, under
    the narrower name ``appliance_id`` — the list it indexes into is called
    ``controllables`` since version 7, and an id that can name the inverter is
    not an appliance id. The three inverter kinds had no target at all and were
    resolved from their own ``kind``; they get the reserved ``inverter`` id
    written out, so what they always meant is now said.

    Reads what version 2 wrote: ``_PARAM_TO_TARGET`` moved ``appliance_id`` from
    ``params`` to ``target`` back then, so by the time a version-1 document
    reaches this step the key is where this step looks for it. That ordering is
    the composition rule ``migrate_config_document`` documents.

    An explicit ``controllable_id`` always wins — on the inverter kinds it is
    what the user authored, and on ``appliance_runtime`` a document carrying
    both keys is already half-migrated by hand.
    """
    target = dict(optimizer.get("target") or {})
    appliance_id = target.pop("appliance_id", None)
    if appliance_id is not None:
        target.setdefault("controllable_id", appliance_id)
    if optimizer.get("kind") in _V7_INVERTER_OPTIMIZER_KINDS:
        target.setdefault("controllable_id", "inverter")
    if not target:
        return optimizer
    return {**optimizer, "target": target}


def _migrate_v8_to_v9(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``projection`` -> ``consumption.projection``, with the meter lifted out.

    A controllable entry said everything about how the device is *driven* under
    ``controls`` and nothing about what it *draws* in any one place: the energy
    meter lived at ``projection.history_average.energy_entity_id``, nested
    inside a strategy, as though it belonged to the strategy rather than to the
    device. It does not — an EV charger has a meter and no projection at all,
    and so had nowhere to declare one.

    ``consumption`` is the sibling of ``controls`` that block was missing.
    Three moves, all mechanical: ``projection`` goes under it, the meter comes
    up to ``consumption.energy_entity_id``, and ``lookback_days`` flattens onto
    ``projection`` — with the meter gone ``history_average`` held one key, and
    the name still carries its meaning in ``strategy: history_average``.

    Entries with no ``projection`` are left alone: the inverter must never get
    a ``consumption`` block, and an entry that gains one for its meter alone is
    version 10's business. An entry that already has ``consumption`` is left
    alone too — it was hand-written against the new shape.
    """
    controllables = document.get("controllables")
    if not isinstance(controllables, list):
        return (document, [])

    rebuilt: list[Any] = []
    for entry in controllables:
        if not isinstance(entry, Mapping) or "consumption" in entry:
            rebuilt.append(entry)
            continue
        migrated = dict(entry)
        raw_projection = migrated.pop("projection", None)
        if raw_projection is None:
            rebuilt.append(migrated)
            continue
        if not isinstance(raw_projection, Mapping):
            # Not ours to interpret. It still belongs under consumption, and
            # the reader reports the type error in the new vocabulary.
            migrated["consumption"] = {"projection": raw_projection}
            rebuilt.append(migrated)
            continue

        projection = deepcopy(dict(raw_projection))
        consumption: dict[str, Any] = {}
        history_average = projection.pop("history_average", None)
        if isinstance(history_average, Mapping):
            energy_entity_id = history_average.get("energy_entity_id")
            if energy_entity_id is not None:
                consumption["energy_entity_id"] = deepcopy(energy_entity_id)
            lookback_days = history_average.get("lookback_days")
            if lookback_days is not None:
                projection["lookback_days"] = deepcopy(lookback_days)
        consumption["projection"] = projection
        migrated["consumption"] = consumption
        rebuilt.append(migrated)

    document["controllables"] = rebuilt
    return (document, [])


def _migrate_v9_to_v10(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``deferrable_consumers`` is derived from ``controllables`` now.

    The old key listed ``{energy_entity_id, label}`` for the loads the house
    forecast carves out of its baseline — the same devices already described
    in ``controllables``, named a second time, with nothing holding the two
    lists in agreement. Version 9 gave each entry its meter, so the list is
    derivable and the key has nothing left to say.

    The subtle half is the *default*. From here on a metered controllable is
    deferrable unless it says otherwise, which is the right rule going forward
    but not a description of any existing config: version 9 lifted meters out
    of ``history_average`` for appliances that were metered only to project
    themselves, and those were never in the deferrable list. Defaulting them
    to ``True`` would quietly widen the baseline split on upgrade and change
    every forecast. So this step writes ``deferrable: false`` on exactly those
    entries — what was true before, said out loud — and leaves the ones that
    *were* listed at the default.

    Matching is by meter where both sides have one, and by the old entry's
    ``label`` against the controllable's ``name`` where they do not — which is
    how a device that was *only* ever a deferrable consumer, the EV charger
    being the obvious one, gets its meter written onto its entry. The label was
    typed to name the same device in the same UI, so it is the only link the
    two lists ever had.

    An entry matching neither is dropped. It described something measured but
    not controlled, which the new shape has no room for; inventing a
    control-less entry to hold it would be worse than the gap, and the user can
    add the device properly.
    """
    forecast = _house_forecast_block(document)
    by_meter, by_label = _listed_deferrable_consumers(forecast)

    controllables = document.get("controllables")
    if isinstance(controllables, list):
        rebuilt: list[Any] = []
        for entry in controllables:
            if not isinstance(entry, Mapping) or entry.get("kind") == "inverter":
                rebuilt.append(entry)
                continue

            raw_consumption = entry.get("consumption")
            consumption = (
                dict(raw_consumption) if isinstance(raw_consumption, Mapping) else {}
            )
            meter = consumption.get("energy_entity_id")
            meter = meter.strip() if isinstance(meter, str) and meter.strip() else None
            name = entry.get("name")
            name = name.strip() if isinstance(name, str) else None

            if meter is not None:
                if meter in by_meter:
                    by_meter.pop(meter)
                else:
                    # Metered for its own projection, never a deferrable
                    # consumer. Say so, rather than letting the new default
                    # widen the split behind the user's back.
                    consumption.setdefault("deferrable", False)
            elif name is not None and name in by_label:
                consumption["energy_entity_id"] = by_label.pop(name)
            else:
                rebuilt.append(entry)
                continue

            rebuilt.append({**entry, "consumption": consumption})
        document["controllables"] = rebuilt

    if isinstance(forecast, dict):
        forecast.pop("deferrable_consumers", None)
    return (document, [])


#: The default the ``self_sustainability_margin_pct`` condition field carries.
#: Spelled out here rather than imported: a migration must keep writing what
#: version 10 meant even if the field's default moves later.
_V10_MARGIN_PCT_DEFAULT = 5


def _migrate_v10_to_v11(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    return _migrate_optimizers(document, _unify_self_sustainability)


def _unify_self_sustainability(optimizer: dict[str, Any]) -> dict[str, Any]:
    """``soft``/``strict`` become one number, and the margin joins it.

    Two changes to the same feature, so one step.

    The level was two settings that were never two points on one scale: ``soft``
    tested only the SoC floor, ``strict`` added a per-day balance test. They
    become a single budget — the share of nominal battery capacity the appliance
    may spend per day on energy the sun did not provide. ``strict`` is that
    budget at ``0``; ``soft`` is it switched off, which is ``100``.

    The margin moves from ``params.self_sustainability.margin_pct`` into each
    group as ``self_sustainability_margin_pct``. It was a param resolved as
    master-plus-override, so each group takes what it resolved *before* the
    move: its own override, else the master value, else the old default.

    It is written only where it ever meant anything — a group that asked for a
    budget, or an optimizer that spelled the margin out. Everywhere else the key
    is left off and the condition field's own default supplies it, because
    stamping ``5`` onto every group of every appliance would be noise the user
    did not write and would have to read past.

    **A named master margin is written onto every group, including ones with no
    budget; an unnamed one is not.** The asymmetry is deliberate, and it is the
    difference between a number the user wrote and a default they never saw. A
    master ``margin_pct: 12`` genuinely *was* what all three groups of a
    three-group optimizer resolved, so dropping it from the two without a budget
    would mean a group that gains one later silently runs on ``5`` instead of
    the 12 the config has said all along. Carrying a value nobody typed would
    have no such meaning to preserve.
    """
    if optimizer.get("kind") != "appliance_runtime":
        return optimizer

    conditions = optimizer.get("conditions")
    if not isinstance(conditions, list):
        # Nothing to move the margin *onto*, and a malformed or absent
        # `conditions` is the reader's to reject — replacing it with `[]` here
        # would launder it into a valid config that silently means "no groups".
        # Same bail as `_rename_appliance_runtime_price_condition`.
        return optimizer

    params = optimizer.get("params")
    params = dict(params) if isinstance(params, Mapping) else {}
    master_margin = _margin_from(params)

    rebuilt: list[Any] = []
    for group in conditions:
        if not isinstance(group, Mapping):
            rebuilt.append(group)
            continue
        group = dict(group)
        level = group.get("ensure_self_sustainability")
        if level == "strict":
            group["ensure_self_sustainability"] = 0
        elif level == "soft":
            group["ensure_self_sustainability"] = 100

        override = group.get("params")
        override = dict(override) if isinstance(override, Mapping) else None
        group_margin = _margin_from(override or {})
        resolved_margin = (
            group_margin if group_margin is not None else master_margin
        )
        if resolved_margin is not None:
            group["self_sustainability_margin_pct"] = resolved_margin
        elif level in ("soft", "strict"):
            # The group used the feature but never named a margin, so it ran on
            # the old param default. Say it out loud rather than trusting two
            # defaults in different modules to stay equal.
            group["self_sustainability_margin_pct"] = _V10_MARGIN_PCT_DEFAULT
        if override is not None:
            override.pop("self_sustainability", None)
            # An override that held nothing else is dropped rather than left as
            # an empty object: `read_fields` would accept it, but it would show
            # in the editor as a group that overrides params when it does not.
            if override:
                group["params"] = override
            else:
                group.pop("params", None)
        rebuilt.append(group)

    params.pop("self_sustainability", None)
    # `params` is left in place even when this empties it: an optimizer without
    # the key and one with an empty object read identically, and earlier steps
    # already produce the empty form.
    return {**optimizer, "params": params, "conditions": rebuilt}


def _margin_from(params: Mapping[str, Any]) -> Any:
    """``params.self_sustainability.margin_pct``, or ``None`` when unset."""
    block = params.get("self_sustainability")
    if not isinstance(block, Mapping):
        return None
    margin = block.get("margin_pct")
    return margin if isinstance(margin, (int, float)) else None


def _migrate_v11_to_v12(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Drop the retired ``slot_invalidation.export_enabled_entity_id``.

    Curtailment is inferred now — battery full, nothing exported, and the slot
    underdelivering against its own forecast — from entities the installation
    already declares. The boolean the user had to hand-build is gone, and with
    it the failure this step exists to clean up after: the entity behind it
    could vanish while the config kept naming it, which silently turned the
    whole rule into a no-op.

    Nothing replaces it in the document. The two thresholds the inference reads
    have defaults, so a config that says nothing gets the working behaviour.
    """
    bias = _bias_correction_block(document)
    if not isinstance(bias, dict):
        return (document, [])
    slot_invalidation = bias.get("slot_invalidation")
    if not isinstance(slot_invalidation, dict):
        return (document, [])
    slot_invalidation.pop("export_enabled_entity_id", None)
    return (document, [])


def _bias_correction_block(document: dict[str, Any]) -> Any:
    """``power_devices.solar.forecast.bias_correction``, or None."""
    power_devices = document.get("power_devices")
    if not isinstance(power_devices, dict):
        return None
    solar = power_devices.get("solar")
    if not isinstance(solar, dict):
        return None
    forecast = solar.get("forecast")
    if not isinstance(forecast, dict):
        return None
    bias = forecast.get("bias_correction")
    return bias if isinstance(bias, dict) else None


def _house_forecast_block(document: dict[str, Any]) -> Any:
    """``power_devices.house.forecast``, or ``None`` if the path is not there."""
    power_devices = document.get("power_devices")
    if not isinstance(power_devices, dict):
        return None
    house = power_devices.get("house")
    if not isinstance(house, dict):
        return None
    forecast = house.get("forecast")
    return forecast if isinstance(forecast, dict) else None


def _listed_deferrable_consumers(
    forecast: Any,
) -> tuple[dict[str, str], dict[str, str]]:
    """The retired key as two indexes: ``meter -> label`` and ``label -> meter``.

    Both are needed because the two lists could be joined from either side: an
    entry whose meter the controllable already carries matches by meter, and
    one whose device had no meter of its own matches by the name the user gave
    it. First wins on either side; the old reader deduplicated by meter too.
    """
    if not isinstance(forecast, dict):
        return ({}, {})
    raw = forecast.get("deferrable_consumers")
    if not isinstance(raw, list):
        return ({}, {})

    by_meter: dict[str, str] = {}
    by_label: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        entity_id = item.get("energy_entity_id")
        if not isinstance(entity_id, str) or not entity_id.strip():
            continue
        entity_id = entity_id.strip()
        label = item.get("label")
        label = label.strip() if isinstance(label, str) and label.strip() else None
        if entity_id in by_meter:
            continue
        by_meter[entity_id] = label or entity_id
        if label is not None:
            by_label.setdefault(label, entity_id)
    return (by_meter, by_label)


def _migrate_v12_to_v13(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Drop ``power_devices.solar.entities.remaining_today_energy_forecast``.

    The key named the entity holding "how much solar is still to come today",
    and the only entity that ever answers that is Helman's own bias-corrected
    ``sensor.helman_solar_forecast_today_remaining``. A setting with one
    correct value is not a setting: the card now reads that id directly. Any
    value the key held is discarded rather than checked -- a config that pointed
    it somewhere else was pointing at a worse number.
    """
    power_devices = document.get("power_devices")
    if not isinstance(power_devices, Mapping):
        return (document, [])
    solar = power_devices.get("solar")
    if not isinstance(solar, Mapping):
        return (document, [])
    entities = solar.get("entities")
    if not isinstance(entities, Mapping) or "remaining_today_energy_forecast" not in entities:
        return (document, [])

    entities = {
        key: value
        for key, value in entities.items()
        if key != "remaining_today_energy_forecast"
    }
    document["power_devices"] = {
        **power_devices,
        "solar": {**solar, "entities": entities},
    }
    return (document, [])


def _migrate_v13_to_v14(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Relocate the five history-window settings into a top-level ``training``.

    ``power_devices.house.forecast.{min_history_days,training_window_days}``
    and ``power_devices.solar.forecast.bias_correction.{min_history_days,
    max_training_window_days,min_valid_slot_days}`` move to
    ``training.house_consumption`` and ``training.solar_bias`` respectively.
    Pure relocation -- same keys, same defaults, same semantics -- because the
    settings were never really about the entity they were nested under; they
    are read by several. The solar-bias legacy alias ``training_window_days``
    collapses into ``max_training_window_days`` here, preserving the existing
    alias precedence (``max_training_window_days`` wins when both are
    present). A ``forecast``/``bias_correction`` map left empty by the move
    keeps its other keys -- it is not pruned.
    """
    power_devices = document.get("power_devices")
    house_consumption: dict[str, Any] = {}
    solar_bias: dict[str, Any] = {}

    if isinstance(power_devices, Mapping):
        power_devices = dict(power_devices)
        house = power_devices.get("house")
        if isinstance(house, Mapping):
            house = dict(house)
            forecast = house.get("forecast")
            if isinstance(forecast, Mapping):
                forecast = dict(forecast)
                for key in ("min_history_days", "training_window_days"):
                    if key in forecast:
                        house_consumption[key] = forecast.pop(key)
                house["forecast"] = forecast
            power_devices["house"] = house

        solar = power_devices.get("solar")
        if isinstance(solar, Mapping):
            solar = dict(solar)
            forecast = solar.get("forecast")
            if isinstance(forecast, Mapping):
                forecast = dict(forecast)
                bias = forecast.get("bias_correction")
                if isinstance(bias, Mapping):
                    bias = dict(bias)
                    if "min_history_days" in bias:
                        solar_bias["min_history_days"] = bias.pop("min_history_days")
                    legacy_window = bias.pop("training_window_days", None)
                    if "max_training_window_days" in bias:
                        solar_bias["max_training_window_days"] = bias.pop(
                            "max_training_window_days"
                        )
                    elif legacy_window is not None:
                        solar_bias["max_training_window_days"] = legacy_window
                    if "min_valid_slot_days" in bias:
                        solar_bias["min_valid_slot_days"] = bias.pop(
                            "min_valid_slot_days"
                        )
                    forecast["bias_correction"] = bias
                solar["forecast"] = forecast
            power_devices["solar"] = solar

        document["power_devices"] = power_devices

    if not house_consumption and not solar_bias:
        return (document, [])

    training = document.get("training")
    training = dict(training) if isinstance(training, Mapping) else {}
    if house_consumption:
        existing = training.get("house_consumption")
        existing = dict(existing) if isinstance(existing, Mapping) else {}
        training["house_consumption"] = {**house_consumption, **existing}
    if solar_bias:
        existing = training.get("solar_bias")
        existing = dict(existing) if isinstance(existing, Mapping) else {}
        training["solar_bias"] = {**solar_bias, **existing}
    document["training"] = training

    return (document, [])


def _migrate_v14_to_v15(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``automation.optimizers`` splits into ``appliance_optimizers`` / ``system_optimizers``.

    :attr:`~.spec.OptimizerSpec.bucket` decides which list an optimizer lands
    in — the one place bucket membership is decided, never a list here. An
    optimizer of an unknown kind has no spec and goes to ``system_optimizers``,
    where it fails validation as it does today rather than being silently
    dropped.

    Relative order is preserved *within* each partition, which is exactly what
    keeps ``charge_hold`` before ``export_price`` when the source document had
    that order: both are system-bucket kinds, so they land in the same list in
    the same relative order. Order *between* the two new lists is not, and
    cannot be, preserved — that is the point of the split, and the accepted
    risk of this phase landing without P2's runtime restructuring.

    A document with no ``automation`` block or no ``optimizers`` key is
    returned unchanged apart from the version stamp, consistent with
    :func:`_migrate_optimizers`.
    """
    automation = document.get("automation")
    if not isinstance(automation, Mapping):
        return (document, [])
    optimizers = automation.get("optimizers")
    if not isinstance(optimizers, list):
        return (document, [])

    # Imported here, not at module level: this module documents itself as
    # Home-Assistant-free (pure ``dict -> dict``), and ``.spec`` pulls in the
    # conditions/scheduling chain, which does reach into Home Assistant. Doing
    # the import lazily keeps every *other* migration step, and every caller
    # that never reaches a v14 document, free of that dependency.
    from .spec import OPTIMIZER_BUCKET_APPLIANCE, OPTIMIZER_SPECS

    appliance_optimizers: list[Any] = []
    system_optimizers: list[Any] = []
    migrated_ids: list[str] = []
    for raw in optimizers:
        if not isinstance(raw, Mapping):
            system_optimizers.append(raw)
            continue
        kind = raw.get("kind")
        spec = OPTIMIZER_SPECS.get(kind) if isinstance(kind, str) else None
        bucket = spec.bucket if spec is not None else None
        if bucket == OPTIMIZER_BUCKET_APPLIANCE:
            appliance_optimizers.append(raw)
        else:
            system_optimizers.append(raw)
        migrated_ids.append(str(raw.get("id", "?")))

    document["automation"] = {
        **{key: value for key, value in automation.items() if key != "optimizers"},
        "appliance_optimizers": appliance_optimizers,
        "system_optimizers": system_optimizers,
    }
    return (document, migrated_ids)


#: ``charge_from_grid`` params retired in v16: the bridge is sized by
#: ``reserve_floor_soc`` alone and capped at the battery's own ``max_soc``.
_V15_CHARGE_FROM_GRID_DROPPED_PARAMS = ("margin_pct", "max_target_soc")


def _migrate_v15_to_v16(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Drop ``margin_pct`` / ``max_target_soc`` from ``charge_from_grid``.

    Removed from the master ``params`` and from every group's ``params``
    override; an override emptied by this is dropped. No value is folded into
    ``reserve_floor_soc``: ``margin_pct`` scaled each window's own dip, so no
    fixed floor shift reproduces it. Other kinds — ``charge_hold``'s
    ``battery_first.margin_pct`` included — are untouched.

    Returns the ids of the optimizers that actually carried a removed key.
    """
    automation = document.get("automation")
    if not isinstance(automation, Mapping):
        return (document, [])
    optimizers = automation.get("system_optimizers")
    if not isinstance(optimizers, list):
        return (document, [])

    migrated_ids: list[str] = []
    rebuilt: list[Any] = []
    for raw in optimizers:
        if not isinstance(raw, Mapping) or raw.get("kind") != "charge_from_grid":
            rebuilt.append(raw)
            continue
        optimizer = dict(raw)
        changed = False
        params = optimizer.get("params")
        if isinstance(params, Mapping):
            optimizer["params"], changed = _without_dropped_params(params)
        conditions = optimizer.get("conditions")
        if isinstance(conditions, list):
            groups: list[Any] = []
            for group in conditions:
                if isinstance(group, Mapping) and isinstance(group.get("params"), Mapping):
                    group = dict(group)
                    override, group_changed = _without_dropped_params(group["params"])
                    changed = changed or group_changed
                    if override:
                        group["params"] = override
                    else:
                        group.pop("params")
                groups.append(group)
            optimizer["conditions"] = groups
        rebuilt.append(optimizer)
        if changed:
            migrated_ids.append(str(raw.get("id", "?")))

    document["automation"] = {**automation, "system_optimizers": rebuilt}
    return (document, migrated_ids)


def _without_dropped_params(params: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    kept = {
        key: value
        for key, value in params.items()
        if key not in _V15_CHARGE_FROM_GRID_DROPPED_PARAMS
    }
    return (kept, len(kept) != len(params))


def _migrate_v16_to_v17(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``appliance_runtime``'s single target becomes an ordered one-member group.

    The mirror image of :func:`_target_controllable_id`: ``target.controllable_id``
    and ``target.climate_mode`` move into ``target.controllables[0]``, so one
    optimizer can drive several appliances in priority order. A one-member group
    plans exactly as the single target did. ``appliance_runtime`` is
    appliance-bucket only, so only that bucket is walked; the inverter kinds
    keep their flat ``target.controllable_id``.
    """
    return _migrate_optimizers(
        document, _target_controllables, bucket="appliance_optimizers"
    )


def _target_controllables(optimizer: dict[str, Any]) -> dict[str, Any]:
    if optimizer.get("kind") != "appliance_runtime":
        return optimizer
    target = dict(optimizer.get("target") or {})
    if "controllables" in target or "controllable_id" not in target:
        return optimizer
    member = {"controllable_id": target.pop("controllable_id")}
    if "climate_mode" in target:
        member["climate_mode"] = target.pop("climate_mode")
    return {**optimizer, "target": {**target, "controllables": [member]}}


#: The top-level keys v18 moves under ``visualization``. Every one of them is
#: read only by the Helman card's ``uiConfig`` (or by the history buckets that
#: feed it), which is what makes them a group.
_VISUALIZATION_KEYS = (
    "history_buckets",
    "history_bucket_duration",
    "sources_title",
    "consumers_title",
    "groups_title",
    "others_group_label",
    "power_sensor_name_cleaner_regex",
    "show_empty_groups",
    "show_others_group",
    "device_label_text",
)


def _migrate_v17_to_v18(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Card-only keys -> ``visualization``; ``training_time`` -> ``training``.

    The top level had become the place where two unrelated things lived: how
    the Helman card renders, and when the nightly training batch runs. Both get
    the section they belong to, and the top level keeps only ``config_version``
    and the real sections.

    The relocated values overwrite whatever sits under ``visualization``
    already: a document at version 17 cannot have authored that key, so
    anything found there came from ``DEFAULT_CONFIG`` being merged in ahead of
    this step, and the user's own value has to win. ``training_time`` merges
    the other way -- an existing ``training.training_time`` was authored, so it
    is kept.
    """
    visualization = document.get("visualization")
    visualization = dict(visualization) if isinstance(visualization, Mapping) else {}
    moved = False
    for key in _VISUALIZATION_KEYS:
        if key in document:
            visualization[key] = document.pop(key)
            moved = True
    if moved or visualization:
        document["visualization"] = visualization

    if "training_time" in document:
        training = document.get("training")
        training = dict(training) if isinstance(training, Mapping) else {}
        training.setdefault("training_time", document.pop("training_time"))
        document["training"] = training

    return (document, [])


def _migrate_v18_to_v19(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``power_devices.solar.forecast.bias_correction`` flattens into ``training.solar_bias``.

    Solar bias config had two owners: the training-window settings moved to
    ``training.solar_bias`` in v14, the correction settings stayed under the
    solar forecast. Every key of the block now sits directly beside the
    day-count settings -- no nested ``correction`` key, since none collide.
    An existing ``training.solar_bias`` value wins over a moved one, as in
    :func:`_migrate_v13_to_v14`. The ``bias_correction`` key is removed from
    ``forecast``; a document without the block is unchanged. A non-mapping
    value (e.g. ``null``) holds no settings and is dropped.
    """
    bias = _bias_correction_block(document)
    if bias is None:
        forecast: Any = document
        for key in ("power_devices", "solar", "forecast"):
            forecast = forecast.get(key) if isinstance(forecast, dict) else None
        if isinstance(forecast, dict):
            forecast.pop("bias_correction", None)
        return (document, [])
    forecast = document["power_devices"]["solar"]["forecast"]
    del forecast["bias_correction"]

    training = document.get("training")
    training = dict(training) if isinstance(training, Mapping) else {}
    existing = training.get("solar_bias")
    existing = dict(existing) if isinstance(existing, Mapping) else {}
    training["solar_bias"] = {**bias, **existing}
    document["training"] = training
    return (document, [])


def _migrate_v19_to_v20(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``controllables`` -> the ``devices`` tree.

    Everything in the old list was schedulable, so every non-inverter entry
    says so now with ``schedulable: true``; the inverter moves unchanged and
    carries no flag. ``consumption.deferrable`` is dropped everywhere: the
    carve-out is derived from ``schedulable`` from here on, and no known config
    ever set the opt-out.

    The implicit shared meter becomes explicit. Two or more entries naming one
    ``energy_entity_id`` become the children of a new passive parent that owns
    the meter, placed where the first sharer was. The parent's id is the
    meter's object id (``_2``, ``_3``... on a clash with any existing id); the
    sharers keep their ids, controls and projections and lose only the meter,
    which they now draw from their parent — so optimizer targets and stored
    schedules keep resolving.

    A ``controllables`` value that is not a list moves across unchanged, for
    the validator to report in the new vocabulary.
    """
    if "controllables" not in document:
        return (document, [])
    controllables = document.pop("controllables")
    if not isinstance(controllables, list):
        document["devices"] = controllables
        return (document, [])

    entries = [_schedulable_device(entry) for entry in controllables]
    sharers: dict[str, list[int]] = {}
    for index, entry in enumerate(entries):
        meter = _consumption_meter(entry)
        if meter is not None:
            sharers.setdefault(meter, []).append(index)
    taken_ids = {
        entry["id"].strip()
        for entry in entries
        if isinstance(entry, Mapping) and isinstance(entry.get("id"), str)
    }

    devices: list[Any] = []
    for index, entry in enumerate(entries):
        meter = _consumption_meter(entry)
        group = sharers.get(meter, []) if meter is not None else []
        if len(group) < 2:
            devices.append(entry)
            continue
        if index != group[0]:
            continue
        parent_id = meter_device_id(meter, taken_ids)
        devices.append(
            {
                "id": parent_id,
                "consumption": {"energy_entity_id": meter},
                "children": [_without_meter(entries[member]) for member in group],
            }
        )
    document["devices"] = devices
    return (document, [])


def _schedulable_device(entry: Any) -> Any:
    """One old entry as a device: ``schedulable: true``, no ``deferrable``."""
    if not isinstance(entry, Mapping) or entry.get("kind") == "inverter":
        return entry
    device = {**entry, "schedulable": True}
    consumption = device.get("consumption")
    if isinstance(consumption, Mapping) and "deferrable" in consumption:
        device["consumption"] = {
            key: value for key, value in consumption.items() if key != "deferrable"
        }
    return device


def _consumption_meter(entry: Any) -> str | None:
    """A non-inverter entry's ``consumption.energy_entity_id``, stripped."""
    if not isinstance(entry, Mapping) or entry.get("kind") == "inverter":
        return None
    consumption = entry.get("consumption")
    if not isinstance(consumption, Mapping):
        return None
    meter = consumption.get("energy_entity_id")
    return meter.strip() if isinstance(meter, str) and meter.strip() else None


def _without_meter(entry: dict[str, Any]) -> dict[str, Any]:
    """A sharer as a meterless child: its ``consumption`` minus the meter."""
    consumption = {
        key: value
        for key, value in entry["consumption"].items()
        if key != "energy_entity_id"
    }
    child = {key: value for key, value in entry.items() if key != "consumption"}
    if consumption:
        child["consumption"] = consumption
    return child


def _migrate_v20_to_v21(
    document: dict[str, Any],
    energy_preferences: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Energy ``device_consumption`` imported into ``devices``, once.

    From here on the device list is the only source for the card, and Energy
    preferences are never read at runtime. Each row the list does not already
    cover becomes a passive device (see
    :func:`..controllables.energy_import.import_energy_preferences`); a device
    already owning a row's meter only gains a missing ``power_entity_id``.
    Existing devices are not restructured.

    A row Energy nests where the tree cannot hold it (under a schedulable
    device's meter, or as a power-less sibling of meterless children) is a
    conflict and is skipped: the parent's meter already contains that energy,
    so totals stay correct. Conflicts and external statistics are logged.

    A ``devices`` value that is not a list is left for the validator to report.
    """
    devices = document.get("devices", [])
    if not isinstance(devices, list):
        return (document, [])
    result = import_energy_preferences(devices, energy_preferences)
    for statistic in result.external_statistics:
        _LOGGER.info(
            "Energy device %s is an external statistic; not imported as a device",
            statistic,
        )
    for conflict in result.conflicts:
        _LOGGER.warning(
            "Energy device %s cannot be nested under device %s (%s); not imported, "
            "since that device's meter already counts it",
            conflict.energy_entity_id,
            conflict.device_id,
            conflict.reason,
        )
    if "devices" in document or result.devices:
        document["devices"] = result.devices
    return (document, [])


#: ``power_devices.house`` keys v22 moves to ``devices``. They are read only by
#: the entity suggestions of the Devices editor.
_DEVICE_LABEL_KEYS = ("power_sensor_label", "power_switch_label")


def _migrate_v21_to_v22(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``devices`` becomes a section object holding its list and its settings.

    The list moves to ``devices.items``;
    ``visualization.power_sensor_name_cleaner_regex`` becomes
    ``devices.name_cleaner_regex``, since it names every device on every
    surface; ``power_devices.house.power_sensor_label`` and
    ``power_switch_label`` move beside it. ``power_devices.house.
    unmeasured_power_title`` is dropped: the Unmeasured rows use a fixed,
    localized label.

    The ``devices`` object is created only when something goes in it. A
    ``devices`` value that is neither a list nor absent (``null`` counts as
    absent) is left alone for the validator to report.
    """
    devices = document.get("devices")
    if devices is not None and not isinstance(devices, list):
        return (document, [])
    section: dict[str, Any] = {}

    visualization = document.get("visualization")
    if isinstance(visualization, dict) and (
        "power_sensor_name_cleaner_regex" in visualization
    ):
        section["name_cleaner_regex"] = visualization.pop(
            "power_sensor_name_cleaner_regex"
        )

    power_devices = document.get("power_devices")
    house = power_devices.get("house") if isinstance(power_devices, dict) else None
    if isinstance(house, dict):
        for key in _DEVICE_LABEL_KEYS:
            if key in house:
                section[key] = house.pop(key)
        house.pop("unmeasured_power_title", None)

    if devices is not None:
        section["items"] = devices
    if section:
        document["devices"] = section
    return (document, [])


def _migrate_v22_to_v23(
    document: dict[str, Any],
    entity_suggestions: EntitySuggestions | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Backfill the power sensor and switch the v21 Energy import never set.

    Before v21 the card resolved both at render time from the HA device owning
    a device's meter; v21 copied only Energy's ``stat_rate``, so an upgraded
    device lost its watts and its switch. Every non-inverter device with its
    own meter, children included, gains from the meter's suggestions:

    * ``consumption.power_entity_id`` — the only ``power`` candidate, or the
      only one carrying the power-sensor label;
    * ``controls.switch`` (a generic device only; the editor offers no switch
      on any other kind) — the only ``switch`` candidate carrying the switch
      label or named like the HA device.

    Two candidates with an equal claim (a multi-channel meter's HA device) are
    not guessed between, and an entity chosen for two devices goes to neither:
    this step runs once, and a wrong pick would be saved for good. Nor is an
    entity another device already names. An existing value is never
    overwritten. Each backfill is logged, and so is a metered
    device left without power.
    """
    if entity_suggestions is None:
        return (document, [])
    picks: list[tuple[dict[str, Any], str | None, str | None]] = []
    for device, _parent in _iter_items_devices(document):
        kind = peek_controllable_kind(device)
        meter = own_meter(device)
        if kind == CONTROLLABLE_KIND_INVERTER or meter is None:
            continue
        # ``null`` counts as absent; any other non-mapping is the validator's.
        controls = device.get("controls") or {}
        needs_switch = (
            kind == CONTROLLABLE_KIND_GENERIC
            and isinstance(controls, Mapping)
            and "switch" not in controls
        )
        needs_power = not device["consumption"].get("power_entity_id")
        if not (needs_power or needs_switch):
            continue
        suggestions = entity_suggestions([meter], document)
        power = (
            _sole_candidate(suggestions.get("power", []), ("label",))
            if needs_power
            else None
        )
        switch = (
            _sole_candidate(
                suggestions.get("switch", []), ("label", "name_match"), required=True
            )
            if needs_switch
            else None
        )
        picks.append((device, power, switch))

    # Entities another device already names are taken, whether configured
    # before this step or picked by it for a second device.
    claimed = [entity for _device, *entities in picks for entity in entities if entity]
    claimed += [
        entity.strip()
        for device, _parent in _iter_items_devices(document)
        for entity in _named_power_and_switch(device)
    ]
    for device, power, switch in picks:
        device_id = device.get("id", own_meter(device))
        if power is not None and claimed.count(power) == 1:
            device["consumption"]["power_entity_id"] = power
            _LOGGER.info("Device %s power sensor backfilled: %s", device_id, power)
        elif not device["consumption"].get("power_entity_id"):
            _LOGGER.info(
                "Device %s has a meter but no single power sensor to backfill",
                device_id,
            )
        if switch is not None and claimed.count(switch) == 1:
            device["controls"] = {
                **(device.get("controls") or {}),
                "switch": {"entity_id": switch},
            }
            _LOGGER.info("Device %s switch backfilled: %s", device_id, switch)
    return (document, [])


def _iter_items_devices(
    document: Mapping[str, Any],
) -> Iterator[tuple[Mapping[str, Any], Mapping[str, Any] | None]]:
    """:func:`iter_devices` over the v22-v24 ``devices.items`` list.

    The reader walks the v25 lists, so a step that runs before v25 hands it
    ``items`` as the one list it walks as a tree.
    """
    section = document.get("devices")
    items = section.get("items") if isinstance(section, Mapping) else None
    return iter_devices({"devices": {"consumers": items}})


def _named_power_and_switch(device: Mapping[str, Any]) -> list[str]:
    """The power sensor and switch-like controls ``device`` already names."""
    consumption = device.get("consumption")
    controls = device.get("controls")
    named = [
        consumption.get("power_entity_id") if isinstance(consumption, Mapping) else None,
        *(
            control.get("entity_id")
            for key in ("switch", "charge")
            if isinstance(controls, Mapping)
            and isinstance(control := controls.get(key), Mapping)
        ),
    ]
    return [entity for entity in named if isinstance(entity, str) and entity.strip()]


def _sole_candidate(
    candidates: Sequence[Mapping[str, Any]],
    preferred: tuple[str, ...],
    *,
    required: bool = False,
) -> str | None:
    """The one candidate with a ``preferred`` reason, else the only candidate.

    ``required`` takes only a candidate with a ``preferred`` reason. ``None``
    when two share the best claim: there is nothing to tell them apart by.
    """
    marked = [
        candidate
        for candidate in candidates
        if any(reason.get("code") in preferred for reason in candidate["reasons"])
    ]
    pool = marked or ([] if required else list(candidates))
    return pool[0]["entityId"] if len(pool) == 1 else None


def _migrate_v23_to_v24(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``power_devices`` -> ``energy_nodes``.

    The four site-level blocks (house, grid, solar, battery) sat beside
    ``devices`` under a near-synonym. The moved value overwrites an existing
    ``energy_nodes``, as in :func:`_migrate_v17_to_v18`: a version-23 document
    cannot have authored that key, so one found there is the ``DEFAULT_CONFIG``
    merged in ahead of this step. A document without ``power_devices`` is
    unchanged.
    """
    if "power_devices" in document:
        document["energy_nodes"] = document.pop("power_devices")
    return (document, [])


def _migrate_v24_to_v25(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``devices.items`` splits into ``devices.system`` and ``devices.consumers``.

    Top-level entries of kind ``inverter`` go to ``system``, all others to
    ``consumers``, each in document order; a key is written only if it gets
    entries. An ``items`` value that is not a list moves to ``consumers`` as is,
    and an inverter nested as a child stays where it is, so the validator
    reports either at its new path. A document without ``devices.items`` is
    unchanged.
    """
    section = document.get("devices")
    if not isinstance(section, dict) or "items" not in section:
        return (document, [])
    items = section.pop("items")
    if not isinstance(items, list):
        section["consumers"] = items
        return (document, [])
    system = [
        item
        for item in items
        if peek_controllable_kind(item) == CONTROLLABLE_KIND_INVERTER
    ]
    consumers = [
        item
        for item in items
        if peek_controllable_kind(item) != CONTROLLABLE_KIND_INVERTER
    ]
    if system:
        section["system"] = system
    if consumers:
        section["consumers"] = consumers
    return (document, [])


def _migrate_v25_to_v26(
    document: dict[str, Any],
    device_labels: DeviceLabels | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """``visualization.device_label_text`` -> ``devices.groupings`` + device ``groups``.

    Device groups were HA labels the card matched against a category -> label
    name -> badge text map; they move into the config, and labels are read
    here once and never again. Each category becomes a grouping named after
    it, each of its labels a group (``name`` = the label, ``short_name`` = the
    badge text), in document order, with ids slugged from the names.

    A device's labels are those on the HA device of its own meter or, for a
    meterless child, of its running signal: where the card read them. Per
    category, the first label in the category's order that the device carries
    is its group -- the card's first-match rule. The inverter is skipped.
    ``device_labels=None`` still converts the groupings and assigns nothing.

    A ``devices`` value that is neither an object nor absent is left alone,
    with the old key, for the validator to report.
    """
    visualization = document.get("visualization")
    if not isinstance(visualization, dict) or "device_label_text" not in visualization:
        return (document, [])
    section = document.get("devices")
    if section is not None and not isinstance(section, dict):
        return (document, [])
    label_text = visualization.pop("device_label_text")
    if not isinstance(label_text, Mapping) or not label_text:
        return (document, [])

    groupings: list[dict[str, Any]] = []
    grouping_ids: set[str] = set()
    for category, labels in label_text.items():
        if not isinstance(labels, Mapping):
            continue
        group_ids: set[str] = set()
        groups = [
            {
                "id": _slug_id(label, group_ids, "group"),
                "name": label,
                "short_name": badge,
            }
            for label, badge in labels.items()
        ]
        grouping_id = _slug_id(category, grouping_ids, "grouping")
        groupings.append({"id": grouping_id, "name": category, "groups": groups})
    section = section if section is not None else {}
    section["groupings"] = groupings
    document["devices"] = section

    if device_labels is None:
        return (document, [])
    for device, parent in iter_devices(document):
        if peek_controllable_kind(device) == CONTROLLABLE_KIND_INVERTER:
            continue
        entity_id = own_meter(device)
        if entity_id is None and parent is not None:
            signal = running_signal(device)
            entity_id = signal[0] if signal is not None else None
        if entity_id is None:
            continue
        carried = set(device_labels(entity_id))
        assigned: dict[str, str] = {}
        # A group's name is the label it came from.
        for grouping in groupings:
            for group in grouping["groups"]:
                if group["name"] in carried:
                    assigned[grouping["id"]] = group["id"]
                    break
        if assigned:
            device["groups"] = assigned
    return (document, [])


def _slug_id(name: Any, taken: set[str], fallback: str) -> str:
    """A stable id slugged from ``name``, unique within ``taken`` (which it joins).

    NFKD-folded to ASCII, lower-cased, every other run of characters becoming
    ``_``; ``_2``, ``_3``... on a collision, and ``fallback`` when nothing is
    left (an emoji-only name). Mirrors ``slugId`` in
    ``frontend/cards/shared/config/devices.ts``, spelled here because this
    module must not import Home Assistant's ``slugify``.
    """
    folded = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-z0-9]+", "_", folded.lower()).strip("_") or fallback
    slug, suffix = base, 2
    while slug in taken:
        slug, suffix = f"{base}_{suffix}", suffix + 1
    taken.add(slug)
    return slug


_MIGRATIONS = {
    1: _migrate_v1_to_v2,
    2: _migrate_v2_to_v3,
    3: _migrate_v3_to_v4,
    4: _migrate_v4_to_v5,
    5: _migrate_v5_to_v6,
    6: _migrate_v6_to_v7,
    7: _migrate_v7_to_v8,
    8: _migrate_v8_to_v9,
    9: _migrate_v9_to_v10,
    10: _migrate_v10_to_v11,
    11: _migrate_v11_to_v12,
    12: _migrate_v12_to_v13,
    13: _migrate_v13_to_v14,
    14: _migrate_v14_to_v15,
    15: _migrate_v15_to_v16,
    16: _migrate_v16_to_v17,
    17: _migrate_v17_to_v18,
    18: _migrate_v18_to_v19,
    19: _migrate_v19_to_v20,
    # 20 -> 21 needs the Energy preferences: bound in migrate_config_document.
    21: _migrate_v21_to_v22,
    # 22 -> 23 needs the entity suggestions: bound in migrate_config_document.
    23: _migrate_v23_to_v24,
    24: _migrate_v24_to_v25,
    # 25 -> 26 needs the HA labels: bound in migrate_config_document.
}


def _document_version(document: Mapping[str, Any]) -> int:
    """Absent or unreadable ``config_version`` means version 1, pre-unification."""
    version = document.get("config_version")
    return version if isinstance(version, int) and not isinstance(version, bool) else 1


def _migrate_optimizer(optimizer: dict[str, Any]) -> dict[str, Any]:
    kind = optimizer.get("kind")
    params = dict(optimizer.get("params") or {})
    target = dict(optimizer.get("target") or {})
    group: dict[str, Any] = {}

    for key in _DROPPED_PARAMS:
        params.pop(key, None)

    for key in _PARAM_TO_TARGET:
        if key in params:
            target[key] = params.pop(key)

    for old_key, condition_key in _PARAM_TO_CONDITION.get(kind, {}).items():
        if old_key in params:
            group[condition_key] = params.pop(old_key)

    if kind == "charge_hold" and "run_when" not in group:
        # `only_on_days` absent meant "every classification".
        group["run_when"] = list(DAY_CLASSIFICATIONS)
    if kind == "daily_runtime":
        run_when, max_consecutive_skips = _migrate_skip(params.pop("skip", None))
        group["run_when"] = run_when
        params["max_consecutive_skips"] = max_consecutive_skips

    group["custom"] = list(optimizer.get("condition") or [])

    migrated = {
        key: value
        for key, value in optimizer.items()
        if key not in ("params", "target", "condition", "conditions")
    }
    if target:
        migrated["target"] = target
    migrated["params"] = params
    migrated["conditions"] = [group]
    return migrated


def _migrate_skip(skip: Any) -> tuple[list[str], int]:
    """Invert ``skip.on_days`` into ``run_when``. Not a plain complement.

    A day was skipped only when ``classification in skip.on_days`` **AND**
    ``prior_skips + 1 <= max_consecutive_skips``. So with
    ``max_consecutive_skips == 0`` — the default, and therefore most existing
    configs — skipping never actually happened, and the complement would
    silently stop the optimizer running on those days. Three cases:

    * ``skip`` absent or ``on_days`` empty  -> every classification
    * ``max_consecutive_skips == 0``        -> every classification
    * otherwise                             -> DAY_CLASSIFICATIONS - on_days
    """
    if not isinstance(skip, Mapping):
        return (list(DAY_CLASSIFICATIONS), 0)
    raw_max = skip.get("max_consecutive_skips", 0)
    max_consecutive_skips = (
        raw_max if isinstance(raw_max, int) and not isinstance(raw_max, bool) else 0
    )
    on_days = skip.get("on_days")
    if not isinstance(on_days, (list, tuple)) or not on_days or max_consecutive_skips <= 0:
        return (list(DAY_CLASSIFICATIONS), max_consecutive_skips)
    return (
        [
            classification
            for classification in DAY_CLASSIFICATIONS
            if classification not in on_days
        ],
        max_consecutive_skips,
    )
