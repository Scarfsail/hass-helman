# Helman Card – Backend Migration: Comprehensive Implementation Plan

## Overview

This document is the master plan for migrating the majority of helman-card's data
fetching, computation, and configuration into a new Home Assistant custom component
(`hass-helman`). The frontend card retains its entire UX and visual layer but
delegates all heavy work to the backend.

### Goals
- Single configuration point (set up once in HA integrations, not per-Lovelace-view)
- Eliminate 4 parallel WebSocket registry lookups on every card load
- Move O(buckets × entities) history aggregation out of the browser
- Enable battery ETA and unmeasured-power as proper HA sensors
- Allow simpler sibling cards (e.g. "Helman Battery Card") with zero extra config

### Non-goals
- Changing the card's visual design or UX in any way
- Replacing the custom Lovelace card with a built-in panel (keep HACS card approach)
- Real-time streaming (standard HA entity push is sufficient)

### Repositories (relative to this document's location)
  - Backend: ../../../../hass-helman/custom_components/helman/
  - Frontend: ../../../../hass-helman-card/src/
---

## Progress Tracking

**This file is the single source of truth for implementation progress across sessions.**
Each phase is implemented in a separate session. At the end of a session (once testing
is confirmed), the assistant updates the status table below, commits all changes, and
provides a short prompt to start the next session.

### Status Table

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| 1 | Backend Skeleton | ✅ Tested & complete | |
| 2 | Config Migration | ✅ Tested & complete | |
| 3 | Device Tree in Backend | ✅ Tested & complete | |
| 4 | Live Power Subscription | ✅ Tested & complete | |
| 5 | History Aggregation | ✅ Tested & complete | |
| 6 | Derived Sensors | ✅ Tested & complete | |
| 7 | Frontend Cleanup | 🧪 Implemented – awaiting test | |

Status values: ⬜ Not started · 🔄 In progress · 🧪 Implemented – awaiting test · ✅ Tested & complete

### Session Workflow

1. **Start of session**: read this file to find the first phase that is not ✅.
2. **Implement**: follow the detail document for that phase.
3. **Hand off for testing**: set the phase to 🧪, list the testing checklist below
   so the user knows exactly what to verify.
4. **After user confirms it works**: set the phase to ✅, commit all changes with
   the commit message from the phase document, then output the next-session prompt.

### Testing Checklists

Filled in by the assistant at the end of each implementation session.

#### Phase 1 – Backend Skeleton
1. Copy `hass-helman/custom_components/helman/` to your HA `config/custom_components/` directory.
2. Restart Home Assistant.
3. Go to **Settings → Integrations → Add Integration** and search for "Helman Energy".
4. Click through the single-step setup flow (no fields to fill in).
5. Verify the entry appears in the integrations list with no errors in the HA logs.
6. Reload the integration (⋮ menu → Reload) → should succeed without errors.
7. Delete the entry (⋮ menu → Delete) → should succeed without errors.
8. Re-add it to confirm the single-instance guard works (adding a second instance should show "Only one Helman Energy instance is supported.").

#### Phase 2 – Config Migration
1. Copy the updated `hass-helman/custom_components/helman/` to `config/custom_components/` (it now contains `storage.py` and `websockets.py`).
2. Restart Home Assistant.
3. Verify the integration loads without errors in HA logs.
4. Open **Developer Tools → WebSocket** (or browser console) and send:
   ```json
   { "id": 1, "type": "helman/get_config" }
   ```
   Confirm the response contains the default config (`history_buckets`, `sources_title`, etc.).
5. Save a custom config via:
   ```json
   { "id": 2, "type": "helman/save_config", "config": { "sources_title": "Test Sources", "history_buckets": 30, "history_bucket_duration": 1, "consumers_title": "Test Consumers", "others_group_label": "Others", "groups_title": "Group by:", "device_label_text": {}, "power_devices": {} } }
   ```
   Confirm `{ "success": true }` is returned.
6. Restart HA and call `helman/get_config` again — confirm the saved value (`"sources_title": "Test Sources"`) persists across restarts.
7. Build the frontend (`npm run build-dev` in `hass-helman-card/`) and load the card in a dashboard **without** the `sensor.helman_power_summary` entity present — the card should fall back to YAML config (legacy mode).

#### Phase 3 – Device Tree in Backend
1. Copy the updated `hass-helman/custom_components/helman/` to `config/custom_components/` (it now contains `tree_builder.py` and `coordinator.py`).
2. Restart Home Assistant.
3. Verify the integration loads without errors in HA logs.
4. Open browser console on your HA dashboard and run:
   ```javascript
   const result = await hass.connection.sendMessagePromise({ type: "helman/get_device_tree" });
   console.log(JSON.stringify(result, null, 2));
   ```
   Confirm the response contains `{ sources: [...], consumers: [...] }` with your configured solar/battery/grid sources and the house node with device children.
