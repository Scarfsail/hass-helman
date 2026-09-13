"""Reserve-floor breach classifier (#274, P0 of #270).

``charge_from_grid`` decides whether to bridge an expensive import window by
reading the projected SoC trajectory *when it runs*. Optimizers running after
it can add demand inside the same window, so the shipped plan can still cross
``reserve_floor_soc`` even though the bridge was sized correctly at the time.
This module classifies, after the fact, whether a given evaluated window ended
up breached in the final plan and — if so — why, by joining the raw
observations ``charge_from_grid`` emits (see ``ReserveFloorObservation`` in
``.trace``) against snapshots the pipeline captures deliberately:

- the **control** snapshot: the trajectory before anything was planned
  (user-owned actions only);
- the **boundary** snapshot: the forecast right after the emitting step wrote
  its bridge, with the same demand basis the step's own input used;
- the **final** snapshot/document: what actually shipped.

This is diagnostic only. It never changes a schedule document and it is never
rendered — see ``ReserveFloorObservation`` and ``OptimizerTrace`` in
``.trace``.

**Accurate is not causal.** A boundary-to-final diff establishes *that*
appliance/inverter lanes changed inside the window, never that a particular
change is *why* the floor was crossed. ``appliance_lane_changed`` and
``inverter_lane_changed`` (summarised as ``exclusive_appliance`` /
``exclusive_inverter`` / ``mixed``) are exactly that and no more.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import TYPE_CHECKING, Any

from ..scheduling.schedule import appliance_actions, inverter_action, parse_slot_id
from .optimizers.charge_from_grid import _min_soc_over
from .rails import forecast_covers_horizon, read_soc_by_bucket

if TYPE_CHECKING:
    from datetime import datetime

    from ..scheduling.schedule import ScheduleDocument
    from .snapshot import OptimizationSnapshot
    from .trace import ReserveFloorObservation

_LOGGER = logging.getLogger(__name__)

# --- status: whether classification could even be attempted -----------------
STATUS_MEASURED = "measured"
STATUS_UNAVAILABLE = "unavailable"
STATUS_FAILED = "failed"

# --- classes: the decision table's outcomes, first match wins ---------------
CLASS_UNMEASURABLE = "unmeasurable"
CLASS_NONE = "none"
CLASS_DOWNSTREAM_INTRODUCED = "downstream_introduced"
CLASS_PRE_EXISTING_PHYSICAL = "pre_existing_physical"
CLASS_KNOWN_UNREPAIRABLE = "known_unrepairable"
CLASS_UNRESOLVED_AT_BOUNDARY = "unresolved_at_boundary"

# --- reasons ------------------------------------------------------------
REASON_CAP = "cap"
REASON_CAPACITY = "capacity"
REASON_UNRESOLVED = "unresolved"

# --- lane-change summaries ------------------------------------------------
LANE_EXCLUSIVE_APPLIANCE = "exclusive_appliance"
LANE_EXCLUSIVE_INVERTER = "exclusive_inverter"
LANE_MIXED = "mixed"


@dataclass(frozen=True)
class ReserveFloorBoundary:
    """One emitting ``charge_from_grid`` step's boundary capture.

    ``snapshot`` is built with ``next_index=index`` on the *current*
    (unrestructured) pipeline — the same demand basis the step's own input
    used, not the next step's ``next_index=index + 1`` rebuild (which would
    drop the next optimizer's own pending lane and read artificially high).
    ``demand_document`` is the effective projection document behind that
    snapshot, captured separately because restored appliance demand never
    rides in ``snapshot.schedule`` (see ``coordinator.py``).
    """

    snapshot: "OptimizationSnapshot"
    demand_document: "ScheduleDocument"


@dataclass(frozen=True)
class ReserveFloorResult:
    """The classifier's verdict for one observed window.

    Keyed by ``(optimizer_id, group_index, window)`` — the same identity the
    golden file commits.
    """

    optimizer_id: str
    group_index: int
    window: tuple[str, str]
    status: str
    klass: str | None = None
    appliance_lane_changed: bool | None = None
    inverter_lane_changed: bool | None = None
    lane_summary: str | None = None
    reason: str | None = None
    shortfall_pp: float | None = None

    @property
    def key(self) -> tuple[str, int, tuple[str, str]]:
        return (self.optimizer_id, self.group_index, self.window)

    def to_dict(self) -> dict[str, Any]:
        return {
            "optimizerId": self.optimizer_id,
            "groupIndex": self.group_index,
            "window": list(self.window),
            "status": self.status,
            "class": self.klass,
            "applianceLaneChanged": self.appliance_lane_changed,
            "inverterLaneChanged": self.inverter_lane_changed,
            "laneSummary": self.lane_summary,
            "reason": self.reason,
            "shortfallPp": self.shortfall_pp,
        }


def _lane_summary(appliance_changed: bool, inverter_changed: bool) -> str | None:
    if appliance_changed and inverter_changed:
        return LANE_MIXED
    if appliance_changed:
        return LANE_EXCLUSIVE_APPLIANCE
    if inverter_changed:
        return LANE_EXCLUSIVE_INVERTER
    return None


def _window_bounds(window: tuple[str, str]) -> tuple["datetime", "datetime"]:
    return parse_slot_id(window[0]), parse_slot_id(window[1])


def _min_soc_for_window(
    snapshot: "OptimizationSnapshot | None", window: tuple[str, str]
) -> float | None:
    if snapshot is None:
        return None
    start, end = _window_bounds(window)
    # A partial forecast truncates its series rather than padding the missing
    # tail.  Taking the minimum of whatever prefix happens to be present can
    # therefore make an uncovered breach look clean.  The forecast metadata is
    # the authoritative coverage signal; only evaluate windows it fully spans.
    if not forecast_covers_horizon(
        snapshot.battery_forecast,
        required_coverage_until=end,
    ):
        return None
    soc_by_bucket = read_soc_by_bucket(snapshot)
    if not soc_by_bucket:
        return None
    return _min_soc_over(soc_by_bucket, start, end)


def _lane_changes(
    before: "ScheduleDocument",
    after: "ScheduleDocument",
) -> tuple[bool, bool]:
    """Whether the appliance/inverter lanes differ anywhere in the document.

    Not restricted to the observed window: the write that ends up mattering
    (a bridge, an overwrite) commonly lands in the *preceding cheap* band,
    outside the expensive window the SoC minimum is measured over. Accurate,
    not causal — see the module docstring.
    """
    appliance_changed = False
    inverter_changed = False
    for slot_id in set(before.slots) | set(after.slots):
        before_actions = before.slots.get(slot_id, {})
        after_actions = after.slots.get(slot_id, {})
        if inverter_action(before_actions) != inverter_action(after_actions):
            inverter_changed = True
        if appliance_actions(before_actions) != appliance_actions(after_actions):
            appliance_changed = True
    return appliance_changed, inverter_changed


def classify_reserve_floor_observation(
    observation: "ReserveFloorObservation",
    *,
    control_snapshot: "OptimizationSnapshot | None",
    boundary: "ReserveFloorBoundary | None",
    final_snapshot: "OptimizationSnapshot",
    final_document: "ScheduleDocument",
) -> ReserveFloorResult:
    """Classify one observed window per the #274 decision table.

    An ordered decision table, first match wins, so the classes are total and
    mutually exclusive by construction. Never raises: a failure is caught,
    logged at debug, and reported as ``status="failed"`` — it must never look
    indistinguishable from "no breaches".
    """
    try:
        if boundary is None:
            # Structural gap: no boundary was ever captured for this step's
            # id (e.g. capture failed, or diagnostics were never armed).
            return ReserveFloorResult(
                optimizer_id=observation.optimizer_id,
                group_index=observation.group_index,
                window=observation.window,
                status=STATUS_UNAVAILABLE,
            )

        # Rule 1 (part): inputs incomplete for the final plan.
        final_min = _min_soc_for_window(final_snapshot, observation.window)
        floor = observation.reserve_floor_soc
        if final_min is None:
            return ReserveFloorResult(
                optimizer_id=observation.optimizer_id,
                group_index=observation.group_index,
                window=observation.window,
                status=STATUS_MEASURED,
                klass=CLASS_UNMEASURABLE,
            )

        # Rule 2.
        if final_min >= floor:
            return ReserveFloorResult(
                optimizer_id=observation.optimizer_id,
                group_index=observation.group_index,
                window=observation.window,
                status=STATUS_MEASURED,
                klass=CLASS_NONE,
                shortfall_pp=0.0,
            )

        shortfall = round(floor - final_min, 4)

        # Rule 1 (part): boundary coverage incomplete.
        boundary_min = _min_soc_for_window(boundary.snapshot, observation.window)
        if boundary_min is None:
            return ReserveFloorResult(
                optimizer_id=observation.optimizer_id,
                group_index=observation.group_index,
                window=observation.window,
                status=STATUS_MEASURED,
                klass=CLASS_UNMEASURABLE,
            )

        # Rule 3.
        if boundary_min >= floor:
            appliance_changed, inverter_changed = _lane_changes(
                boundary.demand_document, final_document
            )
            return ReserveFloorResult(
                optimizer_id=observation.optimizer_id,
                group_index=observation.group_index,
                window=observation.window,
                status=STATUS_MEASURED,
                klass=CLASS_DOWNSTREAM_INTRODUCED,
                appliance_lane_changed=appliance_changed,
                inverter_lane_changed=inverter_changed,
                lane_summary=_lane_summary(appliance_changed, inverter_changed),
                shortfall_pp=shortfall,
            )

        # Rule 4. Requires the control trajectory to tell pre-existing from
        # downstream apart; if it could not be captured or does not cover
        # this window, we cannot rule out `pre_existing_physical`, so this
        # observation is reported `unavailable` rather than silently falling
        # through to rules 5/6 and reading as a repairable optimizer failure.
        control_min = _min_soc_for_window(control_snapshot, observation.window)
        if control_min is None:
            return ReserveFloorResult(
                optimizer_id=observation.optimizer_id,
                group_index=observation.group_index,
                window=observation.window,
                status=STATUS_UNAVAILABLE,
            )
        if control_min < floor:
            return ReserveFloorResult(
                optimizer_id=observation.optimizer_id,
                group_index=observation.group_index,
                window=observation.window,
                status=STATUS_MEASURED,
                klass=CLASS_PRE_EXISTING_PHYSICAL,
                shortfall_pp=shortfall,
            )

        # Rule 5. Never "power" — see `ReserveFloorObservation.limit`.
        if observation.limit in (REASON_CAP, REASON_CAPACITY):
            return ReserveFloorResult(
                optimizer_id=observation.optimizer_id,
                group_index=observation.group_index,
                window=observation.window,
                status=STATUS_MEASURED,
                klass=CLASS_KNOWN_UNREPAIRABLE,
                reason=observation.limit,
                shortfall_pp=shortfall,
            )

        # Rule 6.
        return ReserveFloorResult(
            optimizer_id=observation.optimizer_id,
            group_index=observation.group_index,
            window=observation.window,
            status=STATUS_MEASURED,
            klass=CLASS_UNRESOLVED_AT_BOUNDARY,
            reason=REASON_UNRESOLVED,
            shortfall_pp=shortfall,
        )
    except Exception:  # pragma: no cover - classification must not fail runs
        _LOGGER.debug(
            "reserve floor classification failed for %s/%s/%s; run continues",
            observation.optimizer_id,
            observation.group_index,
            observation.window,
            exc_info=True,
        )
        return ReserveFloorResult(
            optimizer_id=observation.optimizer_id,
            group_index=observation.group_index,
            window=observation.window,
            status=STATUS_FAILED,
        )


def classify_reserve_floor_observations(
    observations: "tuple[ReserveFloorObservation, ...] | list[ReserveFloorObservation]",
    *,
    control_snapshot: "OptimizationSnapshot | None",
    boundaries: dict[str, ReserveFloorBoundary],
    final_snapshot: "OptimizationSnapshot",
    final_document: "ScheduleDocument",
) -> tuple[ReserveFloorResult, ...]:
    """Classify every observation, joining each to its own step's boundary.

    Several ``charge_from_grid`` instances can exist in one run (config
    enforces unique ids, not unique kinds) — ``boundaries`` is keyed by
    optimizer id precisely so each observation joins only its own step's
    boundary, never another instance's.
    """
    return tuple(
        classify_reserve_floor_observation(
            observation,
            control_snapshot=control_snapshot,
            boundary=boundaries.get(observation.optimizer_id),
            final_snapshot=final_snapshot,
            final_document=final_document,
        )
        for observation in observations
    )
