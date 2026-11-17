# Recipes

Complete setups for common goals. Each one can be built in the visual editor, and the YAML shows exactly what it stores, so you can paste it into the **YAML** view of the Automation tab and adapt the ids.

!!! tip "Try before you trust"
    Add a recipe with **Execute actions** off, check the plan in the [inspector](../using/inspector.md) for a day or two, and read a few slots with [Explain automation](../using/schedule-editor.md#explain-automation).

## Sell the morning, store the noon

*Spot export prices, battery fills too early, occasional negative prices.*

Charge hold keeps the battery from charging in the dearer slots of the morning, so that surplus is sold, and fills it from the cheapest slots. Export price stops exporting below zero. Export price comes second, so its *No export* wins a slot both want.

```yaml
system_optimizers:
  - id: charge-hold
    kind: charge_hold
    target: { controllable_id: inverter }
    params:
      window: { start: "06:00", end: "16:00" }
      battery_first: { target_soc: 100, margin_pct: 20, min_soc: 15 }
    conditions:
      - run_when: [surplus]
  - id: no-negative-export
    kind: export_price
    target: { controllable_id: inverter }
    conditions:
      - when_price_below: 0
```

## Outage reserve on a two-rate tariff

*Keep 20 % for a blackout; never buy evening power at the peak rate if the night rate could cover it.*

```yaml
system_optimizers:
  - id: reserve
    kind: battery_reserve
    target: { controllable_id: inverter }
    params:
      charge_start_margin_slots: 2
    conditions:
      - reserve_floor_soc: 20
        expensive_window_buffer_pct: 10
        solar_dip_floor_soc: 12
        hold_reserve_in_expensive_windows: true
```

Your import price windows must define the two rates, for example `22:00–06:00` cheap and `06:00–22:00` expensive.

## Pool: filtration every day, heating on sun

*Filter 4 hours a day in the cheapest sunny hours, never skip more than two days. Heat only while filtration runs: on near-free prices any time, on solar when the pool is cool, on any surplus when it is cold.*

```yaml
appliance_optimizers:
  - id: pool-filtration
    kind: appliance_runtime
    target:
      controllables: [{ controllable_id: pool-filtration }]
    params:
      window: { start: "08:00", end: "18:00" }
      daily_minimum: { min_hours_per_day: 4, max_consecutive_skips: 2 }
    conditions:
      - run_when: [surplus, tight]

  - id: pool-heating
    kind: appliance_runtime
    target:
      controllables: [{ controllable_id: pool-heat-pump, climate_mode: heat }]
    params:
      window: { start: "08:00", end: "18:00" }
    conditions:
      - name: Negative price
        requires_appliance: pool-filtration
        max_run_price: 0.5
        min_soc_pct: 20
      - name: Cool pool
        requires_appliance: pool-filtration
        max_run_price: 2
        min_soc_pct: 80
        min_solar_coverage_pct: 90
        custom:
          - condition: numeric_state
            entity_id: sensor.pool_temperature
            below: 31
      - name: Cold pool
        requires_appliance: pool-filtration
        run_when: [surplus, tight]
        min_soc_pct: 20
        ensure_self_sustainability: 0
        custom:
          - condition: numeric_state
            entity_id: sensor.pool_temperature
            below: 29
```

Heating is listed **below** filtration, so it sees filtration's plan.

## Heat with air conditioning on sunny days only

*Several split units heat the house when the sun can pay for it, and never take the battery below 30 %.*

```yaml
appliance_optimizers:
  - id: ac-heat
    kind: appliance_runtime
    target:
      controllables:
        - { controllable_id: ac-living-room, climate_mode: heat }
        - { controllable_id: ac-kids-room, climate_mode: heat }
    params:
      window: { start: "08:30", end: "20:00" }
    conditions:
      - run_when: [surplus]
        min_soc_pct: 30
        ensure_self_sustainability: 0
        self_sustainability_margin_pct: 5
        custom:
          - condition: numeric_state
            entity_id: sensor.outdoor_temperature
            below: 18
```

No daily minimum, so the units run on every slot that qualifies. The living room comes first and gets the surplus first. A twin optimizer with `climate_mode: cool` and `above: 24` covers summer.

## Charge the car at night without draining the house battery

```yaml
system_optimizers:
  - id: ev-hold
    kind: battery_hold_while_ev_charging
    target: { controllable_id: inverter }
    params:
      ev_chargers: [{ controllable_id: garage-ev }]
      sensor_grace_seconds: 60
    conditions:
      - when_solar_below_w: 2000
```

Below 2 kW of sun the battery stops discharging while the car draws power. A sunny midday charge is left alone.

## Hot water only when power is free

*An electric heater that should use energy only when exporting it would cost money.*

```yaml
appliance_optimizers:
  - id: heater-free-power
    kind: appliance_runtime
    target:
      controllables: [{ controllable_id: water-heater }]
    conditions:
      - max_run_price: 0
```

No window and no minimum: the heater runs in every slot where the export price is zero or negative, and nowhere else.
