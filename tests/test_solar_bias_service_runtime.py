from __future__ import annotations

import asyncio
import importlib
import inspect
import sys
import types
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


if "custom_components" not in sys.modules:
    pkg = types.ModuleType("custom_components")
    pkg.__path__ = [str(ROOT / "custom_components")]
    sys.modules["custom_components"] = pkg

if "custom_components.helman" not in sys.modules:
    pkg = types.ModuleType("custom_components.helman")
    pkg.__path__ = [str(ROOT / "custom_components" / "helman")]
    sys.modules["custom_components.helman"] = pkg

if "homeassistant" not in sys.modules:
    sys.modules["homeassistant"] = types.ModuleType("homeassistant")

core_mod = types.ModuleType("homeassistant.core")
core_mod.HomeAssistant = type("HomeAssistant", (), {})
sys.modules["homeassistant.core"] = core_mod

util_mod = types.ModuleType("homeassistant.util")
sys.modules["homeassistant.util"] = util_mod

dt_mod = types.ModuleType("homeassistant.util.dt")
dt_mod.now = lambda: None
dt_mod.as_local = lambda value: value
sys.modules["homeassistant.util.dt"] = dt_mod

helpers_mod = types.ModuleType("homeassistant.helpers")
sys.modules["homeassistant.helpers"] = helpers_mod

event_mod = types.ModuleType("homeassistant.helpers.event")
event_mod.async_track_time_change = lambda hass, callback, **kwargs: lambda: None
sys.modules["homeassistant.helpers.event"] = event_mod

actuals_mod = types.ModuleType("custom_components.helman.solar_bias_correction.actuals")
async def _load_actuals_window(*args, **kwargs):
    return None
actuals_mod.load_actuals_window = _load_actuals_window
sys.modules[actuals_mod.__name__] = actuals_mod

forecast_history_mod = types.ModuleType("custom_components.helman.solar_bias_correction.forecast_history")
async def _load_trainer_samples(*args, **kwargs):
    return []
forecast_history_mod.load_trainer_samples = _load_trainer_samples
sys.modules[forecast_history_mod.__name__] = forecast_history_mod


models = importlib.import_module("custom_components.helman.solar_bias_correction.models")
service_mod = importlib.import_module("custom_components.helman.solar_bias_correction.service")
scheduler_mod = importlib.import_module("custom_components.helman.solar_bias_correction.scheduler")


class _DummyStore:
    profile = None

    async def async_save(self, payload):
        self.saved = payload


def _make_cfg() -> models.BiasConfig:
    return models.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        daily_energy_entity_ids=[],
        total_energy_entity_id=None,
    )


def test_training_failed_with_preserved_profile_keeps_adjusted_variant():
    service = service_mod.SolarBiasCorrectionService(
        SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
        _DummyStore(),
        _make_cfg(),
    )
    service._profile = models.SolarBiasProfile(factors={"12:00": 2.0}, omitted_slots=[])
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-24T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=2.0,
        factor_max=2.0,
        factor_median=2.0,
        omitted_slot_count=0,
        last_outcome="training_failed",
        error_reason="boom",
    )

    result = service.build_adjustment_result(
        [{"timestamp": "2026-04-24T12:00:00+02:00", "value": 10.0}],
        None,
    )

    assert result.status == "training_failed"
    assert result.effective_variant == "adjusted"
    assert result.adjusted_points[0]["value"] == 20.0
    assert result.explainability.error == "boom"


def test_training_failed_without_profile_falls_back_to_raw():
    service = service_mod.SolarBiasCorrectionService(
        SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
        _DummyStore(),
        _make_cfg(),
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-24T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=0,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=0,
        last_outcome="training_failed",
        error_reason="boom",
    )

    result = service.build_adjustment_result(
        [{"timestamp": "2026-04-24T12:00:00+02:00", "value": 10.0}],
        None,
    )

    assert result.status == "training_failed"
    assert result.effective_variant == "raw"
    assert result.adjusted_points[0]["value"] == 10.0


def test_scheduler_registers_sync_callback_that_schedules_training():
    captured: dict[str, object] = {}

    async def _training_callback():
        captured["ran"] = True

    def _track_time_change(hass, callback, **kwargs):
        captured["callback"] = callback
        captured["kwargs"] = kwargs
        return lambda: None

    scheduler_mod.async_track_time_change = _track_time_change

    created = []

    def _create_task(coro):
        created.append(coro)
        return SimpleNamespace()

    scheduler = scheduler_mod.SolarBiasTrainingScheduler(
        SimpleNamespace(async_create_task=_create_task),
        _training_callback,
    )

    scheduler.schedule("03:15")

    callback = captured["callback"]
    assert not inspect.iscoroutinefunction(callback)

    callback(None)
    assert len(created) == 1
    asyncio.run(created[0])
    assert captured["ran"] is True
