from __future__ import annotations

from _fakes import FakeHass as SharedFakeHass

import json
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path

from _ha_stubs import stub_module

ROOT = Path(__file__).resolve().parents[1]


from custom_components.helman.const import (
    CARD_URL,
    PANEL_FRONTEND_URL_PATH,
    PANEL_ICON,
    PANEL_URL,
)
from custom_components.helman.frontend import (
    async_card_module_url,
    async_register_frontend,
)
from custom_components.helman.panel import async_register_panel, async_unregister_panel


class FakeHttp:
    def __init__(self) -> None:
        self.static_paths = []

    async def async_register_static_paths(self, configs) -> None:
        self.static_paths.extend(configs)


class FakeConfig:
    def path(self, part: str) -> str:
        return f"/config/{part}"


class FakeResources:
    """The storage-mode Lovelace resource collection, as frontend.py uses it.

    Including its field rename, which is the whole reason this fake models the
    write path rather than echoing what it was handed: Lovelace *takes* a
    resource's type as ``res_type`` and *stores* it as ``type``
    (``ResourceStorageCollection._process_create_data`` and ``._update_data``).
    A fake that kept the caller's spelling would let code that reads back the
    wrong key pass here and fail on every real installation.
    """

    def __init__(self) -> None:
        self.items: list[dict] = []
        # Stands in for a Lovelace that will not change a resource's type.
        self.ignore_res_type_updates = False

    async def async_get_info(self) -> dict:
        return {}

    def async_items(self) -> list[dict]:
        return list(self.items)

    async def async_create_item(self, data: dict) -> dict:
        item = {"id": f"res{len(self.items)}", **self._stored(data)}
        self.items.append(item)
        return item

    async def async_update_item(self, item_id: str, changes: dict) -> None:
        if self.ignore_res_type_updates:
            changes = {k: v for k, v in changes.items() if k != "res_type"}
        for item in self.items:
            if item["id"] == item_id:
                item.update(self._stored(changes))

    @staticmethod
    def _stored(data: dict) -> dict:
        """The item as Lovelace keeps it: ``res_type`` in, ``type`` out."""
        stored = dict(data)
        if "res_type" in stored:
            stored["type"] = stored.pop("res_type")
        return stored

    async def async_delete_item(self, item_id: str) -> None:
        self.items = [item for item in self.items if item["id"] != item_id]


class FakeLovelace:
    def __init__(self) -> None:
        self.resources = FakeResources()


class FakeHass(SharedFakeHass):
    def __init__(self) -> None:
        super().__init__()
        self.config = FakeConfig()
        self.http = FakeHttp()
        self.data = {}


class PanelTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.removed_panels = []
        self.calls = []

        async def register_panel(*args, **kwargs):
            self.calls.append((args, kwargs))

        async def get_integration(*args):
            return types.SimpleNamespace(version="1.2.3")

        for target, replacement in (
            ("custom_components.helman.panel.frontend.async_remove_panel", lambda _hass, path: self.removed_panels.append(path)),
            ("custom_components.helman.panel.panel_custom.async_register_panel", register_panel),
            ("custom_components.helman.frontend.async_get_integration", get_integration),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_register_panel_registers_static_bundle_and_admin_panel(self) -> None:
        hass = FakeHass()

        await async_register_panel(hass)

        self.assertEqual(len(hass.http.static_paths), 1)
        self.assertEqual(hass.http.static_paths[0].url_path, PANEL_URL)
        self.assertIn(
            "/config/custom_components/helman/frontend_compiled/helman-config-editor.js",
            hass.http.static_paths[0].path,
        )

        panel_custom_mod = types.SimpleNamespace(calls=self.calls)
        self.assertEqual(len(panel_custom_mod.calls), 1)
        _args, kwargs = panel_custom_mod.calls[0]
        self.assertTrue(kwargs["require_admin"])
        self.assertEqual(kwargs["frontend_url_path"], PANEL_FRONTEND_URL_PATH)
        self.assertEqual(kwargs["sidebar_icon"], PANEL_ICON)

    async def test_register_panel_hands_the_editor_the_versioned_card_url(self) -> None:
        """The URL in the panel config is the one Lovelace loads, stamp included.

        The editor imports it at runtime to embed the solar inspector, and the
        browser keys module identity on the URL -- so a stamp that drifted from
        the registered Lovelace resource would evaluate the card bundle a second
        time. Registered in setup order: the frontend creates the resource, then
        the panel passes on the URL of the resource that was actually created.
        """
        hass = FakeHass()
        hass.data["lovelace"] = FakeLovelace()

        await async_register_frontend(hass)
        await async_register_panel(hass)

        _args, kwargs = self.calls[0]
        expected = await async_card_module_url(hass)
        self.assertEqual(kwargs["config"], {"card_module_url": expected})
        self.assertTrue(expected.startswith(f"{CARD_URL}?v="))
        # The very URL the dashboard will import, not merely one of the same shape.
        self.assertEqual(
            [item["url"] for item in hass.data["lovelace"].resources.items],
            [expected],
        )

    async def test_register_frontend_upgrades_a_legacy_js_resource_to_a_module(
        self,
    ) -> None:
        """A leftover ``js`` resource is brought up to ``module``, then published.

        The deprecated type is loaded by a ``script`` tag, and a classic script
        and an ES module of one URL are two separate evaluations -- so the editor
        importing it as a module while Lovelace loads it as a script would define
        every custom element twice and break the dashboard's cards.
        """
        hass = FakeHass()
        lovelace = FakeLovelace()
        hass.data["lovelace"] = lovelace
        lovelace.resources.items.append({"id": "legacy", "type": "js", "url": CARD_URL})

        await async_register_frontend(hass)
        await async_register_panel(hass)

        self.assertEqual(
            lovelace.resources.items,
            [{"id": "legacy", "type": "module", "url": await async_card_module_url(hass)}],
        )
        _args, kwargs = self.calls[0]
        self.assertEqual(kwargs["config"], {"card_module_url": await async_card_module_url(hass)})

    async def test_register_panel_passes_no_card_url_when_the_resource_stays_classic(
        self,
    ) -> None:
        """If the type will not budge, the editor is told nothing rather than a guess."""
        hass = FakeHass()
        lovelace = FakeLovelace()
        hass.data["lovelace"] = lovelace
        lovelace.resources.items.append({"id": "legacy", "type": "js", "url": CARD_URL})
        # A Lovelace that accepts the URL change but not the type change.
        lovelace.resources.ignore_res_type_updates = True

        await async_register_frontend(hass)
        await async_register_panel(hass)

        _args, kwargs = self.calls[0]
        self.assertEqual(kwargs["config"], {})

    async def test_register_panel_passes_no_card_url_without_a_registered_resource(
        self,
    ) -> None:
        """No resource of ours, no URL for the editor to import.

        Under YAML-mode Lovelace the resource list is the user's, so the spelling
        they gave the card bundle is unknown here. Importing a differently spelled
        URL for the same file evaluates it twice, which redefines every custom
        element and breaks that page's dashboard cards -- so the editor is handed
        nothing and says so, rather than being handed a guess.
        """
        hass = FakeHass()  # no `lovelace` in hass.data: resources unavailable

        await async_register_frontend(hass)
        await async_register_panel(hass)

        _args, kwargs = self.calls[0]
        self.assertEqual(kwargs["config"], {})

    def test_manifest_orders_setup_after_lovelace(self) -> None:
        """The panel's config is a snapshot, so Lovelace has to be set up first.

        ``async_register_panel`` runs once and the config it passes is fixed for
        the lifetime of the install. If Helman were set up before Lovelace, the
        card resource would not exist yet, the snapshot would carry no URL, and
        the second registration attempt returns early -- leaving a storage-mode
        install showing the editor's "unavailable" message for good. Not a hard
        dependency: Helman itself does not need Lovelace.
        """
        manifest = json.loads((ROOT / "custom_components" / "helman" / "manifest.json").read_text())

        self.assertIn("lovelace", manifest.get("after_dependencies", []))
        self.assertNotIn("lovelace", manifest.get("dependencies", []))

    async def test_unregister_panel_removes_registered_panel(self) -> None:
        hass = FakeHass()
        await async_register_panel(hass)
        async_unregister_panel(hass)

        self.assertEqual(
            self.removed_panels,
            [PANEL_FRONTEND_URL_PATH],
        )

    async def test_register_panel_does_not_reregister_static_path_after_reload(self) -> None:
        hass = FakeHass()
        frontend_mod = types.SimpleNamespace(removed_panels=self.removed_panels)
        panel_custom_mod = types.SimpleNamespace(calls=self.calls)

        await async_register_panel(hass)
        async_unregister_panel(hass)
        await async_register_panel(hass)

        self.assertEqual(len(hass.http.static_paths), 1)
        self.assertEqual(frontend_mod.removed_panels, [PANEL_FRONTEND_URL_PATH])
        self.assertEqual(len(panel_custom_mod.calls), 2)


if __name__ == "__main__":
    unittest.main()