5. Verify each device node has `displayName`, `powerSensorId`, `labels`, `color`, `icon` correctly set.
6. Verify the house node's `children` contains all energy-dashboard-tracked devices with nested parent-child structure matching `energy/get_prefs` hierarchy.
7. Trigger a cache invalidation: add a label to any entity in HA, then re-call `helman/get_device_tree` — the response should reflect the new label.
8. Call `helman/save_config` with a changed config and re-call `helman/get_device_tree` — tree should rebuild (cache invalidated).
9. The frontend card should still work normally (it uses the legacy path until `sensor.helman_power_summary` exists).

#### Phase 4 – Live Power Subscription
1. Copy the updated `hass-helman/custom_components/helman/` to `config/custom_components/` (it now contains `sensor.py`).
2. Restart Home Assistant.
3. Verify the integration loads without errors in the HA logs.
4. Go to **Settings → Integrations → Helman Energy** — you should see `sensor.helman_power_summary` listed as a new entity.
5. Open **Developer Tools → States** and verify `sensor.helman_power_summary` exists:
   - State should show a numeric watt value (house power consumption)
   - Attributes should include `house_power`, `solar_power`, `battery_power`, `grid_power`, `devices`, `timestamp`
6. Verify `extra_state_attributes.devices` contains entries for each tracked device (keyed by node id with `power` and `name` fields).
7. Open the browser console on your HA dashboard and verify the card loads normally:
   - In backend mode (entity exists): **no `setInterval` is running** — verify by checking that history updates are driven by sensor state changes, not a timer
   - In legacy mode: setInterval still runs as before
8. Verify live power values on the card update when power sensors change (without needing to reload).
9. Confirm the card transitions correctly if the entity appears after the card loads (backend entity appears → interval cleared → hass setter takes over).
10. Reload the integration (⋮ → Reload) → entity should reappear and resume pushing snapshots without errors.

#### Phase 5 – History Aggregation
1. Copy the updated `hass-helman/custom_components/helman/` to `config/custom_components/` (it now contains `history_aggregator.py`; `coordinator.py`, `websockets.py`, and `manifest.json` are updated).
2. Build the frontend (`npm run build-dev` in `hass-helman-card/`).
3. Restart Home Assistant and verify it loads without errors in HA logs.
4. Open browser console on your HA dashboard and run:
   ```javascript
   const result = await hass.connection.sendMessagePromise({ type: "helman/get_history" });
   console.log(JSON.stringify(result, null, 2));
   ```
   Confirm the response contains:
   - `buckets` (number, e.g. 60)
   - `bucket_duration` (number, e.g. 1)
   - `entity_history` — an object keyed by entity_id, each value an array of `buckets` floats (oldest first)
   - `source_ratios` — an object keyed by non-source entity_id; each value is an object keyed by source entity_id with arrays of `buckets` floats
5. Verify `entity_history` contains entries for all tracked power sensors (solar, battery, grid, house, and each house device).
6. Verify `source_ratios` contains entries for all non-source sensors (house, each device) but NOT for sources themselves.
7. Load the card in a dashboard in backend mode (sensor.helman_power_summary exists). Open the browser console and verify:
   - No `history/history_during_period` calls appear in the Network tab or WS frames
   - The card renders history bars for all devices (history bars visible in the house section)
8. Verify the history bars show colored source segments (solar yellow, battery green, grid blue) for house devices.
9. Reload the page and confirm history bars appear correctly after reconnect.
10. Call `helman/save_config` with a changed config, then call `helman/get_history` again — verify fresh data is returned (cache was invalidated).

#### Phase 6 – Derived Sensors
1. Copy the updated `hass-helman/custom_components/helman/` to `config/custom_components/` (`sensor.py` and `coordinator.py` are updated).
2. Build the frontend (`npm run build-dev` in `hass-helman-card/`).
3. Restart Home Assistant and verify it loads without errors in HA logs.
4. Go to **Settings → Integrations → Helman Energy** — you should now see **three** entities listed:
   - `sensor.helman_power_summary`
   - `sensor.helman_battery_time_to_target`
   - `sensor.helman_unmeasured_house_power`
5. Open **Developer Tools → States** and verify `sensor.helman_battery_time_to_target`:
   - When battery is charging or discharging (power > 1 W): state shows a positive float (minutes to target), attributes include `target_time` (ISO string), `mode` (`"charging"` or `"discharging"`), and `target_soc` (integer, e.g. 90 or 20)
   - When battery is idle: state shows `unavailable`
