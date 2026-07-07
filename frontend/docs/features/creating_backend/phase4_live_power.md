# Phase 4: Live Power – Replace setInterval with Entity State Push

## Goal
Replace the frontend's `setInterval` polling with a push-based mechanism. The
backend subscribes to power sensor state changes using HA's
`async_track_state_change_event` and writes the current power snapshot to a sensor
entity's `extra_state_attributes`. The card's existing `hass` setter receives
updates automatically, eliminating the need for any polling interval.

## Background: Current Mechanism

The frontend currently:
1. Sets `setInterval(updateLivePower, bucketDuration * 1000)` in `connectedCallback`
2. On each tick: reads `hass.states[powerSensorId].state` for every tracked entity
3. Updates `DeviceNode.powerValue` and appends to `DeviceNode.powerHistory[]`
4. Calls `requestUpdate()` on the root card to trigger re-render

This runs in the browser, even when the dashboard is in a background tab.

## Deliverables

- `sensor.py`: `HelmanPowerSummarySensor` entity
- `coordinator.py`: Power tracking logic using `async_track_state_change_event`
- Updated `__init__.py`: forward setup to sensor platform
- Frontend `helman-card.ts`: Read live power from sensor attributes; remove `setInterval`

## Backend: `sensor.py`

```python
from __future__ import annotations
from homeassistant.components.sensor import SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from .const import DOMAIN

async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([HelmanPowerSummarySensor(coordinator, entry)])


class HelmanPowerSummarySensor(SensorEntity):
    _attr_should_poll = False   # push-based; no periodic poll
    _attr_has_entity_name = True
    _attr_name = "Power Summary"

    def __init__(self, coordinator, entry):
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_power_summary"
        self._snapshot: dict = {}

    @property
    def state(self) -> str:
        """Returns total house consumption as the main sensor state."""
        house_power = self._snapshot.get("house_power", 0)
        return str(round(house_power))

    @property
    def unit_of_measurement(self) -> str:
        return "W"

    @property
    def extra_state_attributes(self) -> dict:
        return self._snapshot

    def update_snapshot(self, snapshot: dict) -> None:
        """Called by coordinator whenever power values change."""
        self._snapshot = snapshot
        self.async_write_ha_state()
```

## Power Snapshot Format

The `extra_state_attributes` dict carries everything the frontend currently
calculates on every tick:

```json
{
  "house_power": 3420,
  "solar_power": 4100,
  "battery_power": -850,
  "grid_power": 170,
  "battery_capacity": 78,
  "battery_min_soc": 10,
  "battery_max_soc": 100,
  "battery_remaining_energy": 12400,
  "devices": {
    "device_id_1": { "power": 2100, "name": "Jističe - Technická zálohované" },
    "device_id_2": { "power": 480, "name": "Klimatizace garáž" }
  },
  "unmeasured_power": 840,
  "timestamp": "2025-10-15T14:32:01+02:00"
}
```

All values are already in Watts (integers). The frontend reads these directly and
assigns to `DeviceNode.powerValue` without any computation.

## Backend: Coordinator Power Tracking

```python
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.core import callback, HomeAssistant

class HelmanCoordinator:
    def __init__(self, hass: HomeAssistant, config: dict, storage) -> None:
        self._hass = hass
        self._config = config
        self._sensor: HelmanPowerSummarySensor | None = None
        self._power_sensor_ids: list[str] = []
        self._unsubscribe_states: list = []

    def set_sensor(self, sensor: HelmanPowerSummarySensor) -> None:
        self._sensor = sensor

    async def async_setup(self) -> None:
        await self._build_device_tree()
        self._power_sensor_ids = self._collect_all_power_sensor_ids()
        self._subscribe_to_power_sensors()
        # Push initial state immediately
        self._push_power_snapshot()

    def _subscribe_to_power_sensors(self) -> None:
        if self._unsubscribe_states:
            for unsub in self._unsubscribe_states:
                unsub()
        self._unsubscribe_states = [
            async_track_state_change_event(
                self._hass,
                self._power_sensor_ids,
                self._on_power_sensor_change,
            )
        ]

    @callback
    def _on_power_sensor_change(self, event) -> None:
        """Called by HA whenever any tracked power sensor changes state."""
        self._push_power_snapshot()

    def _push_power_snapshot(self) -> None:
        if self._sensor is None:
            return
        snapshot = self._compute_snapshot()
        self._sensor.update_snapshot(snapshot)

    def _compute_snapshot(self) -> dict:
        """Read current hass.states for all power entities and build snapshot."""
        states = self._hass.states
        # ... read each sensor from states, compute unmeasured, etc ...
        return snapshot

    def async_unload(self) -> None:
        for unsub in self._unsubscribe_states:
            unsub()
        self._unsubscribe_states = []
```

