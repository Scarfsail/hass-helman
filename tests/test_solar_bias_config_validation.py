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


if __name__ == "__main__":
    unittest.main()