6. Verify `sensor.helman_unmeasured_house_power`:
   - State shows a non-negative integer watt value
   - Value ≈ house power sensor reading minus sum of all tracked house device power readings
7. Open the card in a dashboard in backend mode. When the battery is charging or discharging, verify the battery device info row shows the ETA: `${target_soc}% ➜ 🕓HH:MM ⏳H:MM`
8. Verify minutes are zero-padded (e.g. `⏳1:05` not `⏳1:5`).
9. When the battery is idle (power < 1 W), verify the ETA row is hidden.
10. Reload the integration (⋮ → Reload) → all three entities should reappear and resume updating without errors.

#### Phase 7 – Frontend Cleanup

**Backend**: Copy updated `hass-helman/custom_components/helman/` to `config/custom_components/` (`tree_builder.py` updated to include `uiConfig` in `get_device_tree` response).
**Frontend**: Build the card (`npm run build-dev` in `hass-helman-card/`) and deploy.

1. Restart Home Assistant and verify it loads without errors in HA logs.
2. Open browser console on your HA dashboard and run:
   ```javascript
   const result = await hass.connection.sendMessagePromise({ type: "helman/get_device_tree" });
   console.log(JSON.stringify(result.uiConfig, null, 2));
   ```
   Confirm the response now contains a `uiConfig` object with `sources_title`, `consumers_title`, `groups_title`, `device_label_text`, `history_buckets`, `history_bucket_duration`.
3. Load the card in a dashboard. Verify it renders correctly with no console errors — power values, history bars, and source-colour segments should all be visible.
4. Verify the card config in YAML now only requires:
   ```yaml
   type: custom:helman-card
   ```
   (No `power_devices`, `history_buckets`, etc. needed.)
5. Wait ~10 seconds and confirm history bars are animating (rolling forward) driven by the frontend timer.
6. Verify power values update in real-time when sensors change (driven by the timer reading from `hass.states`).
7. Verify history bars show colored source segments (solar/battery/grid breakdown).
8. Verify the battery ETA row (`${targetSoc}% ➜ 🕓HH:MM ⏳H:MM`) still shows when battery is active.
9. Verify category chips (Group by: …) still appear and filter devices when `device_label_text` is configured.
10. Navigate away from the dashboard and back — card should reload data correctly, no stale intervals or duplicate timers.
11. Verify no `setInterval`-style polling remains for data fetching (only one timer for bucket advancement).
12. Confirm `energy-data-helper.ts` and `config-loader.ts` no longer exist in `src/`.

---

## Repository Strategy

Create a **new Git repository** `hass-helman` (sibling to `hass-helman-card`):

```
hass-helman/
  custom_components/
    helman/
      __init__.py
      manifest.json
      config_flow.py
      const.py
      storage.py
      coordinator.py
      websockets.py
      sensor.py
      services.yaml
```

The existing `hass-helman-card` repository is kept; only its `src/` is progressively
simplified as backend phases land.

---

## Phase Overview

Current progress is tracked in the **Status Table** above.

| Phase | Name | Backend deliverable | Frontend change |
|-------|------|---------------------|-----------------|
| 1 | Backend Skeleton | HACS-installable component (no-op) | None |
| 2 | Config Migration | `HelmanStorage` + `helman/get_config` / `helman/save_config` WS | Config-loader with backend-first / YAML fallback |
| 3 | Device Tree in Backend | `HelmanTreeBuilder` + `helman/get_device_tree` WS | Replace 4 WS calls with 1 |
| 4 | Live Power Subscription | `HelmanPowerSummarySensor` + `async_track_state_change_event` | Replace `setInterval` with `hass` setter |
| 5 | History Aggregation | `HelmanHistoryAggregator` + history in sensor attributes | Remove raw history fetch + bucketing |
| 6 | Derived Sensors | `sensor.helman_battery_time_to_target` + `sensor.helman_unmeasured_house_power` | Read ETA from sensor state |
| 7 | Frontend Cleanup | Stable (no backend changes) | Delete `energy-data-helper.ts`; strip card to pure renderer |

Detailed notes for each phase are in separate files alongside this document.

---

## Architecture Decision: Communication Channels

Three channels will be used, chosen to match the nature of each data type:

### Channel A – Custom WebSocket Commands
**Used for:** One-shot structured data (device tree, config, history)

Modelled after `hass-door-window-watcher`'s `dww/get_config` pattern.

```
Frontend → hass.connection.sendMessagePromise({ type: "helman/get_device_tree" })
Backend  → connection.send_result(msg["id"], tree_payload)
```

Commands planned:
- `helman/get_config` – fetch current backend config
- `helman/save_config` – persist config changes
- `helman/get_device_tree` – fetch the fully-resolved device tree
- `helman/get_history` – fetch pre-bucketed history for a time window

