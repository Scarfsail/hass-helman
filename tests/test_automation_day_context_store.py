from __future__ import annotations

import asyncio
import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
PRAGUE = ZoneInfo("Europe/Prague")
_NOW = datetime(2026, 7, 10, 12, 0, tzinfo=PRAGUE)


class _FakeStore:
    def __init__(self, *args, **kwargs) -> None:
        self.saved: object = None

    async def async_load(self) -> object:
        return self.saved

    async def async_save(self, data: object) -> None:
        self.saved = data


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

    automation_pkg = sys.modules.get("custom_components.helman.automation")
    if automation_pkg is None:
        automation_pkg = types.ModuleType("custom_components.helman.automation")
        sys.modules["custom_components.helman.automation"] = automation_pkg
    automation_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "automation")
    ]

    def _ensure(name: str) -> types.ModuleType:
        mod = sys.modules.get(name)
        if mod is None:
            mod = types.ModuleType(name)
            sys.modules[name] = mod
        return mod

    homeassistant_pkg = _ensure("homeassistant")
    core_mod = _ensure("homeassistant.core")
    core_mod.HomeAssistant = object
    helpers_pkg = _ensure("homeassistant.helpers")
    storage_mod = _ensure("homeassistant.helpers.storage")
    storage_mod.Store = _FakeStore
    helpers_pkg.storage = storage_mod
    homeassistant_pkg.helpers = helpers_pkg

    util_pkg = _ensure("homeassistant.util")
    dt_mod = _ensure("homeassistant.util.dt")

    def _as_local(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=PRAGUE)
        return value.astimezone(PRAGUE)

    dt_mod.as_local = _as_local
    dt_mod.as_utc = lambda v: v.astimezone(timezone.utc) if v.tzinfo else v.replace(
        tzinfo=timezone.utc
    )
    dt_mod.parse_datetime = datetime.fromisoformat
    dt_mod.now = lambda: _NOW
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.day_context import (  # noqa: E402
    DayMinWindow,
    FrozenDayContext,
)
from custom_components.helman.automation.day_context_store import (  # noqa: E402
    DayContextStore,
)

TODAY = date(2026, 7, 10)


def _window() -> DayMinWindow:
    start = datetime(2026, 7, 10, 13, 0, tzinfo=PRAGUE)
    return DayMinWindow(start=start, end=start + timedelta(minutes=30))


class DayContextStoreTests(unittest.TestCase):
    def test_first_run_persists_then_reuses(self) -> None:
        async def scenario() -> None:
            store = DayContextStore(hass=object())
            self.assertEqual(await store.async_load(), {})
            await store.async_freeze_and_prune(
                computed={
                    TODAY: FrozenDayContext(
                        classification="surplus", day_min_window=_window()
                    )
                },
                today=TODAY,
            )
            # A fresh store instance reading the same backing save reuses it.
            reloaded = await store.async_load()
            self.assertIn(TODAY, reloaded)
            self.assertEqual(reloaded[TODAY].classification, "surplus")
            self.assertEqual(reloaded[TODAY].day_min_window, _window())

        asyncio.run(scenario())

    def test_existing_record_is_not_overwritten(self) -> None:
        async def scenario() -> None:
            store = DayContextStore(hass=object())
            await store.async_load()
            await store.async_freeze_and_prune(
                computed={
                    TODAY: FrozenDayContext(
                        classification="surplus", day_min_window=_window()
                    )
                },
                today=TODAY,
            )
            await store.async_load()
            # Re-freeze with a different classification: existing day is kept.
            await store.async_freeze_and_prune(
                computed={
                    TODAY: FrozenDayContext(
                        classification="deficit", day_min_window=None
                    )
                },
                today=TODAY,
            )
            reloaded = await store.async_load()
            self.assertEqual(reloaded[TODAY].classification, "surplus")

        asyncio.run(scenario())

    def test_prunes_past_days(self) -> None:
        async def scenario() -> None:
            store = DayContextStore(hass=object())
            await store.async_load()
            await store.async_freeze_and_prune(
                computed={
                    TODAY: FrozenDayContext(
                        classification="surplus", day_min_window=_window()
                    )
                },
                today=TODAY,
            )
            await store.async_load()
            tomorrow = TODAY + timedelta(days=1)
            await store.async_freeze_and_prune(
                computed={
                    tomorrow: FrozenDayContext(
                        classification="tight", day_min_window=None
                    )
                },
                today=tomorrow,
            )
            reloaded = await store.async_load()
            self.assertNotIn(TODAY, reloaded)
            self.assertIn(tomorrow, reloaded)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
