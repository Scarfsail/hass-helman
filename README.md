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

## Supporting entities

Helman reads and writes plain Home Assistant entities; it never talks to hardware itself. Your
inverter integration supplies most of them, but a few have to be built by hand — house load and its
energy integral, battery SOC bounds, signed grid power, the mode selector the battery schedule is
executed through, and an EV charging switch.

See [docs/supporting-entities.md](docs/supporting-entities.md) for what each one is for, where in the
config and code it is consumed, and a ready-to-adapt Solax example.

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
- `power_devices.grid`: `entities.power` (positive export, negative import),
  `entities.today_export`, `entities.today_import`. Solar bias correction reads the signed power
  sensor too, to tell a clipped slot from an exporting one.
- `power_devices.battery`: `entities.power`, `entities.capacity` (% SoC), `entities.min_soc`,
  `entities.max_soc`, `entities.remaining_energy` (Wh). When enough fields are present and current
  power is significant, the card shows target SoC, ETA time, and wall clock time.
- `power_devices.solar`: `entities.power`, `entities.today_energy`. The "remaining today" figure
  next to it on the card is Helman's own bias-corrected
  `sensor.helman_energy_production_today_remaining` and is not configurable.

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
Driven by the shared Helman config under `power_devices.house.forecast` for the entity, and under
`training.house_consumption` for the history windows (not a Lovelace YAML option):

```yaml
power_devices:
  house:
    forecast:
      total_energy_entity_id: sensor.house_energy_total

training:
  house_consumption:
    min_history_days: 14
    training_window_days: 42
```

- `power_devices.house.forecast.total_energy_entity_id`: required cumulative energy sensor used as
  the forecast source.
- `training.house_consumption.min_history_days` (default 14): minimum history span (from the oldest
  hourly statistics row) before charts can be shown.
