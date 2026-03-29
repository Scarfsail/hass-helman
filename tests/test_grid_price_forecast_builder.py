from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
SPRING_FORWARD_REFERENCE_TIME = datetime.fromisoformat("2026-03-29T01:30:00+01:00")
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


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

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = type("HomeAssistant", (), {})

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    util_pkg.dt = dt_mod


class _FakeDtUtil:
    @staticmethod
    def as_local(value: datetime) -> datetime:
        if value.tzinfo == TZ:
            return value
        return value.astimezone(TZ)

    @staticmethod
    def as_utc(value: datetime) -> datetime:
        if value.tzinfo == UTC:
            return value
        return value.astimezone(UTC)


class _FakeStateMachine:
    def __init__(self, states: dict[str, object] | None = None) -> None:
        self._states = states or {}

    def get(self, entity_id: str):
        return self._states.get(entity_id)


_install_import_stubs()


class GridPriceForecastBuilderTests(unittest.TestCase):
    def _make_builder(
        self,
        *,
        config: dict | None = None,
        states: dict[str, object] | None = None,
    ):
        module = importlib.reload(
            importlib.import_module("custom_components.helman.grid_price_forecast_builder")
        )
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            states=_FakeStateMachine(states),
        )
        return module, module.GridPriceForecastBuilder(hass, config or {})

    def test_build_combines_export_entity_prices_with_fixed_import_windows(self) -> None:
        module, builder = self._make_builder(
            config={
                "power_devices": {
                    "grid": {
                        "forecast": {
                            "sell_price_entity_id": "sensor.export_price",
                            "import_price_unit": "CZK/kWh",
                            "import_price_windows": [
                                {"start": "22:00", "end": "06:00", "price": 5},
                                {"start": "06:00", "end": "22:00", "price": 7},
                            ],
                        }
                    }
                }
            },
            states={
                "sensor.export_price": SimpleNamespace(
                    state="2.5",
                    attributes={
                        "unit_of_measurement": "CZK/kWh",
                        "2026-03-20T21:00:00+01:00": 100.0,
                        "2026-03-20T22:00:00+01:00": 120.0,
                    },
                )
            },
        )

        with patch.object(module, "dt_util", _FakeDtUtil):
            snapshot = builder.build(reference_time=REFERENCE_TIME)

        self.assertEqual(snapshot["export"]["status"], "available")
        self.assertEqual(snapshot["export"]["currentPrice"], 2.5)
        self.assertEqual(
            snapshot["export"]["points"],
            [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 100.0},
                {"timestamp": "2026-03-20T22:00:00+01:00", "value": 120.0},
            ],
        )

        self.assertEqual(snapshot["import"]["status"], "available")
        self.assertEqual(snapshot["import"]["unit"], "CZK/kWh")
        self.assertEqual(snapshot["import"]["currentPrice"], 7.0)
        self.assertEqual(
            snapshot["import"]["points"][0],
            {"timestamp": "2026-03-20T21:00:00+01:00", "value": 7.0},
        )
        self.assertEqual(
            snapshot["import"]["points"][3],
            {"timestamp": "2026-03-20T21:45:00+01:00", "value": 7.0},
        )
        self.assertEqual(
            snapshot["import"]["points"][4],
            {"timestamp": "2026-03-20T22:00:00+01:00", "value": 5.0},
        )
        self.assertEqual(
            snapshot["import"]["points"][36],
            {"timestamp": "2026-03-21T06:00:00+01:00", "value": 7.0},
        )

    def test_build_rejects_gap_in_import_windows(self) -> None:
        module, builder = self._make_builder(
            config={
                "power_devices": {
                    "grid": {
                        "forecast": {
                            "import_price_unit": "CZK/kWh",
                            "import_price_windows": [
                                {"start": "22:00", "end": "06:00", "price": 5},
                                {"start": "07:00", "end": "22:00", "price": 7},
                            ],
                        }
                    }
                }
            }
        )

        with patch.object(module, "dt_util", _FakeDtUtil):
            snapshot = builder.build(reference_time=REFERENCE_TIME)

        self.assertEqual(snapshot["import"]["status"], "invalid_config")
        self.assertEqual(snapshot["import"]["unit"], None)
        self.assertEqual(snapshot["import"]["currentPrice"], None)
        self.assertEqual(snapshot["import"]["points"], [])

    def test_build_rejects_overlap_in_import_windows(self) -> None:
        module, builder = self._make_builder(
            config={
                "power_devices": {
                    "grid": {
                        "forecast": {
                            "import_price_unit": "CZK/kWh",
                            "import_price_windows": [
                                {"start": "22:00", "end": "06:00", "price": 5},
                                {"start": "05:00", "end": "22:00", "price": 7},
                            ],
                        }
                    }
                }
            }
        )

        with patch.object(module, "dt_util", _FakeDtUtil):
            snapshot = builder.build(reference_time=REFERENCE_TIME)

        self.assertEqual(snapshot["import"]["status"], "invalid_config")
        self.assertEqual(snapshot["import"]["unit"], None)
        self.assertEqual(snapshot["import"]["currentPrice"], None)
        self.assertEqual(snapshot["import"]["points"], [])

    def test_build_rejects_timezone_aware_import_window_time(self) -> None:
        module, builder = self._make_builder(
            config={
                "power_devices": {
                    "grid": {
                        "forecast": {
                            "import_price_unit": "CZK/kWh",
                            "import_price_windows": [
                                {"start": "22:00+01:00", "end": "06:00", "price": 5},
                                {"start": "06:00", "end": "22:00", "price": 7},
                            ],
                        }
                    }
                }
            }
        )

        with patch.object(module, "dt_util", _FakeDtUtil):
            snapshot = builder.build(reference_time=REFERENCE_TIME)

        self.assertEqual(snapshot["import"]["status"], "invalid_config")
        self.assertEqual(snapshot["import"]["unit"], None)
        self.assertEqual(snapshot["import"]["currentPrice"], None)
        self.assertEqual(snapshot["import"]["points"], [])

    def test_build_import_points_skip_spring_forward_gap(self) -> None:
        module, builder = self._make_builder(
            config={
                "power_devices": {
                    "grid": {
                        "forecast": {
                            "import_price_unit": "CZK/kWh",
                            "import_price_windows": [
                                {"start": "00:00", "end": "12:00", "price": 5},
                                {"start": "12:00", "end": "00:00", "price": 7},
                            ],
                        }
                    }
                }
            }
        )

        with patch.object(module, "dt_util", _FakeDtUtil):
            snapshot = builder.build(reference_time=SPRING_FORWARD_REFERENCE_TIME)

        first_day_points = [
            point
            for point in snapshot["import"]["points"]
            if point["timestamp"].startswith("2026-03-29T")
        ]
        self.assertEqual(
            first_day_points[:4],
            [
                {"timestamp": "2026-03-29T01:30:00+01:00", "value": 5.0},
                {"timestamp": "2026-03-29T01:45:00+01:00", "value": 5.0},
                {"timestamp": "2026-03-29T03:00:00+02:00", "value": 5.0},
                {"timestamp": "2026-03-29T03:15:00+02:00", "value": 5.0},
            ],
        )
        self.assertEqual(len(first_day_points), 86)
        self.assertTrue(
            all("T02:" not in point["timestamp"] for point in first_day_points)
        )


if __name__ == "__main__":
    unittest.main()
