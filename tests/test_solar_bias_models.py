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
    assert (
        bias.max_training_window_days
        == const.SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS
    )
    assert bias.training_time == const.SOLAR_BIAS_DEFAULT_TRAINING_TIME
    assert bias.clamp_min == const.SOLAR_BIAS_DEFAULT_CLAMP_MIN
    assert bias.clamp_max == const.SOLAR_BIAS_DEFAULT_CLAMP_MAX
    assert bias.min_valid_slot_days == const.SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS
    assert bias.aggregation_method == const.SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD
    assert bias.source_config_entry_id is None
    assert bias.total_energy_entity_id is None


def test_read_nested_config():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {
                        "enabled": False,
                        "min_history_days": 5,
                        "max_training_window_days": 45,
                        "training_time": "04:00",
                        "clamp_min": 0.5,
                        "clamp_max": 1.5,
                        "min_valid_slot_days": 7,
                    },
                    "source_config_entry_id": "provider-entry",
                }
            }
        }
    }

    bias = read_bias_config(config)
    assert bias.enabled is False
    assert bias.min_history_days == 5
    assert bias.max_training_window_days == 45
    assert bias.training_time == "04:00"
    assert bias.clamp_min == 0.5
    assert bias.clamp_max == 1.5
    assert bias.min_valid_slot_days == 7
    assert bias.source_config_entry_id == "provider-entry"
    assert bias.total_energy_entity_id is None


def test_reads_total_energy_entity_from_bias_correction_config():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {
                        "total_energy_entity_id": "sensor.bias_total",
                    },
                    "source_config_entry_id": "provider-entry",
                }
            }
        }
    }

    bias = read_bias_config(config)

    assert bias.total_energy_entity_id == "sensor.bias_total"


def test_legacy_training_window_days_is_still_accepted_as_fallback():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {
                        "training_window_days": 30,
                    },
                }
            }
        }
    }

    bias = read_bias_config(config)

    assert bias.max_training_window_days == 30


def test_slot_invalidation_fields_default_to_none_when_absent():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {},
                }
            }
        }
    }

    bias = read_bias_config(config)

    assert bias.slot_invalidation_max_battery_soc_percent is None
    assert bias.slot_invalidation_export_enabled_entity_id is None


def test_slot_invalidation_fields_are_parsed_when_present():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {
                        "slot_invalidation": {
                            "max_battery_soc_percent": 87,
                            "export_enabled_entity_id": "  switch.export_enabled  ",
                        }
                    },
                }
            }
        }
    }

    bias = read_bias_config(config)

    assert bias.slot_invalidation_max_battery_soc_percent == 87.0
    assert (
        bias.slot_invalidation_export_enabled_entity_id
        == "switch.export_enabled"
    )


def test_trainer_sample_has_slot_forecast_wh_field():
    from custom_components.helman.solar_bias_correction.models import TrainerSample

    sample = TrainerSample(
        date="2026-04-15",
        forecast_wh=60000.0,
        slot_forecast_wh={"12:00": 9000.0, "13:00": 9100.0},
    )
    assert sample.slot_forecast_wh == {"12:00": 9000.0, "13:00": 9100.0}
    assert sample.forecast_wh == 60000.0


def test_solar_actuals_window_has_invalidated_slots_by_date_field():
    from custom_components.helman.solar_bias_correction.models import SolarActualsWindow

    window = SolarActualsWindow(
        slot_actuals_by_date={"2026-04-15": {"12:00": 1000.0}},
        invalidated_slots_by_date={"2026-04-15": {"12:00", "13:00"}},
    )

    assert window.invalidated_slots_by_date == {"2026-04-15": {"12:00", "13:00"}}


def test_solar_actuals_window_invalidated_slots_by_date_defaults_empty():
    from custom_components.helman.solar_bias_correction.models import SolarActualsWindow

    window = SolarActualsWindow(slot_actuals_by_date={})

    assert window.invalidated_slots_by_date == {}


def test_solar_bias_metadata_has_invalidation_fields_by_default():
    from custom_components.helman.solar_bias_correction.models import SolarBiasMetadata

    metadata = SolarBiasMetadata(
        trained_at="2026-04-15T03:00:00+00:00",
        training_config_fingerprint="abc123",
        usable_days=5,
        dropped_days=[],
        factor_min=0.9,
        factor_max=1.1,
        factor_median=1.0,
        omitted_slot_count=0,
        last_outcome="success",
    )

    assert metadata.invalidated_slots_by_date == {}
    assert metadata.invalidated_slot_count == 0


def test_inspector_day_to_payload_includes_invalidated_series():
    from custom_components.helman.solar_bias_correction.models import (
        SolarBiasInspectorAvailability,
        SolarBiasInspectorDay,
        SolarBiasInspectorPoint,
        SolarBiasInspectorSeries,
        SolarBiasInspectorTotals,
        inspector_day_to_payload,
    )

    day = SolarBiasInspectorDay(
        date="2026-04-15",
        timezone="UTC",
        status="ready",
        effective_variant="corrected",
        trained_at="2026-04-15T03:00:00+00:00",
        min_date="2026-04-01",
        max_date="2026-04-30",
        series=SolarBiasInspectorSeries(
            raw=[],
            corrected=[],
            actual=[],
            invalidated=[
                SolarBiasInspectorPoint(
                    timestamp="2026-04-15T12:00:00+00:00",
                    value_wh=1200.0,
                )
            ],
            factors=[],
        ),
        totals=SolarBiasInspectorTotals(
            raw_wh=10000.0,
            corrected_wh=9000.0,
            actual_wh=9500.0,
        ),
        availability=SolarBiasInspectorAvailability(
            has_raw_forecast=True,
            has_corrected_forecast=True,
            has_actuals=True,
            has_profile=True,
            has_invalidated=True,
        ),
        is_today=False,
        is_future=False,
    )

    payload = inspector_day_to_payload(day)

    assert payload["series"]["invalidated"] == [
        {
            "timestamp": "2026-04-15T12:00:00+00:00",
            "valueWh": 1200.0,
        }
    ]
    assert payload["availability"]["hasInvalidated"] is True


def test_read_bias_config_passes_explicit_aggregation_method():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {
                        "aggregation_method": "trimmed_mean",
                    },
                }
            }
        }
    }

    bias = read_bias_config(config)

    assert bias.aggregation_method == "trimmed_mean"


def test_read_bias_config_reads_source_config_entry_id():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "source_config_entry_id": " provider-entry ",
                }
            }
        }
    }

    bias = read_bias_config(config)

    assert bias.source_config_entry_id == "provider-entry"


def test_read_bias_config_normalizes_blank_or_non_string_source_config_entry_id():
    blank_config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "source_config_entry_id": "  ",
                }
            }
        }
    }
    non_string_config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "source_config_entry_id": 123,
                }
            }
        }
    }

    assert read_bias_config(blank_config).source_config_entry_id is None
    assert read_bias_config(non_string_config).source_config_entry_id is None
