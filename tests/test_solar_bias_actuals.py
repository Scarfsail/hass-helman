from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
TZ = timezone.utc


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

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    recorder_mod = sys.modules.get("homeassistant.components.recorder")
    if recorder_mod is None:
        recorder_mod = types.ModuleType("homeassistant.components.recorder")
        sys.modules["homeassistant.components.recorder"] = recorder_mod
    if not hasattr(recorder_mod, "get_instance"):
        recorder_mod.get_instance = lambda hass: None

    history_mod = sys.modules.get("homeassistant.components.recorder.history")
    if history_mod is None:
        history_mod = types.ModuleType("homeassistant.components.recorder.history")
        sys.modules["homeassistant.components.recorder.history"] = history_mod
    if not hasattr(history_mod, "get_significant_states"):
        history_mod.get_significant_states = lambda *args, **kwargs: {}
    if not hasattr(history_mod, "state_changes_during_period"):
        history_mod.state_changes_during_period = lambda *args, **kwargs: {}

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


_install_import_stubs()

from custom_components.helman.solar_bias_correction import actuals  # noqa: E402


class _FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 4, 17, 12, 0, tzinfo=tz or TZ)


class SolarBiasActualsTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_boundary_sampled_slot_actuals_as_wh(self) -> None:
        with patch.object(
            actuals,
            "query_cumulative_slot_energy_changes",
            AsyncMock(
                return_value={
                    datetime(2026, 4, 15, 8, 0, tzinfo=TZ): 0.6,
                    datetime(2026, 4, 15, 10, 30, tzinfo=TZ): 0.4,
                }
            ),
        ):
            slot_actuals = await actuals._read_day_slot_actuals(
                SimpleNamespace(),
                "sensor.solax_total_solar_energy",
                date(2026, 4, 15),
                local_now=datetime(2026, 4, 16, 12, 0, tzinfo=TZ),
            )

        self.assertAlmostEqual(sum(slot_actuals.values()), 1000.0)
        self.assertEqual(slot_actuals["08:00"], 600.0)
        self.assertEqual(slot_actuals["10:30"], 400.0)

    async def test_today_actuals_stop_at_current_completed_slot(self) -> None:
        captured = {}

        async def _query(hass, entity_id, *, local_start, local_end, interval_minutes):
            captured["args"] = {
                "entity_id": entity_id,
                "local_start": local_start,
                "local_end": local_end,
                "interval_minutes": interval_minutes,
            }
            return {}

        with patch.object(
            actuals,
            "query_cumulative_slot_energy_changes",
            AsyncMock(side_effect=_query),
        ):
            await actuals._read_day_slot_actuals(
                SimpleNamespace(),
                "sensor.solax_total_solar_energy",
                date(2026, 4, 15),
                local_now=datetime(2026, 4, 15, 10, 7, tzinfo=TZ),
            )

        self.assertEqual(captured["args"]["entity_id"], "sensor.solax_total_solar_energy")
        self.assertEqual(
            captured["args"]["local_start"],
            datetime(2026, 4, 15, 0, 0, tzinfo=TZ),
        )
        self.assertEqual(
            captured["args"]["local_end"],
            datetime(2026, 4, 15, 10, 0, tzinfo=TZ),
        )
        self.assertEqual(captured["args"]["interval_minutes"], 15)

    async def test_load_actuals_window_feature_off_returns_empty_invalidation_map(self) -> None:
        hass = SimpleNamespace(
            data={"helman": {"coordinator": SimpleNamespace(config={})}},
            config=SimpleNamespace(time_zone="UTC"),
        )
        cfg = SimpleNamespace(
            total_energy_entity_id="sensor.solax_total_solar_energy",
            slot_invalidation_max_battery_soc_percent=None,
            slot_invalidation_export_enabled_entity_id=None,
        )

        with patch.object(actuals, "datetime", _FixedDateTime), patch.object(
            actuals,
            "_read_day_slot_actuals",
            AsyncMock(return_value={"12:00": 600.0}),
        ) as read_day_slot_actuals, patch.object(
            actuals,
            "_load_state_samples_for_entity",
            AsyncMock(),
        ) as load_state_samples, patch.object(
            actuals,
            "compute_invalidated_slots_for_window",
        ) as compute_invalidated:
            window = await actuals.load_actuals_window(hass, cfg, days=1)

        self.assertEqual(
            window.slot_actuals_by_date,
            {"2026-04-16": {"12:00": 600.0}},
        )
        self.assertEqual(window.invalidated_slots_by_date, {})
        self.assertEqual(read_day_slot_actuals.await_count, 1)
        load_state_samples.assert_not_awaited()
        compute_invalidated.assert_not_called()

    async def test_load_actuals_window_feature_on_calls_evaluator_with_utc_slots(self) -> None:
        hass = SimpleNamespace(
            data={
                "helman": {
                    "coordinator": SimpleNamespace(
                        config={
                            "power_devices": {
                                "battery": {
                                    "entities": {
                                        "capacity": "sensor.battery_soc",
                                    }
                                }
                            }
                        }
                    )
                }
            },
            config=SimpleNamespace(time_zone="UTC"),
        )
        cfg = SimpleNamespace(
            total_energy_entity_id="sensor.solax_total_solar_energy",
            slot_invalidation_max_battery_soc_percent=87.0,
            slot_invalidation_export_enabled_entity_id="switch.export_enabled",
        )
        invalidated = {"2026-04-15": {"12:00"}, "2026-04-16": {"23:45"}}

        with patch.object(actuals, "datetime", _FixedDateTime), patch.object(
            actuals,
            "_read_day_slot_actuals",
            AsyncMock(side_effect=[{"12:00": 600.0, "12:15": 400.0}, {"23:45": 50.0}]),
        ), patch.object(
            actuals,
            "_load_state_samples_for_entity",
            AsyncMock(side_effect=[[SimpleNamespace()], [SimpleNamespace()]]),
        ) as load_state_samples, patch.object(
            actuals,
            "compute_invalidated_slots_for_window",
            return_value=invalidated,
        ) as compute_invalidated:
            window = await actuals.load_actuals_window(hass, cfg, days=2)

        self.assertEqual(window.invalidated_slots_by_date, invalidated)
        self.assertEqual(load_state_samples.await_count, 2)
        inputs = compute_invalidated.call_args.args[0]
        self.assertEqual(inputs.max_battery_soc_percent, 87.0)
        self.assertEqual(set(inputs.slot_keys_by_date), {"2026-04-15", "2026-04-16"})
        for day in ("2026-04-15", "2026-04-16"):
            self.assertEqual(len(inputs.slot_keys_by_date[day]), 96)
            self.assertEqual(inputs.slot_keys_by_date[day][0], "00:00")
            self.assertEqual(inputs.slot_keys_by_date[day][-1], "23:45")
            self.assertEqual(len(inputs.forecast_slot_starts_by_date[day]), 96)
        self.assertEqual(
            inputs.forecast_slot_starts_by_date["2026-04-15"][48],
            datetime(2026, 4, 15, 12, 0, tzinfo=TZ),
        )

    async def test_load_actuals_window_skips_invalidation_when_battery_soc_entity_is_missing(self) -> None:
        hass = SimpleNamespace(
            data={"helman": {"coordinator": SimpleNamespace(config={})}},
            config=SimpleNamespace(time_zone="UTC"),
        )
        cfg = SimpleNamespace(
            total_energy_entity_id="sensor.solax_total_solar_energy",
            slot_invalidation_max_battery_soc_percent=87.0,
            slot_invalidation_export_enabled_entity_id="switch.export_enabled",
        )

        with patch.object(actuals, "datetime", _FixedDateTime), patch.object(
            actuals,
            "_read_day_slot_actuals",
            AsyncMock(return_value={"12:00": 600.0}),
        ), patch.object(
            actuals,
            "_load_state_samples_for_entity",
            AsyncMock(),
        ) as load_state_samples, patch.object(
            actuals,
            "compute_invalidated_slots_for_window",
        ) as compute_invalidated:
            window = await actuals.load_actuals_window(hass, cfg, days=1)

        self.assertEqual(window.invalidated_slots_by_date, {})
        load_state_samples.assert_not_awaited()
        compute_invalidated.assert_not_called()

    async def test_load_actuals_window_logs_warning_when_battery_soc_entity_is_missing(self) -> None:
        hass = SimpleNamespace(
            data={"helman": {"coordinator": SimpleNamespace(config={})}},
            config=SimpleNamespace(time_zone="UTC"),
        )
        cfg = SimpleNamespace(
            total_energy_entity_id="sensor.solax_total_solar_energy",
            slot_invalidation_max_battery_soc_percent=87.0,
            slot_invalidation_export_enabled_entity_id="switch.export_enabled",
        )

        with patch.object(actuals, "datetime", _FixedDateTime), patch.object(
            actuals,
            "_read_day_slot_actuals",
            AsyncMock(return_value={"12:00": 600.0}),
        ), self.assertLogs(actuals.__name__, level="WARNING") as captured_logs:
            await actuals.load_actuals_window(hass, cfg, days=1)

        self.assertTrue(
            any("battery" in message and "slot invalidation" in message for message in captured_logs.output)
        )

    async def test_load_actuals_window_uses_capacity_entity_without_soc_bounds(self) -> None:
        hass = SimpleNamespace(
            data={
                "helman": {
                    "coordinator": SimpleNamespace(
                        config={
                            "power_devices": {
                                "battery": {
                                    "entities": {
                                        "capacity": "sensor.battery_soc",
                                    }
                                }
                            }
                        }
                    )
                }
            },
            config=SimpleNamespace(time_zone="UTC"),
        )
        cfg = SimpleNamespace(
            total_energy_entity_id="sensor.solax_total_solar_energy",
            slot_invalidation_max_battery_soc_percent=87.0,
            slot_invalidation_export_enabled_entity_id="switch.export_enabled",
        )

        with patch.object(actuals, "datetime", _FixedDateTime), patch.object(
            actuals,
            "_read_day_slot_actuals",
            AsyncMock(return_value={"12:00": 600.0}),
        ), patch.object(
            actuals,
            "_load_state_samples_for_entity",
            AsyncMock(side_effect=[[SimpleNamespace()], [SimpleNamespace()]]),
        ) as load_state_samples, patch.object(
            actuals,
            "compute_invalidated_slots_for_window",
            return_value={"2026-04-16": {"12:00"}},
        ) as compute_invalidated:
            window = await actuals.load_actuals_window(hass, cfg, days=1)

        self.assertEqual(window.invalidated_slots_by_date, {"2026-04-16": {"12:00"}})
        self.assertEqual(load_state_samples.await_args_list[0].args[1], "sensor.battery_soc")
        slot_keys = compute_invalidated.call_args.args[0].slot_keys_by_date
        self.assertEqual(set(slot_keys), {"2026-04-16"})
        self.assertEqual(len(slot_keys["2026-04-16"]), 96)
        self.assertIn("12:00", slot_keys["2026-04-16"])


if __name__ == "__main__":
    unittest.main()
