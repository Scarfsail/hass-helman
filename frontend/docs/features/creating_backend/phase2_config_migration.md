# Phase 2: Configuration Migration

## Goal
Move all helman-card YAML configuration into the backend integration's persistent
storage. The frontend card discovers the config from the backend via a custom
WebSocket command, so users configure the integration once and all cards (on any
dashboard) pick it up automatically.

## Background: Current Config Location

All configuration currently lives in the Lovelace card YAML:
```yaml
type: custom:helman-card
power_sensor_name_cleaner_regex: " Výkon$"
history_buckets: 60
history_bucket_duration: 1
sources_title: "Zdroje energie"
# ... 50+ more lines
```

Every Lovelace view that uses the card requires the full config to be copied.

## Deliverables
- `storage.py`: `HelmanStorage` class wrapping `homeassistant.helpers.storage.Store`
- `websockets.py`: `helman/get_config` and `helman/save_config` WebSocket commands
- Updated `__init__.py`: wire storage and WebSocket registration
- Frontend: new `config-loader.ts` that fetches config via WS on first connect

## Backend: `storage.py`

```python
from __future__ import annotations
from typing import Any
from homeassistant.helpers import storage
from homeassistant.core import HomeAssistant
from .const import DOMAIN, STORAGE_VERSION, STORAGE_KEY

DEFAULT_CONFIG: dict[str, Any] = {
    "history_buckets": 60,
    "history_bucket_duration": 1,
    "sources_title": "Energy Sources",
    "consumers_title": "Energy Consumers",
    "others_group_label": "Others",
    "groups_title": "Group by:",
    "device_label_text": {},
    "power_devices": {},
}

class HelmanStorage:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store = storage.Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._config: dict[str, Any] = {}

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        self._config = {**DEFAULT_CONFIG, **(stored or {})}

    @property
    def config(self) -> dict[str, Any]:
        return self._config

    async def async_save(self, new_config: dict[str, Any]) -> None:
        self._config = new_config
        await self._store.async_save(new_config)
```

## Backend: `websockets.py`

```python
from __future__ import annotations
import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.components.websocket_api import async_register_command
from .const import DOMAIN

def async_register_websocket_commands(hass: HomeAssistant) -> None:
    async_register_command(hass, ws_get_config)
    async_register_command(hass, ws_save_config)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_config",
})
@callback
def ws_get_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    storage: HelmanStorage = hass.data[DOMAIN]["storage"]
    connection.send_result(msg["id"], storage.config)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/save_config",
    vol.Required("config"): dict,
})
@websocket_api.async_response
async def ws_save_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    storage: HelmanStorage = hass.data[DOMAIN]["storage"]
    await storage.async_save(msg["config"])
    connection.send_result(msg["id"], {"success": True})
```

Note: `ws_save_config` is async (uses `@async_response`) because it awaits the disk
write. `ws_get_config` is synchronous `@callback` since reading from memory is
non-blocking.

## Updated `__init__.py`

```python
from .storage import HelmanStorage
from .websockets import async_register_websocket_commands

async def async_setup_entry(hass, entry):
    hass.data.setdefault(DOMAIN, {})

    storage = HelmanStorage(hass)
    await storage.async_load()

    hass.data[DOMAIN][entry.entry_id] = {"storage": storage}

    async_register_websocket_commands(hass)
    return True
```

## Frontend: Config Fetch on Connect

Add `src/config-loader.ts`:

```typescript
import type { HomeAssistant } from "../hass-frontend/src/types";
import type { HelmanCardConfig } from "./HelmanCardConfig";

const BACKEND_AVAILABLE_ENTITY = "sensor.helman_power_summary";

export async function loadConfig(
  hass: HomeAssistant,
  cardConfig: HelmanCardConfig
): Promise<HelmanCardConfig> {
  // Phase 2: check if backend is available
  if (!hass.states[BACKEND_AVAILABLE_ENTITY]) {
    // Legacy mode: use card YAML config as-is
    return cardConfig;
  }

  const result = await hass.connection.sendMessagePromise({
    type: "helman/get_config",
  });

  // Merge: backend config takes precedence, but card YAML overrides
  // allow per-card UI overrides (e.g. sources_title) during migration
  return { ...result, ...cardConfig };
}
```

The merge strategy allows gradual migration: users can still override individual
keys in YAML during the transition period.

## Migration Path for Users

To migrate their existing YAML config to the backend:
1. Install `hass-helman` integration.
2. A one-time migration helper reads the current card config and calls
   `helman/save_config`. (Can be triggered manually via a button in the card
   while developer tools are open, or via a service call.)
3. After confirming the backend works, strip the YAML to just `entity: sensor.helman_power_summary`.

## Config Schema Validation (backend)

In a future iteration, add `voluptuous` validation in `async_save`:

```python
CONFIG_SCHEMA = vol.Schema({
    vol.Optional("history_buckets", default=60): vol.All(int, vol.Range(min=1, max=300)),
    vol.Optional("history_bucket_duration", default=1): vol.All(int, vol.Range(min=1)),
    vol.Optional("sources_title", default=""): str,
    # ... etc
    vol.Optional("power_devices", default={}): dict,
    vol.Optional("device_label_text", default={}): dict,
}, extra=vol.ALLOW_EXTRA)
```

## Commit Sequence
```
feat(storage): add HelmanStorage for persistent config via HA storage.Store
feat(websockets): add helman/get_config and helman/save_config WS commands
feat(card): add config-loader with backend-first, YAML-fallback config resolution
```
