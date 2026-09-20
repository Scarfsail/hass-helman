from __future__ import annotations

import unittest

# Import the existing test helpers which install import stubs and provide _valid_config
from test_config_validation import _valid_config, _install_import_stubs

_install_import_stubs()

from custom_components.helman.config_validation import validate_config_document


class SolarBiasConfigValidationTests(unittest.TestCase):
    def test_valid_full_config_passes(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "min_history_days": 10,
            "max_training_window_days": 90,
            "enabled": True,
            "clamp_min": 0.1,
            "clamp_max": 5.0,
        }

        report = validate_config_document(config)
        self.assertTrue(report.valid)

    def test_enabled_must_be_bool(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "enabled": "yes",
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.enabled"
                for issue in report.errors
            )
        )

    def test_a_minimum_above_the_max_training_window_is_refused(self) -> None:
        # The solar floor is judged against *usable* days, which can only ever
        # be fewer than the window fetched -- so a minimum above the window is
        # unreachable and would omit every slot on every run.
        config = _valid_config()
        config["training"] = {
            "solar_bias": {"min_history_days": 120, "max_training_window_days": 90}
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.min_history_days"
                and issue.code == "invalid_relation"
                for issue in report.errors
            )
        )

    def test_min_history_days_invalid_when_zero(self) -> None:
        config = _valid_config()
        config["training"] = {"solar_bias": {"min_history_days": 0}}

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.min_history_days"
                and issue.code == "invalid_range"
                for issue in report.errors
            )
        )

    def test_min_history_days_invalid_when_too_large(self) -> None:
        config = _valid_config()
        config["training"] = {"solar_bias": {"min_history_days": 366}}

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.min_history_days"
                and issue.code == "invalid_range"
                for issue in report.errors
            )
        )

    def test_max_training_window_days_invalid_when_zero(self) -> None:
        config = _valid_config()
        config["training"] = {"solar_bias": {"max_training_window_days": 0}}

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.max_training_window_days"
                and issue.code == "invalid_range"
                for issue in report.errors
            )
        )

    def test_max_training_window_days_invalid_when_too_large(self) -> None:
        config = _valid_config()
        config["training"] = {"solar_bias": {"max_training_window_days": 366}}

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.max_training_window_days"
                and issue.code == "invalid_range"
                for issue in report.errors
            )
        )

    def test_min_valid_slot_days_invalid_when_zero(self) -> None:
        config = _valid_config()
        config["training"] = {"solar_bias": {"min_valid_slot_days": 0}}

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.min_valid_slot_days"
                and issue.code == "invalid_range"
                for issue in report.errors
            )
        )

    def test_min_valid_slot_days_valid_when_positive(self) -> None:
        config = _valid_config()
        config["training"] = {"solar_bias": {"min_valid_slot_days": 5}}

        report = validate_config_document(config)
        self.assertTrue(report.valid)

    def test_the_relocated_bias_correction_block_is_refused(self) -> None:
        """Load migrates (see ``_migrate_v18_to_v19``); save refuses.

        The whole block moved into ``training.solar_bias``, so any
        ``bias_correction`` key -- the day-count keys that left it in v14
        included -- is refused as one relocated block.
        """
        for block in ({"enabled": True}, {"min_history_days": 10}, {}):
            with self.subTest(block=block):
                config = _valid_config()
                config["power_devices"]["solar"]["forecast"]["bias_correction"] = block

                report = validate_config_document(config)
                self.assertFalse(report.valid)
                self.assertEqual(
                    [
                        (issue.path, issue.code)
                        for issue in report.errors
                        if "bias_correction" in issue.path
                    ],
                    [
                        (
                            "power_devices.solar.forecast.bias_correction",
                            "relocated_config_key",
                        )
                    ],
                )
                self.assertTrue(
                    any(
                        "training.solar_bias" in issue.message
                        for issue in report.errors
                    )
                )

    def test_clamp_min_valid_when_zero(self) -> None:
        # Zero is what the reader applies when the key is absent, and the
        # editor now offers it as the field's hint, so a document that states
        # it has to save.
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "clamp_min": 0.0,
        }

        report = validate_config_document(config)
        self.assertTrue(report.valid)

    def test_clamp_min_invalid_when_negative(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "clamp_min": -0.1,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.clamp_min"
                for issue in report.errors
            )
        )

    def test_clamp_max_invalid_when_too_large(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "clamp_max": 11.0,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.clamp_max"
                for issue in report.errors
            )
        )

    def test_clamp_min_must_be_less_than_clamp_max(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "clamp_min": 1.0,
            "clamp_max": 1.0,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path.startswith("training.solar_bias")
                for issue in report.errors
            )
        )

    def test_absence_of_correction_settings_is_valid(self) -> None:
        config = _valid_config()
        config.get("training", {}).pop("solar_bias", None)

        report = validate_config_document(config)
        self.assertTrue(report.valid)

    def test_valid_slot_invalidation_config_passes(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
            }
        }

        report = validate_config_document(config)

        self.assertTrue(report.valid)

    def test_slot_invalidation_accepts_a_document_still_carrying_the_retired_key(
        self,
    ) -> None:
        """Curtailment stopped reading `export_enabled_entity_id` (issue #71).
        A stored document that still carries it must load, not error — the load
        migration is what removes it."""
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
                "export_enabled_entity_id": "switch.export_enabled",
            }
        }

        report = validate_config_document(config)

        self.assertTrue(report.valid)

    def test_slot_invalidation_requires_grid_power_entity(self) -> None:
        config = _valid_config()
        config["power_devices"]["grid"]["entities"]["power"] = "   "
        config.setdefault("training", {})["solar_bias"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "training.solar_bias.slot_invalidation.max_battery_soc_percent"
                and issue.code == "missing_prerequisite"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_rejects_ratio_above_one(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
                "curtailment_max_actual_forecast_ratio": 1.5,
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "training.solar_bias.slot_invalidation.curtailment_max_actual_forecast_ratio"
                and issue.code == "invalid_range"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_rejects_negative_export_deadband(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
                "curtailment_max_export_w": -5,
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "training.solar_bias.slot_invalidation.curtailment_max_export_w"
                and issue.code == "invalid_range"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_rejects_bool_soc_type(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": True,
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "training.solar_bias.slot_invalidation.max_battery_soc_percent"
                and issue.code == "invalid_type"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_rejects_soc_out_of_range(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 0,
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "training.solar_bias.slot_invalidation.max_battery_soc_percent"
                and issue.code == "invalid_range"
                for issue in report.errors
            )
        )

    def test_slot_invalidation_requires_battery_capacity_entity(self) -> None:
        config = _valid_config()
        config["power_devices"]["battery"]["entities"]["capacity"] = "   "
        config.setdefault("training", {})["solar_bias"] = {
            "slot_invalidation": {
                "max_battery_soc_percent": 87,
            }
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "training.solar_bias.slot_invalidation"
                and issue.code == "missing_prerequisite"
                for issue in report.errors
            )
        )


    def test_aggregation_method_invalid_type_rejected(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "aggregation_method": 42,
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.aggregation_method"
                and issue.code == "invalid_type"
                for issue in report.errors
            )
        )

    def test_aggregation_method_unknown_value_rejected(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["solar_bias"] = {
            "aggregation_method": "mean_of_ratios",
        }

        report = validate_config_document(config)
        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.solar_bias.aggregation_method"
                and issue.code == "invalid_choice"
                for issue in report.errors
            )
        )

    def test_aggregation_method_valid_values_accepted(self) -> None:
        for method in ("ratio_of_sums", "trimmed_mean"):
            with self.subTest(method=method):
                config = _valid_config()
                config.setdefault("training", {})["solar_bias"] = {
                    "aggregation_method": method,
                }

                report = validate_config_document(config)
                self.assertTrue(report.valid)


if __name__ == "__main__":
    unittest.main()
