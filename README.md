# Helman Energy

A Home Assistant custom integration for household electricity management: consumption/production
forecasting, battery capacity forecasting, solar bias correction, manual scheduling, and a bundled
Lovelace card to visualize and control power flows.

The integration ships its own Lovelace card and config-editor panel — installing the integration is
enough; the card's Lovelace resource is registered automatically, no manual resource step needed.

## Installation

### HACS (custom repository)
1. In Home Assistant, open HACS → Integrations → ⋮ menu → Custom repositories.
2. Add this repository URL, category **Integration**.
3. Install "Helman Energy", then restart Home Assistant.
4. Add the integration via **Settings → Devices & Services → Add Integration → Helman Energy**.
5. The `custom:helman-card` Lovelace resource is registered automatically (UI/storage-mode dashboards
   only — YAML-mode dashboards are not auto-registered).

### Migrating from `hass-helman-card`
The card used to be a separate HACS repository (`hass-helman-card`, category Lovelace). It has been
merged into this integration and that repository is now archived.

If you previously installed the card separately:
1. Remove the old `hass-helman-card` entry from HACS (Integrations → Lovelace list).
2. Remove any manually-added Lovelace resource pointing at
   `/hacsfiles/hass-helman-card/...` (Settings → Dashboards → Resources) — otherwise the card is
   registered twice.
3. Install/update this integration as described above. The card element name
   (`custom:helman-card`) is unchanged, so existing dashboard YAML keeps working.

## Cards

### `custom:helman-card`
Visualizes real-time power for sources (solar, battery, grid) and consumers (house, devices), with
animated flow indicators and compact history bars. Can group house devices by Home Assistant Labels
and surface custom label badges per device.

- Live power and per-bucket history bars (configurable buckets and duration)
- Sources vs Consumers layout with animated flow arrows scaled by max power
- House device tree built from Energy device consumption prefs (with "Unmeasured power")
- Optional house consumption forecast in the node detail dialogs
- Entity disambiguation via HA Labels for power sensor and power switch selection
- Group devices by label categories (e.g., Location, Type) with emojis/text
- Optional aggregate info for Solar (today + forecast), Grid (import/export), and Battery
  (charge/empty ETA)

#### Quick start
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

#### Configuration reference

Top-level schema is `HelmanCardConfig`. Only `power_devices` is required; everything else is optional.

**Top-level options**
- `type`: string — Must be `custom:helman-card`.
- `sources_title` / `consumers_title` / `groups_title`: panel titles. Defaults: "Energy Sources",
  "Energy Consumers", "Group by".
- `max_power`: number — Scaling reference (W) for animated flow arrows. Defaults to a 3-phase 25A
  system: `25 * 230 * 3`.
- `history_buckets`: number — Number of history samples to keep/render. Default: 60.
- `history_bucket_duration`: number — Duration of each bucket in seconds (also the live update
  interval). Default: 1.
- `power_sensor_name_cleaner_regex`: string — JavaScript regex (no slashes, global flag applied) used
  to clean device names derived from sensors, e.g. `" - [Pp]ower$"`.
- `device_label_text`: object — Mapping to enable label grouping and per-device badges. See
  "Grouping by labels".
- `show_empty_groups` / `show_others_group` / `others_group_label`: control the "Others" group.
  Defaults: `false`, `true`, `"Others"`.

**`power_devices`**
Defines entities for the four power endpoints. At least `house.entities.power` should be provided to
build the consumer tree around the house.

Common optional fields (house tree disambiguation):
- `source_name` / `consumption_name`: display name overrides.
- `power_sensor_label` / `power_switch_label`: HA Label names used to disambiguate the power sensor /
  switch entity when a device exposes multiple. Only applied when building the house tree from Energy
  preferences — not the explicitly configured source tiles (grid/solar/battery). Label names must
  match HA Labels exactly.

- `power_devices.house`: `unmeasured_power_title`; `entities.power`, `entities.today_energy`.
  House consumption forecast uses a separate config surface — see "House consumption forecast" below.
- `power_devices.grid`: `entities.power` (positive import, negative export),
  `entities.today_export`, `entities.today_import`.
