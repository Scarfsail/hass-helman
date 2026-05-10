from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if "custom_components" not in sys.modules:
    custom_components_pkg = types.ModuleType("custom_components")
    sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

if "custom_components.helman" not in sys.modules:
    helman_pkg = types.ModuleType("custom_components.helman")
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]
    sys.modules["custom_components.helman"] = helman_pkg

if "homeassistant" not in sys.modules:
    ha_pkg = types.ModuleType("homeassistant")
    sys.modules["homeassistant"] = ha_pkg

core_mod = types.ModuleType("homeassistant.core")
core_mod.HomeAssistant = type("HomeAssistant", (), {})
sys.modules["homeassistant.core"] = core_mod

helpers_mod = types.ModuleType("homeassistant.helpers")
sys.modules["homeassistant.helpers"] = helpers_mod

storage_stub = types.ModuleType("homeassistant.helpers.storage")


class _DummyStore:
    def __init__(self, hass, version, key):
        pass

    async def async_load(self):
        return None

    async def async_save(self, data):
        pass


storage_stub.Store = _DummyStore
sys.modules["homeassistant.helpers.storage"] = storage_stub

from custom_components.helman.storage import HelmanStorage  # noqa: E402


class _FakeStore:
    def __init__(self) -> None:
        self.saved: list[dict] = []

    async def async_save(self, payload: dict) -> None:
        self.saved.append(payload)

    async def async_load(self) -> dict | None:
        return None


def test_save_snapshots_skips_when_unchanged(monkeypatch) -> None:
    storage = HelmanStorage.__new__(HelmanStorage)
    storage._snapshot_store = _FakeStore()
    storage._snapshot = None
    storage._solar_snapshot = None

    payload = {"a": 1}
    asyncio.run(storage.async_save_snapshots(house_snapshot=payload, solar_snapshot=None))
    asyncio.run(storage.async_save_snapshots(house_snapshot=payload, solar_snapshot=None))
    assert len(storage._snapshot_store.saved) == 1
