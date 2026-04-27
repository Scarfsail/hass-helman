from __future__ import annotations

import unittest

# Import the existing test helpers which install import stubs and provide _valid_config
from test_config_validation import _valid_config, _install_import_stubs

_install_import_stubs()

from custom_components.helman.config_validation import validate_config_document


class SolarBiasConfigValidationTests(unittest.TestCase):
    def test_valid_full_config_passes(self) -> None:
        config = _valid_config()
        config.setdefault("power_devices", {}).setdefault("solar", {}).setdefault(
            "forecast", {}
        )["bias_correction"] = {
            "enabled": True,
            "min_history_days": 10,
            "max_training_window_days": 90,
            "training_time": "03:00",
            "clamp_min": 0.1,
            "clamp_max": 5.0,
        }

        report = validate_config_document(config)
        self.assertTrue(report.valid)

    def test_enabled_must_be_bool(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "enabled": "yes",
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.enabled"
                for issue in report.errors
            )
        )

    def test_min_history_days_invalid_when_zero(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "min_history_days": 0,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.min_history_days"
                for issue in report.errors
            )
        )

    def test_min_history_days_invalid_when_too_large(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "min_history_days": 366,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.min_history_days"
                for issue in report.errors
            )
        )

    def test_training_time_invalid_for_bad_string(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "training_time": "3am",
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.training_time"
                for issue in report.errors
            )
        )

    def test_max_training_window_days_invalid_when_zero(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "max_training_window_days": 0,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.max_training_window_days"
                for issue in report.errors
            )
        )

    def test_max_training_window_days_invalid_when_too_large(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "max_training_window_days": 366,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.max_training_window_days"
                for issue in report.errors
            )
        )

    def test_legacy_training_window_days_invalid_when_zero(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "training_window_days": 0,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.training_window_days"
                for issue in report.errors
            )
        )

    def test_training_time_valid_for_hhmm(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "training_time": "03:00",
        }

        report = validate_config_document(config)
        self.assertTrue(report.valid)

    def test_clamp_min_invalid_when_zero(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "clamp_min": 0.0,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.clamp_min"
                for issue in report.errors
            )
        )

    def test_clamp_max_invalid_when_too_large(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "clamp_max": 11.0,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.clamp_max"
                for issue in report.errors
            )
        )

    def test_clamp_min_must_be_less_than_clamp_max(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "clamp_min": 1.0,
            "clamp_max": 1.0,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path.startswith("power_devices.solar.forecast.bias_correction")
                for issue in report.errors
            )
        )

    def test_absence_of_bias_correction_is_valid(self) -> None:
        config = _valid_config()
        # ensure solar forecast has no bias_correction
        config["power_devices"]["solar"]["forecast"].pop("bias_correction", None)

        report = validate_config_document(config)
        self.assertTrue(report.valid)

    def test_valid_slot_invalidation_config_passes(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
                "export_enabled_entity_id": "switch.export_enabled",
            }
        }

        report = validate_config_document(config)

        self.assertTrue(report.valid)

    def test_slot_invalidation_rejects_partial_config_when_soc_missing(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "slot_invalidation": {
                "export_enabled_entity_id": "switch.export_enabled",
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "power_devices.solar.forecast.bias_correction.slot_invalidation"
                and issue.code == "incomplete_slot_invalidation"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_rejects_partial_config_when_export_entity_missing(
        self,
    ) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "power_devices.solar.forecast.bias_correction.slot_invalidation"
                and issue.code == "incomplete_slot_invalidation"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_rejects_bool_soc_type(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": True,
                "export_enabled_entity_id": "switch.export_enabled",
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "power_devices.solar.forecast.bias_correction.slot_invalidation.max_battery_soc_percent"
                and issue.code == "invalid_type"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_rejects_soc_out_of_range(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 0,
                "export_enabled_entity_id": "switch.export_enabled",
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "power_devices.solar.forecast.bias_correction.slot_invalidation.max_battery_soc_percent"
                and issue.code == "invalid_range"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_rejects_malformed_export_enabled_entity_id(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
                "export_enabled_entity_id": "bad entity id",
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "power_devices.solar.forecast.bias_correction.slot_invalidation.export_enabled_entity_id"
                and issue.code == "invalid_entity_id"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_requires_battery_capacity_entity(self) -> None:
        config = _valid_config()
        config["power_devices"]["battery"]["entities"]["capacity"] = "   "
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
                "export_enabled_entity_id": "switch.export_enabled",
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "power_devices.solar.forecast.bias_correction.slot_invalidation"
                and issue.code == "missing_prerequisite"
                for issue in report.errors
            )
        )


    def test_aggregation_method_invalid_type_rejected(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "aggregation_method": 42,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.aggregation_method"
                and issue.code == "invalid_type"
                for issue in report.errors
            )
        )

    def test_aggregation_method_unknown_value_rejected(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "aggregation_method": "mean_of_ratios",
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.bias_correction.aggregation_method"
                and issue.code == "invalid_choice"
                for issue in report.errors
            )
        )

    def test_aggregation_method_valid_values_accepted(self) -> None:
        for method in ("ratio_of_sums", "trimmed_mean"):
            with self.subTest(method=method):
                config = _valid_config()
                config["power_devices"]["solar"]["forecast"]["bias_correction"] = {
                    "aggregation_method": method,
                }

                report = validate_config_document(config)
                self.assertTrue(report.valid)


if __name__ == "__main__":
    unittest.main()
