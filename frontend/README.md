# Helman Card — House Electricity Manager Card

A Home Assistant Lovelace custom card to visualize and control household electricity flows. It shows real-time power for sources (solar, battery, grid) and consumers (house, devices), with animated flow indicators and compact history bars. It can group house devices by Home Assistant Labels and surface custom label badges per device.

- Live power and per-bucket history bars (configurable buckets and duration)
- Sources vs Consumers layout with animated flow arrows scaled by max power
- House device tree built from Energy device consumption prefs (with “Unmeasured power”)
- Optional house consumption forecast in the `custom:helman-simple-card` house detail with base and deferrable breakdown charts
- Entity disambiguation via HA Labels for power sensor and power switch selection
- Group devices by label categories (e.g., Location, Type) with emojis/text
- Optional aggregate info for Solar (today + forecast), Grid (import/export), and Battery (charge/empty ETA)


## Installation

You can install via HACS (as a custom repository) or manually.

### HACS (custom repository)
1. In Home Assistant, open HACS → Integrations → … menu → Custom repositories.
2. Add this repository URL and select category “Lovelace”.
3. Install “House Electricity Manager Card”.
4. Add a Lovelace resource (if not auto-added):
  - URL: /hacsfiles/hass-helman-card/helman-card-prod.js
   - Type: JavaScript Module

### Manual installation
1. Download the built file from Releases: `helman-card-prod.js`.
2. Copy it to your HA config under `www/helman-card/helman-card-prod.js`.
3. Add a Lovelace resource:
   - URL: /local/helman-card/helman-card-prod.js
   - Type: JavaScript Module


## Quick start (minimal card)
```yaml
type: custom:helman-card
power_devices:
  house:
    entities:
      power: sensor.house_power
  grid:
    entities:
      power: sensor.grid_power
  solar:
    entities:
      power: sensor.solar_power
  battery:
    entities:
      power: sensor.battery_power
```

This renders sources and consumers panels plus the house subtree from Energy prefs.


## Configuration reference

Top-level schema is `HelmanCardConfig`. Only `power_devices` is required; everything else is optional.

### Top-level options
- `type`: string — Must be `custom:helman-card`.
- `sources_title`: string — Title for the sources panel. Default: “Energy Sources”.
- `consumers_title`: string — Title for the consumers panel. Default: “Energy Consumers”.
- `groups_title`: string — Title preceding grouping chips. Default: “Group by”.
- `max_power`: number — Scaling reference (W) for animated flow arrows. If omitted, defaults to a 3-phase 25A system: `25 * 230 * 3`.
- `history_buckets`: number — Number of history samples to keep/render. Default: 60.
- `history_bucket_duration`: number — Duration of each bucket in seconds (also the live update interval). Default: 1.
- `power_sensor_name_cleaner_regex`: string — JavaScript regex (no slashes, global flag is applied) used to clean device names derived from sensors, e.g. to remove suffixes. Example: `" - [Pp]ower$"` or `"^[A-Z]{2}-"`.
- `device_label_text`: object — Mapping to enable label grouping and per-device badges. See “Grouping by labels”.
- `show_empty_groups`: boolean — If true, show label groups even when empty. Default: false.
- `show_others_group`: boolean — If true, show an “Others” group with unmatched devices. Default: true.
- `others_group_label`: string — Custom label for the Others group. Default: “Others”.

### `power_devices`
Defines entities for the four power endpoints. At least `house.entities.power` should be provided to build the consumer tree around the house.

Common optional fields (house tree disambiguation):
- `source_name`: string — Optional display override for the source device name.
- `consumption_name`: string — Optional display override for the consumer device name.
- `power_sensor_label`: string — Label name used to select the correct power sensor when a device exposes multiple power entities.
- `power_switch_label`: string — Label name used to select the matching switch entity for control.

Note: `power_sensor_label` and `power_switch_label` are only applied when building the house devices from Energy preferences. They do not affect the explicitly configured source tiles (grid/solar/battery).

Note: Label names must match HA Labels exactly (see Settings → Automations & Scenes → Labels). The card resolves label IDs internally.

#### HouseDeviceConfig (`power_devices.house`)
- `unmeasured_power_title`: string — Name for the synthetic “unmeasured” child node.
- `entities`:
  - `power`: sensor entity_id — Total house power.
  - `today_energy`: sensor entity_id — Optional; today's house energy consumption (any energy unit supported).

Note: House consumption forecast uses a separate shared/backend config surface. See “House consumption forecast” below.

#### GridDeviceConfig (`power_devices.grid`)
- `entities`:
  - `power`: sensor entity_id — Grid power (positive import, negative export). The card treats import/export explicitly when rendering.
  - `today_export`: sensor entity_id — Optional; shown in consumer mode (any energy unit supported).
  - `today_import`: sensor entity_id — Optional; shown in source mode (any energy unit supported).

