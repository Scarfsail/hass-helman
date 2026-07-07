# Feasibility Analysis: Simple Node Detail Modal

## Overview

This document analyses what data is already available from the existing frontend
and backend, and what gaps would need to be filled to implement the node detail
modal described in `simple-node-detail-idea.md`.

---

## Current Data Available in Frontend

The `helman-simple-card` builds an `EnergyEntityMap` from the
`helman/get_device_tree` WebSocket response. The entity IDs currently tracked are:

| Field | Source in DTO | Status |
|---|---|---|
| `solarPowerEntityId` | `sources[sourceType=solar].powerSensorId` | ✅ Available |
| `gridPowerEntityId` | `sources[sourceType=grid].powerSensorId` | ✅ Available |
| `batteryPowerEntityId` | `sources[sourceType=battery].powerSensorId` | ✅ Available |
| `batterySocEntityId` | `batteryNode.sourceConfig.entities.capacity` | ✅ Available |
| `batteryMinSocEntityId` | `batteryNode.sourceConfig.entities.min_soc` | ✅ Available |
| `housePowerEntityId` | `consumers[sourceType=house].powerSensorId` | ✅ Available |
| `solarMaxPower` | `solarNode.sourceConfig.max_power` | ✅ Available |
| `gridMaxPower` | `gridNode.sourceConfig.max_power` | ✅ Available |
| `batteryMaxPower` | `batteryNode.sourceConfig.max_power` | ✅ Available |

The backend design docs (phase 4) also define a power snapshot pushed via sensor
attributes that includes `battery_max_soc`, `battery_remaining_energy`, and
(phase 6) a `HelmanBatteryTimeSensor` with `target_time` and `mode` attributes.

---

## Node-by-Node Feasibility

### 🔋 Battery

| Detail item | Feasibility | Notes |
|---|---|---|
| Current power | ✅ Ready | Already in `EnergyEntityMap` |
| Current SoC | ✅ Ready | `batterySocEntityId` already mapped |
| Current mode (idle/charging/discharging) | ✅ Ready | Derivable from power sign; already done in `simple-card-battery.ts` |
| Time to full/empty | ✅ Ready | `power-device-info.ts` already reads `sensor.helman_battery_time_to_empty` (discharging) and `sensor.helman_battery_time_to_full` (charging) by well-known entity ID — no DTO change needed |
| When it will be charged/discharged (target time) | ✅ Ready | `target_time` attribute on the same well-known sensors, already used in `_renderBatteryInfo()` |
| Target SoC | ✅ Ready | `target_soc` attribute on the same sensors, already rendered |
| Min SoC | ✅ Ready | `batteryMinSocEntityId` already mapped |
| Max SoC | ✅ Ready | `BatteryDeviceConfig.entities.max_soc` — already in `sourceConfig.entities` |
| Remaining capacity in kWh | ✅ Ready | `BatteryDeviceConfig.entities.remaining_energy` — already in `sourceConfig.entities` |
| Today's kWh charged | ❓ User config | No field exists in `BatteryDeviceConfig` yet. Depends on whether the battery HA integration exposes a dedicated energy-charged-today sensor. A new optional field (e.g. `entities.today_charged`) would need to be added to `BatteryDeviceConfig` |
| Today's kWh discharged | ❓ User config | Same as above — needs `entities.today_discharged` in `BatteryDeviceConfig` |

**Summary:** Everything except today's charged/discharged kWh is fully ready. The ETA
logic already exists in `power-device-info.ts` using well-known Helman backend sensor
entity IDs — no DTO changes are needed. The detail dialog can reuse this approach.

---

### 🏠 House

| Detail item | Feasibility | Notes |
|---|---|---|
| Current power | ✅ Ready | `housePowerEntityId` already mapped |
| Today's consumed energy in kWh | ⚠️ Minor config gap | `HouseDeviceConfig` has no `today_energy` field (unlike `SolarDeviceConfig`). Either add `entities.today_energy` to `HouseDeviceConfig`, or derive it by querying `recorder/statistics_during_period` for the house power entity (no new entity needed) |