- `power_devices.battery`: `entities.power`, `entities.capacity` (% SoC), `entities.min_soc`,
  `entities.max_soc`, `entities.remaining_energy` (Wh). When enough fields are present and current
  power is significant, the card shows target SoC, ETA time, and wall clock time.
- `power_devices.solar`: `entities.power`, `entities.today_energy`,
  `entities.remaining_today_energy_forecast`.

All energy sensors auto-detect units from `unit_of_measurement` (Wh, kWh, MWh, GWh supported).

#### Grouping by labels (house devices)
Group house devices into virtual groups based on HA Labels. Top-level keys are category names
(rendered as chips); each category maps label names to an emoji/text badge.

```yaml
device_label_text:
  Location:
    Kitchen: "🍳"
    Living room: "🛋️"
  Type:
    Heating: "🔥"
    Entertainment: "🎮"
show_empty_groups: false
show_others_group: true
others_group_label: "Other devices"
```

Devices inherit all labels assigned to any of their entities; the first matching label in a category
determines the group. Per-device badges list all matching mappings across categories.

#### House consumption forecast
Driven by the shared Helman config under `power_devices.house.forecast` (not a Lovelace YAML option):

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
```

- `total_energy_entity_id`: required cumulative energy sensor used as the forecast source.
- `min_history_days` (default 14): minimum history span (from the oldest hourly statistics row)
  before charts can be shown.
- `training_window_days` (default 42): Recorder lookback window; keep ≥ `min_history_days`.
- `deferrable_consumers`: optional per-consumer sub-meters, each a non-overlapping sub-meter already
  included in the house total. Baseline is derived as `house total - sum(deferrables)`.

### `custom:helman-solar-inspector-card`
Solar bias correction inspector, using the `helman/solar_bias/inspector` WebSocket API.

```yaml
type: custom:helman-solar-inspector-card
transparent_background: false
```

### `custom:helman-scheduling-card`
Manual scheduling card, reading the backend's slot-native `helman/get_schedule` response. Shows the
current slot in a **Now** strip, groups future slots into day sections, and supports editing a single
slot, a sub-range, or a whole interval.

```yaml
type: custom:helman-scheduling-card
transparent_background: false
default_expanded_days: 1
show_header: true
```

## Tips and troubleshooting
- No devices shown under house: ensure Energy → Device consumption is configured and your power
  sensors feed the statistics used there.
- House forecast not visible or only showing a status message: confirm
  `power_devices.house.forecast.total_energy_entity_id` is set, `training_window_days` ≥
  `min_history_days`, and Recorder has hourly statistics spanning at least `min_history_days` from
  the oldest available row.
- Strange baseline/breakdown numbers: make sure each deferrable consumer is a non-overlapping
  sub-meter already included in the configured house total.
- Card resource not auto-registering: auto-registration only works with storage-mode (UI) dashboards.

## Development
Frontend TypeScript source lives at repo-root `frontend/` (dev-only, never shipped to users).

```bash
git submodule update --init frontend/hass-frontend
npm --prefix frontend ci
npm --prefix frontend run build   # → custom_components/helman/frontend_compiled/
npm --prefix frontend run watch   # dev/watch mode
```

### Running tests

The backend tests import the real Home Assistant package, so they need an
interpreter with `homeassistant` installed (Python ≥3.14.2, matching HA's floor).
The suite is run **one file per process** — many test modules install conflicting
`sys.modules` stubs at import time, so a single `pytest tests/` invocation would
cross-pollute and fail. `scripts/run_tests.sh` handles this for you.

```bash
scripts/setup_test_venv.sh    # once — creates .venv and installs requirements-test.txt (idempotent)
scripts/run_tests.sh          # run the whole suite (auto-detects .venv)
scripts/run_tests.sh tests/test_schedule.py   # run specific files
```

`scripts/run_tests.sh` uses the repo's `.venv` when present; override with
`PYTHON=/path/to/python scripts/run_tests.sh`. To run against the Home Assistant
dev container instead of a local venv, use `scripts/run_tests_in_container.sh`.

CI (`.github/workflows/release.yml`) runs the same `scripts/run_tests.sh` against
`requirements-test.txt` on every push and pull request. The release job depends
on the tests passing, so a red test run blocks the release.
