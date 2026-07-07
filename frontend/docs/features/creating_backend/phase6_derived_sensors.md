# Phase 6: Derived Sensors

## Goal
Expose battery ETA and unmeasured house power as proper HA sensor entities.
This makes these values available to any HA component (automations, dashboards,
history graphs), not just the helman card, and removes the last major computation
from the frontend render path.

## Background

Currently, the frontend computes these values in `power-device-info.ts`:

**Battery ETA (time to empty or time to full):**
```typescript
// Reads 4 entity states, performs float arithmetic, returns timestamp
const totalCapacityWh = remainingEnergyWh / (currentSoC / 100);
const remainingUsable = currentEnergyWh - totalCapacityWh * minSoC / 100;
const timeToEmpty = remainingUsable / currentPowerW;  // hours
```

**Unmeasured house power:**
```typescript
// Computed per-render, not exposed outside the card
unmeasuredPower = parentPower - sum(measuredChildrenPower);
```

## Deliverables

- `sensor.py`: Add `HelmanBatteryTimeSensor` and `HelmanUnmeasuredPowerSensor`
- `coordinator.py`: Compute derived values on every power state change
- Frontend `power-device-info.ts`: Read ETA from sensor state instead of computing it

## Sensor Definitions

### `HelmanBatteryTimeSensor`

```python
from homeassistant.components.sensor import SensorEntity, SensorDeviceClass
from homeassistant.const import UnitOfTime

class HelmanBatteryTimeSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry):
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_battery_time_to_target"
        self._attr_name = "Battery Time to Target"
        self._minutes: float | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._minutes, 1) if self._minutes is not None else None

    @property
    def extra_state_attributes(self) -> dict:
        return {
            "target_time": self._target_time_iso,
            "mode": self._mode,  # "discharging" | "charging" | "idle"
        }

    def update_value(self, minutes: float | None, target_time: str, mode: str) -> None:
        self._minutes = minutes
        self._target_time_iso = target_time
        self._mode = mode
        self.async_write_ha_state()
```

### `HelmanUnmeasuredPowerSensor`

```python
class HelmanUnmeasuredPowerSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_native_unit_of_measurement = "W"
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry):
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_unmeasured_house_power"
        self._attr_name = "Unmeasured House Power"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return max(0.0, round(self._value)) if self._value is not None else None

    def update_value(self, watts: float) -> None:
        self._value = watts
        self.async_write_ha_state()
```

## Coordinator: Compute Derived Values

Extend `_compute_snapshot()` to also update derived sensors:

```python
def _push_power_snapshot(self) -> None:
    snapshot = self._compute_snapshot()

    if self._power_summary_sensor:
        self._power_summary_sensor.update_snapshot(snapshot)

    if self._battery_time_sensor:
        minutes, target_time, mode = self._compute_battery_eta(snapshot)
        self._battery_time_sensor.update_value(minutes, target_time, mode)

    if self._unmeasured_sensor:
        unmeasured = self._compute_unmeasured_power(snapshot)
        self._unmeasured_sensor.update_value(unmeasured)


def _compute_battery_eta(self, snapshot: dict) -> tuple[float | None, str, str]:
    """Port of battery ETA logic from power-device-info.ts."""
    from datetime import datetime, timedelta, timezone
    import math

    battery_cfg = self._config.get("power_devices", {}).get("battery", {})
    entities = battery_cfg.get("entities", {})

    hass_states = self._hass.states
    try:
        remaining_wh = float(hass_states[entities["remaining_energy"]].state)
        capacity_pct = float(hass_states[entities["capacity"]].state)
        min_soc = float(hass_states[entities["min_soc"]].state)
        max_soc = float(hass_states[entities["max_soc"]].state)
        power_w = snapshot.get("battery_power", 0.0)
    except (KeyError, TypeError, ValueError):
        return None, "", "idle"

    if capacity_pct <= 0:
        return None, "", "idle"

    total_capacity_wh = remaining_wh / (capacity_pct / 100)
    rolling_power = abs(power_w)  # Use instantaneous; rolling avg needs history

    if power_w < 0:  # discharging (source)
        if rolling_power < 1:
            return None, "", "idle"
        usable = remaining_wh - total_capacity_wh * min_soc / 100
        hours = usable / rolling_power
        mode = "discharging"
    elif power_w > 0:  # charging (consumer)
        if rolling_power < 1:
            return None, "", "idle"
        to_full = total_capacity_wh * max_soc / 100 - remaining_wh
        hours = to_full / rolling_power
        mode = "charging"
    else:
        return None, "", "idle"

    minutes = hours * 60
    target = datetime.now(tz=timezone.utc) + timedelta(hours=hours)
    return minutes, target.isoformat(), mode


def _compute_unmeasured_power(self, snapshot: dict) -> float:
    house_power = snapshot.get("house_power", 0.0)
    measured_sum = sum(snapshot.get("devices", {}).values())  # device power values
    # Actually need device dict to only include measured leaf nodes, not house total
    # Implementation depends on tree structure details
    return max(0.0, house_power - measured_sum)
```

