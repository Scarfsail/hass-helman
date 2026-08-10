# Supporting entities — what helman needs beyond the inverter integration

Helman consumes plain Home Assistant entities; it does not talk to hardware itself. On a Solax
install the `solax_modbus` integration provides most of what the config asks for, but **not all of
it** — a working setup also needs a handful of hand-built helpers and entities from other
integrations.

This document describes those non-inverter entities: what each is for, how it works, and where in
helman it is consumed. It is written against a real production deployment (Solax hybrid inverter +
battery + EV charger, HA 2026.8.1, snapshot 2026-08-10), so the examples are concrete entity ids
rather than placeholders. Adapt the ids; the roles are what matter.

Beware of a naming trap in this setup: several entities are *named* like inverter entities —
`sensor.solax_grid`, `sensor.solax_battery_min_soc`, `sensor.solax_today_house_load`, and
`sensor.house_load` whose friendly name is even "SolaX Inverter House load" — but are **template /
utility_meter / integration helpers**. If the helper YAML is lost, they vanish and helman degrades in
ways that are not obviously inverter-related.

> Not covered here: `switch.solax_export_enabled` (solar bias-correction curtailment detection).
> That entity is missing on production and the mechanism is being reworked to remove the dependency
> entirely — see [issue #71](https://github.com/Scarfsail/hass-helman/issues/71).

---

## 1. The house-load chain

Three chained helpers, and the single most load-bearing thing in this list: every demand forecast,
every surplus decision, and every optimizer feasibility check ultimately rests on them. The inverter
reports PV, battery and grid — it never reports *what the house is drawing*.

### `sensor.house_load` — instantaneous house consumption (W)

**Purpose.** Real-time house draw, in watts.

**How it works.** A template sensor applying the power balance to native inverter sensors:

```
house_load = pv_power_total − battery_charge_power − grid_power
```

with the sign conventions confirmed against a day of production history:

- `sensor.solax_grid` — **positive = export, negative = import** (day range −8 800 … +6 656 W).
- `sensor.solax_battery_power_charge` — **positive = charging, negative = discharging**.

Worked example from a live sample: `8994 − 6 − 6380 = 2608 W`, matching `sensor.house_load` exactly at
that instant. The sensor never goes negative (day range 265 … 18 263 W), as expected for a load.

**Used in helman at** `power_devices.house.entities.power` — the House node on `custom:helman-card`,
its live power figure and history bars, and the real-time surplus arithmetic that decides whether the
current moment is "surplus" or "tight".

### `sensor.house_load_total` — cumulative house energy (kWh)

**Purpose.** The **history source for the house consumption forecast**.

**How it works.** A Riemann-sum integration (`integration` platform) over `sensor.house_load`,
producing a monotonically rising lifetime total. Helman needs a cumulative counter, not a power
trace, because it reads per-slot deltas from Recorder's hourly statistics.

**Used in helman at** `power_devices.house.forecast.total_energy_entity_id` →
`consumption_forecast_builder.py:91`. Per slot, the builder computes

```
non_deferrable = house_total − Σ(deferrable consumer energies)
```

(`consumption_forecast_builder.py:334`) and trains the demand profile on that baseline. If any
deferrable sub-meter fails to answer for a slot, the whole slot is skipped rather than trained on a
half-subtracted total.

**Why it matters.** This is the only entity in the config whose *history depth* determines whether
forecasting works at all — `training_window_days` reads back through it, so replacing or renaming it
resets the forecast's memory.

### `sensor.solax_today_house_load` — today's house consumption (kWh)

**Purpose.** The "consumed today" figure on the House node.

**How it works.** A `utility_meter` with a daily cycle over the integration sensor above, resetting at
local midnight.

**Used in helman at** `power_devices.house.entities.today_energy` — display only
(`forecast_builder.py:255` also falls back to it); it does not feed training.

---

## 2. Battery SOC bounds

### `sensor.solax_battery_min_soc` and `sensor.solax_battery_max_soc`

**Purpose.** The usable SOC window of the battery, in percent (production: 10 % / 100 %). The inverter
exposes current SOC but not the reserve floor and charge ceiling that its own firmware settings
enforce, so helman would otherwise plan into capacity that can never be used.

**How it works.** Template sensors mirroring the configured inverter limits.

**Used in helman at** `power_devices.battery.entities.min_soc` / `max_soc` → `battery_state.py:115`.
They are converted into an energy window against nominal capacity
(`min_energy_kwh = capacity × min_soc/100`, `battery_state.py:243`) which bounds battery-capacity
forecasting, charge/empty ETAs, and the `min_soc_pct` headroom checks that optimizers apply before
committing a load.

**Validation.** Both are required together — `battery_state.py:89-92` reports them as missing config;
values outside 0–100, or `min > max`, are rejected (`battery_state.py:288-298`).

---

## 3. Grid power and price

### `sensor.solax_grid` — signed grid power (W)

**Purpose.** One bidirectional grid sensor: positive exporting, negative importing.

**How it works.** A template sensor normalising the raw Solax import/export registers
(`sensor.solax_grid_import` / `sensor.solax_grid_export`, both unsigned) into a single signed value.

**Used in helman at** `power_devices.grid.entities.power` — grid flow direction and magnitude on the
card, and the import/export term of the live balance. The daily counters beside it
(`today_import` / `today_export`) are inverter-native and need no helper.

### `sensor.current_sell_electricity_price` — spot sell price (Kč/kWh)

**Purpose.** What exported energy is currently worth.

**How it works.** Provided by the `cz_energy_spot_prices` integration (Czech OTE spot market) — not
hand-built, but not from the inverter either.

**Used in helman at** `power_devices.grid.forecast.sell_price_entity_id` →
`grid_price_forecast_builder.py:51`. It drives export-value decisions, most visibly the
`export-price` optimizer, which on production runs when the price drops **below 0** — during negative
prices exporting costs money, so it is better to dump the energy into loads.

**Note the asymmetry:** the *import* price is not an entity. It is the fixed two-window tariff in
config (`import_price_windows`: 5.03 at 22:00–06:00, 7.33 at 06:00–22:00). Only the sell side is
market-linked here.

---

## 4. Solar production forecast

### `sensor.energy_production_today_remaining`, `_today`, `_tomorrow`, `_d2` … `_d7`

**Purpose.** The weather-model production forecast, 8 days ahead.

**How it works.** Provided by `open_meteo_solar_forecast` from panel geometry and the Open-Meteo
irradiance model. These are the **raw, uncorrected** predictions.

**Used in helman at** `power_devices.solar.forecast.remaining_today_entity_id` and
`daily_energy_entity_ids[0..7]`. The daily series is what multi-day planning schedules against; the
remaining-today value is the input the solar bias correction learns to correct.

### `sensor.helman_energy_production_today_remaining` — bias-corrected remaining production

**Purpose.** What the card actually displays for "remaining production today".

**How it works.** Produced by helman itself, not by the user: the bias-correction trainer learns
per-slot correction factors from historical forecast-vs-actual pairs and applies them to the raw
Open-Meteo value. On a sample morning it read **57.38 kWh** against Open-Meteo's raw **53.44 kWh** —
the model had learned this site systematically outproduces the generic forecast.

**Used in helman at** `power_devices.solar.entities.remaining_today_energy_forecast` →
`forecast_builder.py:82`. Listed here only to make the distinction explicit: the Open-Meteo sensor is
the model *input*, this one is the model *output*, and they are deliberately different numbers.

---

## 5. Battery scheduling control

### `input_select.rezim_fv` — inverter mode selector

**Purpose.** The **single write-point** through which helman executes its battery schedule. Everything
the optimizer decides about the battery is ultimately expressed by selecting an option here.

**How it works.** An `input_select` helper whose options are translated to inverter register writes by
your own HA automations — helman writes the option, your automation applies it. Helman never talks to
the inverter directly.

**Used in helman at** `scheduler.control.mode_entity_id` → parsed in `scheduling/schedule.py:415`,
written by `scheduling/schedule_executor.py:200` via `ModeEntityController`. The mapping is explicit
config (`action_option_map`):

| Helman action | Option written |
|---|---|
| `normal` | Standardní |
| `charge_to_target_soc` | Nucené nabíjení |
| `discharge_to_target_soc` | Nucené vybíjení |
| `stop_charging` | Zákaz nabíjení |
| `stop_discharging` | Zákaz vybíjení |
| `stop_export` | Zákaz exportu |

`stop_export` is additionally owned by the `export-price` optimizer
(`automation/optimizers/export_price.py:34`), which logs and stands down if that option is not mapped.

**Consequence worth knowing.** Because this is an `input_select` rather than a direct inverter write,
helman's view of "what mode we are in" is only as truthful as the automations behind it. It also means
mode changes made by hand, outside helman, are visible to helman on the same entity.

---

## 6. Per-circuit energy meters (deferrable consumers)

### `sensor.jistic_bazen_filtrace_energy`, `sensor.jistic_klimatizace_energy`, `sensor.jistic_bazen_tepelne_cerpadlo_energy`, `sensor.zasuvka_zebrik_koupelna_energy`

**Purpose.** Keep schedulable loads out of the *base* demand profile.

**How it works.** MQTT-published cumulative energy counters (kWh) from per-circuit meters in the
breaker panels — pool filtration, home AC, pool heat pump, bathroom towel heater. The EV charger's
counter (`sensor.solax_ev_charger_charge_added_total`) is inverter-native and completes the set.

**Used in helman at** `power_devices.house.forecast.deferrable_consumers[]`, each with a display
`label`. As described in §1, each slot's baseline is `house total − Σ(deferrables)`.

**Why this matters.** Without the subtraction, the demand forecast would learn "the house uses 3 kW
every sunny afternoon" — when in truth that was helman itself running the pool pump on surplus. The
forecast would then predict its own past decisions as future demand, and compound the error. Each
sub-meter must be **non-overlapping and genuinely included in the house total**, or the baseline goes
wrong in the other direction. Slots where a sub-meter has no reading are dropped rather than guessed.

---

## 7. Appliance controls

Each entry under `appliances[]` names the entity helman actually actuates. None of these are inverter
entities except the EV charger's mode selects.

| Appliance | Control entity | Integration | Notes |
|---|---|---|---|
| Nabíječka EV | `switch.ev_nabijeni` | `template` | Start/stop EV charging. A template switch wrapping the wallbox commands; `use_mode` / `eco_gear` selects beside it are inverter-native (`select.solax_ev_charger_*`), mapping Fast → `fixed_max_power` and ECO → `surplus_aware`. |
| Bazén filtrace | `switch.jistic_bazen_filtrace` | `mqtt` | Pool filtration circuit; optimizer runs it on surplus **and** tight. |
| Ohřev bazénu | `climate.inverter_pool_heat_pump` | `tuya` | Pool heat pump; two conditions — negative price (`max_run_price: 0.5`), or pool below 30.5 °C. |
| Přímotop TČ bazén | `switch.bazen_primotop_tc` | `mqtt` | Direct-heat element. **Currently `unavailable` on production** — the appliance cannot be actuated. |
| Klimatizace doma | `climate.klimatizace_doma` | `climate_group_helper` | A *group* entity fronting several AC units, so helman schedules them as one load. Runs when outdoor > 24 °C, min SOC 30 %. |
| Žebřík koupelna | `switch.zasuvka_zebrik_koupelna` | `mqtt` | Bathroom towel heater socket, surplus-only. |

Note the pattern: helman is deliberately indifferent to *how* a load is switched. A template switch, an
MQTT relay, a Tuya climate entity and a group helper are all equally valid — the appliance layer only
needs an entity it can turn on and off, plus (for climate) a setpoint.

---

## 8. Optimizer condition inputs

### `sensor.rsc_temperature_outdoor_street`, `sensor.rsc_temperature_pool`

**Purpose.** Physical state that decides whether running a load is *useful*, as opposed to merely
affordable.

**How it works.** Temperature sensors from a custom `rsc` integration.

**Used in helman at** optimizer `conditions[].custom[]` entries of kind `temperature.is_value`:

- `home-ac` — outdoor temperature **above 24 °C**; below that, cooling the house on surplus is waste.
- `pool-heatpump`, condition "Studený bazén" — pool water **below 30.5 °C**; once warm enough, free
  energy is no longer a reason to keep heating.

These are the clearest example of the conditions system doing what price and surplus alone cannot:
surplus says *you can*, the temperature condition says *you should*.

### EV telemetry — `sensor.kona_ev_battery_level`, `number.kona_ac_charging_limit`

**Purpose.** How much energy the car still needs — the demand side of EV charge planning.

**How it works.** Provided by the `kia_uvo` integration from the vehicle's cloud API: current SOC
(85 %) and the user's charge target (90 %).

**Used in helman at** `appliances[garage-ev].vehicles[0].telemetry.soc_entity_id` and
`charge_limit_entity_id` → `appliances/ev_charger.py:364`. The gap between the two, against battery
capacity, is the energy the charging plan must place into the cheapest or sunniest slots.

**Caveat.** Cloud telemetry updates on the vehicle's schedule, not Home Assistant's, and can be stale
or briefly unavailable after the car sleeps — unlike every other entity here, which is local.

---

## Inverter-native entities, for contrast

These come from `solax_modbus` and need no setup beyond the integration itself:

`sensor.solax_pv_power_total`, `sensor.solax_today_s_solar_energy`, `sensor.solax_total_solar_energy`,
`sensor.solax_today_s_import_energy`, `sensor.solax_today_s_export_energy`,
`sensor.solax_battery_power_charge`, `sensor.solax_battery_capacity`,
`sensor.solax_remaining_battery_capacity`, `sensor.solax_battery_input_energy_today`,
`sensor.solax_battery_output_energy_today`, `sensor.solax_ev_charger_charge_added_total`,
`select.solax_ev_charger_charger_use_mode`, `select.solax_ev_charger_eco_gear`.

## Setting this up on a different install

Roughly in dependency order:

1. **House load** — a template power sensor from the balance equation, then a Riemann integration over
   it, then (optionally) a daily utility_meter. Nothing else works properly without this.
2. **Battery SOC bounds** — two template sensors, or `input_number` helpers if your inverter does not
   expose its own limits.
3. **Signed grid power** — only if your integration reports import and export separately.
4. **A mode selector** — an `input_select` plus the automations that translate its options into
   inverter writes, mapped through `scheduler.control.action_option_map`.
5. **A solar forecast integration** — Open-Meteo or Forecast.Solar.
6. **Per-circuit sub-meters** — one per schedulable load, before enabling deferrable-consumer
   subtraction.

A useful audit on any install: fetch the config via the `helman/get_config` WebSocket command, collect
every entity id in it, and join against `config/entity_registry/list` to see each entity's real
`platform`. Anything not from your inverter integration is something you own, and something that can
silently disappear.