#### BatteryDeviceConfig (`power_devices.battery`)
- `entities`:
  - `power`: sensor entity_id — Battery power (sign determines charge/discharge; card treats directions for source/consumer differently).
  - `capacity`: sensor entity_id (%) — Current SoC percent.
  - `min_soc`: sensor entity_id (%) — Target minimum.
  - `max_soc`: sensor entity_id (%) — Target maximum.
  - `remaining_energy`: sensor entity_id (Wh) — Remaining energy used to estimate time to min/max.

When sufficient battery fields are present and current power is significant, the card shows target SoC, ETA time, and wall clock time.

#### SolarDeviceConfig (`power_devices.solar`)
- `entities`:
  - `power`: sensor entity_id — Solar inverter/array power.
  - `today_energy`: sensor entity_id — Energy produced today (any energy unit supported).
  - `remaining_today_energy_forecast`: sensor entity_id — Remaining forecast energy (any energy unit supported).


## Grouping by labels (house devices)
The card can group house devices into virtual groups based on HA Labels. Provide a mapping where the top-level keys are category names (rendered as chips), and each category maps label names to an emoji/text badge used in device info.

Example:
```yaml
device_label_text:
  Location:
    Kitchen: "🍳"
    Living room: "🛋️"
    Bedroom: "🛏️"
  Type:
    Heating: "🔥"
    Entertainment: "🎮"
show_empty_groups: false
show_others_group: true
others_group_label: "Other devices"
```

Usage notes:
- The chips bar appears above the house device list when `device_label_text` is configured.
- Clicking a chip switches the section to grouped view for that category. Groups are collapsed by default; expand to see members.
- Devices inherit all labels assigned to any of their entities. First matching label in the category determines the group.
- Per-device badges list all matching mappings across categories (e.g., “🍳 • 🔥”).


## Entity and data requirements
- Power sensors should have `device_class: power` so the card can locate them per device via the Entity Registry.
- The house device tree is built from Energy → Device consumption preferences (uses the `included_in_stat` relationship to form parent/child links).
- All energy sensors (House `today_energy`, Grid `today_import`/`today_export`, Solar `today_energy` and `remaining_today_energy_forecast`) automatically detect their units from the sensor's `unit_of_measurement` attribute and convert appropriately. Supported units include Wh, kWh, MWh, and GWh.
- Label selection for power sensor/switch requires the Label Registry (core) and correct label assignment in HA.

## House consumption forecast

House forecast data is rendered through the shared unified forecast UI.

In `custom:helman-simple-card`, each node dialog now uses its own preset overview composition without a forecast mode switch.

It is driven by the shared Helman config under `power_devices.house.forecast`; it is not a dedicated Lovelace YAML option of `custom:helman-simple-card`.

```yaml
power_devices:
  house:
    forecast:
      total_energy_entity_id: sensor.house_energy_total
      min_history_days: 14
      training_window_days: 42
      deferrable_consumers:
        - energy_entity_id: sensor.ev_charging_energy_total
          label: EV Charging
        - energy_entity_id: sensor.pool_heating_energy_total
          label: Pool Heating
```

- `total_energy_entity_id`: required cumulative energy sensor used as the house forecast source.
- `min_history_days`: optional minimum history span from the oldest available hourly statistics row before charts can be shown. Default: `14`.
- `training_window_days`: optional Recorder/statistics lookback window used to build the forecast. Default: `42`. Keep this greater than or equal to `min_history_days`, otherwise the backend never queries far enough back to satisfy the threshold.
- `deferrable_consumers`: optional per-consumer forecast inputs.
  - `energy_entity_id`: required cumulative energy sensor for the consumer.
  - `label`: optional UI label for the deferrable breakdown. Falls back to the entity_id if omitted.

Operational notes:

- `house.entities.today_energy` is not a fallback source for the house forecast.
- v1 checks history span from the oldest available Recorder row; it does not validate gaps or continuity inside that window.
- Each deferrable consumer must be a non-overlapping sub-meter already included in the configured house total. The backend derives baseline as `house total - sum(deferrables)`.
- The 168-hour forecast is grouped by calendar day in the UI, so the house detail usually shows today plus the next 7 dates.

## Standalone forecast card

The standalone forecast card is available as `custom:helman-forecast-card`.

It loads the shared `helman/get_forecast` payload once, then renders a unified forecast view that can combine:

- solar production
- battery SoC and charge/discharge flow
- house consumption
- grid price

By default, the standalone card uses the same overview composition as the solar and grid node dialogs:

- solar gauge
- solar chart
- battery chart
- price chart

The same unified renderer is also used in `custom:helman-simple-card` node dialogs, where each node type has its own preset overview:

- solar and grid: solar gauge, solar chart, battery chart, price chart
- house: solar gauge, solar chart, battery chart, consumption gauge, consumption chart
- battery: solar gauge, solar chart, battery gauge, battery chart

Expanded day detail follows the same received config, so only the corresponding forecast rows are shown.

```yaml
type: custom:helman-forecast-card
transparent_background: false
mobile_density: compact
show_solar_gauge: true
show_solar_chart: true
show_battery_gauge: false
show_battery_chart: true
show_consumption_gauge: false
show_consumption_chart: false
show_price_chart: true
```

