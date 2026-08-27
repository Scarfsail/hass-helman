from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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
    core_mod.HomeAssistant = type("HomeAssistant", (), {})

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    dt_mod.now = lambda: datetime.fromisoformat("2026-04-05T12:00:00+00:00")
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.config_validation import validate_config_document


def _valid_config() -> dict:
    return {
        "sources_title": "Energy Sources",
        "consumers_title": "Energy Consumers",
        "groups_title": "Group by:",
        "others_group_label": "Others",
        "show_empty_groups": False,
        "show_others_group": True,
        "history_buckets": 60,
        "history_bucket_duration": 5,
        "device_label_text": {
            "rooms": {
                "Kitchen": "KT",
            }
        },
        "power_sensor_name_cleaner_regex": r"\s+",
        "power_devices": {
            "house": {
                "entities": {
                    "power": "sensor.house_power",
                },
                "unmeasured_power_title": "Unmeasured",
                "forecast": {
                    "total_energy_entity_id": "sensor.house_energy_total",
                    "min_history_days": 14,
                    "training_window_days": 56,
                },
            },
            "solar": {
                "entities": {
                    "power": "sensor.solar_power",
                    "today_energy": "sensor.solar_today",
                },
                "forecast": {
                    "daily_energy_entity_ids": [
                        "sensor.solar_day_1",
                        "sensor.solar_day_2",
                    ],
                    "total_energy_entity_id": "sensor.solar_total",
                },
            },
            "battery": {
                "entities": {
                    "power": "sensor.battery_power",
                    "remaining_energy": "sensor.battery_remaining",
                    "capacity": "sensor.battery_soc",
                    "min_soc": "sensor.battery_min_soc",
                    "max_soc": "sensor.battery_max_soc",
                },
                "forecast": {
                    "charge_efficiency": 0.95,
                    "discharge_efficiency": 0.95,
                    "max_charge_power_w": 5000,
                    "max_discharge_power_w": 5000,
                },
            },
            "grid": {
                "entities": {
                    "power": "sensor.grid_power",
                },
                "forecast": {
                    "sell_price_entity_id": "sensor.grid_sell_price",
                    "import_price_unit": "CZK/kWh",
                    "import_price_windows": [
                        {"start": "00:00", "end": "06:00", "price": 2.5},
                        {"start": "06:00", "end": "00:00", "price": 3.5},
                    ],
                },
            },
        },
        "controllables": [
            _inverter_controllable(),
            {
                "kind": "ev_charger",
                "id": "garage-ev",
                "name": "Garage EV",
                "limits": {
                    "max_charging_power_kw": 11.0,
                },
                "controls": {
                    "charge": {
                        "entity_id": "switch.ev_nabijeni",
                    },
                    "use_mode": {
                        "entity_id": "input_select.ev_use_mode",
                        "values": {
                            "Fast": {"behavior": "fixed_max_power"},
                            "ECO": {"behavior": "surplus_aware"},
                        },
                    },
                    "eco_gear": {
                        "entity_id": "input_select.ev_eco_gear",
                        "values": {
                            "6A": {"min_power_kw": 1.4},
                            "10A": {"min_power_kw": 2.3},
                        },
                    },
                },
                "vehicles": [
                    {
                        "id": "kona",
                        "name": "Kona",
                        "telemetry": {
                            "soc_entity_id": "sensor.kona_soc",
                            "charge_limit_entity_id": "number.kona_charge_limit",
                        },
                        "limits": {
                            "battery_capacity_kwh": 64.0,
                            "max_charging_power_kw": 11.0,
                        },
                    }
                ],
            }
        ],
    }


def _inverter_controllable() -> dict:
    return {
        "kind": "inverter",
        "id": "inverter",
        "name": "Inverter",
        "controls": {
            "mode": {
                "entity_id": "input_select.fv_mode",
                "options": {
                    "normal": "Normal",
                    "charge_to_target_soc": "Charge",
                    "discharge_to_target_soc": "Discharge",
                    "stop_charging": "Stop charging",
                    "stop_discharging": "Stop discharging",
                    "stop_export": "Stop export",
                },
            }
        },
    }


