# Curtailment inference — replacing the export-enabled entity (2026-08-13)

Issue [#71](https://github.com/Scarfsail/hass-helman/issues/71). Curtailment slot-invalidation used to read a user-supplied boolean (`slot_invalidation.export_enabled_entity_id`, `switch.solax_export_enabled` on the reference instance). That entity stopped existing while the config kept naming it, the state API returned `Entity not found`, `_load_curtailment_invalidations` produced no samples, and the rule silently degraded to a no-op for an unknown length of time. The data-glitch layer was unaffected throughout.

## The rule now

A slot is curtailed when all three hold:

1. **Peak battery SoC ≥ `max_battery_soc_percent`** — nowhere left to put the energy. Unchanged, and still the switch that turns the whole rule on.
2. **Peak grid export ≤ `curtailment_max_export_w`** (default 50 W) — nothing went out either, so the only remaining sink is the house. Read from `power_devices.grid.entities.power`, whose convention is **positive = export**.
3. **Actual ≤ `curtailment_max_actual_forecast_ratio` × the historical per-slot forecast** (default 0.8) — the slot underdelivered against what was published for it that morning.

Battery full + no export + underdelivery ⇒ the inverter was throttling PV. Rule (3) is what keeps a cloudy full-battery slot with a hungry house out of the set: there the house absorbs everything and no export flows, but production still tracks the forecast.

Every rule needs positive evidence. A slot with no SoC reading, no grid reading, no forecast, or no actual is left alone rather than invalidated — the same stance the old boolean rule took toward an unknown state.

## Why not the alternatives

A template helper over `number.solax_export_control_user_limit` is the same fragility class that caused the bug. A numeric predicate in config is still a knob the user must wire correctly. A helman-emitted `binary_sensor` is useless to a trainer that reads up to 30 days of recorder history, and circular besides. `scheduler.control.mode_entity_id` only catches export blocks issued through the mode selector, not grid-operator curtailment or manual inverter changes. Inference removes a config knob instead of adding one and works retroactively over existing history.

## Verified against production history

Seven days of recorder history on the reference instance (2026-08-06 → 2026-08-12), replaying the rule slot by slot:

- The sign convention was measured, not assumed: integrating the positive part of `sensor.solax_grid` over 2026-08-09 gives 5.41 kWh against 7.11 kWh on `today_export`, and the negative part 0.53 kWh against 1.04 kWh on `today_import` (both undercounts, from sampling gaps — the correlation is the point). `tree_builder` agrees: the grid **consumer** node reads the positive part. The README said "positive import, negative export" and was wrong; fixed.
- Exactly one slot fires: **2026-08-08 18:15**, peak SoC 99 %, peak export 49 W, 200 Wh actual against a 496 Wh forecast (ratio 0.40). Battery full, no export path, producing at roughly house load — clipping.
- No false positive survives. On 2026-08-09 the battery sat at 100 % from 14:15 onward with actual/forecast ratios of 0.40–0.69, but the house was exporting 0.5–4.9 kW throughout, so rule (2) excludes every one of those slots.
- `number.solax_export_control_user_limit` turned out **not** to be the ground truth the issue hoped for: it reads `0` for hours at a stretch (08:00–12:00 on 08-08, 08:00–13:46 on 08-09) while the inverter exports multiple kW. Measured export is the honest signal; the limit setting is not.

## Config

`export_enabled_entity_id` is dropped by the v11 → v12 load migration, and validation no longer pairs it with `max_battery_soc_percent`. The two new thresholds default to working values, so the feature needs no configuration beyond the SoC threshold that was already there. Curtailment now requires `power_devices.grid.entities.power` alongside `power_devices.battery.entities.capacity`; both are checked at save time and warned about at training time, as is a configured entity the recorder has no history for — the failure mode that started this.
