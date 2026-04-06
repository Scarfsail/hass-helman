from __future__ import annotations

import sys
import types
import unittest
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

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    frontend_mod = sys.modules.get("homeassistant.components.frontend")
    if frontend_mod is None:
        frontend_mod = types.ModuleType("homeassistant.components.frontend")
        sys.modules["homeassistant.components.frontend"] = frontend_mod
    frontend_mod.removed_panels = []

    def async_remove_panel(_hass, path):
        frontend_mod.removed_panels.append(path)

    frontend_mod.async_remove_panel = async_remove_panel

    panel_custom_mod = sys.modules.get("homeassistant.components.panel_custom")
    if panel_custom_mod is None:
        panel_custom_mod = types.ModuleType("homeassistant.components.panel_custom")
        sys.modules["homeassistant.components.panel_custom"] = panel_custom_mod
    panel_custom_mod.calls = []

    async def async_register_panel(*args, **kwargs):
        panel_custom_mod.calls.append((args, kwargs))

    panel_custom_mod.async_register_panel = async_register_panel

    http_mod = sys.modules.get("homeassistant.components.http")
    if http_mod is None:
        http_mod = types.ModuleType("homeassistant.components.http")
        sys.modules["homeassistant.components.http"] = http_mod

    class StaticPathConfig:
        def __init__(self, url_path, path, cache_headers=False) -> None:
            self.url_path = url_path
            self.path = path
            self.cache_headers = cache_headers

    http_mod.StaticPathConfig = StaticPathConfig

    components_pkg.frontend = frontend_mod
    components_pkg.panel_custom = panel_custom_mod
    components_pkg.http = http_mod


_install_import_stubs()

from custom_components.helman.const import PANEL_FRONTEND_URL_PATH, PANEL_ICON, PANEL_URL
from custom_components.helman.panel import async_register_panel, async_unregister_panel


class FakeHttp:
    def __init__(self) -> None:
        self.static_paths = []

    async def async_register_static_paths(self, configs) -> None:
        self.static_paths.extend(configs)


class FakeConfig:
    def path(self, part: str) -> str:
        return f"/config/{part}"


class FakeHass:
    def __init__(self) -> None:
        self.config = FakeConfig()
        self.http = FakeHttp()
        self.data = {}


class PanelTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        sys.modules["homeassistant.components.frontend"].removed_panels.clear()
        sys.modules["homeassistant.components.panel_custom"].calls.clear()

    async def test_register_panel_registers_static_bundle_and_admin_panel(self) -> None:
        hass = FakeHass()

        await async_register_panel(hass)

        self.assertEqual(len(hass.http.static_paths), 1)
        self.assertEqual(hass.http.static_paths[0].url_path, PANEL_URL)
        self.assertIn(
            "/config/custom_components/helman/frontend/dist/helman-config-editor.js",
            hass.http.static_paths[0].path,
        )

        panel_custom_mod = sys.modules["homeassistant.components.panel_custom"]
        self.assertEqual(len(panel_custom_mod.calls), 1)
        _args, kwargs = panel_custom_mod.calls[0]
        self.assertTrue(kwargs["require_admin"])
        self.assertEqual(kwargs["frontend_url_path"], PANEL_FRONTEND_URL_PATH)
        self.assertEqual(kwargs["sidebar_icon"], PANEL_ICON)

    async def test_unregister_panel_removes_registered_panel(self) -> None:
        hass = FakeHass()
        await async_register_panel(hass)
        async_unregister_panel(hass)

        self.assertEqual(
            sys.modules["homeassistant.components.frontend"].removed_panels,
            [PANEL_FRONTEND_URL_PATH],
        )

    async def test_register_panel_does_not_reregister_static_path_after_reload(self) -> None:
        hass = FakeHass()
        frontend_mod = sys.modules["homeassistant.components.frontend"]
        panel_custom_mod = sys.modules["homeassistant.components.panel_custom"]

        await async_register_panel(hass)
        async_unregister_panel(hass)
        await async_register_panel(hass)

        self.assertEqual(len(hass.http.static_paths), 1)
        self.assertEqual(frontend_mod.removed_panels, [PANEL_FRONTEND_URL_PATH])
        self.assertEqual(len(panel_custom_mod.calls), 2)


if __name__ == "__main__":
    unittest.main()
