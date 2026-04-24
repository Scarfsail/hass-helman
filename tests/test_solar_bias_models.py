from typing import Any
import importlib.util
import pathlib


def load_const():
    repo_root = pathlib.Path(__file__).resolve().parents[3]
    const_path = repo_root / "custom_components" / "helman" / "const.py"
    spec = importlib.util.spec_from_file_location("helman_const", str(const_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore
    return module


def load_models():
    worktree_root = pathlib.Path(__file__).resolve().parents[1]
    models_path = (
        worktree_root
        / "custom_components"
        / "helman"
        / "solar_bias_correction"
        / "models.py"
    )
    spec = importlib.util.spec_from_file_location("solar_bias_models", str(models_path))
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)  # type: ignore
    return module


def test_defaults_empty_config():
    const = load_const()
    models = load_models()
    BiasConfig = models.BiasConfig
    read_bias_config = models.read_bias_config

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
    models = load_models()
    read_bias_config = models.read_bias_config

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
