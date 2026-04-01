from __future__ import annotations

import contextlib
import importlib
import sys
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")


def _install_import_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]

    scheduling_pkg = sys.modules.get("custom_components.helman.scheduling")
    if scheduling_pkg is None:
        scheduling_pkg = types.ModuleType("custom_components.helman.scheduling")
        sys.modules["custom_components.helman.scheduling"] = scheduling_pkg
    scheduling_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "scheduling")
    ]

    try:
        import homeassistant.util.dt  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
        homeassistant_pkg = sys.modules.get("homeassistant")
        if homeassistant_pkg is None:
            homeassistant_pkg = types.ModuleType("homeassistant")
            sys.modules["homeassistant"] = homeassistant_pkg

        util_pkg = sys.modules.get("homeassistant.util")
        if util_pkg is None:
            util_pkg = types.ModuleType("homeassistant.util")
            sys.modules["homeassistant.util"] = util_pkg

        dt_mod = sys.modules.get("homeassistant.util.dt")
        if dt_mod is None:
            dt_mod = types.ModuleType("homeassistant.util.dt")
            sys.modules["homeassistant.util.dt"] = dt_mod

        util_pkg.dt = dt_mod

    util_pkg = sys.modules["homeassistant.util"]
    dt_mod = sys.modules["homeassistant.util.dt"]
    if not hasattr(dt_mod, "parse_datetime"):
        dt_mod.parse_datetime = datetime.fromisoformat
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.const import (  # noqa: E402
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_HORIZON_HOURS,
)
from custom_components.helman.scheduling.action_resolution import (  # noqa: E402
    resolve_executed_schedule_action,
)
from custom_components.helman.scheduling.forecast_overlay import (  # noqa: E402
    build_schedule_forecast_overlay,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleDocument,
    ScheduleExecutionUnavailableError,
    build_horizon_start,
)


def _expected_canonical_slot_count() -> int:
    return (SCHEDULE_HORIZON_HOURS * 60) // FORECAST_CANONICAL_GRANULARITY_MINUTES


@contextlib.contextmanager
def _reloaded_schedule_modules(*, schedule_slot_minutes: int):
    _install_import_stubs()
    const_module = importlib.import_module("custom_components.helman.const")
    original_slot_minutes = const_module.SCHEDULE_SLOT_MINUTES
    original_schedule_module = sys.modules.get(
        "custom_components.helman.scheduling.schedule"
    )
    original_overlay_module = sys.modules.get(
        "custom_components.helman.scheduling.forecast_overlay"
    )

    try:
        const_module.SCHEDULE_SLOT_MINUTES = schedule_slot_minutes
        sys.modules.pop("custom_components.helman.scheduling.schedule", None)
        sys.modules.pop("custom_components.helman.scheduling.forecast_overlay", None)
        schedule_module = importlib.import_module(
            "custom_components.helman.scheduling.schedule"
        )
        overlay_module = importlib.import_module(
            "custom_components.helman.scheduling.forecast_overlay"
        )
        yield schedule_module, overlay_module
    finally:
        const_module.SCHEDULE_SLOT_MINUTES = original_slot_minutes
        sys.modules.pop("custom_components.helman.scheduling.schedule", None)
        sys.modules.pop("custom_components.helman.scheduling.forecast_overlay", None)
        if original_schedule_module is not None:
            sys.modules["custom_components.helman.scheduling.schedule"] = (
                original_schedule_module
            )
        if original_overlay_module is not None:
            sys.modules["custom_components.helman.scheduling.forecast_overlay"] = (
                original_overlay_module
            )