Options:

- `transparent_background`: removes card background and shadow.
- `mobile_density`: `comfortable` (default) or `compact` for tighter narrow-screen spacing.
- `show_solar_gauge`: hide/show the solar gauge.
- `show_solar_chart`: hide/show the solar chart.
- `show_battery_gauge`: hide/show the end-of-day battery SoC gauge.
- `show_battery_chart`: hide/show the battery chart.
- `show_consumption_gauge`: hide/show the consumption gauge.
- `show_consumption_chart`: hide/show the consumption chart.
- `show_price_chart`: hide/show the price chart.

The standalone forecast card uses the same backend forecast configuration described above for solar, house, battery, and price data. These YAML options only control presentation of the unified Lovelace card.


## Solar inspector card

The solar bias correction inspector is available as `custom:helman-solar-inspector-card`.

It uses the Helman backend `helman/solar_bias/inspector` WebSocket API and keeps the same inspector UI that was previously embedded in the integration config panel.

```yaml
type: custom:helman-solar-inspector-card
transparent_background: false
```

Options:

- `transparent_background`: removes card background and shadow.


## Scheduling card

The manual scheduling card is available as `custom:helman-scheduling-card`.

It reads the backend's slot-native `helman/get_schedule` response, shows the current slot in a dedicated **Now** strip, groups future slots into day sections and readable intervals, and lets you edit a single slot, a contiguous sub-range, or a whole interval through a dialog.

This card depends on the Helman backend scheduling API being configured and available. The Lovelace config for v1 is intentionally minimal and YAML-only:

```yaml
type: custom:helman-scheduling-card
transparent_background: false
default_expanded_days: 1
show_header: true
```

Options:

- `title`: deprecated and ignored; preserved only for backward compatibility.
- `transparent_background`: removes card background and shadow.
- `default_expanded_days`: how many day sections start expanded by default. Use `0` for fully collapsed; values above the available day count expand all days.
- `show_header`: shows the compact header with updated text, refresh button, and execution toggle. Default: `true`.


## Examples

Minimal with grouping and regex cleaner:
```yaml
type: custom:helman-card
sources_title: Energy Sources
consumers_title: Energy Consumers
groups_title: Group by
max_power: 17250 # 25A x 230V x 3
history_buckets: 120
history_bucket_duration: 2
power_sensor_name_cleaner_regex: " - [Pp]ower$"
power_devices:
  house:
    unmeasured_power_title: Unmeasured
    power_sensor_label: Power
    power_switch_label: Control
    entities:
      power: sensor.house_power
      today_energy: sensor.house_energy_today_wh
  grid:
    entities:
      power: sensor.grid_power
      today_import: sensor.grid_energy_import
      today_export: sensor.grid_energy_export
  solar:
    entities:
      power: sensor.solar_power
      today_energy: sensor.solar_energy_today_wh
      remaining_today_energy_forecast: sensor.solar_forecast_remaining_wh
  battery:
    entities:
      power: sensor.battery_power
      capacity: sensor.battery_soc
      min_soc: number.battery_min_soc
      max_soc: number.battery_max_soc
      remaining_energy: sensor.battery_energy_remaining_wh
device_label_text:
  Location:
    Kitchen: "🍳"
    Living room: "🛋️"
  Type:
    Heating: "🔥"
    Entertainment: "🎮"
show_empty_groups: false
show_others_group: true
others_group_label: Other
```


## Tips and troubleshooting
- No devices shown under house: ensure Energy → Device consumption is configured and your power sensors feed the statistics used there.
- House forecast in `custom:helman-simple-card` not visible or only showing a status message: confirm shared `power_devices.house.forecast.total_energy_entity_id` config is set, `training_window_days` is not smaller than `min_history_days`, and Recorder has hourly statistics spanning at least `min_history_days` from the oldest available row. `today_energy` alone does not enable the forecast.
- Strange baseline or breakdown numbers: make sure each configured deferrable consumer is a non-overlapping sub-meter already included in the configured house total.
- Unmeasured power: a synthetic child is added per node (except virtual grouping nodes) to account for parent minus sum(children).
- History bars frozen: confirm `history_bucket_duration` and that entities update frequently; the card appends live samples between history refreshes.
- House forecast updates hourly in the backend and is served from a persisted snapshot between refreshes.
- Regex cleaner: JavaScript flags are not inline here; the card applies `g`. Use character classes for case-insensitivity (e.g., `[Pp]ower`). Test your pattern safely.


## Development
- Build (production): generates `dist/helman-card-prod.js`.
- Build (dev/watch): generates `dist/helman-card-dev.js`.

Package scripts:
```bash
npm run build-prod
npm run build-dev
npm run watch
```

Load `helman-card-dev.js` as a resource during development for faster debugging.


## License
This project includes type-only references from the Home Assistant frontend for better type safety. See LICENSE of included upstream components as applicable.
