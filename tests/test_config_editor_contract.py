from __future__ import annotations

from _fakes import FakeHass as SharedFakeHass

from _fakes import FakeBus, FakeConnection as SharedFakeConnection

import unittest
from types import SimpleNamespace
from unittest.mock import patch


from custom_components.helman.automation import config as automation_config_module
from custom_components.helman.const import CONFIG_DOCUMENT_VERSION, DOMAIN
from custom_components.helman.config_defaults import CONFIG_FIELD_DEFAULTS
from custom_components.helman.solar_bias_correction.models import read_bias_config
from custom_components.helman.websockets import (
    ws_get_config,
    ws_get_config_defaults,
    ws_get_vendors,
    ws_save_config,
    ws_validate_config,
)

_save_config_handler = ws_save_config.__wrapped__


def _invalid_config() -> dict:
    return {
        "energy_nodes": {
            "inverter": {
                "controls": {
                    "mode": {
                        "entity_id": "sensor.invalid",
                        "options": {"normal": "Normal"},
                    }
                },
            }
        }
    }


def _v6_shaped_config() -> dict:
    """What a hand-edited pre-version-7 document still looks like."""
    return {
        "scheduler": {
            "control": {
                "mode_entity_id": "select.fv_mode",
                "action_option_map": {
                    "normal": "Normal",
                    "stop_charging": "Stop charging",
                    "stop_discharging": "Stop discharging",
                },
            }
        },
        "appliances": [],
    }


class FakeStorage:
    def __init__(self, config: dict | None = None) -> None:
        self.config = config or {}
        self.saved_payloads: list[dict] = []

    async def async_save(self, new_config: dict) -> None:
        self.saved_payloads.append(new_config)
        self.config = new_config


class FakeUser:
    def __init__(self, *, is_admin: bool) -> None:
        self.is_admin = is_admin


class FakeConnection(SharedFakeConnection):
    def __init__(self, *, is_admin: bool) -> None:
        super().__init__()
        self.user = FakeUser(is_admin=is_admin)


class FakeConfigEntry:
    def __init__(self, entry_id: str) -> None:
        self.entry_id = entry_id


class FakeConfigEntries:
    def __init__(
        self,
        *,
        reload_result: bool = True,
        reload_error: Exception | None = None,
    ) -> None:
        self.reload_calls: list[str] = []
        self.entries = [FakeConfigEntry("entry-1")]
        self.reload_result = reload_result
        self.reload_error = reload_error

    def async_entries(self, domain: str, **_kwargs):
        return list(self.entries)

    def async_get_entry(self, entry_id: str):
        return None

    async def async_reload(self, entry_id: str) -> bool:
        self.reload_calls.append(entry_id)
        if self.reload_error is not None:
            raise self.reload_error
        return self.reload_result




class FakeHass(SharedFakeHass):
    def __init__(
        self,
        storage: FakeStorage | None,
        *,
        config_entries: FakeConfigEntries | None = None,
    ) -> None:
        super().__init__()
        domain_data = {}
        if storage is not None:
            domain_data["storage"] = storage
        self.data = {DOMAIN: domain_data}
        self.config_entries = config_entries or FakeConfigEntries()
        self.bus = FakeBus()


class ConfigEditorContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        registry = SimpleNamespace(async_get_entity_id=lambda *args: None)
        patcher = patch(
            "homeassistant.helpers.entity_registry.async_get", return_value=registry
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _set_known_optimizer_kinds(self, *kinds: str) -> None:
        original = automation_config_module.KNOWN_OPTIMIZER_KINDS
        automation_config_module.KNOWN_OPTIMIZER_KINDS = frozenset(kinds)
        self.addCleanup(
            setattr,
            automation_config_module,
            "KNOWN_OPTIMIZER_KINDS",
            original,
        )

    @staticmethod
    def _stamped(config: dict) -> dict:
        """What `ws_save_config` persists: the document plus its version stamp.

        The stamp is written on every save so a YAML round-trip through the
        editor can never drop it and re-trigger the load migration.
        """
        return {**config, "config_version": CONFIG_DOCUMENT_VERSION}

    def test_get_config_requires_admin(self) -> None:
        connection = FakeConnection(is_admin=False)

        ws_get_config(
            FakeHass(FakeStorage({"history_buckets": 60})),
            connection,
            {"id": 1, "type": "helman/get_config"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )

    def test_get_config_returns_config_for_admin(self) -> None:
        connection = FakeConnection(is_admin=True)

        ws_get_config(
            FakeHass(FakeStorage({"history_buckets": 60})),
            connection,
            {"id": 1, "type": "helman/get_config"},
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(1, {"history_buckets": 60})])

    def test_get_config_returns_automation_block_unchanged(self) -> None:
        connection = FakeConnection(is_admin=True)
        config = {
            "automation": {
                "enabled": False,
                "optimizers": [],
                "unknown_key": "preserve-me",
            }
        }

        ws_get_config(
            FakeHass(FakeStorage(config)),
            connection,
            {"id": 1, "type": "helman/get_config"},
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(1, config)])

    def test_get_config_defaults_requires_admin(self) -> None:
        connection = FakeConnection(is_admin=False)

        ws_get_config_defaults(
            FakeHass(FakeStorage()),
            connection,
            {"id": 1, "type": "helman/get_config_defaults"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )

    def test_get_config_defaults_serves_dotted_paths(self) -> None:
        connection = FakeConnection(is_admin=True)

        ws_get_config_defaults(
            FakeHass(FakeStorage()),
            connection,
            {"id": 1, "type": "helman/get_config_defaults"},
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(1, dict(CONFIG_FIELD_DEFAULTS))])

    def test_config_defaults_match_what_the_bias_reader_applies(self) -> None:
        """The hint and the runtime have to be the same number.

        Spot-checked against the one reader with the most entries in the map;
        an empty document is exactly the "nothing configured" case the editor
        draws the placeholders for.
        """
        resolved = read_bias_config({})

        self.assertEqual(
            CONFIG_FIELD_DEFAULTS["training.training_time"],
            resolved.training_time,
        )
        self.assertEqual(
            CONFIG_FIELD_DEFAULTS["training.solar_bias.min_history_days"],
            resolved.min_history_days,
        )
        self.assertEqual(
            CONFIG_FIELD_DEFAULTS["training.solar_bias.min_valid_slot_days"],
            resolved.min_valid_slot_days,
        )
        self.assertEqual(
            CONFIG_FIELD_DEFAULTS["training.solar_bias.clamp_min"],
            resolved.clamp_min,
        )
        self.assertEqual(
            CONFIG_FIELD_DEFAULTS["training.solar_bias.clamp_max"],
            resolved.clamp_max,
        )
        self.assertEqual(
            CONFIG_FIELD_DEFAULTS[
                "training.solar_bias.max_interpolated_consecutive_slots"
            ],
            resolved.max_interpolated_consecutive_slots,
        )
        self.assertEqual(
            CONFIG_FIELD_DEFAULTS[
                "training.solar_bias.slot_invalidation.curtailment_max_export_w"
            ],
            resolved.slot_invalidation_curtailment_max_export_w,
        )
        self.assertEqual(
            CONFIG_FIELD_DEFAULTS[
                "training.solar_bias.slot_invalidation."
                "curtailment_max_actual_forecast_ratio"
            ],
            resolved.slot_invalidation_curtailment_max_actual_forecast_ratio,
        )

    def test_validate_config_returns_structured_report(self) -> None:
        connection = FakeConnection(is_admin=True)

        ws_validate_config(
            FakeHass(FakeStorage()),
            connection,
            {"id": 1, "type": "helman/validate_config", "config": _invalid_config()},
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results[0][0], 1)
        self.assertFalse(connection.results[0][1]["valid"])
        self.assertIn("errors", connection.results[0][1])

    def test_validate_config_reports_unknown_optimizer_kind_for_automation_payload(self) -> None:
        connection = FakeConnection(is_admin=True)

        ws_validate_config(
            FakeHass(FakeStorage()),
            connection,
            {
                "id": 1,
                "type": "helman/validate_config",
                "config": {
                    "automation": {
                        "enabled": True,
                        "system_optimizers": [
                            {
                                "id": "export",
                                "kind": "does_not_exist",
                            }
                        ],
                    }
                },
            },
        )

        self.assertEqual(connection.errors, [])
        self.assertFalse(connection.results[0][1]["valid"])
        self.assertEqual(
            connection.results[0][1]["errors"][0]["section"],
            "automation",
        )
        self.assertEqual(
            connection.results[0][1]["errors"][0]["path"],
            "automation.system_optimizers[0].kind",
        )
        self.assertIn("does_not_exist", connection.results[0][1]["errors"][0]["message"])

    def test_validate_config_reports_a_key_the_hardware_profile_owns(self) -> None:
        connection = FakeConnection(is_admin=True)
        config = {
            "energy_nodes": {
                "inverter": {
                    "profile": {"id": "solax_inverter", "entry_id": "gone"},
                },
                "house": {"entities": {"power": "sensor.house"}},
                "grid": {"max_allowed_export_power": 9900},
            },
        }

        ws_validate_config(
            FakeHass(FakeStorage()),
            connection,
            {"id": 1, "type": "helman/validate_config", "config": config},
        )

        report = connection.results[0][1]
        self.assertFalse(report["valid"])
        self.assertEqual(
            sorted((issue["code"], issue["path"]) for issue in report["errors"]),
            [
                ("invalid_choice", "energy_nodes.inverter.profile.entry_id"),
                ("vendor_owned_key", "energy_nodes.house.entities.power"),
            ],
        )

    async def test_save_config_refuses_a_key_the_hardware_profile_owns(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)
        config = {
            "energy_nodes": {
                "inverter": {
                    "profile": {"id": "solax_inverter", "entry_id": "gone"},
                }
            },
            "training": {"solar_bias": {"total_energy_entity_id": "sensor.pv_total"}},
        }

        await _save_config_handler(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": config},
        )

        self.assertEqual(storage.saved_payloads, [])
        self.assertIn(
            "vendor_owned_key",
            [issue["code"] for issue in connection.results[0][1]["validation"]["errors"]],
        )

    def test_get_vendors_requires_admin(self) -> None:
        connection = FakeConnection(is_admin=False)

        ws_get_vendors(
            FakeHass(FakeStorage()),
            connection,
            {"id": 1, "type": "helman/get_vendors", "config": {}},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors[0][1], "unauthorized")

    async def test_save_config_does_not_persist_invalid_document(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)

        await _save_config_handler(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": _invalid_config()},
        )

        self.assertEqual(storage.saved_payloads, [])
        self.assertEqual(hass.config_entries.reload_calls, [])
        self.assertEqual(connection.errors, [])
        self.assertFalse(connection.results[0][1]["success"])
        self.assertFalse(connection.results[0][1]["reloadStarted"])

    async def test_save_config_persists_and_reloads_valid_document(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)

        await _save_config_handler(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": {}},
        )

        self.assertEqual(storage.saved_payloads, [self._stamped({})])
        self.assertEqual(hass.config_entries.reload_calls, ["entry-1"])
        self.assertEqual(connection.errors, [])
        self.assertTrue(connection.results[0][1]["success"])
        self.assertTrue(connection.results[0][1]["reloadStarted"])
        self.assertTrue(connection.results[0][1]["reloadSucceeded"])
        self.assertIsNone(connection.results[0][1]["reloadError"])
        # Announced only after the reload, so an editor that reloads on this
        # event reads the config the entry is now actually running on.
        self.assertEqual(
            hass.bus.fired,
            [("helman_data_changed", {"kind": "config"})],
        )

    async def test_save_config_does_not_announce_a_failed_reload(self) -> None:
        # A save whose reload blew up left the running config untouched; waking
        # every open editor to re-read it would only show them the old document.
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage, config_entries=FakeConfigEntries(reload_result=False))

        await _save_config_handler(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": {}},
        )

        self.assertFalse(connection.results[0][1]["reloadSucceeded"])
        self.assertEqual(hass.bus.fired, [])

    async def test_save_config_persists_minimal_automation_config(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)
        config = {
            "automation": {
                "enabled": True,
                "system_optimizers": [],
            }
        }

        await _save_config_handler(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": config},
        )

        self.assertEqual(storage.saved_payloads, [self._stamped(config)])
        self.assertEqual(hass.config_entries.reload_calls, ["entry-1"])
        self.assertTrue(connection.results[0][1]["success"])

    async def test_save_config_preserves_optimizers_when_disabling_automation(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)
        config = {
            "automation": {
                "enabled": False,
                "system_optimizers": [
                    {
                        "id": "export",
                        "kind": "export_price",
                        "conditions": [{"when_price_below": 0.0}],
                    }
                ],
            }
        }

        await _save_config_handler(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": config},
        )

        self.assertEqual(storage.saved_payloads, [self._stamped(config)])
        self.assertEqual(
            storage.config["automation"]["system_optimizers"],
            config["automation"]["system_optimizers"],
        )
        self.assertTrue(connection.results[0][1]["success"])

    async def test_save_config_persists_appliance_runtime_optimizer(self) -> None:
        self._set_known_optimizer_kinds("export_price", "appliance_runtime")
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)
        config = {
            "devices": {"consumers": [
                {
                    "kind": "generic",
                    "schedulable": True,
                    "id": "dishwasher",
                    "name": "Dishwasher",
                    "controls": {
                        "switch": {"entity_id": "switch.dishwasher"},
                    },
                    "consumption": {
                        "energy_entity_id": "sensor.dishwasher_energy",
                        "projection": {
                            "strategy": "fixed",
                            "hourly_energy_kwh": 1.2,
                        },
                    },
                }
            ]},
            "automation": {
                "enabled": True,
                "appliance_optimizers": [
                    {
                        "id": "preheat-living-room",
                        "kind": "appliance_runtime",
                        "enabled": True,
                        "target": {"controllables": [{"controllable_id": "dishwasher"}]},
                        "conditions": [{"min_soc_pct": 80}],
                    }
                ],
            }
        }

        await _save_config_handler(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": config},
        )

        self.assertEqual(storage.saved_payloads, [self._stamped(config)])
        self.assertEqual(hass.config_entries.reload_calls, ["entry-1"])
        self.assertTrue(connection.results[0][1]["success"])

    async def test_save_config_rejects_the_retired_appliances_shape(self) -> None:
        # Migration is load-only by contract, so the save path must refuse an
        # old-shape document rather than quietly rewriting the user's YAML.
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)

        await _save_config_handler(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": _v6_shaped_config()},
        )

        self.assertEqual(storage.saved_payloads, [])
        self.assertFalse(connection.results[0][1]["success"])
        errors = connection.results[0][1]["validation"]["errors"]
        retired = [error for error in errors if error["code"] == "retired_config_key"]
        self.assertEqual({error["path"] for error in retired}, {"appliances", "scheduler"})
        for error in retired:
            self.assertIn("devices", error["message"])

    async def test_save_config_reports_reload_failure_after_persisting_document(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(
            storage,
            config_entries=FakeConfigEntries(
                reload_error=RuntimeError("reload failed"),
            ),
        )

        await _save_config_handler(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": {}},
        )

        self.assertEqual(storage.saved_payloads, [self._stamped({})])
        self.assertEqual(hass.config_entries.reload_calls, ["entry-1"])
        self.assertEqual(connection.errors, [])
        self.assertFalse(connection.results[0][1]["success"])
        self.assertTrue(connection.results[0][1]["reloadStarted"])
        self.assertFalse(connection.results[0][1]["reloadSucceeded"])
        self.assertEqual(connection.results[0][1]["reloadError"], "reload failed")


if __name__ == "__main__":
    unittest.main()