def _generic_appliance(*, strategy: str = "fixed") -> dict:
    appliance = {
        "kind": "generic",
        "id": "dishwasher",
        "name": "Dishwasher",
        "controls": {
            "switch": {"entity_id": "switch.dishwasher"},
        },
        "consumption": {
            "projection": {
                "strategy": strategy,
                "hourly_energy_kwh": 1.2,
            },
        },
    }
    if strategy == "history_average":
        appliance["consumption"]["energy_entity_id"] = "sensor.dishwasher_energy_total"
        appliance["consumption"]["projection"]["lookback_days"] = 30
    return appliance


def _climate_appliance(*, strategy: str = "fixed") -> dict:
    appliance = {
        "kind": "climate",
        "id": "living-room-hvac",
        "name": "Living Room HVAC",
        "controls": {
            "climate": {
                "entity_id": "climate.living_room",
            }
        },
        "consumption": {
            "projection": {
                "strategy": strategy,
                "hourly_energy_kwh": 1.5,
            },
        },
    }
    if strategy == "history_average":
        appliance["consumption"]["energy_entity_id"] = (
            "sensor.living_room_hvac_energy_total"
        )
        appliance["consumption"]["projection"]["lookback_days"] = 30
    return appliance


class ConfigValidationTests(unittest.TestCase):
    def test_valid_document_passes(self) -> None:
        report = validate_config_document(_valid_config())

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])
        self.assertEqual(report.warnings, [])

    def test_unknown_controllable_kind_is_warning_only(self) -> None:
        config = _valid_config()
        config["controllables"] = [{"kind": "heat_pump"}]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])
        self.assertEqual(len(report.warnings), 1)
        self.assertEqual(report.warnings[0].code, "unsupported_kind")

    def test_invalid_inverter_control_is_error(self) -> None:
        config = _valid_config()
        config["controllables"][0]["controls"]["mode"] = {
            "entity_id": "sensor.bad_domain",
            "options": {
                "normal": "Normal",
            },
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(issue.code == "invalid_inverter_control" for issue in report.errors)
        )
        self.assertTrue(any(issue.code == "invalid_domain" for issue in report.errors))

    def test_invalid_stop_export_option_type_is_error(self) -> None:
        config = _valid_config()
        config["controllables"][0]["controls"]["mode"]["options"]["stop_export"] = 42

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "controllables[0].controls.mode.options.stop_export"
                and issue.code == "invalid_type"
                for issue in report.errors
            )
        )

    def test_retired_config_keys_are_rejected_by_name(self) -> None:
        # Migration runs on load only, so a hand-edited old-shape document
        # reaching the save path must be refused with the new key named.
        for retired_key, value in (("appliances", []), ("scheduler", {})):
            with self.subTest(retired_key=retired_key):
                config = _valid_config()
                config[retired_key] = value

                report = validate_config_document(config)

                self.assertFalse(report.valid)
                issue = next(
                    issue
                    for issue in report.errors
                    if issue.code == "retired_config_key"
                )
                self.assertEqual(issue.path, retired_key)
                self.assertIn("controllables", issue.message)

    def test_second_inverter_is_rejected(self) -> None:
        config = _valid_config()
        config["controllables"].append(_inverter_controllable())

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(issue.code == "duplicate_inverter" for issue in report.errors)
        )

    def test_reserved_inverter_id_is_rejected_for_other_kinds(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["id"] = "inverter"
        config["controllables"].append(appliance)

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(issue.code == "reserved_controllable_id" for issue in report.errors)
        )

    def test_duplicate_ids_across_kinds_are_rejected(self) -> None:
        config = _valid_config()
        climate = _climate_appliance()
        generic = _generic_appliance()
        generic["id"] = climate["id"]
        config["controllables"].extend([climate, generic])

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.code == "duplicate_controllable_id"
                for issue in report.errors
            )
        )

    def test_invalid_grid_energy_meter_entity_ids_are_reported(self) -> None:
        config = _valid_config()
        config["power_devices"]["grid"]["entities"]["today_import"] = "not-an-entity-id"
        config["power_devices"]["grid"]["entities"]["today_export"] = 42

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        for key in ("today_import", "today_export"):
            self.assertTrue(
                any(
                    issue.path == f"power_devices.grid.entities.{key}"
                    for issue in report.errors
                ),
                msg=f"expected an error for {key}",
            )

    def test_invalid_grid_import_windows_are_reported(self) -> None:
        config = _valid_config()
        config["power_devices"]["grid"]["forecast"]["import_price_windows"] = [
            {"start": "00:00", "end": "05:00", "price": 2.5},
            {"start": "06:00", "end": "00:00", "price": 3.5},
        ]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.code == "invalid_import_price_config"
                and "leave a gap" in issue.message
                for issue in report.errors
            )
        )

    def test_appliance_runtime_optimizer_passes_for_configured_generic_appliance(self) -> None:
        config = _valid_config()
        config["controllables"].append(_generic_appliance())
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "run-dishwasher-on-surplus",
                    "kind": "appliance_runtime",
                    "target": {"controllable_id": "dishwasher"},
                    "conditions": [{"min_soc_pct": 80}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_appliance_runtime_optimizer_rejects_unknown_appliance_id(self) -> None:
        config = _valid_config()
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "run-unknown-on-surplus",
                    "kind": "appliance_runtime",
                    "params": {"window": {"start": "08:00", "end": "18:00"}},
                    "target": {"controllable_id": "missing-appliance"},
                    "conditions": [{}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "automation.optimizers[0].target.controllable_id"
                for issue in report.errors
            )
        )

    def test_appliance_runtime_optimizer_rejects_climate_mode_for_generic_appliance(
        self,
    ) -> None:
        config = _valid_config()
        config["controllables"].append(_generic_appliance())
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "run-dishwasher-on-surplus",
                    "kind": "appliance_runtime",
                    "params": {"window": {"start": "08:00", "end": "18:00"}},
                    "target": {
                        "controllable_id": "dishwasher",
                        "climate_mode": "heat",
                    },
                    "conditions": [{}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "automation.optimizers[0].target.climate_mode"
                for issue in report.errors
            )
        )

    def test_charge_hold_targets_the_inverter_without_saying_so(self) -> None:
        """An existing config omits ``target`` entirely and must keep working.

        The three inverter kinds gained ``controllable_id`` with the reserved
        id as its default, so a document written before the field existed keeps
        meaning exactly what it meant.
        """
        config = _valid_config()
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "hold",
                    "kind": "charge_hold",
                    "params": {
                        "window": {"start": "06:00", "end": "14:00"},
                        "battery_first": {"target_soc": 100, "margin_pct": 20},
                    },
                    "conditions": [{"run_when": ["surplus"]}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertTrue(report.valid, msg=report.to_dict())

    def test_an_optimizer_aimed_at_a_kind_it_cannot_drive_is_rejected(self) -> None:
        """A ``charge_hold`` on a boiler used to be accepted and do nothing.

        The pairing is incoherent — the inverter's actions and an appliance's
        are different vocabularies — and nothing said so, because the kind
        implied its own target.
        """
        config = _valid_config()
        config["controllables"].append(_generic_appliance())
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "hold",
                    "kind": "charge_hold",
                    "target": {"controllable_id": "dishwasher"},
                    "params": {
                        "window": {"start": "06:00", "end": "14:00"},
                        "battery_first": {"target_soc": 100, "margin_pct": 20},
                    },
                    "conditions": [{"run_when": ["surplus"]}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        incompatible = [
            issue for issue in report.errors if issue.code == "incompatible_target"
        ]
        self.assertEqual(len(incompatible), 1)
        self.assertEqual(
            incompatible[0].path, "automation.optimizers[0].target.controllable_id"
        )
        # The kind that cannot be driven is named, not just the id.
        self.assertIn("'generic'", incompatible[0].message)
        self.assertIn("inverter", incompatible[0].message)

    def test_an_appliance_runtime_aimed_at_an_ev_charger_is_rejected(self) -> None:
        """``ev_charger`` declares no optimizer kind, so nothing may target it.

        This used to fail only when the optimizer was *built* — the registry
        authors an action for generic and climate appliances and rejects
        everything else — which meant the config editor accepted it happily.
        Making chargers automatable is a feature; this only moves the existing
        refusal to where the user typed the id.
        """
        config = _valid_config()
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "charge-the-car",
                    "kind": "appliance_runtime",
                    "target": {"controllable_id": "garage-ev"},
                    "params": {"window": {"start": "08:00", "end": "18:00"}},
                    "conditions": [{}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        incompatible = [
            issue for issue in report.errors if issue.code == "incompatible_target"
        ]
        self.assertEqual(len(incompatible), 1)
        self.assertIn("'ev_charger'", incompatible[0].message)
        # And says what it *can* drive, so the fix is in the message.
        self.assertIn("climate, generic", incompatible[0].message)

    def test_an_optimizer_naming_no_configured_controllable_is_rejected_once(
        self,
    ) -> None:
        config = _valid_config()
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "ghost",
                    "kind": "appliance_runtime",
                    "target": {"controllable_id": "nobody"},
                    "params": {"window": {"start": "08:00", "end": "18:00"}},
                    "conditions": [{}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        # One finding: the builder would say the same thing in the appliance
        # registry's words, and two errors for one typo is noise.
        self.assertEqual(len(report.errors), 1)
        self.assertEqual(report.errors[0].code, "unknown_controllable")

    # --- requires_appliance ---------------------------------------------

    @staticmethod
    def _pool_optimizer(optimizer_id, appliance_id, *, requires=None, enabled=True):
        group = {} if requires is None else {"requires_appliance": requires}
        return {
            "id": optimizer_id,
            "kind": "appliance_runtime",
            "enabled": enabled,
            "target": {"controllable_id": appliance_id},
            "params": {"window": {"start": "08:00", "end": "18:00"}},
            "conditions": [group],
        }

    def _pool_config(self, *optimizers) -> dict:
        """Two pool appliances, plus whichever optimizers the case needs.

        The default pair is the correct arrangement — filtration planned first,
        the heat pump depending on it — so a case that wants a fault states only
        the fault.
        """
        config = _valid_config()
        for appliance_id in ("heatpump", "filtration"):
            appliance = _generic_appliance()
            appliance["id"] = appliance_id
            appliance["name"] = appliance_id.title()
            appliance["controls"]["switch"]["entity_id"] = f"switch.{appliance_id}"
            config["controllables"].append(appliance)

        config["automation"] = {
            "enabled": True,
            "optimizers": list(optimizers)
            or [
                self._pool_optimizer("filter", "filtration"),
                self._pool_optimizer("heat", "heatpump", requires="filtration"),
            ],
        }
        return config

    def _findings(self, config, code):
        report = validate_config_document(config)
        return [
            issue for issue in [*report.errors, *report.warnings] if issue.code == code
        ], report

    def test_a_provider_planned_earlier_is_accepted_silently(self) -> None:
        report = validate_config_document(self._pool_config())

        self.assertTrue(report.valid)
        self.assertEqual(report.warnings, [])

    def test_a_provider_with_no_optimizer_at_all_is_accepted_silently(self) -> None:
        """The mask reads the plan, not the optimizer: hand-scheduling is valid."""
        report = validate_config_document(
            self._pool_config(
                self._pool_optimizer("heat", "heatpump", requires="filtration")
            )
        )

        self.assertTrue(report.valid)
        self.assertEqual(report.warnings, [])

    def test_a_provider_planned_later_warns(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("heat", "heatpump", requires="filtration"),
            self._pool_optimizer("filter", "filtration"),
        )

        findings, report = self._findings(config, "required_appliance_planned_later")

        # A warning, not an error: an invisible lane does not prove the
        # dependent is dead, and the config still saves.
        self.assertTrue(report.valid)
        self.assertEqual(len(findings), 1)
        self.assertEqual(
            findings[0].path,
            "automation.optimizers[0].conditions[0].requires_appliance",
        )

    def test_a_provider_whose_only_optimizer_is_disabled_warns(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("filter", "filtration", enabled=False),
            self._pool_optimizer("heat", "heatpump", requires="filtration"),
        )

        findings, report = self._findings(
            config, "required_appliance_optimizer_disabled"
        )

        self.assertTrue(report.valid)
        self.assertEqual(len(findings), 1)
        # The path addresses the *document*, whose index 1 is the heat pump.
        # Index 0 is the disabled filtration optimizer the warning is about —
        # pointing the editor there would highlight the wrong card.
        self.assertEqual(
            findings[0].path,
            "automation.optimizers[1].conditions[0].requires_appliance",
        )

    def test_an_unconfigured_provider_is_rejected(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("filter", "filtration"),
            self._pool_optimizer("heat", "heatpump", requires="nobody"),
        )

        findings, report = self._findings(config, "unknown_required_appliance")

        self.assertFalse(report.valid)
        self.assertEqual(len(findings), 1)

    def test_the_inverter_is_not_an_appliance(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("heat", "heatpump", requires="inverter")
        )

        findings, report = self._findings(config, "unknown_required_appliance")

        self.assertFalse(report.valid)
        self.assertEqual(len(findings), 1)

    def test_an_appliance_cannot_depend_on_itself(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("heat", "heatpump", requires="heatpump")
        )

        findings, report = self._findings(
            config, "self_referential_required_appliance"
        )

        self.assertFalse(report.valid)
        self.assertEqual(len(findings), 1)

    def test_the_inverter_must_carry_the_reserved_id(self) -> None:
        """Targeting by id is only total if the inverter has the id to target.

        Nothing resolves the inverter by *kind* at targeting time on purpose —
        that would make ``controllable_id`` mean "an id, except sometimes a
        kind".
        """
        for raw_id, label in ((None, "absent"), ("fv", "renamed")):
            with self.subTest(label):
                config = _valid_config()
                inverter = config["controllables"][0]
                if raw_id is None:
                    inverter.pop("id")
                else:
                    inverter["id"] = raw_id

                report = validate_config_document(config)

                self.assertFalse(report.valid)
                self.assertTrue(
                    any(
                        issue.code == "required_controllable_id"
                        and issue.path == "controllables[0].id"
                        and "'inverter'" in issue.message
                        for issue in report.errors
                    ),
                    msg=report.to_dict(),
                )

    def test_input_select_ev_controls_are_accepted(self) -> None:
        report = validate_config_document(_valid_config())

        self.assertTrue(report.valid)

    def test_valid_generic_appliance_passes(self) -> None:
        config = _valid_config()
        config["controllables"] = [_inverter_controllable(), _generic_appliance(strategy="history_average")]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_valid_climate_appliance_passes(self) -> None:
        config = _valid_config()
        config["controllables"] = [_inverter_controllable(), _climate_appliance(strategy="history_average")]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_appliance_icon_accepts_non_mdi_value(self) -> None:
        config = _valid_config()
        config["controllables"][1]["icon"] = "hass:car-electric"

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_generic_history_average_requires_energy_entity(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance(strategy="history_average")
        del appliance["consumption"]["energy_entity_id"]
        config["controllables"] = [_inverter_controllable(), appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "controllables[1]"
                and "consumption.energy_entity_id" in issue.message
                for issue in report.errors
            )
        )

    def test_the_inverter_may_not_declare_consumption(self) -> None:
        config = _valid_config()
        inverter = _inverter_controllable()
        inverter["consumption"] = {"energy_entity_id": "sensor.inverter_energy"}
        config["controllables"] = [inverter, _generic_appliance()]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "controllables[0].consumption"
                and issue.code == "consumption_not_allowed"
                for issue in report.errors
            )
        )

    def test_two_controllables_may_not_share_one_meter(self) -> None:
        config = _valid_config()
        first = _generic_appliance(strategy="history_average")
        second = {
            **_climate_appliance(),
            "consumption": {
                "energy_entity_id": first["consumption"]["energy_entity_id"],
                "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.5},
            },
        }
        config["controllables"] = [_inverter_controllable(), first, second]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "controllables[2].consumption.energy_entity_id"
                and issue.code == "duplicate_entity_id"
                for issue in report.errors
            )
        )

    def test_the_meter_must_be_a_sensor(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["consumption"]["energy_entity_id"] = "switch.not_a_meter"
        config["controllables"] = [_inverter_controllable(), appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "controllables[1].consumption.energy_entity_id"
                for issue in report.errors
            )
        )

    def test_a_top_level_projection_is_reported_by_its_new_path(self) -> None:
        # Migration runs on load; a hand-edited save is told where the key went
        # rather than having it silently ignored.
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["projection"] = {"strategy": "fixed", "hourly_energy_kwh": 1.2}
        config["controllables"] = [_inverter_controllable(), appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "controllables[1].projection"
                and issue.code == "retired_config_key"
                and "consumption.projection" in issue.message
                for issue in report.errors
            )
        )

    def test_a_projection_without_a_meter_is_not_warned_about(self) -> None:
        # The ordinary case: a fixed-strategy appliance that is simply not
        # metered. The deferrable default must stay silent here, or most of a
        # real config lights up with warnings that ask for nothing.
        config = _valid_config()
        config["controllables"] = [_inverter_controllable(), _generic_appliance()]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.warnings, [])

    def test_an_explicit_deferrable_without_a_meter_warns(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["consumption"]["deferrable"] = True
        config["controllables"] = [_inverter_controllable(), appliance]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertTrue(
            any(
                issue.code == "deferrable_without_meter"
                and issue.path == "controllables[1].consumption"
                for issue in report.warnings
            )
        )

    def test_deferrable_must_be_a_boolean(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance(strategy="history_average")
        appliance["consumption"]["deferrable"] = "yes"
        config["controllables"] = [_inverter_controllable(), appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "controllables[1].consumption.deferrable"
                for issue in report.errors
            )
        )

    def test_the_retired_deferrable_consumers_key_is_reported(self) -> None:
        config = _valid_config()
        config["power_devices"]["house"]["forecast"]["deferrable_consumers"] = [
            {"energy_entity_id": "sensor.washer_energy", "label": "Washer"}
        ]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "power_devices.house.forecast.deferrable_consumers"
                and issue.code == "retired_config_key"
                for issue in report.errors
            )
        )

    def test_climate_requires_climate_domain(self) -> None:
        config = _valid_config()
        appliance = _climate_appliance()
        appliance["controls"]["climate"]["entity_id"] = "switch.not_a_climate"
        config["controllables"] = [_inverter_controllable(), appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "controllables[1]"
                and "controls.climate.entity_id" in issue.message
                for issue in report.errors
            )
        )

    def test_blank_appliance_icon_is_error(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["icon"] = "   "
        config["controllables"] = [_inverter_controllable(), appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "controllables[1]"
                and ".icon must be a non-empty string" in issue.message
                for issue in report.errors
            )
        )

    def test_invalid_device_label_text_shape_is_reported(self) -> None:
        config = _valid_config()
        config["device_label_text"] = {"rooms": {"Kitchen": 123}}

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].path, "device_label_text.rooms.Kitchen")

    def test_training_time_valid_for_hhmm(self) -> None:
        config = _valid_config()
        config["training_time"] = "03:00"

        report = validate_config_document(config)

        self.assertTrue(report.valid)

    def test_training_time_invalid_for_bad_string(self) -> None:
        config = _valid_config()
        config["training_time"] = "3am"

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(issue.path == "training_time" for issue in report.errors)
        )

    def test_training_time_invalid_for_out_of_range_time(self) -> None:
        config = _valid_config()
        config["training_time"] = "25:00"

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training_time" and issue.code == "invalid_value"
                for issue in report.errors
            )
        )


if __name__ == "__main__":
    unittest.main()