class ScheduleForecastOverlayTests(unittest.TestCase):
    def test_overlay_materializes_full_canonical_horizon(self) -> None:
        overlay = build_schedule_forecast_overlay(
            schedule_document=ScheduleDocument(execution_enabled=True, slots={}),
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(len(overlay.slots), _expected_canonical_slot_count())
        self.assertEqual(overlay.slots[0].id, "2026-03-20T21:00:00+01:00")
        self.assertEqual(
            overlay.lookup_action(build_horizon_start(REFERENCE_TIME)).kind,
            SCHEDULE_ACTION_NORMAL,
        )

    def test_overlay_expands_stop_action_across_coarser_schedule_slot(self) -> None:
        current_slot_start = build_horizon_start(REFERENCE_TIME)
        overlay = build_schedule_forecast_overlay(
            schedule_document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    current_slot_start.isoformat(timespec="seconds"): ScheduleAction(
                        kind=SCHEDULE_ACTION_STOP_CHARGING
                    )
                },
            ),
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            overlay.lookup_action(current_slot_start).kind,
            SCHEDULE_ACTION_STOP_CHARGING,
        )
        self.assertEqual(
            overlay.lookup_action(
                current_slot_start
                + timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
            ).kind,
            SCHEDULE_ACTION_STOP_CHARGING,
        )
        self.assertEqual(
            overlay.lookup_action(
                current_slot_start
                + timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES * 2)
            ).kind,
            SCHEDULE_ACTION_NORMAL,
        )

    def test_overlay_preserves_target_actions_in_canonical_windows(self) -> None:
        current_slot_start = build_horizon_start(REFERENCE_TIME)
        overlay = build_schedule_forecast_overlay(
            schedule_document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    current_slot_start.isoformat(timespec="seconds"): ScheduleAction(
                        kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                        target_soc=80,
                    )
                },
            ),
            reference_time=REFERENCE_TIME,
        )

        first_window = overlay.lookup_action(current_slot_start)
        second_window = overlay.lookup_action(
            current_slot_start
            + timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
        )

        self.assertEqual(first_window.kind, SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC)
        self.assertEqual(first_window.target_soc, 80)
        self.assertEqual(second_window.kind, SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC)
        self.assertEqual(second_window.target_soc, 80)

    def test_overlay_ignores_explicit_actions_when_execution_is_disabled(self) -> None:
        current_slot_start = build_horizon_start(REFERENCE_TIME)
        overlay = build_schedule_forecast_overlay(
            schedule_document=ScheduleDocument(
                execution_enabled=False,
                slots={
                    current_slot_start.isoformat(timespec="seconds"): ScheduleAction(
                        kind=SCHEDULE_ACTION_STOP_DISCHARGING
                    )
                },
            ),
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            overlay.lookup_action(current_slot_start).kind,
            SCHEDULE_ACTION_NORMAL,
        )

    def test_overlay_prunes_expired_slots_before_materializing(self) -> None:
        first_slot_start = build_horizon_start(REFERENCE_TIME)
        next_slot_start = first_slot_start + timedelta(minutes=30)
        overlay = build_schedule_forecast_overlay(
            schedule_document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    first_slot_start.isoformat(timespec="seconds"): ScheduleAction(
                        kind=SCHEDULE_ACTION_STOP_CHARGING
                    ),
                    next_slot_start.isoformat(timespec="seconds"): ScheduleAction(
                        kind=SCHEDULE_ACTION_STOP_DISCHARGING
                    ),
                },
            ),
            reference_time=first_slot_start + timedelta(minutes=31),
        )

        self.assertEqual(overlay.slots[0].id, next_slot_start.isoformat(timespec="seconds"))
        self.assertEqual(
            overlay.lookup_action(next_slot_start).kind,
            SCHEDULE_ACTION_STOP_DISCHARGING,
        )
        self.assertEqual(
            overlay.lookup_action(first_slot_start).kind,
            SCHEDULE_ACTION_NORMAL,
        )

    def test_overlay_uses_direct_lookup_when_granularities_match(self) -> None:
        with _reloaded_schedule_modules(
            schedule_slot_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES
        ) as (schedule_module, overlay_module):
            current_slot_start = schedule_module.build_horizon_start(REFERENCE_TIME)
            overlay = overlay_module.build_schedule_forecast_overlay(
                schedule_document=schedule_module.ScheduleDocument(
                    execution_enabled=True,
                    slots={
                        current_slot_start.isoformat(timespec="seconds"): schedule_module.ScheduleAction(
                            kind=SCHEDULE_ACTION_STOP_CHARGING
                        )
                    },
                ),
                reference_time=REFERENCE_TIME,
            )

            self.assertEqual(len(overlay.slots), _expected_canonical_slot_count())
            self.assertEqual(
                overlay.lookup_action(current_slot_start).kind,
                SCHEDULE_ACTION_STOP_CHARGING,
            )
            self.assertEqual(
                overlay.lookup_action(
                    current_slot_start
                    + timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
                ).kind,
                SCHEDULE_ACTION_NORMAL,
            )


class ScheduleActionResolutionTests(unittest.TestCase):
    def test_resolve_executed_schedule_action_keeps_non_target_actions(self) -> None:
        resolution = resolve_executed_schedule_action(
            action=ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING),
            current_soc=None,
        )

        self.assertEqual(
            resolution.executed_action.kind,
            SCHEDULE_ACTION_STOP_CHARGING,
        )
        self.assertEqual(resolution.reason, "scheduled")

    def test_resolve_executed_schedule_action_keeps_charge_target_before_reaching(self) -> None:
        resolution = resolve_executed_schedule_action(
            action=ScheduleAction(
                kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                target_soc=80,
            ),
            current_soc=72,
        )

        self.assertEqual(
            resolution.executed_action,
            ScheduleAction(kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC, target_soc=80),
        )
        self.assertEqual(resolution.reason, "scheduled")

    def test_resolve_executed_schedule_action_flips_charge_target_to_stop_discharging(
        self,
    ) -> None:
        resolution = resolve_executed_schedule_action(
            action=ScheduleAction(
                kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                target_soc=80,
            ),
            current_soc=80,
        )

        self.assertEqual(
            resolution.executed_action.kind,
            SCHEDULE_ACTION_STOP_DISCHARGING,
        )
        self.assertEqual(resolution.reason, "target_soc_reached")

    def test_resolve_executed_schedule_action_flips_discharge_target_to_stop_charging(
        self,
    ) -> None:
        resolution = resolve_executed_schedule_action(
            action=ScheduleAction(
                kind=SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
                target_soc=30,
            ),
            current_soc=30,
        )

        self.assertEqual(
            resolution.executed_action.kind,
            SCHEDULE_ACTION_STOP_CHARGING,
        )
        self.assertEqual(resolution.reason, "target_soc_reached")

    def test_resolve_executed_schedule_action_requires_current_soc_for_target_actions(
        self,
    ) -> None:
        with self.assertRaises(ScheduleExecutionUnavailableError):
            resolve_executed_schedule_action(
                action=ScheduleAction(
                    kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                    target_soc=80,
                ),
                current_soc=None,
            )


if __name__ == "__main__":
    unittest.main()
