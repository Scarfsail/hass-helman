from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
from pathlib import Path

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
from custom_components.helman.solar_bias_correction.forecast_slot_history import (  # noqa: E402
    ForecastSlotWindow,
)
from custom_components.helman.solar_bias_correction.models import BiasConfig  # noqa: E402


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


class _Recorded:
    """Stands in for the spliced read `forecast_slot_history` performs.

    ``hourly`` names the days it serves from the statistics tail, which is what
    the sample carries through to the trainer as ``hourly_grain``.
    """

    def __init__(
        self,
        days: dict[str, dict[str, float]],
        hourly: set[str] | None = None,
    ) -> None:
        self._days = days
        self._hourly = hourly or set()
        self.windows: list[tuple[str, str]] = []

    async def __call__(self, hass, *, first_date, last_date):
        self.windows.append((str(first_date), str(last_date)))
        return ForecastSlotWindow(
            slots_by_date={
                day: dict(slots)
                for day, slots in self._days.items()
                if str(first_date) <= day <= str(last_date)
            },
            hourly_grain_dates=set(self._hourly),
        )


def _patch_window(recorded):
    return patch.object(
        forecast_history, "load_spliced_forecast_slots_for_window", new=recorded
    )


class LoadArchivedForecastPointsTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_day_comes_back_as_chronological_points(self):
        from datetime import date as date_cls

        async def _day(hass, target_date):
            assert str(target_date) == "2026-08-20"
            return {"07:15": 20.0, "07:00": 10.0}

        with patch.object(
            forecast_history, "load_forecast_slots_for_day", new=_day
        ):
            points = await forecast_history.load_archived_forecast_points(
                object(), date_cls(2026, 8, 20), TZ
            )

        assert points == [
            {"timestamp": "2026-08-20T07:00:00+00:00", "value": 10.0},
            {"timestamp": "2026-08-20T07:15:00+00:00", "value": 20.0},
        ]

    async def test_a_day_with_nothing_recorded_is_empty(self):
        from datetime import date as date_cls

        async def _day(hass, target_date):
            return {}

        with patch.object(
            forecast_history, "load_forecast_slots_for_day", new=_day
        ):
            assert (
                await forecast_history.load_archived_forecast_points(
                    object(), date_cls(2026, 8, 20), TZ
                )
                == []
            )


class LoadTrainerSamplesTests(unittest.IsolatedAsyncioTestCase):
    async def test_samples_carry_the_recorded_slots_and_their_sum(self):
        recorded = _Recorded(
            {
                "2026-04-23": {"12:00": 9000.0, "13:00": 9100.0},
                "2026-04-24": {"12:00": 8000.0, "13:00": 8100.0},
            }
        )
        with _patch_window(recorded):
            samples = await forecast_history.load_trainer_samples(
                object(),
                _cfg(min_history_days=2, max_training_window_days=2),
                datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        assert [s.date for s in samples] == ["2026-04-23", "2026-04-24"]
        assert samples[0].slot_forecast_wh == {"12:00": 9000.0, "13:00": 9100.0}
        # The day total is the recorded slots summed, not a second entity read.
        assert samples[0].forecast_wh == 18100.0

    async def test_the_whole_window_is_one_recorder_read(self):
        recorded = _Recorded({"2026-04-24": {"12:00": 100.0}})
        with _patch_window(recorded):
            await forecast_history.load_trainer_samples(
                object(),
                _cfg(max_training_window_days=30),
                datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        assert recorded.windows == [("2026-03-26", "2026-04-24")]

    async def test_a_day_with_nothing_recorded_yields_no_sample(self):
        recorded = _Recorded({"2026-04-24": {"12:00": 9000.0}})
        with _patch_window(recorded):
            samples = await forecast_history.load_trainer_samples(
                object(),
                _cfg(min_history_days=2, max_training_window_days=2),
                datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        assert [s.date for s in samples] == ["2026-04-24"]

    async def test_the_window_is_the_configured_length(self):
        recorded = _Recorded(
            {
                f"2026-04-{day}": {"12:00": 100.0}
                for day in ("20", "21", "22", "23", "24")
            }
        )
        with _patch_window(recorded):
            samples = await forecast_history.load_trainer_samples(
                object(),
                _cfg(min_history_days=2, max_training_window_days=2),
                datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        assert [s.date for s in samples] == ["2026-04-23", "2026-04-24"]


if __name__ == "__main__":
    unittest.main()
