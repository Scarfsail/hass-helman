from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

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


def _cfg(**overrides) -> BiasConfig:
    kwargs = dict(
        enabled=True,
        min_history_days=10,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        daily_energy_entity_ids=["sensor.energy_production_today"],
        total_energy_entity_id=None,
    )
    kwargs.update(overrides)
    return BiasConfig(**kwargs)


class _FakeStore:
    """Stands in for ``SolarForecastHistoryStore``: only ``slots_for_day`` is read."""

    def __init__(self, days: dict[str, dict[str, float]]) -> None:
        self._days = days

    def slots_for_day(self, target_date):
        return dict(self._days.get(str(target_date), {}))


def test_reads_the_fifteen_minute_series_when_published():
    result = forecast_history._read_per_slot_forecast(
        {
            "wh_period_15m": {
                "2026-08-20T07:00:00+00:00": 10.0,
                "2026-08-20T07:15:00+00:00": 20.0,
                "2026-08-20T07:30:00+00:00": 30.0,
                "2026-08-20T07:45:00+00:00": 40.0,
            },
            # Contradictory hourly data, to prove which source wins.
            "wh_period": {"2026-08-20T07:00:00+00:00": 4000.0},
            "watts": {
                "2026-08-20T07:00:00+00:00": 1.0,
                "2026-08-20T07:15:00+00:00": 1.0,
                "2026-08-20T07:30:00+00:00": 1.0,
                "2026-08-20T07:45:00+00:00": 1.0,
            },
        },
        TZ,
    )

    assert result == {"07:00": 10.0, "07:15": 20.0, "07:30": 30.0, "07:45": 40.0}


def test_uses_the_fifteen_minute_series_even_without_watts():
    """The old watts guard must not reject a series that needs no expansion."""
    result = forecast_history._read_per_slot_forecast(
        {
            "wh_period_15m": {
                "2026-08-20T07:00:00+00:00": 10.0,
                "2026-08-20T07:15:00+00:00": 20.0,
                "2026-08-20T07:30:00+00:00": 30.0,
                "2026-08-20T07:45:00+00:00": 40.0,
            }
        },
        TZ,
    )

    assert result == {"07:00": 10.0, "07:15": 20.0, "07:30": 30.0, "07:45": 40.0}


def test_ignores_a_fifteen_minute_series_that_does_not_cover_the_day():
    """A partial 15m map must not displace the full hourly series.

    Taken at face value it would become the whole day's forecast, and the
    trainer stretches its last slot to midnight -- weighing a full day of
    actuals against a sliver of forecast.
    """
    result = forecast_history._read_per_slot_forecast(
        {
            # Only two of hour 07's four slots.
            "wh_period_15m": {
                "2026-08-20T07:00:00+00:00": 10.0,
                "2026-08-20T07:15:00+00:00": 20.0,
            },
            "wh_period": {"2026-08-20T07:00:00+00:00": 4000.0},
            "watts": {
                "2026-08-20T07:00:00+00:00": 1.0,
                "2026-08-20T07:15:00+00:00": 1.0,
                "2026-08-20T07:30:00+00:00": 1.0,
                "2026-08-20T07:45:00+00:00": 1.0,
            },
        },
        TZ,
    )

    assert result == {
        "07:00": 1000.0,
        "07:15": 1000.0,
        "07:30": 1000.0,
        "07:45": 1000.0,
    }


def test_returns_nothing_when_only_the_hourly_series_is_published():
    result = forecast_history._read_per_slot_forecast(
        {
            "wh_period": {
                "2026-04-15T11:00:00+00:00": 7000.0,
                "2026-04-15T12:00:00+00:00": 9000.0,
            }
        },
        TZ,
    )

    assert result == {}


