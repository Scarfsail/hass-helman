# Phase 3: Device Tree Construction in Backend

## Goal
Move the four-WebSocket-call registry lookup and tree-construction logic
(currently `fetchDeviceTree()` in `energy-data-helper.ts`) into the backend
Python component. The frontend requests the pre-built tree with a single
`helman/get_device_tree` command.

## Background: Current Cost

On every card connect (or page reload), the frontend fires **4 parallel WebSocket
calls** and then processes the results into a tree:

```
energy/get_prefs           → energy sources + device consumption hierarchy
config/entity_registry/list → all entities (device_id, labels, entity_id)
config/device_registry/list → all devices (id, name)
config/label_registry/list  → label id → name mapping
```

This data is then cross-referenced in ~180 lines of TypeScript to produce the
`DeviceNode[]` tree. The backend already has direct in-process access to all four
registries with no WebSocket overhead.

## Deliverables

- `tree_builder.py`: Python class that builds the `DeviceNode` tree
- `websockets.py`: Add `helman/get_device_tree` WS command
- `coordinator.py`: Central coordinator that rebuilds the tree on config change
- Frontend `energy-data-helper.ts`: Replace `fetchDeviceTree()` with `fetchDeviceTreeFromBackend()`

## Tree Data Model (Python → JSON)

The JSON payload sent to the frontend mirrors the `DeviceNode` interface:

```typescript
// TypeScript interface for the WS response
interface DeviceTreePayload {
  sources: DeviceNodeDTO[];
  consumers: DeviceNodeDTO[];
}

interface DeviceNodeDTO {
  id: string;                // unique stable ID (device_id or synthetic ID)
  displayName: string;       // cleaned device name
  powerSensorId: string | null;
  switchEntityId: string | null;
  isSource: boolean;
  isUnmeasured: boolean;
  isVirtual: boolean;
  valueType: "default" | "positive" | "negative";
  labels: string[];          // HA label names on this device
  labelBadgeTexts: string[]; // mapped badge texts from device_label_text config
  sourceConfig: SolarConfig | GridConfig | BatteryConfig | HouseConfig | null;
  children: DeviceNodeDTO[];
}
```

The `labelBadgeTexts` field is computed server-side using the `device_label_text`
map from the backend config, so the frontend does not need to perform that mapping.

## Backend: `tree_builder.py`

```python
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any, Literal
from homeassistant.core import HomeAssistant

@dataclass
class DeviceNodeDTO:
    id: str
    display_name: str
    power_sensor_id: str | None
    switch_entity_id: str | None
    is_source: bool
    is_unmeasured: bool
    is_virtual: bool
    value_type: Literal["default", "positive", "negative"]
    labels: list[str]
    label_badge_texts: list[str]
    source_config: dict | None
    children: list["DeviceNodeDTO"] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["children"] = [c.to_dict() for c in self.children]
        return d


class HelmanTreeBuilder:
    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self._hass = hass
        self._config = config

    async def build(self) -> dict:
        """Build and return the full device tree as a serializable dict."""
        energy_prefs = await self._hass.connection.async_send_command({
            "type": "energy/get_prefs"
        })
        entity_registry = self._hass.data["entity_registry"]
        device_registry = self._hass.data["device_registry"]
        label_registry = self._hass.data["label_registry"]

        # ... tree construction logic ported from energy-data-helper.ts ...
        # Returns {"sources": [...], "consumers": [...]}
        return {
            "sources": [...],
            "consumers": [...],
        }

    def _build_house_node(self, device_consumption, entity_registry, ...) -> DeviceNodeDTO:
        # Port of fetchDeviceTree house subtree logic
        pass

    def _resolve_labels(self, device_id: str, entity_registry, label_registry) -> list[str]:
        # Port of label resolution logic
        pass

    def _apply_label_badge_texts(self, labels: list[str]) -> list[str]:
        # Uses device_label_text from config
        label_map = self._config.get("device_label_text", {})
        result = []
        for category_map in label_map.values():
            for label, badge_text in category_map.items():
                if label in labels:
                    result.append(badge_text)
        return result

    def _clean_device_name(self, name: str) -> str:
        import re
        pattern = self._config.get("power_sensor_name_cleaner_regex", "")
        if pattern:
            return re.sub(pattern, "", name).strip()
        return name
```

