from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path

from _ha_stubs import stub_module

ROOT = Path(__file__).resolve().parents[1]


def _load_helman_init_with_stubs():
    for module_name in list(sys.modules):
        if module_name == "custom_components.helman" or module_name.startswith(
            "custom_components.helman."
        ):
            sys.modules.pop(module_name)

    stub_module("custom_components", __path__=[str(ROOT / "custom_components")])
    import homeassistant.config_entries  # type: ignore  # noqa: F401

    # Use the real ``homeassistant.core``: a partial stub shadows it and breaks
    # the many transitive ``from homeassistant.core import ...`` in real HA helpers.
    import homeassistant.core  # type: ignore  # noqa: F401

    frontend_mod = types.ModuleType("custom_components.helman.frontend")

    async def async_register_frontend(_hass) -> None:
        return None

    async def async_unregister_frontend(_hass) -> None:
        return None

    frontend_mod.async_register_frontend = async_register_frontend
    frontend_mod.async_unregister_frontend = async_unregister_frontend
    sys.modules["custom_components.helman.frontend"] = frontend_mod

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

    group_services_mod = types.ModuleType("custom_components.helman.group_services")
    group_services_mod.register_calls = 0
    group_services_mod.schema_updates = 0

    async def async_register_group_services(_hass) -> None:
        group_services_mod.register_calls += 1

    def async_update_group_service_schemas(_hass) -> None:
        group_services_mod.schema_updates += 1

    group_services_mod.async_register_group_services = async_register_group_services
    group_services_mod.async_update_group_service_schemas = (
        async_update_group_service_schemas
    )
    sys.modules["custom_components.helman.group_services"] = group_services_mod

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
    return (
        module,
        panel_mod,
        websockets_mod,
        storage_mod,
        coordinator_mod,
        group_services_mod,
    )


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
            self.group_services_mod,
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
