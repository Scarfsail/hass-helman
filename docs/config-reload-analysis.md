# Config Reload Without HASS Restart

## Goal

When the user saves config via `helman/save_config` websocket command, reload the entire integration (behaving as if HASS restarted) instead of the current partial `async_handle_config_saved()` hot-patch. Additionally, verify whether any extra integration code is needed for a "Reload" button in the HASS UI integrations page.

## Current State

### Setup lifecycle (`__init__.py`)

- `async_setup_entry` creates `HelmanStorage`, loads all 3 storage files, creates `HelmanCoordinator`, calls `coordinator.async_setup()`, registers websocket commands, forwards sensor platform setup.
- `async_unload_entry` unloads sensor platform, calls `coordinator.async_unload()`, pops all data from `hass.data[DOMAIN]`.

### Unload is mostly comprehensive (`coordinator.py:1919-1945`)

`coordinator.async_unload()` tears down:
- Schedule executor (stops interval timer, cancels in-flight reconcile tasks)
- Power-history tick timer (`_unsub_tick`)
- Forecast refresh timer (`_unsub_forecast_refresh`)
- Battery forecast cache
- All entity back-references (sensors, factory, entry)
- Event bus listeners (`entity_registry_updated`, `device_registry_updated`)
- Energy manager listener (`_unsub_energy`)

This cleanup is solid for tracked listeners/timers, but it does **not** cancel coordinator-created fire-and-forget tasks started via `hass.async_create_task()` (forecast refreshes and tree rebuilds).

### Config save path currently diverges stored config and active runtime (`websockets.py:107-122`, `coordinator.py:986-993`)

Currently: `stor.async_save()` then `coordinator.async_handle_config_saved()`, which invalidates tree/forecast caches, resets schedule runtime, and reconciles schedule.

Important nuance: this **does** trigger a tree rebuild path, but it still runs against the coordinator's stale `_active_config`. `_active_config` and `_appliances_registry` are rebuilt only during `coordinator.async_setup()`.

So today:
- `helman/get_config` immediately reflects the newly saved stored config
- runtime APIs (`get_appliances`, projections, schedule execution inputs) continue using the old active runtime until reload
- battery config readers, source-ratio entities, and schedule-control reads also keep using stale active config

There is direct test coverage for this behavior: `tests/test_coordinator_schedule_execution.py:1128-1201`.

### Config flow (`config_flow.py`)

Minimal — only `async_step_user`. No `OptionsFlowHandler`, no `add_update_listener`.

### Existing repo contract already treats reload as the activation boundary

Recent appliance/runtime docs already define three separate states:

1. Stored config
2. Validated active config
3. Runtime appliance registry

Those docs explicitly say `helman/save_config` updates stored config only, while restart / reload makes it active (`docs/features/ev-charger/ev-charger-implementation-shared.md:124-141`, `docs/features/ev-charger/ev-charger-feature-request-refined.md:555-568`). Current code and tests already match that contract.

### Websocket registration (`websockets.py:73-83`)

10 handlers registered via `async_register_command`. These are global Home Assistant websocket registrations and are **never unregistered** during unload.

---

## What Needs to Change

### 1. Guard websocket double-registration

**File:** `websockets.py`
**Lines:** 73-83 (function `async_register_websocket_commands`)

**Problem:** `async_register_command` is called on every `async_setup_entry`. After any unload + setup cycle, setup will try to register the same commands again. The duplicate registration attempt is proven by this code; the exact Home Assistant warning/error behavior is external to this repo and should be treated as unverified here.

**Preferred fix:** Move websocket registration to a top-level `async_setup(hass, config)` function in `__init__.py`. This runs once per HASS lifetime and is not affected by entry reload. However, it requires HASS to call `async_setup` before `async_setup_entry`, which happens automatically when both are defined.

```python
# __init__.py
async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    async_register_websocket_commands(hass)
    return True
```

This is the cleaner repo-backed approach — websocket commands are stateless functions that look up `hass.data[DOMAIN]` at call time, so they don't need to be re-registered. If a guard-based approach is preferred instead, verify the relevant Home Assistant websocket-registry API first rather than depending on undocumented internals.

### 2. Replace `async_handle_config_saved` with full reload

**File:** `websockets.py`
**Lines:** 107-122 (function `ws_save_config`)

**Change:** After saving config to storage, trigger a full entry reload instead of the current hot-path refresh.

The key reason is not just entity re-registration. A full reload is what:

- reconstructs coordinator `_active_config` from storage
- rebuilds `_appliances_registry`
- re-runs sensor platform setup (including source-ratio entities and battery dependency capture)
- re-runs `_async_normalize_schedule_document()`, which resets incompatible persisted schedules and prunes stale appliance actions against the active registry

This aligns the legacy core config path with the newer stored-config -> reload -> active-runtime contract already documented for appliances.

