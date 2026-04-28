# Solar Bias Slot Invalidation Investigation: 2026-04-26

This note documents two separate invalidation use cases observed in real Home
Assistant data on 2026-04-26. They should be treated independently:

1. a bug in the existing export-disabled + high-battery-SoC invalidation rule
2. a new data-quality rule for abrupt zero/gap samples

No implementation change is implied by this note. It is input for debugging the
invalidation pipeline.

## Context

Live Helman config at investigation time:

```yaml
power_devices:
  solar:
    forecast:
      bias_correction:
        enabled: true
        slot_invalidation:
          max_battery_soc_percent: 97
          export_enabled_entity_id: switch.solax_export_enabled
```

Relevant entities checked:

- Solar cumulative actuals: `sensor.solax_today_s_solar_energy`
- Solar instantaneous power: `sensor.solax_pv_power_total`
- House load: `sensor.solax_house_load`
- Battery SoC: `sensor.solax_battery_capacity`
- Battery chargeable capacity: `sensor.solax_chargeable_battery_capacity`
- Battery charge power: `sensor.solax_battery_power_charge`
- Export enabled flag: `switch.solax_export_enabled`

The solar bias inspector for 2026-04-26 reported invalidated slots only from
17:00 through 18:45. It did not report invalidation for the 14:30+ curtailed
slots described below.

## Use Case 1: Export Off + SoC Above Threshold

This is the existing intended rule:

> If export is disabled and battery SoC reaches or exceeds the configured
> threshold during a forecast slot, the slot must be excluded from solar bias
> training because the inverter can curtail PV production to local demand.

Observed real data on 2026-04-26, local time:

| Slot | Solar actual | Avg PV power | Avg house load | Avg battery power | Battery SoC | Chargeable capacity | Export |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 14:00 | 2.5 kWh | ~10.0 kW | ~5.7 kW | ~4.3 kW charging | 86% | 2419 Wh | off |
| 14:15 | 1.4 kWh | ~5.6 kW | ~5.4 kW | ~0.1 kW charging | 96% | 691 Wh | off |
| 14:30 | 1.4 kWh | ~5.7 kW | ~5.7 kW | ~0.0 kW | 100% | 0 Wh | off |
| 14:45 | 1.4 kWh | ~5.5 kW | ~5.6 kW | ~0.0 kW | 100% | 0 Wh | off |
| 15:00 | 1.4 kWh | ~5.6 kW | ~5.7 kW | ~0.0 kW | 100% | 0 Wh | off |
| 15:15 | 1.4 kWh | ~5.5 kW | ~5.5 kW | ~0.0 kW | 100% | 0 Wh | off |
| 15:30 | 1.4 kWh | ~5.7 kW | ~5.7 kW | ~0.0 kW | 100% | 0 Wh | off |
| 15:45 | 1.4 kWh | ~5.5 kW | ~5.5 kW | ~0.0 kW | 100% | 0 Wh | off |
| 16:00 | 1.4 kWh | n/a | n/a | n/a | 100% | 0 Wh | off |
| 16:15 | 1.4 kWh | n/a | n/a | n/a | 100% | 0 Wh | off |
| 16:30 | 1.4 kWh | n/a | n/a | n/a | 100% | 0 Wh | off |
| 16:45 | 1.4 kWh | n/a | n/a | n/a | 100% | 0 Wh | off |

Expected behavior:

- `14:30` and later slots should be invalidated by the existing rule because
  SoC is `100%`, the threshold is `97%`, and export is `off`.
- `14:15` is a borderline/near-threshold case. With the current configured
  threshold it is `96%`, so the current rule may legitimately miss it, even
  though production already appears curtailed.

Observed incorrect behavior:

- The solar bias inspector did not list these slots in `series.invalidated`.
- The trainer therefore used curtailed production as if it were real available
  solar production.
- The corrected forecast learned an artificial low factor around this part of
  the afternoon.

Debugging focus:

- Check how `compute_invalidated_slots_for_window` receives slot boundaries and
  SoC/export samples for 2026-04-26.
- Confirm whether the 14:30+ slot keys are present in
  `forecast_slot_starts_by_date` / `slot_keys_by_date`.
- Confirm whether `sensor.solax_battery_capacity` samples include the `100%`
  value inside those slot intervals.
- Confirm whether `switch.solax_export_enabled` samples are parsed as boolean
  `False` inside those slot intervals.
- Check whether invalidation depends on historical forecast slot availability;
  missing forecast slots could prevent actual slots from being evaluated.

## Use Case 2: Abrupt Zero/Gapped Actuals

This is a new data-quality rule, not part of the current export/SOC logic:

> If an actual solar slot suddenly drops from normal production to zero and then
> rebounds, while surrounding slots show strong production, the zero slot should
> be treated as a recorder/source glitch and excluded from training.

Observed real data on 2026-04-26, local time, from the inspector actual series:

| Slot | Actual solar |
| --- | ---: |
| 10:00 | 1700 Wh |
| 10:15 | 1200 Wh |
| 10:30 | 1800 Wh |
| 10:45 | 800 Wh |
| 11:00 | 0 Wh |
| 11:15 | 0 Wh |
| 11:30 | 7600 Wh |
| 11:45 | 2400 Wh |
| 12:00 | 2200 Wh |

The cumulative energy history showed this is not a real no-production period.
Instantaneous PV power around that window stayed high, around 8.5 kW in the
11:00-11:30 range. The `7600 Wh` at 11:30 looks like delayed/redistributed
cumulative energy rather than real production in a single 15-minute slot.

Expected behavior for the new rule:

- The `11:00` and `11:15` zero actual slots should be invalidated as data
  glitches because they are surrounded by high production.
- The compensating spike at `11:30` should also be considered suspicious. It is
  physically implausible for a 15-minute slot in this system and likely
  represents the missing energy from the preceding zero slots.

Potential rule shape:

- Only evaluate daytime slots where the raw forecast or neighboring actuals
  imply meaningful production.
- If actual Wh is `0` or near-zero and both neighboring slots exceed a minimum
  threshold, invalidate the zero slot.
- If an immediately following slot has an implausible catch-up spike, invalidate
  that spike too.
- Use conservative thresholds to avoid invalidating real cloud events. A real
  cloud event should usually reduce production but not create exact zero slots
  surrounded by multi-kWh 15-minute production.

Debugging/design focus:

- This should be separate from export/SOC invalidation so normal weather drops
  are not confused with inverter curtailment.
- The rule should probably operate on actual slot values after cumulative
  deltas are computed, before samples are passed into the trainer.
- The rule should preserve explainability by reporting these slots separately
  from export/SOC invalidations, or by tagging the reason internally.