- `training.house_consumption.training_window_days` (default 56): Recorder lookback window; keep ≥
  `min_history_days`. This is the main driver of the nightly training cost — see
  [Scheduled work](#scheduled-work).

**Deferrable consumers** — the loads subtracted from the house total to leave the baseline
(`house total - sum(deferrables)`) — are not listed here. They are read off `controllables`: a
controllable is a device whose consumption can be deferred, so each one that names its energy meter
counts as one, unless it opts out.

```yaml
controllables:
  - id: ev
    kind: ev_charger
    name: EV Charging
    controls: { ... }
    consumption:
      energy_entity_id: sensor.ev_charging_energy_total   # a non-overlapping sub-meter
      deferrable: true                                    # optional; true is the default
```

Set `deferrable: false` for a device you meter for its own demand projection but want left inside
the baseline. The inverter may not declare `consumption` at all — it moves energy rather than
drawing it.

For how the house-load chain feeding `total_energy_entity_id` is built, see
[Supporting entities](docs/supporting-entities.md#1-the-house-load-chain).

### `custom:helman-solar-inspector-card`
Solar bias correction inspector, using the `helman/solar_bias/inspector` WebSocket API.

```yaml
type: custom:helman-solar-inspector-card
transparent_background: false
```

## Appliance self-sustainability

When Helman schedules an appliance (`appliance_runtime`), it can ask what running it *does* to the battery rather than only what the house looks like without it. Two numbers on each condition group control that, and they answer different questions.

**Self-sustainability tolerance %** (`ensure_self_sustainability`) — how much of the battery's capacity the appliance may spend per day on energy the sun did not provide. Helman re-simulates the whole 48-hour horizon with the appliance's runs included and compares it against the same horizon without them. Whatever the runs cost is added up and must fit the tolerance:

```
spent = (battery the day ends lower than it otherwise would have) + (extra grid energy bought)
```

Three things about that sum are worth knowing before you pick a value.

- **It is measured against the forecast without the appliance, not against a full battery.** If the day was going to end at 55 % anyway, a tolerance of 10 % of capacity permits it to end near 45 %.
- **Battery and grid count equally.** A cloudy day where the appliance ends on the same state of charge but imported 2 kWh has spent as much of the tolerance as one where it took 2 kWh out of the battery. Helman does not choose between them: a shortfall is covered by the battery first, and by the grid only once the battery is empty or too slow to keep up. Which one you get is battery physics, not policy — so the tolerance governs both.
- **It is a ceiling, not a target.** A run placed in midday surplus that would otherwise have been exported can cost nothing at all.

`0` means the day must pay for itself entirely from the sun, which in practice confines the appliance to daylight hours — though it may still dip the battery deeply at noon as long as the afternoon refills it, because the tolerance is about where the day *lands*, not how it swings on the way. `100` switches it off. In between is a real allowance: on a 20 kWh battery, `10` is 2 kWh a day. Higher values are more permissive, and because the unit is a share of the *whole* battery while a single run is a few kWh, the useful settings bunch up at the bottom of the range. Leave it empty to ignore the battery impact entirely.

**Required reserve above min SoC %** (`self_sustainability_margin_pct`, default `5`) — a hard floor the projected battery must never cross, in percentage points above the inverter's own minimum SoC. With an inverter minimum of 10 % and a reserve of 5, the forecast may never drop below 15 %.

The reserve is not a weaker version of the tolerance; the two bite at opposite ends. The reserve is about the battery's worst *moment* and applies across the whole 48-hour horizon, so an evening run can be refused for a dip it would cause the next morning — it bites when the battery is already low. The tolerance is about *how much* is spent and is scored per day — it bites when the battery is full and there is headroom to burn. Both apply at every tolerance value, including `0`: a day can balance overall and still dip too low at noon.

A slot that fails either test is skipped and the next candidate is tried, so a constrained day usually runs fewer hours rather than not running at all. If the battery is projected below the floor even *without* the appliance, the inspector says so rather than blaming the appliance for it.

The mechanism, the trace codes and the config migration are documented in [docs/features/automation/optimizers/helman-appliance-runtime-self-sustainability-implementation-plan.md](docs/features/automation/optimizers/helman-appliance-runtime-self-sustainability-implementation-plan.md).

## Tips and troubleshooting
- No devices shown under house: ensure Energy → Device consumption is configured and your power
  sensors feed the statistics used there.
- House forecast not visible or only showing a status message: confirm
  `power_devices.house.forecast.total_energy_entity_id` is set,
  `training.house_consumption.training_window_days` ≥
  `training.house_consumption.min_history_days`, and Recorder has hourly statistics spanning at
  least `min_history_days` from the oldest available row.
- Strange baseline/breakdown numbers: make sure each deferrable consumer is a non-overlapping
  sub-meter already included in the configured house total.
- Card resource not auto-registering: auto-registration only works with storage-mode (UI) dashboards.
- Solar inspector price strip empty or missing bars on past days: neither `sensor.helman_grid_import_price` nor your configured `power_devices.grid.forecast.sell_price_entity_id` may be excluded from Recorder. The inspector reads a past day's rates back out of their recorded history, so an `exclude` entry (or a `purge_keep_days` shorter than the inspector's day range) silently costs you that history. The import side falls back to the `import_price_windows` table where history is missing; the export side has no fallback, because a spot price is not derivable from config.

## Scheduled work

Helman runs a handful of jobs on timers. This is what they are, when they fire, and what they
cost — useful if you are wondering what the integration is doing when you are not looking at it.

| # | Job | Runs on a timer | Also triggered by | Cost |
|---|---|---|---|---|
| 1 | **Power tick** | every `history_bucket_duration` s (default **5 s**) | device-tree invalidation (entity/device registry updates, an Energy prefs change); a config save | Cheap |
| 2 | **Schedule executor reconcile** | every **30 s** | startup; any schedule write; execution enable/disable; restore-normal-state; a config save | Cheap |
| 3 | **Pre-execution reality check** | inside #2, so in practice every **30 s** | — | Cheap |
| 4 | **Forecast rebuild** | **:00, :15, :30, :45** | startup; a config save; solar-bias trained/status events; a completed house-consumption fit from #6 | Moderate |
| 5 | **Automation re-plan** | — | a successful #4 (0.5 s debounce, only when automation has enabled optimizers); a day-editor edit; execution enable; condition drift seen by #3; "run now" | Moderate |
| 6 | **Nightly training batch** | daily at `training_time` (default **03:00**) | startup or a config save, when the stored profile is missing, no longer matches your config, or is over 48 h old; the manual "train now" button (solar bias only) | **Heavy — off-peak by design** |
| 7 | **Battery capacity forecast** | — (on demand, 300 s cache) | every card read, when its inputs have actually changed | Moderate |

**Opening or refreshing a card never rebuilds the house or solar forecast.** Those are served from
the last prepared snapshot, whatever its age; the work that prepares them runs on its own schedule.
What a read still computes is the battery projection and the appliance demand projection feeding it
(job #7), and only when its inputs have actually changed — it is anchored to the current battery
reading, which is what lets the battery curve move the moment you edit a slot. That reading is
itself one of the inputs, so on a battery under load the cache turns over well before its 300 s
ceiling. Rebuilding reads today's battery history from Recorder, which is bounded by the length of
the day.

**No card read issues a multi-day Recorder query.** Appliances that estimate their energy use from
history (`consumption.projection.strategy: history_average`) used to have their `lookback_days` window read
inside that projection rebuild, so a card refresh or a slot edit could block on a 30-day scan. That
estimate is resolved once a night by job #6 now and read from storage here.

If a forecast has not been rebuilt for over an hour, the cards show a warning banner rather than
going blank — old data still beats no data, and the banner is what tells you something is wrong. A
card *does* go blank when a setting changes such that the stored data no longer answers the
question you are now asking; that resolves as soon as the rebuild finishes.

### What each job does

1. **Power tick** — Helman's own live-power sampler, independent of Recorder: it reads your power
   sensors into ring buffers, works out the "Others" remainder for each parent node, and computes
   the consumption/production totals and source ratios that colour the bars. Pure state reads and
   arithmetic, no I/O.
2. **Schedule executor reconcile** — the only job that touches hardware. It finds the slot covering
   now and makes the inverter and each appliance match it, issuing a service call only when the
   desired state differs from what was last applied. With execution disabled, planning still runs;
   only this apply step is skipped. The cards then show the plan and the reality side by side: the
   schedule strips keep showing what Helman would do, while the forecast curves project the
   unmanaged house — no scheduled inverter action and no scheduled appliance run, because neither
   will happen while execution is off.
3. **Pre-execution reality check** — execution conditions ("only when the EV is plugged in") are
   evaluated at planning time and stamped onto each slot. This re-checks them against live state
   before anything is applied, and asks for a re-plan if reality has moved.
4. **Forecast rebuild** — rebuilds the house consumption, solar and automation forecasts and
   publishes them to the cards and sensors. It reads only today's history from Recorder; every
   multi-day read belongs to job #6.
5. **Automation re-plan** — the optimizer loop that decides what goes into each schedule slot. It
   never rebuilds forecasts, it reads the ones job #4 cached, which is why it can also run on its
   own after an edit.
6. **Nightly training batch** — the heavy Recorder work, deliberately parked in the small hours. It
   runs three jobs one after another (never at the same time — they share Recorder's worker
   thread): solar bias correction, which learns how your forecast provider is systematically wrong
   for your roof; the house consumption profile, which fits an hour-of-week model over
   `training.house_consumption.training_window_days` of history; and the per-appliance energy
   estimates, which work out how much each `history_average` appliance actually draws while it is
   running. All of it is stored, so
   a restart reuses it instead of recomputing. Changing a relevant setting recomputes immediately
   rather than waiting for the next night, so you see your change take effect.
7. **Battery capacity forecast** — projects battery state of charge across the horizon: forecast
   solar minus forecast demand, with the scheduled action for each slot applied, carried forward
   from the current live reading. It is what draws the battery curve and why editing a slot moves
   it right away.

### The knobs that scale the cost

- `history_bucket_duration` (default 5 s) — how often job #1 samples. Lower means smoother bars and
  more work; it is the only job on a seconds-level cadence.
- `training_time` (default `03:00`) — when the nightly batch runs. Pick a quiet hour: these jobs
  read a lot of Recorder history and you do not want them competing with anything.
- `training.house_consumption.training_window_days` (default 56) — how much history the house
  consumption fit reads. This is the single biggest driver of job #6's cost. It has no effect on the
  per-quarter-hour work.
- An appliance's `consumption.projection.lookback_days` (default 30) — how much history each such
  appliance's estimate reads: two Recorder queries over the window, one for its switch/climate
  entity and one for its energy meter. Like `training.house_consumption.training_window_days`, this
  is a **job #6** cost paid once a night, so it scales the nightly run rather than anything you wait
  for. With every appliance on `strategy: fixed` (the default) the job has nothing to do at all.

### If Home Assistant feels sluggish

All four quarter-hour boundaries behave the same. Job #4 fires at `:00`, `:15`, `:30` and `:45`,
and measuring what a card actually waits for across each of them showed no difference between them
— and no difference from ordinary background variation either. If you see a stall on the hour or
half hour specifically, it is worth looking outside Helman: Home Assistant runs its own periodic
Recorder and statistics work on those same boundaries.

Things worth checking, roughly in order:

- **Is it 03:00 (or your `training_time`)?** That is job #6, and it is meant to be heavy. If it is
  landing at an awkward time, move it.
- **A very large `training.house_consumption.training_window_days`** makes job #6 proportionally
  more expensive.
- **A very low `history_bucket_duration`** makes job #1 run more often. It does no I/O, so this
  costs CPU rather than Recorder time.
- **Lots of deferrable consumers** — job #6 reads the training window once per consumer, so the
  nightly cost scales with how many you configure.
- **Appliances estimating their energy use from history** — each one adds two multi-day reads to
  job #6, sized by its `consumption.projection.lookback_days`. Nightly only; nothing on the quarter-hour
  cadence and nothing a card waits for.
- **A stale-forecast banner on the cards** means rebuilds have been failing for over an hour; the
  Home Assistant log will say why.

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
