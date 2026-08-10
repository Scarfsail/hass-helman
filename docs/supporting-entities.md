# Supporting entities — the helpers you have to build yourself

Helman consumes plain Home Assistant entities; it does not talk to hardware itself. On a Solax
install the `solax_modbus` integration provides most of what the config asks for, but **not all of
it**. This document covers the gap: the handful of entities *you* have to create, because no
integration provides them.

Each section gives the purpose, how it works, where helman consumes it, and a **Solax-specific
example** you can adapt.

Scope: only user-created helpers are documented here. Entities that other integrations provide —
solar forecast, spot prices, per-circuit sub-meters, appliance switches and climates, vehicle
telemetry — are out of scope; install the integration and point the config at whatever it produces.

> Also not covered: `switch.solax_export_enabled` (solar bias-correction curtailment detection). That
> mechanism is being reworked to remove the dependency entirely — see
> [issue #71](https://github.com/Scarfsail/hass-helman/issues/71).

## About the examples

The examples are written as YAML (`configuration.yaml`), which is the clearest way to show what a
helper *is*. Every one of them can equally be created through **Settings → Devices & Services →
Helpers**, which is how the reference deployment actually does it — the UI stores the same definition
as a config entry instead of in YAML. Either route produces an identical entity.

The formulas were verified by rendering them against a live production instance (Solax hybrid
inverter + battery + EV charger) and comparing to the real entity values, so the sign conventions
below are measured, not assumed:

- `sensor.solax_grid` — **positive = export, negative = import**
- `sensor.solax_battery_power_charge` — **positive = charging, negative = discharging**

One cross-cutting warning: Modbus polling drops out regularly, and every source entity below spends
part of its life in `unknown`/`unavailable`. Templates that do not handle that will propagate garbage
into helman's training data. Each example handles it explicitly — pay attention to the `availability`
blocks and the `float()` defaults, they are the difference between a helper that works and one that
quietly poisons a forecast.

---

## 1. The house-load chain

Three chained helpers, and the single most load-bearing thing in this list: every demand forecast,
every surplus decision, and every optimizer feasibility check ultimately rests on them. The inverter
reports PV, battery and grid — it never reports *what the house is drawing*. You have to derive it.

Build them in order; each one consumes the previous.

### 1.1 `sensor.house_load` — instantaneous house consumption (W)

**Purpose.** Real-time house draw, in watts.

**How it works.** The power balance: whatever the panels make, minus what the battery absorbs, minus
what leaves through the meter, is what the house is using.

```
house_load = pv_power_total − battery_charge_power − grid_power
```

Verified on a live sample: `8994 − 6 − 6380 = 2608 W`, matching the real sensor exactly. The result
never goes negative in practice (a day's range: 265 … 18 263 W), as expected for a load.

**Used in helman at** `power_devices.house.entities.power` — the House node on `custom:helman-card`,
its live figure and history bars, and the real-time surplus arithmetic behind "surplus" vs "tight".

```yaml
template:
  - sensor:
      - name: House load
        unique_id: house_load
        unit_of_measurement: W
        device_class: power
        state_class: measurement
        availability: >
          {{ ['sensor.solax_pv_power_total',
              'sensor.solax_battery_power_charge',
              'sensor.solax_grid']
             | map('states') | reject('in', ['unknown', 'unavailable'])
             | list | count == 3 }}
        state: >
          {{ states('sensor.solax_pv_power_total')   | float(0)
           - states('sensor.solax_battery_power_charge') | float(0)
           - states('sensor.solax_grid')             | float(0) }}
```

The `availability` block is the important part: if one Modbus register is stale, the sensor must go
unavailable rather than compute a balance from two-thirds of the inputs. A momentarily missing
`grid` term would otherwise look like a genuine multi-kW consumption spike, and — through the
integral below — get permanently written into the forecast's training history.

### 1.2 `sensor.house_load_total` — cumulative house energy (kWh)

**Purpose.** The **history source for the house consumption forecast**. Helman needs a cumulative
counter, not a power trace, because it reads per-slot deltas from Recorder's hourly statistics.

**How it works.** A Riemann-sum integration over `sensor.house_load`.

**Used in helman at** `power_devices.house.forecast.total_energy_entity_id` →
`consumption_forecast_builder.py:91`. Per slot, the builder computes

```
non_deferrable = house_total − Σ(deferrable consumer energies)
```

(`consumption_forecast_builder.py:334`) and trains the demand profile on that baseline. If a
deferrable sub-meter fails to answer for a slot, the whole slot is skipped rather than trained on a
half-subtracted total.

```yaml
sensor:
  - platform: integration
    source: sensor.house_load
    name: Celková spotřeba domu
    unique_id: house_load_total
    unit_prefix: k          # → kWh
    unit_time: h
    method: left
    max_sub_interval: "00:01:00"
```

`max_sub_interval` matters: without it the integration only advances when the source *changes*, so a
constant load that reports no new value contributes nothing. `method: left` suits a sensor that
updates frequently on change.

**Why this one deserves care.** It is the only entity whose *history depth* determines whether
forecasting works at all — `training_window_days` reads back through it. Renaming or recreating it
resets the forecast's memory, and there is no way to backfill.

### 1.3 `sensor.solax_today_house_load` — today's house consumption (kWh)

**Purpose.** The "consumed today" figure on the House node. Display only
(`forecast_builder.py:255`); it does not feed training.

**How it works.** A daily-cycle utility meter over the integration sensor, resetting at local
midnight.

**Used in helman at** `power_devices.house.entities.today_energy`.

```yaml
utility_meter:
  solax_today_house_load:
    source: sensor.house_load_total
    name: Dnešní spotřeba domu
    cycle: daily
```

---

## 2. Battery SOC bounds

### `sensor.solax_battery_min_soc` and `sensor.solax_battery_max_soc`

**Purpose.** The usable SOC window of the battery, in percent (reference deployment: 10 % / 100 %).
The inverter exposes current SOC, but the reserve floor and charge ceiling live in *mode-specific*
registers. Without them helman would plan into capacity the firmware will never release.

**Used in helman at** `power_devices.battery.entities.min_soc` / `max_soc` → `battery_state.py:115`.
They become an energy window against nominal capacity
(`min_energy_kwh = capacity × min_soc/100`, `battery_state.py:243`), bounding battery forecasting,
charge/empty ETAs, and the `min_soc_pct` headroom checks optimizers apply before committing a load.

**How it works.** Solax keeps a *separate* discharge floor per charger use mode — 
`number.solax_selfuse_discharge_min_soc` for Self Use, `number.solax_feedin_discharge_min_soc` for
Feedin Priority — so the template follows the active mode. The ceiling is single-valued:
`number.solax_battery_charge_upper_soc`.

```yaml
template:
  - sensor:
      - name: Solax Battery Min SOC
        unique_id: solax_battery_min_soc
        unit_of_measurement: "%"
        state: >
          {% if states('select.solax_charger_use_mode') == 'Feedin Priority' %}
            {{ states('number.solax_feedin_discharge_min_soc') | float(10) }}
          {% else %}
            {{ states('number.solax_selfuse_discharge_min_soc') | float(10) }}
          {% endif %}

      - name: Solax Battery Max SOC
        unique_id: solax_battery_max_soc
        unit_of_measurement: "%"
        state: >
          {{ states('number.solax_battery_charge_upper_soc') | float(100) }}
```

On the reference install both mode floors read 10 and have never diverged, so a single-source
template would work there today — the mode-aware form is the one that stays correct if you ever set
them differently.

Note the deliberate choice here, opposite to §1.1: these fall back to a **safe constant** rather than
going unavailable. `battery_state.py:274-298` rejects non-numeric values and refuses `min > max` or
anything outside 0–100, which would disable battery forecasting entirely during a Modbus blip. A
conservative floor is better than no forecast. Pick defaults that match your firmware settings — a
default that is *lower* than reality would let helman plan a discharge the inverter then refuses.

---

## 3. Signed grid power

### `sensor.solax_grid`

**Purpose.** One bidirectional grid sensor: positive exporting, negative importing.

**How it works.** `solax_modbus` reports import and export as two separate unsigned sensors; helman
wants a single signed value. Verified against the live sensor: `5518 − 0 = 5518 W`, exact match.

**Used in helman at** `power_devices.grid.entities.power` — grid flow direction and magnitude on the
card, and the import/export term of the live balance. The daily counters beside it
(`today_import` / `today_export`) are inverter-native and need no helper.

```yaml
template:
  - sensor:
      - name: Solax Grid
        unique_id: solax_grid
        unit_of_measurement: W
        device_class: power
        state_class: measurement
        icon: mdi:transmission-tower
        availability: >
          {{ ['sensor.solax_grid_export', 'sensor.solax_grid_import']
             | map('states') | reject('in', ['unknown', 'unavailable'])
             | list | count == 2 }}
        state: >
          {{ states('sensor.solax_grid_export') | float(0)
           - states('sensor.solax_grid_import') | float(0) }}
```

Check your inverter first: some `solax_modbus` models already expose a signed grid/measured-power
sensor, in which case skip this helper and point the config straight at it. Whatever you use, confirm
the sign convention — an inverted grid sensor makes §1.1 report import as consumption and silently
doubles the error.

---

## 4. Battery scheduling control

### `input_select.rezim_fv` — inverter mode selector

**Purpose.** The **single write-point** through which helman executes its battery schedule.
Everything the optimizer decides about the battery is expressed by selecting an option here.

**How it works.** An `input_select` helper, plus your own automation translating each option into
inverter register writes. Helman writes the option; your automation applies it. This indirection is
deliberate — it keeps helman independent of any particular inverter integration, and lets you
intervene by hand on the same entity.

**Used in helman at** `scheduler.control.mode_entity_id` → parsed in `scheduling/schedule.py:415`,
written by `scheduling/schedule_executor.py:200` via `ModeEntityController`. Options are mapped
explicitly through `scheduler.control.action_option_map`, so they can be named in any language:

```yaml
input_select:
  rezim_fv:
    name: Režim FV
    options:
      - Standardní
      - Nucené nabíjení
      - Nucené vybíjení
      - Zákaz nabíjení
      - Zákaz vybíjení
      - Zákaz exportu
    initial: Standardní
    icon: mdi:solar-power
```

The matching helman config:

```yaml
scheduler:
  control:
    mode_entity_id: input_select.rezim_fv
    action_option_map:
      normal: Standardní
      charge_to_target_soc: Nucené nabíjení
      discharge_to_target_soc: Nucené vybíjení
      stop_charging: Zákaz nabíjení
      stop_discharging: Zákaz vybíjení
      stop_export: Zákaz exportu
```

Every action you map must be handled by your automation, or helman will select an option that does
nothing. `stop_export` is additionally owned by the `export-price` optimizer
(`automation/optimizers/export_price.py:34`), which logs and stands down if that option is missing
from the map.

A sketch of the automation behind it — the Self Use / Feedin Priority split is where the actual
inverter behaviour comes from:

```yaml
automation:
  - alias: Režim FV → střídač
    triggers:
      - trigger: state
        entity_id: input_select.rezim_fv
    actions:
      - choose:
          - conditions: "{{ trigger.to_state.state == 'Standardní' }}"
            sequence:
              - action: select.select_option
                target: { entity_id: select.solax_charger_use_mode }
                data: { option: Self Use Mode }
          - conditions: "{{ trigger.to_state.state == 'Zákaz exportu' }}"
            sequence:
              - action: number.set_value
                target: { entity_id: number.solax_export_control_user_limit }
                data: { value: 0 }
          # … remaining options: forced charge/discharge via Manual Mode,
          #    charge/discharge inhibits via the mode-specific SOC limits
```

Keep the automation's writes idempotent. Helman re-applies the current action on its own cadence, so
an automation that toggles rather than sets will drift out of step with what helman believes is
active.

---

## 5. EV charging control

### `switch.ev_nabijeni`

**Purpose.** The on/off control helman actuates to start and stop EV charging. The appliance layer
only needs something switchable — Solax exposes charging as a *mode select*, not a switch, so the
switch has to be built.

**Used in helman at** `appliances[garage-ev].controls.charge.entity_id`. The mode selects beside it
are inverter-native and used directly:

```yaml
appliances:
  - id: garage-ev
    controls:
      charge:
        entity_id: switch.ev_nabijeni          # this helper
      use_mode:
        entity_id: select.solax_ev_charger_charger_use_mode   # native
        values:
          Fast: { behavior: fixed_max_power }
          ECO:  { behavior: surplus_aware }
```

**How it works.** `select.solax_ev_charger_charger_use_mode` offers `Stop`, `Fast`, `ECO`, `Green`.
Anything other than `Stop` means charging is enabled, which gives the switch its state; turning off
selects `Stop`.

```yaml
template:
  - switch:
      - name: EV Nabíjení
        unique_id: ev_nabijeni
        icon: mdi:ev-station
        availability: >
          {{ states('select.solax_ev_charger_charger_use_mode')
             not in ['unknown', 'unavailable'] }}
        state: >
          {{ states('select.solax_ev_charger_charger_use_mode') != 'Stop' }}
        turn_on:
          - action: select.select_option
            target: { entity_id: select.solax_ev_charger_charger_use_mode }
            data: { option: ECO }
        turn_off:
          - action: select.select_option
            target: { entity_id: select.solax_ev_charger_charger_use_mode }
            data: { option: Stop }
```

**The interaction to watch.** Helman drives *both* this switch and the `use_mode` select — the switch
to start charging, the select to choose `Fast` (charge at full power) or `ECO` (follow surplus). A
`turn_on` that hard-codes `ECO`, as above, will overwrite a `Fast` decision if the switch is flipped
last. Two ways out: have `turn_on` restore the last non-`Stop` mode from an `input_text`, or rely on
helman applying `use_mode` after the switch. If EV sessions occasionally run in the wrong mode, this
is the first place to look.

This example reproduces the observable behaviour of the reference deployment's switch rather than
copying its internals — that helper toggles somewhat more often than the mode select changes, so it
likely drives an additional wallbox command. Treat it as a working starting point, not a transcript.

---

## Checklist for a new install

In dependency order:

1. `sensor.house_load` — template, the power balance. Nothing else works properly without it.
2. `sensor.house_load_total` — Riemann integration over it. Start this early; forecast quality is
   bounded by how much history it has.
3. `sensor.solax_today_house_load` — daily utility meter (optional, display only).
4. `sensor.solax_battery_min_soc` / `max_soc` — templates over the mode-specific inverter limits.
5. `sensor.solax_grid` — template, only if your integration reports import and export separately.
6. `input_select.rezim_fv` + the automation behind it — required before scheduling can execute.
7. `switch.ev_nabijeni` — only if you have an EV charger to schedule.

To audit an existing install, fetch the config with the `helman/get_config` WebSocket command,
collect every entity id in it, and join against `config/entity_registry/list` to see each entity's
real `platform`. Anything whose platform is `template`, `integration`, `utility_meter` or `input_*`
is a helper you own — and one that can silently disappear.