**Note on "today's energy" for a total_increasing sensor:** HA energy statistics
entities accumulate lifetime. A frontend call to `recorder/statistics_during_period`
with `period: "day"` from midnight gives the daily delta without needing a
dedicated reset sensor — the same approach the HA Energy dashboard uses.

---

### ☀️ Solar Panel

| Detail item | Feasibility | Notes |
|---|---|---|
| Current power | ✅ Ready | `solarPowerEntityId` already mapped |
| Today's produced energy in kWh | ✅ Ready | `SolarDeviceConfig.entities.today_energy` already read in `_renderSolarInfo()` |
| Remaining forecasted energy in kWh | ✅ Optional | `SolarDeviceConfig.entities.remaining_today_energy_forecast` already read in `_renderSolarInfo()`. Both fields must be non-null; if absent the row is hidden. No new backend work needed. |

---

### ⚡ Grid

| Detail item | Feasibility | Notes |
|---|---|---|
| Current power | ✅ Ready | `gridPowerEntityId` already mapped |
| Today's imported energy in kWh | ✅ Ready | `GridDeviceConfig.entities.today_import` already read in `_renderGridInfo()` |
| Today's exported energy in kWh | ✅ Ready | `GridDeviceConfig.entities.today_export` already read in `_renderGridInfo()` |

---

## Frontend Architecture Gap: No Click Handling or Modal

None of the node components (`simple-card-solar`, `simple-card-battery`,
`simple-card-grid`, `simple-card-house`) have click handlers. There is also no
modal/dialog infrastructure in the simple card.

Required purely-frontend additions:
1. `@click` handler on each node cell in `helman-simple-card`
2. A new `simple-node-detail-dialog` Lit component (following the project's dialog
   pattern from shared-agents.md) with a `showDialog(params)` public method
3. The dialog renders different content per `nodeType: 'battery' | 'solar' | 'grid' | 'house'`
4. The dialog receives the current `hass` reference and the relevant entity IDs so
   it can read current state and fire statistics queries if needed

---

## Summary of Gaps vs. Backend Changes Needed

### ✅ No change needed — already implemented in `power-device-info.ts`
- Current power for all four nodes
- Battery SoC, mode, min SoC, max SoC, remaining energy
- Battery time-to-full/empty, target time, target SoC — via well-known entity IDs
  `sensor.helman_battery_time_to_empty` / `sensor.helman_battery_time_to_full`
- Solar today's energy + remaining forecast (optional — hidden when not configured)
- Grid today's import + today's export

All entity IDs are already defined in `src/DeviceConfig.ts` and flow through
`sourceConfig.entities` in the `DeviceNodeDTO`. The well-known battery sensor IDs
require no DTO wiring — they are resolved directly from `hass.states`.

### ⚠️ Small gaps requiring minor work
- **Battery today's charged/discharged**: No field in `BatteryDeviceConfig` yet. Needs
  two new optional fields (`entities.today_charged`, `entities.today_discharged`).
- **House today's energy**: `HouseDeviceConfig` lacks a `today_energy` field.
  Either add it, or query `recorder/statistics_during_period` client-side.

### No external dependency blockers
- Solar forecast is already an **optional** config field (`remaining_today_energy_forecast`
  in `SolarDeviceConfig`). If a forecast sensor is configured it appears; if not, the row
  is hidden. Nothing to do.

---

## Recommended Approach

1. **Frontend only for almost everything**: Implement click handling and the detail
   dialog. All display logic already exists in `power-device-info.ts` and can be
   ported/expanded into the dialog. No backend changes are needed for any item
   except the two below.
2. **House today's energy**: Add `entities.today_energy` to `HouseDeviceConfig`, or
   query `recorder/statistics_during_period` client-side — both are straightforward.
3. **Battery today's charged/discharged**: Add two optional fields to
   `BatteryDeviceConfig` when there is a concrete sensor to map them to.
