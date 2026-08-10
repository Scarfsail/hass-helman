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


_MIGRATIONS = {
    1: _migrate_v1_to_v2,
    2: _migrate_v2_to_v3,
    3: _migrate_v3_to_v4,
    4: _migrate_v4_to_v5,
    5: _migrate_v5_to_v6,
    6: _migrate_v6_to_v7,
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