**Important note on HA registry access**: In HA's Python environment, registries are
accessed via the `er` (entity registry), `dr` (device registry), and `lr` (label
registry) helpers:

```python
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import device_registry as dr

ent_reg = er.async_get(hass)
dev_reg = dr.async_get(hass)
```

The energy prefs still require a WebSocket call (to the internal HA websocket
handler) or direct database access via the recorder. The simplest approach is to
use `hass.async_create_task` to call the existing `energy/get_prefs` handler
internally, or to import the relevant energy module directly.

## Backend: WebSocket Command

```python
@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_device_tree",
})
@websocket_api.async_response
async def ws_get_device_tree(hass, connection, msg):
    coordinator: HelmanCoordinator = hass.data[DOMAIN][entry_id]["coordinator"]
    tree = await coordinator.get_device_tree()
    connection.send_result(msg["id"], tree)
```

The coordinator caches the tree and rebuilds it only when:
- The config changes (via `helman/save_config`)
- The energy prefs change (HA event `energy_prefs_updated`)
- A device or entity is added/removed (HA events `entity_registry_updated`,
  `device_registry_updated`)

## Frontend: Replace `fetchDeviceTree()`

In `energy-data-helper.ts`, replace the current `fetchDeviceTree()` function:

```typescript
// BEFORE (4 parallel WS calls + tree construction in TS):
async function fetchDeviceTree(hass, config): Promise<DeviceNode[]> {
  const [energyPrefs, entityRegistry, deviceRegistry, labelRegistry] =
    await Promise.all([
      hass.connection.sendMessagePromise({ type: "energy/get_prefs" }),
      hass.connection.sendMessagePromise({ type: "config/entity_registry/list" }),
      hass.connection.sendMessagePromise({ type: "config/device_registry/list" }),
      hass.connection.sendMessagePromise({ type: "config/label_registry/list" }),
    ]);
  return buildTree(energyPrefs, entityRegistry, deviceRegistry, labelRegistry, config);
}

// AFTER (1 WS call, tree built server-side):
async function fetchDeviceTreeFromBackend(hass): Promise<DeviceNode[]> {
  const payload = await hass.connection.sendMessagePromise({
    type: "helman/get_device_tree",
  });
  return hydrateDeviceNodes(payload.sources, payload.consumers);
}
```

The `hydrateDeviceNodes()` function converts DTOs back into `DeviceNode` instances
(which hold live power state) without re-doing the registry lookups.

## Tree Rebuild Triggers (Backend)

```python
class HelmanCoordinator:
    def __init__(self, hass, config):
        self._hass = hass
        self._config = config
        self._cached_tree: dict | None = None
        self._builder = HelmanTreeBuilder(hass, config)

    async def async_setup(self):
        # Listen for registry changes that invalidate the tree
        self._hass.bus.async_listen(
            "entity_registry_updated", self._on_registry_updated
        )
        self._hass.bus.async_listen(
            "device_registry_updated", self._on_registry_updated
        )

    @callback
    def _on_registry_updated(self, event):
        self._cached_tree = None   # invalidate; rebuilt on next get_device_tree call

    async def get_device_tree(self) -> dict:
        if self._cached_tree is None:
            self._cached_tree = await self._builder.build()
        return self._cached_tree
```

## Fallback (No Backend)

In the frontend `energy-data-helper.ts`, check for backend availability before
deciding which fetch path to use:

```typescript
async function fetchSourceAndConsumerRoots(hass, config) {
  if (hass.states["sensor.helman_power_summary"]) {
    return fetchDeviceTreeFromBackend(hass);
  }
  // Legacy path: 4 WS calls
  return fetchDeviceTreeLegacy(hass, config);
}
```

## Startup Latency Improvement

| Scenario | Before | After |
|---|---|---|
| Card first load | 4 parallel WS calls + ~180 lines TS processing | 1 WS call |
| Second dashboard view | Same 4 calls again | Cache hit – near-instant |
| Registry change | Full tree rebuild in TS | Backend cache invalidated, rebuilt once |

## Commit Sequence
```
feat(tree-builder): port device tree construction to Python HelmanTreeBuilder
feat(coordinator): add HelmanCoordinator with cached device tree and registry listeners
feat(websockets): add helman/get_device_tree WS command
feat(card): add backend device tree fetch with legacy fallback
```
