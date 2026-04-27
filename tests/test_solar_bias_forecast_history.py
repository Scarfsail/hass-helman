from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
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

from custom_components.helman.solar_bias_correction import forecast_history  # noqa: E402
from custom_components.helman.solar_bias_correction.models import BiasConfig  # noqa: E402


def test_expand_to_15min_uses_watts_weighting():
    hourly = {"07:00": 1000.0}
    watts = {"07:00": 0.0, "07:15": 600.0, "07:30": 200.0, "07:45": 200.0}

    result = forecast_history._expand_hourly_to_15min(hourly, watts)

    assert set(result) == {"07:00", "07:15", "07:30", "07:45"}
    assert result["07:00"] == 0.0
    assert result["07:15"] == 600.0
    assert result["07:30"] == 200.0
    assert result["07:45"] == 200.0
    assert abs(sum(result.values()) - 1000.0) < 1e-9


def test_expand_to_15min_falls_back_to_equal_split_when_watts_sum_zero():
    hourly = {"00:00": 0.0, "12:00": 800.0}
    watts = {
        "00:00": 0.0,
        "00:15": 0.0,
        "00:30": 0.0,
        "00:45": 0.0,
        "12:00": 0.0,
        "12:15": 0.0,
        "12:30": 0.0,
        "12:45": 0.0,
    }

    result = forecast_history._expand_hourly_to_15min(hourly, watts)

    assert result["00:00"] == 0.0
    assert result["00:15"] == 0.0
    assert result["12:00"] == 200.0
    assert result["12:15"] == 200.0
    assert result["12:30"] == 200.0
    assert result["12:45"] == 200.0


def test_expand_to_15min_skips_hours_missing_from_watts():
    hourly = {"07:00": 400.0, "08:00": 800.0}
    watts = {"07:00": 100.0, "07:15": 100.0, "07:30": 100.0, "07:45": 100.0}

    result = forecast_history._expand_hourly_to_15min(hourly, watts)

    assert set(result) == {"07:00", "07:15", "07:30", "07:45"}
    assert result["07:00"] == 100.0
    assert result["07:15"] == 100.0
    assert result["07:30"] == 100.0
    assert result["07:45"] == 100.0


class _FakeState:
    def __init__(self, state: str, last_updated: datetime) -> None:
        self.state = state
        self.last_updated = last_updated


class ForecastHistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_only_today_forecast_entity_for_historical_day(self) -> None:
        hass = SimpleNamespace()
        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=[
                "sensor.energy_production_today",
                "sensor.energy_production_tomorrow",
                "sensor.energy_production_d2",
            ],
            total_energy_entity_id=None,
        )
        later = datetime(2026, 3, 20, 0, 5, tzinfo=TZ)
        history = {
            "sensor.energy_production_today": [_FakeState("30.0", later)],
            "sensor.energy_production_tomorrow": [_FakeState("40.0", later)],
            "sensor.energy_production_d2": [_FakeState("50.0", later)],
        }

        async def _get_significant_states(hass_arg, start_time, end_time, **kwargs):
            if start_time.date() == datetime(2026, 3, 20, tzinfo=TZ).date():
                return history
            return {}

        with patch.object(
            forecast_history,
            "get_significant_states",
            AsyncMock(side_effect=_get_significant_states),
        ), patch.object(
            forecast_history,
            "load_historical_per_slot_forecast",
            new=AsyncMock(return_value={"12:00": 1.0}),
        ):
            samples = await forecast_history.load_trainer_samples(
                hass,
                cfg,
                datetime(2026, 3, 21, 12, 0, tzinfo=TZ),
            )

        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0].forecast_wh, 30000.0)

    async def test_ignores_midnight_boundary_state(self) -> None:
        hass = SimpleNamespace()
        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )
        midnight = datetime(2026, 3, 20, 0, 0, tzinfo=TZ)
        later = datetime(2026, 3, 20, 0, 5, tzinfo=TZ)
        history = {
            "sensor.energy_production_today": [
                _FakeState("1.0", midnight),
                _FakeState("2.0", later),
            ]
        }

        async def _get_significant_states(hass_arg, start_time, end_time, **kwargs):
            if start_time.date() == datetime(2026, 3, 20, tzinfo=TZ).date():
                return history
            return {}

        with patch.object(
            forecast_history,
            "get_significant_states",
            AsyncMock(side_effect=_get_significant_states),
        ), patch.object(
            forecast_history,
            "load_historical_per_slot_forecast",
            new=AsyncMock(return_value={"12:00": 1.0}),
        ):
            samples = await forecast_history.load_trainer_samples(
                hass,
                cfg,
                datetime(2026, 3, 21, 12, 0, tzinfo=TZ),
            )

        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0].forecast_wh, 2000.0)

    async def test_load_trainer_samples_uses_configured_max_training_window_days(self) -> None:
        hass = SimpleNamespace()
        cfg = BiasConfig(
            enabled=True,
            min_history_days=2,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
            max_training_window_days=2,
        )

        with patch.object(
            forecast_history,
            "_read_day_forecast_wh",
            new=AsyncMock(side_effect=[1000.0, 2000.0]),
        ) as read_day_forecast_wh, patch.object(
            forecast_history,
            "load_historical_per_slot_forecast",
            new=AsyncMock(side_effect=[{"12:00": 1.0}, {"12:00": 2.0}]),
        ):
            samples = await forecast_history.load_trainer_samples(
                hass,
                cfg,
                datetime(2026, 3, 21, 12, 0, tzinfo=TZ),
            )

        self.assertEqual(
            [sample.date for sample in samples],
            ["2026-03-19", "2026-03-20"],
        )
        self.assertEqual(read_day_forecast_wh.await_count, 2)


class LoadHistoricalPerSlotForecastTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_15min_keys_when_watts_attribute_present(self):
        from datetime import date as date_cls

        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )

        target_date = date_cls(2026, 4, 15)
        local_now = datetime(2026, 4, 25, 10, 0, tzinfo=TZ)

        wh_period = {
            "2026-04-15T07:00:00+00:00": 1000.0,
            "2026-04-15T08:00:00+00:00": 2400.0,
        }
        watts = {
            "2026-04-15T07:00:00+00:00": 0.0,
            "2026-04-15T07:15:00+00:00": 600.0,
            "2026-04-15T07:30:00+00:00": 200.0,
            "2026-04-15T07:45:00+00:00": 200.0,
            "2026-04-15T08:00:00+00:00": 300.0,
            "2026-04-15T08:15:00+00:00": 400.0,
            "2026-04-15T08:30:00+00:00": 800.0,
            "2026-04-15T08:45:00+00:00": 900.0,
        }

        historical_state = SimpleNamespace(
            state="3400",
            attributes={"wh_period": wh_period, "watts": watts},
            last_updated=datetime(2026, 4, 15, 0, 5, tzinfo=TZ),
            last_changed=datetime(2026, 4, 15, 0, 5, tzinfo=TZ),
        )

        async def fake_history(*args, **kwargs):
            return {"sensor.energy_production_today": [historical_state]}

        with patch.object(
            forecast_history,
            "_read_history_for_entities_with_attributes",
            new=AsyncMock(side_effect=fake_history),
        ):
            result = await forecast_history.load_historical_per_slot_forecast(
                hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
                cfg=cfg,
                target_date=target_date,
                local_now=local_now,
            )

        assert result == {
            "07:00": 0.0,
            "07:15": 600.0,
            "07:30": 200.0,
            "07:45": 200.0,
            "08:00": 300.0,
            "08:15": 400.0,
            "08:30": 800.0,
            "08:45": 900.0,
        }

    async def test_returns_none_when_watts_attribute_missing(self):
        from datetime import date as date_cls

        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )

        target_date = date_cls(2026, 4, 15)
        local_now = datetime(2026, 4, 25, 10, 0, tzinfo=TZ)

        wh_period = {
            "2026-04-15T11:00:00+00:00": 7000.0,
            "2026-04-15T12:00:00+00:00": 9000.0,
            "2026-04-15T13:00:00+00:00": 8500.0,
        }
        historical_state = SimpleNamespace(
            state="24500",
            attributes={"wh_period": wh_period},
            last_updated=datetime(2026, 4, 15, 0, 5, tzinfo=TZ),
            last_changed=datetime(2026, 4, 15, 0, 5, tzinfo=TZ),
        )

        async def fake_history(*args, **kwargs):
            return {"sensor.energy_production_today": [historical_state]}

        with patch.object(
            forecast_history, "_read_history_for_entities_with_attributes", new=AsyncMock(side_effect=fake_history)
        ):
            result = await forecast_history.load_historical_per_slot_forecast(
                hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
                cfg=cfg,
                target_date=target_date,
                local_now=local_now,
            )

        assert result is None

    async def test_returns_none_when_state_missing(self):
        from datetime import date as date_cls

        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )

        async def fake_history(*args, **kwargs):
            return {"sensor.energy_production_today": []}

        with patch.object(
            forecast_history, "_read_history_for_entities_with_attributes", new=AsyncMock(side_effect=fake_history)
        ):
            result = await forecast_history.load_historical_per_slot_forecast(
                hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
                cfg=cfg,
                target_date=date_cls(2026, 4, 15),
                local_now=datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        assert result is None

    async def test_returns_none_when_no_entity_configured(self):
        from datetime import date as date_cls

        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=[],
            total_energy_entity_id=None,
        )

        result = await forecast_history.load_historical_per_slot_forecast(
            hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
            cfg=cfg,
            target_date=date_cls(2026, 4, 15),
            local_now=datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
        )

        assert result is None