## Updated `__init__.py`

```python
PLATFORMS = ["sensor"]

async def async_setup_entry(hass, entry):
    hass.data.setdefault(DOMAIN, {})

    storage = HelmanStorage(hass)
    await storage.async_load()

    coordinator = HelmanCoordinator(hass, storage.config, storage)
    await coordinator.async_setup()

    hass.data[DOMAIN][entry.entry_id] = {
        "storage": storage,
        "coordinator": coordinator,
    }

    async_register_websocket_commands(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True

async def async_unload_entry(hass, entry):
    coordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    coordinator.async_unload()
    await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    hass.data[DOMAIN].pop(entry.entry_id)
    return True
```

## Frontend Changes

In `helman-card.ts`:

```typescript
// REMOVE: setInterval
// REMOVE: updateLivePower() on interval tick
// ADD: read power from sensor attributes in hass setter

public set hass(hass: HomeAssistant) {
  this._hass = hass;

  if (this._deviceTree.length === 0) return;

  const summaryEntity = hass.states["sensor.helman_power_summary"];
  if (summaryEntity) {
    // Backend mode: update power values from entity attributes
    this._applyPowerSnapshot(summaryEntity.attributes);
  } else {
    // Legacy mode: read individual sensor states
    this._updateLivePowerLegacy(hass);
  }

  this.requestUpdate();
}

private _applyPowerSnapshot(attrs: Record<string, any>): void {
  for (const node of this._allDeviceNodes) {
    const deviceData = attrs.devices?.[node.id];
    if (deviceData) {
      node.powerValue = deviceData.power;
    }
  }
}
```

The history ring buffer (`powerHistory[]`) is still updated by the frontend in
Phase 4 – it reads `node.powerValue` each time the `hass` setter fires (which
happens on every HA state change, roughly every second). The setInterval is
replaced by the HA push cadence.

In practice the history update logic moves to the `hass` setter:

```typescript
public set hass(hass: HomeAssistant) {
  const prevHass = this._hass;
  this._hass = hass;

  if (this._deviceTree.length === 0) return;

  this._updateLivePower(hass);

  // Append to history ring buffer on every hass update
  // (HA fires roughly on every state change, ~1 s cadence for power sensors)
  if (prevHass !== hass) {
    this._appendHistoryBucket();
  }

  this.requestUpdate();
}
```

## Push Frequency vs. setInterval

Current behavior: `setInterval` fires every `history_bucket_duration` seconds (default: 1).
New behavior: `hass` setter fires whenever any subscribed entity changes.

For high-frequency power sensors (1–5 second polling), this is essentially
equivalent. The backend can also emit a synthetic state change on a 1-second
`async_track_time_interval` if sub-second history granularity is ever needed.

## Removing `setInterval` Risk

The setInterval handle is stored in `this._historyInterval`. After removing it:
- `connectedCallback` no longer calls `setInterval`
- `disconnectedCallback` no longer needs `clearInterval`
- History updates happen in the `hass` setter

This simplifies the component lifecycle significantly.

## Commit Sequence
```
feat(sensor): add HelmanPowerSummarySensor with extra_state_attributes snapshot
feat(coordinator): subscribe to power sensor changes via async_track_state_change_event
feat(card): replace setInterval with hass-setter-driven power and history updates
```