```python
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
    domain_data = hass.data.get(DOMAIN, {})
    stor: HelmanStorage | None = domain_data.get("storage")
    if not stor:
        connection.send_error(msg["id"], "not_loaded", "Helman storage not available")
        return

    await stor.async_save(msg["config"])

    # Find the config entry and trigger a full reload
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    connection.send_result(msg["id"], {"success": True})
    await hass.config_entries.async_reload(entry.entry_id)
```

**Note:** `async_reload(entry_id)` internally calls `async_unload_entry` then `async_setup_entry`. The config is already on disk at this point, so `HelmanStorage.async_load()` will read it back.

**Note:** Send the websocket result *before* triggering reload, so the frontend gets its success response before the integration tears down.

### 3. Treat Reload-button work as a verification task first

**Files:** `config_flow.py`, `manifest.json`

Repo-backed facts:

- `manifest.json` already has `"config_flow": true`
- the integration already implements `async_unload_entry`
- `config_flow.py` is minimal and has no options flow today

What this repo does **not** prove:

- whether the Home Assistant Integrations page already shows a Reload button
- whether an `OptionsFlow` is required to expose it

**Recommendation:** verify the current UI in a running Home Assistant instance before changing `config_flow.py`. Do not add a placeholder `OptionsFlowHandler` based only on this repo; treat that as a separate HA-core behavior check.

### 4. (Optional) Add update listener for options-based reload

**File:** `__init__.py`
**Lines:** 12-28 (function `async_setup_entry`)

If you ever want to store config in `entry.options` (instead of custom storage files), wire up an update listener:

```python
async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    # ... existing setup code ...
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    return True


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
```

This is only needed if you migrate config to `entry.options`. It is unrelated to the current storage-backed config model; with today's custom storage files, the websocket-triggered reload (change #2) is the relevant activation path.

---

## Summary of Changes

| # | File | Change | Difficulty |
|---|------|--------|------------|
| 1 | `__init__.py` | Move `async_register_websocket_commands` to `async_setup` | Easy |
| 2 | `websockets.py` | Replace `async_handle_config_saved()` with `async_reload()` in `ws_save_config` | Easy |
| 3 | `config_flow.py` / `manifest.json` | Verify whether any code is actually needed for the Integrations-page Reload button | Easy (verification first) |
| 4 | `__init__.py` | (Optional) Add options update listener | Easy, only if migrating to `entry.options` |

## Risks and Edge Cases

### Fire-and-forget background tasks

`coordinator.invalidate_forecast()` and `coordinator.invalidate_tree()` create tasks via `hass.async_create_task()`. These are not tracked or cancelled during unload. If reload happens while one is running, the old coordinator can continue background work after unload.

- Forecast refresh can still write snapshot storage after the new coordinator has already loaded.
- Tree rebuild can still restart tick or rebuild subscriptions on the old coordinator instance.

Both task bodies catch/log exceptions, so failure is noisy rather than silent, but this is still a real lifecycle gap.

### Stored config vs active runtime mismatch

Between `helman/save_config` and the eventual reload, `helman/get_config` returns the newly saved stored config while runtime code keeps using the old `_active_config` and `_appliances_registry`. This is already the behavior codified by current code/tests, and it is the main reason a full reload is cleaner than expanding `async_handle_config_saved()`.

Also note that `HelmanStorage.async_load()` merges `DEFAULT_CONFIG`, while `async_save()` persists the raw payload. If the frontend ever sends a partial config, the post-reload runtime can differ from the immediate pre-reload in-memory config because defaults are re-applied during load.

### Reload re-normalizes persisted schedule

Full reload reruns `_async_normalize_schedule_document()`. That is a correctness benefit, not just a side effect:

- incompatible `slotMinutes` resets the persisted schedule
- invalid stored schedule data resets
- stale appliance actions are pruned against the active runtime registry

So config activation via reload can legitimately modify persisted schedule data when the new active config makes stored actions invalid.

### Invalid appliance config should remain non-fatal

Existing runtime-registry build behavior logs explicit errors and ignores invalid appliances rather than failing the whole integration. A reload-based activation path should preserve that behavior.

### `async_handle_config_saved` becomes dead code

After change #2, `coordinator.async_handle_config_saved()` is no longer the primary config-activation path. Removing it is fine. Keeping it as a generic hot-reload path would conflict with the repo's stored-config -> reload -> active-runtime contract unless its scope is explicitly narrowed and documented.

### Frontend reconnection

After `async_reload`, the websocket connection stays alive but `hass.data[DOMAIN]` is briefly empty during teardown/setup. Any websocket calls during this window will get `"not_loaded"` errors. The frontend needs to tolerate that short window; this repo does not prove the current UI behavior.

### Entity history continuity

Entities keep the same `unique_id` across reload (based on `entry.entry_id`), so HASS's recorder/history sees them as the same entity. No data loss.