class LoadTrainerSamplesTests(unittest.IsolatedAsyncioTestCase):
    async def test_samples_carry_per_slot_forecast(self):
        cfg = BiasConfig(
            enabled=True,
            min_history_days=2,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )

        async def fake_total(hass, entity_ids, target_date, *, local_now):
            return 60000.0 if str(target_date) in {"2026-04-23", "2026-04-24"} else None

        async def fake_per_slot(hass, c, target_date, *, local_now):
            return {"12:00": 9000.0, "13:00": 9100.0}

        with patch.object(
            forecast_history, "_read_day_forecast_wh", new=AsyncMock(side_effect=fake_total)
        ), patch.object(
            forecast_history,
            "load_historical_per_slot_forecast",
            new=AsyncMock(side_effect=fake_per_slot),
        ):
            samples = await forecast_history.load_trainer_samples(
                hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
                cfg=cfg,
                now=datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        dates = [s.date for s in samples]
        assert "2026-04-23" in dates
        assert "2026-04-24" in dates
        for s in samples:
            assert s.slot_forecast_wh == {"12:00": 9000.0, "13:00": 9100.0}

    async def test_sample_dropped_when_per_slot_forecast_missing(self):
        cfg = BiasConfig(
            enabled=True,
            min_history_days=2,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )

        async def fake_total(hass, entity_ids, target_date, *, local_now):
            return 60000.0

        async def fake_per_slot(hass, c, target_date, *, local_now):
            return None  # recorder retention exhausted

        with patch.object(
            forecast_history, "_read_day_forecast_wh", new=AsyncMock(side_effect=fake_total)
        ), patch.object(
            forecast_history,
            "load_historical_per_slot_forecast",
            new=AsyncMock(side_effect=fake_per_slot),
        ):
            samples = await forecast_history.load_trainer_samples(
                hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
                cfg=cfg,
                now=datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        assert samples == []


def test_select_first_state_for_window_includes_midnight_boundary():
    from datetime import timedelta, timezone
    midnight_utc = datetime(2026, 4, 24, 22, 0, 0, tzinfo=timezone.utc)  # midnight Prague (UTC+2)

    class _State:
        def __init__(self, ts):
            self.last_updated = ts

    before = _State(midnight_utc - timedelta(seconds=1))
    at_midnight = _State(midnight_utc)
    after = _State(midnight_utc + timedelta(seconds=1))

    result = forecast_history._select_first_state_for_window(
        [before, at_midnight, after], after=midnight_utc
    )
    assert result is at_midnight


if __name__ == "__main__":
    unittest.main()
