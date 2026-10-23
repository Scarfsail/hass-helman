"""Live custom-condition evaluation and plan-freshness decisions."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..const import AUTOMATION_CONDITION_PLAN_FRESHNESS_SECONDS
from .compute_inputs import (
    CustomConditionGroupResult,
    CustomConditionResult,
    condition_met_map,
)
from .condition_trace import (
    ConditionTrace,
    evaluate_traced,
    extract_entity_ids,
    read_entity_params,
    stamp_params,
)
from .config import AutomationConfig, ConditionGroup

_LOGGER = logging.getLogger(__name__)


class ConditionEvaluator:
    """Own cached HA checkers, diagnostic traces and plan freshness."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._optimizer_condition_checkers: dict[
            tuple[str, int], tuple[Any, tuple[Any, ...], tuple[tuple[str, ...], ...]]
        ] = {}
        self._condition_traces: dict[tuple[str, int], dict[str, Any]] = {}
        self._last_automation_plan_at: datetime | None = None
        self._last_plan_condition_map: dict[str, tuple[bool, ...]] = {}

    def get_trace(
        self, *, optimizer_id: str, group_index: int
    ) -> dict[str, Any] | None:
        return self._condition_traces.get((optimizer_id, group_index))

    def record_plan(
        self, reference_time: datetime, condition_map: dict[str, tuple[bool, ...]]
    ) -> None:
        self._last_automation_plan_at = reference_time
        self._last_plan_condition_map = dict(condition_map)

    def plan_is_stale(self, reference_time: datetime) -> bool:
        plan_at = self._last_automation_plan_at
        return (
            plan_at is not None
            and (reference_time - plan_at).total_seconds()
            >= AUTOMATION_CONDITION_PLAN_FRESHNESS_SECONDS
        )

    async def needs_replan(
        self, reference_time: datetime, automation_config: AutomationConfig | None
    ) -> bool:
        if not self.plan_is_stale(reference_time):
            return False
        try:
            current_map = condition_met_map(await self.evaluate(automation_config))
        except Exception:
            _LOGGER.debug(
                "Reality-check condition eval failed; executing plan as-is",
                exc_info=True,
            )
            return False
        return _any_group_met_by_optimizer(current_map) != _any_group_met_by_optimizer(
            self._last_plan_condition_map
        )

    def async_unload(self) -> None:
        self._prune_optimizer_condition_checkers(active_keys=set())
        self._condition_traces.clear()

    async def evaluate(
        self,
        automation_config: AutomationConfig | None,
    ) -> dict[str, tuple[CustomConditionGroupResult, ...]]:
        """Evaluate every condition group's ``custom`` conditions against live state.

        Runs on the event loop (conditions read ``hass.states``) so the result
        can be frozen into ``ComputeInputs`` for the pure optimizer loop. The
        value is one :class:`CustomConditionGroupResult` per group, in config
        order, each holding one result per configured ``custom`` entry plus the
        group aggregate — the AND over its entries, ``True`` for a group with no
        custom conditions. An optimizer id absent from the map means "not
        evaluated", which counts as met.

        Fail-closed, now per entry: an entry that could not be built or that
        raised while evaluating is ``met=False, errored=True``, so it still drags
        the group aggregate false while staying distinguishable from a condition
        that plainly evaluated to false.

        Every evaluated group also leaves its HA condition trace behind for
        :meth:`get_condition_trace`. The record is rebuilt wholesale here rather
        than pruned, so a group that has left the config simply stops being
        recorded.
        """
        if automation_config is None:
            self._prune_optimizer_condition_checkers(active_keys=set())
            self._condition_traces = {}
            return {}

        results: dict[str, tuple[CustomConditionGroupResult, ...]] = {}
        traces: dict[tuple[str, int], dict[str, Any]] = {}
        run_at = dt_util.now().isoformat()
        active_keys: set[tuple[str, int]] = set()
        for optimizer in automation_config.all_optimizers:
            group_results: list[CustomConditionGroupResult] = []
            for group in optimizer.conditions:
                if not group.custom:
                    # No custom conditions is unconditionally met — and must not
                    # build a checker, which would evaluate an empty AND anyway.
                    group_results.append(
                        CustomConditionGroupResult(index=group.index, met=True)
                    )
                    continue
                key = (optimizer.id, group.index)
                active_keys.add(key)
                checkers, entity_ids = await self._ensure_optimizer_condition_checkers(
                    key, group
                )
                trace: ConditionTrace = {}
                # Read before evaluating, so the reading is the one the condition
                # went on to judge rather than a state that moved in between;
                # stamped after, onto the step the evaluation left behind.
                params_by_entry = {
                    entry_index: read_entity_params(self._hass, ids)
                    for entry_index, ids in enumerate(entity_ids)
                    if ids
                }
                entries = tuple(
                    self._evaluate_optimizer_condition(checker, key, entry_index, trace)
                    for entry_index, checker in enumerate(checkers)
                )
                for entry_index, params in params_by_entry.items():
                    stamp_params(trace, entry_index=entry_index, params=params)
                traces[key] = {
                    "optimizerId": optimizer.id,
                    "groupIndex": group.index,
                    "runAt": run_at,
                    # The config as evaluated, so the renderer draws the tree the
                    # trace paths point into rather than a config read later.
                    "config": [dict(entry) for entry in group.custom],
                    "trace": trace,
                }
                group_results.append(
                    CustomConditionGroupResult(
                        index=group.index,
                        # The AND over the entries, exactly what the single
                        # combined checker used to evaluate.
                        met=all(entry.met for entry in entries),
                        errored=any(entry.errored for entry in entries),
                        entries=entries,
                    )
                )
            results[optimizer.id] = tuple(group_results)
        self._prune_optimizer_condition_checkers(active_keys=active_keys)
        self._condition_traces = traces
        return results

    async def _ensure_optimizer_condition_checkers(
        self, key: tuple[str, int], group: ConditionGroup
    ) -> tuple[tuple[Any, ...], tuple[tuple[str, ...], ...]]:
        """One checker per ``custom`` entry, and the entities each entry reads.

        Both are cached until the group's ``custom`` config changes: the entity
        ids follow from the config alone, so re-extracting them every run would
        buy nothing. Their states are what moves, and those are read at
        evaluation time.
        """
        cached = self._optimizer_condition_checkers.get(key)
        if cached is not None and cached[0] == group.custom:
            return cached[1], cached[2]
        if cached is not None:
            self._unload_optimizer_condition_checkers(cached[1])
        built = [
            await self._build_optimizer_condition_checker(
                key=key,
                entry_index=entry_index,
                condition_config=[entry],
            )
            for entry_index, entry in enumerate(group.custom)
        ]
        checkers = tuple(checker for checker, _entity_ids in built)
        entity_ids = tuple(ids for _checker, ids in built)
        self._optimizer_condition_checkers[key] = (group.custom, checkers, entity_ids)
        return checkers, entity_ids

    async def _build_optimizer_condition_checker(
        self,
        *,
        key: tuple[str, int],
        entry_index: int,
        condition_config: list[dict[str, Any]],
    ) -> tuple[Any, tuple[str, ...]]:
        """The entry's checker, and the entities its validated config reads.

        The entity ids come from the validated config rather than the raw one:
        validation is where a ``device`` condition's entity is resolved, and
        where a platform condition's ``target`` has been normalised.
        """
        from homeassistant.helpers import condition as ha_condition
        from homeassistant.helpers import config_validation as cv

        label = f"optimizer:{key[0]}#{key[1]}[{entry_index}]"
        try:
            validated = []
            for entry in condition_config:
                # cv.CONDITION_SCHEMA coerces built-in literals (e.g. a ``time``
                # condition's "18:00:00" -> datetime.time). async_validate alone
                # only coerces state/numeric_state, so a bare ``time`` literal
                # would survive as a str and HA would misread it as an entity id.
                # async_validate_condition_config then resolves platform/async
                # conditions (device, etc.).
                coerced = cv.CONDITION_SCHEMA(dict(entry))
                validated.append(
                    await ha_condition.async_validate_condition_config(
                        self._hass, coerced
                    )
                )
            checker = await ha_condition.async_conditions_from_config(
                self._hass, validated, _LOGGER, label
            )
            entity_ids = tuple(
                entity_id
                for entry in validated
                for entity_id in extract_entity_ids(entry)
            )
            return checker, entity_ids
        except Exception:
            _LOGGER.exception(
                "Failed to build custom conditions for %s; treating as not met",
                label,
            )
            return None, ()

    def _evaluate_optimizer_condition(
        self,
        checker: Any,
        key: tuple[str, int],
        entry_index: int,
        trace: ConditionTrace,
    ) -> CustomConditionResult:
        """Evaluate one ``custom`` entry. Build/eval failure is met=False + errored.

        What HA recorded while evaluating lands in ``trace``, the raising path
        included: whatever the entry reached before blowing up is kept, which is
        what makes an errored entry readable rather than merely flagged.
        """
        if checker is None:
            return CustomConditionResult(met=False, errored=True)
        try:
            return CustomConditionResult(
                met=bool(
                    evaluate_traced(
                        checker.async_check, entry_index=entry_index, into=trace
                    )
                )
            )
        except Exception:
            _LOGGER.debug(
                "Custom condition %d for optimizer %s group %d could not be "
                "evaluated; treating as not met",
                entry_index,
                key[0],
                key[1],
                exc_info=True,
            )
            return CustomConditionResult(met=False, errored=True)

    def _prune_optimizer_condition_checkers(
        self, *, active_keys: set[tuple[str, int]]
    ) -> None:
        for key in list(self._optimizer_condition_checkers):
            if key in active_keys:
                continue
            _config, checkers, _entity_ids = self._optimizer_condition_checkers.pop(key)
            self._unload_optimizer_condition_checkers(checkers)

    @classmethod
    def _unload_optimizer_condition_checkers(cls, checkers: tuple[Any, ...]) -> None:
        for checker in checkers:
            cls._unload_optimizer_condition_checker(checker)

    @staticmethod
    def _unload_optimizer_condition_checker(checker: Any) -> None:
        if checker is None:
            return
        try:
            checker.async_unload()
        except Exception:
            _LOGGER.debug("Failed to unload condition checker", exc_info=True)


def _any_group_met_by_optimizer(
    condition_map: dict[str, tuple[bool, ...]],
) -> dict[str, bool]:
    """Fold a per-group condition map to the per-optimizer OR outcome."""
    return {
        optimizer_id: any(met_by_group)
        for optimizer_id, met_by_group in condition_map.items()
    }