class LoadForecastPointsForDayTests(unittest.IsolatedAsyncioTestCase):
    """The inspector's forecast curve: live for today, archived for the past."""

    async def test_today_comes_from_the_live_entity(self):
        from datetime import date as date_cls

        state = SimpleNamespace(
            attributes={
                "wh_period_15m": {
                    "2026-08-25T07:00:00+00:00": 10.0,
                    "2026-08-25T07:15:00+00:00": 20.0,
                    "2026-08-25T07:30:00+00:00": 30.0,
                    "2026-08-25T07:45:00+00:00": 40.0,
                }
            }
        )
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="UTC"),
            states=SimpleNamespace(get=lambda entity_id: state),
        )

        points = await forecast_history.load_forecast_points_for_day(
            hass,
            _cfg(),
            date_cls(2026, 8, 25),
            local_now=datetime(2026, 8, 25, 10, 0, tzinfo=TZ),
            store=_FakeStore({"2026-08-25": {"07:00": 999.0}}),
        )

        assert [point["value"] for point in points] == [10.0, 20.0, 30.0, 40.0]

    async def test_a_past_day_comes_from_the_archive(self):
        """What the fit was computed from, not the entity's present revision."""
        from datetime import date as date_cls

        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="UTC"),
            states=SimpleNamespace(
                get=lambda entity_id: (_ for _ in ()).throw(
                    AssertionError("a past day must not read the live entity")
                )
            ),
        )

        points = await forecast_history.load_forecast_points_for_day(
            hass,
            _cfg(),
            date_cls(2026, 8, 20),
            local_now=datetime(2026, 8, 25, 10, 0, tzinfo=TZ),
            store=_FakeStore({"2026-08-20": {"07:15": 20.0, "07:00": 10.0}}),
        )

        assert points == [
            {"timestamp": "2026-08-20T07:00:00+00:00", "value": 10.0},
            {"timestamp": "2026-08-20T07:15:00+00:00", "value": 20.0},
        ]

    async def test_a_past_day_with_nothing_archived_draws_nothing(self):
        from datetime import date as date_cls

        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="UTC"),
            states=SimpleNamespace(get=lambda entity_id: None),
        )

        points = await forecast_history.load_forecast_points_for_day(
            hass,
            _cfg(),
            date_cls(2026, 8, 20),
            local_now=datetime(2026, 8, 25, 10, 0, tzinfo=TZ),
            store=_FakeStore({}),
        )

        assert points == []


class LoadTrainerSamplesTests(unittest.TestCase):
    def test_samples_carry_the_archived_slots_and_their_sum(self):
        store = _FakeStore(
            {
                "2026-04-23": {"12:00": 9000.0, "13:00": 9100.0},
                "2026-04-24": {"12:00": 8000.0, "13:00": 8100.0},
            }
        )

        samples = forecast_history.load_trainer_samples(
            store,
            _cfg(min_history_days=2, max_training_window_days=2),
            datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
        )

        assert [s.date for s in samples] == ["2026-04-23", "2026-04-24"]
        assert samples[0].slot_forecast_wh == {"12:00": 9000.0, "13:00": 9100.0}
        # The day total is the archived slots summed, not a second entity read.
        assert samples[0].forecast_wh == 18100.0

    def test_a_day_with_nothing_archived_yields_no_sample(self):
        store = _FakeStore({"2026-04-24": {"12:00": 9000.0}})

        samples = forecast_history.load_trainer_samples(
            store,
            _cfg(min_history_days=2, max_training_window_days=2),
            datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
        )

        assert [s.date for s in samples] == ["2026-04-24"]

    def test_the_window_is_the_configured_length(self):
        store = _FakeStore(
            {
                f"2026-04-{day}": {"12:00": 100.0}
                for day in ("20", "21", "22", "23", "24")
            }
        )

        samples = forecast_history.load_trainer_samples(
            store,
            _cfg(min_history_days=2, max_training_window_days=2),
            datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
        )

        assert [s.date for s in samples] == ["2026-04-23", "2026-04-24"]

    def test_no_store_means_no_samples(self):
        samples = forecast_history.load_trainer_samples(
            None,
            _cfg(),
            datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
        )

        assert samples == []


if __name__ == "__main__":
    unittest.main()
