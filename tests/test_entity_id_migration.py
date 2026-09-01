"""Covers ``async_migrate_entry`` (config entry version 1 -> 2): the entity
registry rewrite that carries #194's unified entity ids and unique ids onto an
install that already holds the old ones.

Reuses ``test_init_recovery.py``'s pattern of stubbing out Helman's heavier
submodules (frontend/panel/websockets/storage/coordinator) so importing
``custom_components.helman`` stays cheap. Keeps the real
``homeassistant.helpers.entity_registry`` module (much of HA's own import
graph runs through it) and patches only the three functions the migration
calls against it, so the test drives a small fake registry without standing
up HA's full registry machinery.
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

ENTRY_ID = "entry-1"


class FakeRegistryEntry:
    def __init__(self, entity_id: str, unique_id: str) -> None:
        self.entity_id = entity_id
        self.unique_id = unique_id
        self.config_entry_id = ENTRY_ID

    @property
    def domain(self) -> str:
        return self.entity_id.split(".")[0]


class FakeEntityRegistry:
    def __init__(self, entries: list[FakeRegistryEntry]) -> None:
        self._entries: dict[str, FakeRegistryEntry] = {e.entity_id: e for e in entries}
        self.updates: list[tuple[str, dict]] = []

    def entries_for_config_entry(self, config_entry_id: str) -> list[FakeRegistryEntry]:
        return [e for e in self._entries.values() if e.config_entry_id == config_entry_id]

    # Named to match ``EntityRegistry.async_update_entity``, the real instance
    # method the migration calls.
    def async_update_entity(self, entity_id: str, **changes: str) -> FakeRegistryEntry:
        self.updates.append((entity_id, dict(changes)))
        entry = self._entries[entity_id]
        new_unique_id = changes.get("new_unique_id")
        new_entity_id = changes.get("new_entity_id")
        if new_unique_id is not None:
            entry.unique_id = new_unique_id
        if new_entity_id is not None and new_entity_id != entity_id:
            del self._entries[entity_id]
            entry.entity_id = new_entity_id
            self._entries[new_entity_id] = entry
        return entry


class FakeConfigEntry:
    def __init__(self, entry_id: str = ENTRY_ID, version: int = 1) -> None:
        self.entry_id = entry_id
        self.version = version


class FakeConfigEntries:
    def __init__(self) -> None:
        self.update_calls: list[tuple[str, int]] = []

    def async_update_entry(self, entry, *, version: int) -> None:
        entry.version = version
        self.update_calls.append((entry.entry_id, version))


class FakeHass:
    def __init__(self, registry: FakeEntityRegistry) -> None:
        self.data: dict = {}
        self.config_entries = FakeConfigEntries()
        self._fake_registry = registry


def _load_helman_init_with_stubs():
    for module_name in list(sys.modules):
        if module_name == "custom_components.helman" or module_name.startswith(
            "custom_components.helman."
        ):
            sys.modules.pop(module_name)

    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    # Stub the submodules async_setup_entry pulls in that this test does not
    # exercise -- same approach as test_init_recovery.py.
    frontend_mod = types.ModuleType("custom_components.helman.frontend")

    async def async_register_frontend(_hass) -> None:
        return None

    async def async_unregister_frontend(_hass) -> None:
        return None

    frontend_mod.async_register_frontend = async_register_frontend
    frontend_mod.async_unregister_frontend = async_unregister_frontend
    sys.modules["custom_components.helman.frontend"] = frontend_mod

    panel_mod = types.ModuleType("custom_components.helman.panel")

    async def async_register_panel(_hass) -> None:
        return None

    panel_mod.async_register_panel = async_register_panel
    sys.modules["custom_components.helman.panel"] = panel_mod

    websockets_mod = types.ModuleType("custom_components.helman.websockets")

    def async_register_websocket_commands(_hass) -> None:
        return None

    websockets_mod.async_register_websocket_commands = async_register_websocket_commands
    sys.modules["custom_components.helman.websockets"] = websockets_mod

    storage_mod = types.ModuleType("custom_components.helman.storage")

    class HelmanStorage:
        def __init__(self, _hass) -> None:
            pass

        async def async_load(self) -> None:
            return None

    storage_mod.HelmanStorage = HelmanStorage
    sys.modules["custom_components.helman.storage"] = storage_mod

    coordinator_mod = types.ModuleType("custom_components.helman.coordinator")

    class HelmanCoordinator:
        def __init__(self, _hass, storage) -> None:
            pass

    coordinator_mod.HelmanCoordinator = HelmanCoordinator
    sys.modules["custom_components.helman.coordinator"] = coordinator_mod

    module = importlib.import_module("custom_components.helman")
    return module


class EntityIdMigrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.helman_init = _load_helman_init_with_stubs()

    def _patch_registry(self, registry: FakeEntityRegistry) -> None:
        # The module under test calls the module-level ``er.async_get`` /
        # ``er.async_entries_for_config_entry`` against the *real*
        # ``homeassistant.helpers.entity_registry`` module (needed intact --
        # much of real HA's own import graph runs through it), then the
        # *instance* method ``ent_reg.async_update_entity(...)`` on whatever
        # ``async_get`` returned. Patching the two module-level lookups to
        # return this fake registry -- whose own ``async_update_entity`` is
        # named to match -- lets the test drive its own registry state without
        # standing up HA's full registry machinery.
        er = self.helman_init.er
        self.enterContext(
            patch.object(er, "async_get", lambda hass: hass._fake_registry)
        )
        self.enterContext(
            patch.object(
                er,
                "async_entries_for_config_entry",
                lambda reg, entry_id: reg.entries_for_config_entry(entry_id),
            )
        )

    async def test_old_unique_id_is_rewritten_and_default_entity_id_follows(self) -> None:
        registry = FakeEntityRegistry(
            [
                FakeRegistryEntry(
                    "sensor.helman_consumption_total", f"{ENTRY_ID}_consumption_total"
                ),
            ]
        )
        self._patch_registry(registry)
        hass = FakeHass(registry)
        entry = FakeConfigEntry(version=1)

        result = await self.helman_init.async_migrate_entry(hass, entry)

        self.assertTrue(result)
        (migrated,) = registry.entries_for_config_entry(ENTRY_ID)
        self.assertEqual(migrated.entity_id, "sensor.helman_house_consumption_power")
        self.assertEqual(migrated.unique_id, f"{ENTRY_ID}_house_consumption_power")
        self.assertEqual(entry.version, 2)
        self.assertEqual(hass.config_entries.update_calls, [(ENTRY_ID, 2)])

    async def test_user_renamed_entity_id_is_left_alone(self) -> None:
        registry = FakeEntityRegistry(
            [
                FakeRegistryEntry(
                    "sensor.my_custom_solar_today", f"{ENTRY_ID}_energy_production_today"
                ),
            ]
        )
        self._patch_registry(registry)
        hass = FakeHass(registry)
        entry = FakeConfigEntry(version=1)

        await self.helman_init.async_migrate_entry(hass, entry)

        (migrated,) = registry.entries_for_config_entry(ENTRY_ID)
        # The unique id still moves -- that is what keeps the registry entry
        # matched to the entity `sensor.py` creates on the next load -- but the
        # user's chosen entity id is never touched.
        self.assertEqual(migrated.entity_id, "sensor.my_custom_solar_today")
        self.assertEqual(migrated.unique_id, f"{ENTRY_ID}_solar_forecast_today")

    async def test_battery_time_unique_id_is_fixed_without_renaming_the_entity_id(
        self,
    ) -> None:
        # The pre-existing bug: the unique id suffix was "battery_to_full",
        # missing "time_", even though the (name-derived) entity id was always
        # "helman_battery_time_to_full". Only the unique id needs migrating.
        registry = FakeEntityRegistry(
            [
                FakeRegistryEntry(
                    "sensor.helman_battery_time_to_full", f"{ENTRY_ID}_battery_to_full"
                ),
            ]
        )
        self._patch_registry(registry)
        hass = FakeHass(registry)
        entry = FakeConfigEntry(version=1)

        await self.helman_init.async_migrate_entry(hass, entry)

        (migrated,) = registry.entries_for_config_entry(ENTRY_ID)
        self.assertEqual(migrated.entity_id, "sensor.helman_battery_time_to_full")
        self.assertEqual(migrated.unique_id, f"{ENTRY_ID}_battery_time_to_full")

    async def test_unmeasured_entity_migrates_by_pattern(self) -> None:
        node_id = "sensor.jistic_zasuvky_spiz_a_jidelna_energy"
        old_entity_id = "sensor.helman_sensor_jistic_zasuvky_spiz_a_jidelna_energy_unmeasured_power"
        registry = FakeEntityRegistry(
            [
                FakeRegistryEntry(old_entity_id, f"{ENTRY_ID}_{node_id}_unmeasured_power"),
                FakeRegistryEntry(
                    "sensor.helman_house_unmeasured_power", f"{ENTRY_ID}_house_unmeasured_power"
                ),
            ]
        )
        self._patch_registry(registry)
        hass = FakeHass(registry)
        entry = FakeConfigEntry(version=1)

        await self.helman_init.async_migrate_entry(hass, entry)

        entries = {e.unique_id: e for e in registry.entries_for_config_entry(ENTRY_ID)}
        migrated = entries[f"{ENTRY_ID}_unmeasured_power_jistic_zasuvky_spiz_a_jidelna_energy"]
        self.assertEqual(
            migrated.entity_id,
            "sensor.helman_unmeasured_power_jistic_zasuvky_spiz_a_jidelna_energy",
        )
        root_migrated = entries[f"{ENTRY_ID}_unmeasured_power_house"]
        self.assertEqual(root_migrated.entity_id, "sensor.helman_unmeasured_power_house")

    async def test_unmeasured_entity_with_a_user_rename_is_left_alone(self) -> None:
        node_id = "house"
        registry = FakeEntityRegistry(
            [
                FakeRegistryEntry(
                    "sensor.my_unmeasured_house_load",
                    f"{ENTRY_ID}_{node_id}_unmeasured_power",
                ),
            ]
        )
        self._patch_registry(registry)
        hass = FakeHass(registry)
        entry = FakeConfigEntry(version=1)

        await self.helman_init.async_migrate_entry(hass, entry)

        (migrated,) = registry.entries_for_config_entry(ENTRY_ID)
        self.assertEqual(migrated.entity_id, "sensor.my_unmeasured_house_load")
        self.assertEqual(migrated.unique_id, f"{ENTRY_ID}_unmeasured_power_house")

    async def test_second_run_is_a_no_op(self) -> None:
        registry = FakeEntityRegistry(
            [
                FakeRegistryEntry(
                    "sensor.helman_production_total", f"{ENTRY_ID}_production_total"
                ),
            ]
        )
        self._patch_registry(registry)
        hass = FakeHass(registry)
        entry = FakeConfigEntry(version=1)

        await self.helman_init.async_migrate_entry(hass, entry)
        updates_after_first_run = list(registry.updates)
        self.assertTrue(updates_after_first_run)

        # A second run against an already-migrated entry (version bumped to 2
        # by the first run) is a genuine no-op: the function returns early.
        await self.helman_init.async_migrate_entry(hass, entry)
        self.assertEqual(registry.updates, updates_after_first_run)

        # Even re-run against a not-yet-bumped entry, the target state is
        # already reached, so no further registry writes happen.
        entry.version = 1
        await self.helman_init.async_migrate_entry(hass, entry)
        self.assertEqual(registry.updates, updates_after_first_run)


if __name__ == "__main__":
    unittest.main()
