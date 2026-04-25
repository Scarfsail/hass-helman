from typing import Any
import importlib
import sys
import types
import pathlib


def setup_package_stubs():
    repo_root = pathlib.Path(__file__).resolve().parents[1]
    custom_components_dir = repo_root / "custom_components"
    helman_dir = custom_components_dir / "helman"

    # custom_components package stub
    if "custom_components" not in sys.modules:
        pkg = types.ModuleType("custom_components")
        pkg.__path__ = [str(custom_components_dir)]
        sys.modules["custom_components"] = pkg

    # custom_components.helman package stub
    if "custom_components.helman" not in sys.modules:
        pkg = types.ModuleType("custom_components.helman")
        pkg.__path__ = [str(helman_dir)]
        sys.modules["custom_components.helman"] = pkg


setup_package_stubs()

from custom_components.helman.solar_bias_correction.models import (
    BiasConfig,
    read_bias_config,
)


def test_defaults_empty_config():
    import custom_components.helman.const as const

    config: dict[str, Any] = {}
    bias = read_bias_config(config)
    assert isinstance(bias, BiasConfig)
    assert bias.enabled == const.SOLAR_BIAS_DEFAULT_ENABLED
    assert bias.min_history_days == const.SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS
    assert bias.training_time == const.SOLAR_BIAS_DEFAULT_TRAINING_TIME
    assert bias.clamp_min == const.SOLAR_BIAS_DEFAULT_CLAMP_MIN
    assert bias.clamp_max == const.SOLAR_BIAS_DEFAULT_CLAMP_MAX
    assert bias.daily_energy_entity_ids == []
    assert bias.total_energy_entity_id is None


def test_read_nested_config():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {
                        "enabled": False,
                        "min_history_days": 5,
                        "training_time": "04:00",
                        "clamp_min": 0.5,
                        "clamp_max": 1.5,
                    },
                    "daily_energy_entity_ids": ["sensor.daily1", "sensor.daily2"],
                    "total_energy_entity_id": "sensor.total",
                }
            }
        }
    }

    bias = read_bias_config(config)
    assert bias.enabled is False
    assert bias.min_history_days == 5
    assert bias.training_time == "04:00"
    assert bias.clamp_min == 0.5
    assert bias.clamp_max == 1.5
    assert bias.daily_energy_entity_ids == ["sensor.daily1", "sensor.daily2"]
    assert bias.total_energy_entity_id == "sensor.total"


def test_reads_total_energy_entity_from_bias_correction_config():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {
                        "total_energy_entity_id": "sensor.bias_total",
                    },
                    "daily_energy_entity_ids": ["sensor.daily1"],
                }
            }
        }
    }

    bias = read_bias_config(config)

    assert bias.total_energy_entity_id == "sensor.bias_total"


def test_trainer_sample_has_slot_forecast_wh_field():
    from custom_components.helman.solar_bias_correction.models import TrainerSample

    sample = TrainerSample(
        date="2026-04-15",
        forecast_wh=60000.0,
        slot_forecast_wh={"12:00": 9000.0, "13:00": 9100.0},
    )
    assert sample.slot_forecast_wh == {"12:00": 9000.0, "13:00": 9100.0}
    assert sample.forecast_wh == 60000.0