### Channel B – HA Entity State Push
**Used for:** Live power values and derived metrics (battery ETA, unmeasured power)

Modelled after `hass-door-window-watcher`'s `BinarySensorEntity` with
`extra_state_attributes`. The card's existing `hass` setter already receives every
state update automatically. No polling interval needed.

Entity planned:
- `sensor.helman_power_summary` – attributes contain the full current power tree
  (sources, consumers, per-device readings) as a JSON-serializable dict
- `sensor.helman_battery_time_to_target` (or per-battery if multiple)
- `sensor.helman_unmeasured_house_power`

### Channel C – HA Services (action-only)
**Used for:** Triggering side effects from the frontend (e.g. future: manual refresh)

Not needed in initial phases; reserved for future use.

---

## Data Flow (target state)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Home Assistant Core                                                  │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  helman custom component                                      │   │
│  │                                                               │   │
│  │  HelmanCoordinator                                            │   │
│  │    ├── Reads: energy/get_prefs                                │   │
│  │    ├── Reads: entity_registry / device_registry / labels     │   │
│  │    ├── Subscribes: async_track_state_change_event (power)    │   │
│  │    ├── Subscribes: async_track_time_interval (1 s tick)      │   │
│  │    ├── Computes: power tree, history buckets, source ratios  │   │
│  │    └── Pushes: async_write_ha_state() on every change        │   │
│  │                                                               │   │
│  │  Entities                                                     │   │
│  │    sensor.helman_power_summary (attrs: full tree snapshot)   │   │
│  │    sensor.helman_battery_time_to_target                      │   │
│  │    sensor.helman_unmeasured_house_power                      │   │
│  │                                                               │   │
│  │  WebSocket commands                                           │   │
│  │    helman/get_device_tree  → tree JSON                       │   │
│  │    helman/get_history      → bucketed history JSON           │   │
│  │    helman/get_config       → config JSON                     │   │
│  │    helman/save_config      → persist config                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                        ↕  HA state machine                           │
└───────────────────────────────────────┬─────────────────────────────┘
                                        │ WebSocket (existing HA connection)
                                ┌───────┴───────────────────────┐
                                │  helman-card (Lovelace)        │
                                │                                │
                                │  On connect:                   │
                                │    sendMessage(get_device_tree)│
                                │    sendMessage(get_history)    │
                                │                                │
                                │  On hass setter:               │
                                │    read sensor.helman_*        │
                                │    update rendered power values │
                                │                                │
                                │  Render (unchanged UX):        │
                                │    power-flow-arrows           │
                                │    power-device (sources)      │
                                │    power-house-devices-section │
                                │    power-device-history-bars   │
                                └────────────────────────────────┘
```

---

## Configuration Schema (target)

The YAML card config shrinks to a minimal reference:

```yaml
# helman-card: minimal future config
type: custom:helman-card
entity: sensor.helman_power_summary   # the backend entity to bind to
```

All content currently in the card YAML moves into the backend integration's config,
stored in `.storage/helman/<entry_id>.json` via HA's `storage.Store` helper:

```json
{
  "power_sensor_name_cleaner_regex": " Výkon$",
  "history_buckets": 60,
  "history_bucket_duration": 1,
  "sources_title": "Zdroje energie",
  "consumers_title": "Distribuce energie",
  "others_group_label": "Ostatní",
  "groups_title": "Seskupit:",
  "device_label_text": { ... },
  "power_devices": {
    "solar": { "source_name": "FV Panely", "entities": { ... } },
    "battery": { ... },
    "grid": { ... },
    "house": { ... }
  }
}
```

A companion config UI can be added as a custom panel (optional, Phase 2 extension)
or via a YAML import flow. For now, `helman/save_config` WebSocket command lets the
existing card write config directly during a one-time migration wizard step.

---

## Backward Compatibility

- Phases 1–3 are **additive**: the card keeps working with full YAML config while the
  backend is installed and running. The card detects whether the backend entity exists
  and falls back to legacy mode automatically.
- Phase 7 is the **breaking change** that removes legacy mode. A major semver bump
  (`BREAKING CHANGE:`) is required at that point.

---

## Phased Detail Documents

See the following files in this directory for detailed implementation notes:

- [`phase1_backend_skeleton.md`](./phase1_backend_skeleton.md)
- [`phase2_config_migration.md`](./phase2_config_migration.md)
- [`phase3_device_tree.md`](./phase3_device_tree.md)
- [`phase4_live_power.md`](./phase4_live_power.md)
- [`phase5_history_aggregation.md`](./phase5_history_aggregation.md)
- [`phase6_derived_sensors.md`](./phase6_derived_sensors.md)
- [`phase7_frontend_cleanup.md`](./phase7_frontend_cleanup.md)
