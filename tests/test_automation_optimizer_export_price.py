from __future__ import annotations

import sys
import types
import unittest
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"
NEXT_SLOT_ID = "2026-03-20T21:30:00+01:00"
THIRD_SLOT_ID = "2026-03-20T22:00:00+01:00"


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
    dt_mod.parse_datetime = datetime.fromisoformat
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.config import OptimizerInstanceConfig  # noqa: E402
from custom_components.helman.automation.optimizers.export_price import (  # noqa: E402
    ExportPriceOptimizer,
)
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleDocument,
    build_horizon_end,
    schedule_document_to_dict,
)
from custom_components.helman.appliances import AppliancesRuntimeRegistry  # noqa: E402


def _make_optimizer_config(
    *,
    when_price_below: float = 0.0,
    action: str = "stop_export",
) -> OptimizerInstanceConfig:
    return OptimizerInstanceConfig(
        id="avoid-negative-export",
        kind="export_price",
        params={
            "when_price_below": when_price_below,
            "action": action,
        },
    )


def _make_snapshot(
    *,
    schedule_document: ScheduleDocument | None = None,
    export_price_points: list[dict[str, object]] | None = None,
    grid_series: list[dict[str, object]] | None = None,
    current_price: float = 2.0,
) -> OptimizationSnapshot:
    return OptimizationSnapshot(
        schedule=ScheduleDocument() if schedule_document is None else schedule_document,
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={
            "status": "available",
            "series": [] if grid_series is None else deepcopy(grid_series),
        },
        grid_forecast={
            "status": "available",
            "exportPriceUnit": "CZK/kWh",
            "currentExportPrice": current_price,
            "series": [] if grid_series is None else deepcopy(grid_series),
        },
        context=OptimizationContext(
            now=REFERENCE_TIME,
            battery_state=None,
            solar_forecast={"status": "available", "points": []},
            import_price_forecast={"unit": "CZK/kWh", "currentPrice": 7.0, "points": []},
            export_price_forecast={
                "unit": "CZK/kWh",
                "currentPrice": current_price,
                "points": [] if export_price_points is None else deepcopy(export_price_points),
            },
            appliance_registry=AppliancesRuntimeRegistry(),
            when_active_hourly_energy_kwh_by_appliance_id={},
        ),
    )


class ExportPriceOptimizerTests(unittest.TestCase):
    def test_returns_unchanged_schedule_when_export_prices_stay_above_threshold(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                THIRD_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "appliances": {},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[
                {"timestamp": CURRENT_SLOT_ID, "value": 1.2},
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.3},
            ],
            grid_series=[
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "exportedToGridKwh": 0.6,
                },
                {
                    "timestamp": "2026-03-20T21:15:00+01:00",
                    "exportedToGridKwh": 0.4,
                },
            ],
            current_price=1.0,
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(
            schedule_document_to_dict(result),
            schedule_document_to_dict(schedule_document),
        )

    def test_writes_stop_export_for_negative_price_slots_only(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "empty"},
                    "appliances": {"boiler": {"on": True, "setBy": "user"}},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[
                {"timestamp": CURRENT_SLOT_ID, "value": -0.1},
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.2},
                {"timestamp": NEXT_SLOT_ID, "value": 1.5},
            ],
            grid_series=[
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "exportedToGridKwh": 0.6,
                },
                {
                    "timestamp": "2026-03-20T21:15:00+01:00",
                    "exportedToGridKwh": 0.0,
                },
                {
                    "timestamp": NEXT_SLOT_ID,
                    "exportedToGridKwh": 0.5,
                },
            ],
            current_price=1.0,
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(
            schedule_document_to_dict(result),
            {
                "executionEnabled": True,
                "slotMinutes": 30,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "stop_export", "setBy": "automation"},
                        "appliances": {"boiler": {"on": True, "setBy": "user"}},
                    }
                },
            },
        )

    def test_does_not_write_when_negative_price_and_export_do_not_overlap(self) -> None:
        snapshot = _make_snapshot(
            schedule_document=ScheduleDocument(execution_enabled=True),
            export_price_points=[
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": -0.2},
            ],
            grid_series=[
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "exportedToGridKwh": 0.6,
                }
            ],
            current_price=0.5,
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(schedule_document_to_dict(result)["slots"], {})

    def test_leaves_user_owned_inverter_slots_untouched(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal", "setBy": "user"},
                    "appliances": {},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[{"timestamp": CURRENT_SLOT_ID, "value": -0.1}],
            grid_series=[{"timestamp": CURRENT_SLOT_ID, "exportedToGridKwh": 0.6}],
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(
            schedule_document_to_dict(result),
            schedule_document_to_dict(schedule_document),
        )

    def test_warns_and_skips_when_stop_export_is_unsupported(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                THIRD_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "appliances": {"boiler": {"on": True, "setBy": "user"}},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[{"timestamp": CURRENT_SLOT_ID, "value": -0.1}],
            grid_series=[{"timestamp": CURRENT_SLOT_ID, "exportedToGridKwh": 0.6}],
        )

        with self.assertLogs(
            "custom_components.helman.automation.optimizers.export_price",
            level="WARNING",
        ) as captured_logs:
            result = ExportPriceOptimizer(
                id="avoid-negative-export",
                stop_export_supported=False,
            ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(
            schedule_document_to_dict(result),
            schedule_document_to_dict(schedule_document),
        )
        self.assertIn("stop_export", captured_logs.output[0])

    def test_does_not_mutate_snapshot_schedule_in_place(self) -> None:
        schedule_document = ScheduleDocument(execution_enabled=True)
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[{"timestamp": CURRENT_SLOT_ID, "value": -0.1}],
            grid_series=[{"timestamp": CURRENT_SLOT_ID, "exportedToGridKwh": 0.6}],
        )
        original_snapshot_schedule = schedule_document_to_dict(snapshot.schedule)

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(schedule_document_to_dict(snapshot.schedule), original_snapshot_schedule)
        self.assertNotEqual(
            schedule_document_to_dict(result),
            original_snapshot_schedule,
        )

    def test_never_writes_outside_existing_horizon(self) -> None:
        outside_horizon = build_horizon_end(REFERENCE_TIME) + timedelta(minutes=15)
        snapshot = _make_snapshot(
            schedule_document=ScheduleDocument(execution_enabled=True),
            export_price_points=[{"timestamp": outside_horizon.isoformat(), "value": -0.1}],
            grid_series=[
                {
                    "timestamp": outside_horizon.isoformat(),
                    "exportedToGridKwh": 0.6,
                }
            ],
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(schedule_document_to_dict(result)["slots"], {})


if __name__ == "__main__":
    unittest.main()
