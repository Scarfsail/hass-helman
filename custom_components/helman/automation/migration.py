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

#: Keys that carried exactly one legal value, so moving them would move no
#: information. Dropped silently here; the reader rejects them from now on.
_DROPPED_PARAMS = ("action", "hold_action")

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
    if not isinstance(document, Mapping) or "automation" not in document:
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
    """
    if not isinstance(document, Mapping):
        return ({} if document is None else dict(document), [])
    migrated = deepcopy(dict(document))
    if _document_version(document) >= CONFIG_DOCUMENT_VERSION:
        migrated["config_version"] = CONFIG_DOCUMENT_VERSION
        return (migrated, [])

    migrated["config_version"] = CONFIG_DOCUMENT_VERSION
    automation = migrated.get("automation")
    if not isinstance(automation, Mapping):
        return (migrated, [])
    optimizers = automation.get("optimizers")
    if not isinstance(optimizers, list):
        return (migrated, [])

    migrated_ids: list[str] = []
    rebuilt: list[Any] = []
    for raw in optimizers:
        if not isinstance(raw, Mapping):
            rebuilt.append(raw)
            continue
        rebuilt.append(_migrate_optimizer(dict(raw)))
        migrated_ids.append(str(raw.get("id", "?")))
    migrated["automation"] = {**automation, "optimizers": rebuilt}
    return (migrated, migrated_ids)


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