**Note on rolling average for battery ETA:** The current frontend uses the average
of the last N `powerHistory` values as the "current power". In the backend, the
history buffer is available (see Phase 5), so the coordinator can maintain a rolling
window of battery power readings and use their average. The implementation above
uses instantaneous power as a simplification; the rolling average can be added in
a follow-up.

## Updated `sensor.py` Setup

```python
async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]

    entities = [
        HelmanPowerSummarySensor(coordinator, entry),
        HelmanBatteryTimeSensor(coordinator, entry),
        HelmanUnmeasuredPowerSensor(coordinator, entry),
    ]

    coordinator.set_sensors(
        power_summary=entities[0],
        battery_time=entities[1],
        unmeasured=entities[2],
    )

    async_add_entities(entities)
```

## Frontend Changes

In `power-device-info.ts`, the battery ETA block currently reads 4 raw entity
states and computes the ETA. After Phase 6, it reads from the dedicated sensor:

```typescript
// BEFORE: compute ETA from raw entities
private _computeBatteryEta(): { minutes: number; targetTime: Date } | null {
  const remaining = parseFloat(hass.states[entities.remaining_energy].state);
  // ... 60+ lines of calculation ...
}

// AFTER: read pre-computed value from HA sensor
private _getBatteryEta(): { minutes: number; targetTime: Date } | null {
  const etaSensor = this.hass?.states["sensor.helman_battery_time_to_target"];
  if (!etaSensor || etaSensor.state === "unavailable") return null;
  return {
    minutes: parseFloat(etaSensor.state),
    targetTime: new Date(etaSensor.attributes.target_time),
  };
}
```

## Entity IDs and Naming

| Entity | ID | State | Unit |
|---|---|---|---|
| Power Summary | `sensor.helman_power_summary` | house power (W) | W |
| Battery Time | `sensor.helman_battery_time_to_target` | minutes to target | min |
| Unmeasured Power | `sensor.helman_unmeasured_house_power` | unmeasured W | W |

If multiple batteries are tracked in the future, `HelmanBatteryTimeSensor` can be
instantiated per battery using the device name as a suffix.

## Benefits Beyond the Card

These sensors becoming first-class HA entities means:
- **Automations**: trigger when `sensor.helman_battery_time_to_target < 30 min`
- **History graphs**: track unmeasured power trends over time
- **Dashboards**: use `sensor.helman_battery_time_to_target` in any card, not just helman-card
- **Alerts**: create a notification when battery is projected to be empty before morning

## Commit Sequence
```
feat(sensor): add HelmanBatteryTimeSensor with time-to-target and mode attributes
feat(sensor): add HelmanUnmeasuredPowerSensor
feat(coordinator): compute battery ETA and unmeasured power on every state change
feat(card): read battery ETA from sensor.helman_battery_time_to_target
```
