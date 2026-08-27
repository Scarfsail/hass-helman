"""One-way migration of stored automation configs to the unified shape.

Pure ``dict -> dict``: no Home Assistant, no storage, no logging side effects,
so its tests run on the host and every rule is table-checkable.

Runs on **load only**. The save path rejects the old shape instead of rewriting
it (see ``validate_config_document``): hand-editing is a save-path concern, and
silently rewriting a user's YAML under them is worse than refusing it.
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any

from ..const import CONFIG_DOCUMENT_VERSION, DAY_CLASSIFICATIONS

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
) -> tuple[dict[str, Any], list[str]]:
    """Return ``(migrated_document, migrated_optimizer_ids)``.

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

    migrated_ids: list[str] = []
    while version < CONFIG_DOCUMENT_VERSION:
        migrated, ids = _MIGRATIONS[version](migrated)
        migrated_ids = ids or migrated_ids
        version += 1
    return (migrated, migrated_ids)


def _migrate_optimizers(
    document: dict[str, Any],
    migrate: Any,
) -> tuple[dict[str, Any], list[str]]:
    """Apply ``migrate`` to every optimizer, dropping the ones it returns ``None`` for."""
    automation = document.get("automation")
    if not isinstance(automation, Mapping):
        return (document, [])
    optimizers = automation.get("optimizers")
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
    document["automation"] = {**automation, "optimizers": rebuilt}
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
    ``sensor.helman_energy_production_today_remaining``. A setting with one
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
