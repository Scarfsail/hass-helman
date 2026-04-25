from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    config_entries_mod = types.ModuleType("homeassistant.config_entries")
    config_entries_mod.ConfigEntry = type("ConfigEntry", (), {})
    sys.modules["homeassistant.config_entries"] = config_entries_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    panel_mod = types.ModuleType("custom_components.helman.panel")
    panel_mod.register_calls = 0

    async def async_register_panel(_hass) -> None:
        panel_mod.register_calls += 1

    panel_mod.async_register_panel = async_register_panel
    sys.modules["custom_components.helman.panel"] = panel_mod

    websockets_mod = types.ModuleType("custom_components.helman.websockets")
    websockets_mod.register_calls = 0

    def async_register_websocket_commands(_hass) -> None:
        websockets_mod.register_calls += 1

    websockets_mod.async_register_websocket_commands = async_register_websocket_commands
    sys.modules["custom_components.helman.websockets"] = websockets_mod

    storage_mod = types.ModuleType("custom_components.helman.storage")

    class HelmanStorage:
        load_calls = 0

        def __init__(self, _hass) -> None:
            self.loaded = False

        async def async_load(self) -> None:
            self.loaded = True
            type(self).load_calls += 1

    storage_mod.HelmanStorage = HelmanStorage
    sys.modules["custom_components.helman.storage"] = storage_mod

    coordinator_mod = types.ModuleType("custom_components.helman.coordinator")

    class HelmanCoordinator:
        fail_setup = False
        unload_calls = 0

        def __init__(self, _hass, storage) -> None:
            self.storage = storage

        async def async_setup(self) -> None:
            if type(self).fail_setup:
                raise RuntimeError("coordinator setup failed")

        async def async_unload(self) -> None:
            type(self).unload_calls += 1

    coordinator_mod.HelmanCoordinator = HelmanCoordinator
    sys.modules["custom_components.helman.coordinator"] = coordinator_mod

    module = importlib.import_module("custom_components.helman")
    return module, panel_mod, websockets_mod, storage_mod, coordinator_mod


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


class FakeHass:
    def __init__(self) -> None:
        self.data: dict = {}
        self.config_entries = FakeConfigEntries()


class InitRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        (
            self.helman_init,
            self.panel_mod,
            self.websockets_mod,
            self.storage_mod,
            self.coordinator_mod,
        ) = _load_helman_init_with_stubs()
        self.storage_mod.HelmanStorage.load_calls = 0
        self.coordinator_mod.HelmanCoordinator.fail_setup = False
        self.coordinator_mod.HelmanCoordinator.unload_calls = 0
        self.panel_mod.register_calls = 0

    async def test_async_setup_initializes_storage_and_panel(self) -> None:
        hass = FakeHass()

        result = await self.helman_init.async_setup(hass, {})

        self.assertTrue(result)
        self.assertIn("helman", hass.data)
        self.assertIn("storage", hass.data["helman"])
        self.assertEqual(self.storage_mod.HelmanStorage.load_calls, 1)
        self.assertEqual(self.panel_mod.register_calls, 1)
        self.assertEqual(self.websockets_mod.register_calls, 1)

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

        result = await self.helman_init.async_unload_entry(hass, FakeConfigEntry())

        self.assertTrue(result)
        self.assertIn("storage", hass.data["helman"])
        self.assertNotIn("coordinator", hass.data["helman"])
        self.assertNotIn("entry-1", hass.data["helman"])
        self.assertEqual(self.coordinator_mod.HelmanCoordinator.unload_calls, 1)


if __name__ == "__main__":
    unittest.main()
