from __future__ import annotations

from _fakes import FakeHass as SharedFakeHass

import importlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class _FakeStorage:
    load_calls = 0

    def __init__(self, _hass) -> None:
        self.loaded = False

    async def async_load(self) -> None:
        self.loaded = True
        type(self).load_calls += 1


class _FakeCoordinator:
    fail_setup = False
    unload_calls = 0

    def __init__(self, _hass, storage) -> None:
        self.storage = storage

    async def async_setup(self) -> None:
        if type(self).fail_setup:
            raise RuntimeError("coordinator setup failed")

    async def async_unload(self) -> None:
        type(self).unload_calls += 1


class FakeConfigEntry:
    def __init__(self, entry_id: str = "entry-1") -> None:
        self.entry_id = entry_id


class FakeConfigEntries:
    def __init__(self) -> None:
        self.forward_calls: list[tuple[str, tuple[str, ...]]] = []
        self.unload_calls: list[tuple[str, tuple[str, ...]]] = []

    async def async_forward_entry_setups(self, entry, platforms) -> None:
        self.forward_calls.append((entry.entry_id, tuple(platforms)))

    async def async_unload_platforms(self, entry, platforms) -> bool:
        self.unload_calls.append((entry.entry_id, tuple(platforms)))
        return True


class FakeHass(SharedFakeHass):
    def __init__(self) -> None:
        super().__init__()
        self.data: dict = {}
        self.config_entries = FakeConfigEntries()


class InitRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.helman_init = importlib.import_module("custom_components.helman")
        self.panel_mod = SimpleNamespace(register_calls=0)
        self.websockets_mod = SimpleNamespace(register_calls=0)
        self.group_services_mod = SimpleNamespace(register_calls=0, schema_updates=0)
        self.storage_mod = SimpleNamespace(HelmanStorage=_FakeStorage)
        self.coordinator_mod = SimpleNamespace(HelmanCoordinator=_FakeCoordinator)
        _FakeStorage.load_calls = 0
        _FakeCoordinator.fail_setup = False
        _FakeCoordinator.unload_calls = 0

        async def register_panel(_hass):
            self.panel_mod.register_calls += 1

        def register_websockets(_hass):
            self.websockets_mod.register_calls += 1

        async def register_services(_hass):
            self.group_services_mod.register_calls += 1

        def update_schemas(_hass):
            self.group_services_mod.schema_updates += 1

        async def nothing(_hass):
            return None

        replacements = {
            "HelmanStorage": _FakeStorage,
            "HelmanCoordinator": _FakeCoordinator,
            "async_register_panel": register_panel,
            "async_register_websocket_commands": register_websockets,
            "async_register_group_services": register_services,
            "async_update_group_service_schemas": update_schemas,
            "async_register_frontend": nothing,
            "async_unregister_frontend": nothing,
        }
        for name, replacement in replacements.items():
            self.enterContext(patch.object(self.helman_init, name, replacement))

    async def test_async_setup_initializes_storage_and_panel(self) -> None:
        hass = FakeHass()

        result = await self.helman_init.async_setup(hass, {})

        self.assertTrue(result)
        self.assertIn("helman", hass.data)
        self.assertIn("storage", hass.data["helman"])
        self.assertEqual(self.storage_mod.HelmanStorage.load_calls, 1)
        self.assertEqual(self.panel_mod.register_calls, 1)
        self.assertEqual(self.websockets_mod.register_calls, 1)
        self.assertEqual(self.group_services_mod.register_calls, 1)

    async def test_setup_entry_failure_keeps_storage_available_for_recovery(self) -> None:
        hass = FakeHass()
        await self.helman_init.async_setup(hass, {})
        self.coordinator_mod.HelmanCoordinator.fail_setup = True

        with self.assertRaisesRegex(RuntimeError, "coordinator setup failed"):
            await self.helman_init.async_setup_entry(hass, FakeConfigEntry())

        self.assertIn("storage", hass.data["helman"])
        self.assertNotIn("coordinator", hass.data["helman"])
        self.assertNotIn("entry-1", hass.data["helman"])

    async def test_async_unload_entry_keeps_storage_after_runtime_unload(self) -> None:
        hass = FakeHass()
        await self.helman_init.async_setup(hass, {})
        await self.helman_init.async_setup_entry(hass, FakeConfigEntry())
        self.assertEqual(self.group_services_mod.schema_updates, 1)

        result = await self.helman_init.async_unload_entry(hass, FakeConfigEntry())

        self.assertTrue(result)
        self.assertIn("storage", hass.data["helman"])
        self.assertNotIn("coordinator", hass.data["helman"])
        self.assertNotIn("entry-1", hass.data["helman"])
        self.assertEqual(self.coordinator_mod.HelmanCoordinator.unload_calls, 1)

    async def test_async_unload_entry_drops_the_recorder_probe_cache(self) -> None:
        """A reload starts asking the recorder again rather than inheriting answers.

        Where each entity's raw history begins is cached for hours, which is
        what keeps the probe off every request -- and exactly why it must not
        survive the entry that filled it: a reload is how a changed
        configuration takes effect, and the entities being asked about may not
        be the same ones any more.
        """
        span_mod = importlib.import_module(
            "custom_components.helman.recorder_statistics_span"
        )
        hass = FakeHass()
        await self.helman_init.async_setup(hass, {})
        await self.helman_init.async_setup_entry(hass, FakeConfigEntry())
        hass.data["helman"][span_mod._OLDEST_STATE_CACHE_KEY] = {"sensor.a": object()}

        await self.helman_init.async_unload_entry(hass, FakeConfigEntry())

        self.assertNotIn(span_mod._OLDEST_STATE_CACHE_KEY, hass.data["helman"])


if __name__ == "__main__":
    unittest.main()
