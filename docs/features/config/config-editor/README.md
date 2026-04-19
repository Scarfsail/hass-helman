# Helman UI Config Editor

## Intent

Helman should have a **dedicated configuration UI shipped with the integration**, not another Lovelace card in `hass-helman-card`.

The goal is to give the user one admin-oriented place to edit Helman's persisted config without touching YAML or backend internals directly. This follows the same high-level idea as `hass-door-window-watcher`:

- the integration owns the config editor UI
- the UI is opened from Home Assistant as a dedicated panel
- the panel loads and saves config through Home Assistant websocket commands
- the Lovelace card remains focused on runtime visualization and control

For Helman, that split is even more important because the config model is much richer than a normal options flow:

- nested `power_devices`
- scheduler control mapping
- appliance list
- EV charger controls, modes, eco gears, and vehicles

That shape is a poor fit for a native config flow wizard, but it is a good fit for a custom editor.

## Reference Pattern from Door Window Watcher

`hass-door-window-watcher` is the reference for the **delivery model**, not for the full implementation details.

Useful ideas to carry over:

- register a dedicated Home Assistant panel from the integration
- serve a frontend bundle from `custom_components/<domain>/frontend/dist/...`
- load the current stored config over websocket
- save the edited config over websocket

The important Helman-specific difference is that Helman should keep its stronger backend lifecycle:

- config is saved through `helman/save_config`
- save returns success first
- the integration reloads
- runtime code then rebuilds the validated active config from storage

So the editor should feel similar to Door Window Watcher from the user perspective, but internally it should respect Helman's stored-config -> reload -> active-runtime model.

## What the Editor Edits

From the UI perspective, the important contract is simple:

- load the current integration config through `helman/get_config`
- save changes through `helman/save_config`
- let the backend reload and rebuild the active runtime from that saved config

The exact persistence mechanism behind that websocket contract is a backend implementation detail. It is useful for architecture work, but it should not drive the editor design.

What *does* matter is scope:

- the editor manages Helman's persisted integration config
- it does **not** manage authored schedule state
- it does **not** manage cached forecast snapshots

So the editor is for the configuration model itself, not for runtime data or derived data.

## Config Lifecycle

The editor should follow this lifecycle rule:

1. **Stored config** is saved by `helman/save_config`.
2. **Validated active config** is built during integration reload/startup.
3. **Runtime registries** are built from the validated active config.

This distinction matters because Helman already treats runtime state as derived from the active config, not directly from the raw stored document.

Practical consequence:

- the editor saves the config document
- Helman reloads
- runtime APIs such as appliances, projections, and schedule execution then use the refreshed active config

## What Needs to Be Configured in This UI

The editor should cover the parts of `helman.config` that a user would otherwise have to craft manually.

### 1. General UI / tree config

Current top-level defaults already include:

- `history_buckets`
- `history_bucket_duration`
- `sources_title`
- `consumers_title`
- `others_group_label`
- `groups_title`
- `device_label_text`

These belong naturally in a simple "General" section.

### 2. `power_devices`

This is the core topology/config branch for Helman. The editor should eventually help configure things like:

- house entities
- solar entities and forecast config
- battery entities and forecast config
- grid entities and price/forecast config
- optional labels and grouping behavior

This branch is also where forecast-related setup already lives, for example:

- `power_devices.house.forecast`
- `power_devices.battery.forecast`

### 3. `scheduler`

The editor should expose schedule-control config such as:

- `scheduler.control.mode_entity_id`
- `scheduler.control.action_option_map`
- default execution behavior where relevant

This is backend control mapping, not authored schedule content.

### 4. `appliances`

This is the most important reason to build a custom editor.

The editor should support add/edit/remove for appliances, starting with `ev_charger`, including:

- appliance identity (`id`, `name`, `kind`)
- appliance limits
- charge switch entity
- use-mode select entity and mode definitions
- eco-gear select entity and configured min-power map
- vehicles
- per-vehicle telemetry
- per-vehicle limits

This is nested, repeatable, and validator-driven, which is exactly the kind of config that becomes awkward in a native options flow.

## What Does **Not** Belong in This Editor

The config editor should not become a dumping ground for every Helman screen.

### Keep out of scope:

- authored slot schedule editing
- runtime execution status
- forecast visualizations
- historical charts

Those belong in the runtime-facing Helman frontend, especially `hass-helman-card`.

In other words:

- **config editor** = define the model and entity mapping
- **Helman card / scheduling UI** = use that configured model at runtime

## Suggested Delivery Model

The current preferred direction is:

- keep `custom_components/helman/config_flow.py` minimal for bootstrap/single-instance setup
- add a dedicated panel UI inside the `hass-helman` integration
- keep the frontend bundle in this repo, next to the integration
- use websocket APIs for read/save
- reuse frontend ideas and styling patterns from `hass-helman-card` where useful

This keeps config editing close to:

- the websocket API contract
- backend validators
- integration reload behavior
- future appliance-specific validation errors

## Suggested File Shape

Based on Door Window Watcher, a reasonable future structure is:

```text
custom_components/helman/
  panel.py
  frontend/
    package.json
    vite.config.ts
    src/
    dist/
```

Likely additional backend touchpoints:

- `custom_components/helman/__init__.py`
- `custom_components/helman/websockets.py`
- `custom_components/helman/storage.py`
- `custom_components/helman/config_flow.py`

## Example of the Kind of Config This Editor Should Manage

```yaml
history_buckets: 60
history_bucket_duration: 1
sources_title: Energy Sources
consumers_title: Energy Consumers
others_group_label: Others
groups_title: Group by:

power_devices:
  house:
    entities:
      power: sensor.house_power
      today_energy: sensor.house_energy_today
    forecast:
      total_energy_entity_id: sensor.house_energy_total
      min_history_days: 14
      training_window_days: 56
  battery:
    entities:
      capacity: sensor.battery_soc
      min_soc: sensor.battery_min_soc
      max_soc: sensor.battery_max_soc
      remaining_energy: sensor.battery_remaining_energy

scheduler:
  control:
    mode_entity_id: input_select.rezim_fv
    action_option_map:
      normal: Standardni
      charge_to_target_soc: Nucene nabijeni
      discharge_to_target_soc: Nucene vybijeni
      stop_charging: Zakaz nabijeni
      stop_discharging: Zakaz vybijeni

appliances:
  - kind: ev_charger
    id: garage-ev
    name: Charger EV in Garage
    limits:
      max_charging_power_kw: 11.0
    controls:
      charge:
        entity_id: switch.ev_nabijeni
      use_mode:
        entity_id: select.solax_ev_charger_charger_use_mode
        values:
          Fast:
            behavior: fixed_max_power
          ECO:
            behavior: surplus_aware
      eco_gear:
        entity_id: select.solax_ev_charger_eco_gear
        values:
          6A:
            min_power_kw: 1.4
          10A:
            min_power_kw: 2.3
    vehicles:
      - id: kona
        name: Kona
        telemetry:
          soc_entity_id: sensor.kona_ev_battery_level
          charge_limit_entity_id: number.kona_ac_charging_limit
        limits:
          battery_capacity_kwh: 64.0
          max_charging_power_kw: 11.0
```

The exact fields can evolve, but this example shows why the editor should be a proper custom UI rather than a multi-step config flow.

## UX Expectations

At minimum, the editor should support:

- loading the current stored config
- editing nested sections safely
- add/remove/reorder where lists are used
- entity picking instead of raw string typing where possible
- validation feedback before or during save
- clear save/reload messaging

The long-term goal is that a user can fully set up Helman from Home Assistant UI without manually editing raw config documents.
