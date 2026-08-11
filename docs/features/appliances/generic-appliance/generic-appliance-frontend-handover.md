# Generic Appliance FE Handover

This increment adds backend support for `kind: "generic"` appliances and built-in config-editor support in this repository.

The later frontend work elsewhere only needs to consume the new backend surfaces for schedule authoring and projection display.

## Config shape

```json
{
  "kind": "generic",
  "id": "dishwasher",
  "name": "Dishwasher",
  "controls": {
    "switch": {
      "entity_id": "switch.dishwasher"
    }
  },
  "consumption": {
    "energy_entity_id": "sensor.dishwasher_energy_total",
    "projection": {
      "strategy": "fixed",
      "hourly_energy_kwh": 1.2,
      "lookback_days": 30
    }
  }
}
```

## Semantics

- `consumption` is the sibling of `controls`: everything the device *draws*, as against how it is driven.
- `consumption.projection.hourly_energy_kwh` is always required and represents **average hourly energy**, not per-slot energy.
- `consumption.projection.strategy` supports `fixed` and `history_average`.
- When the strategy is `history_average`, `consumption.energy_entity_id` is required; `lookback_days` defaults to 30.
- `consumption.energy_entity_id` must be a cumulative energy sensor. It belongs to the device, not to the strategy, so a kind with no projection at all may still declare one.
- If history is insufficient, the backend falls back to `consumption.projection.hourly_energy_kwh`.
- When the strategy is `fixed`, `consumption.energy_entity_id` is not read by the projection path.

## get_appliances

`helman/get_appliances` now includes generic entries like:

```json
{
  "id": "dishwasher",
  "name": "Dishwasher",
  "kind": "generic",
  "metadata": {
    "scheduleCapabilities": {
      "onOffToggle": true
    }
  },
  "controls": {
    "switch": {
      "entityId": "switch.dishwasher"
    }
  }
}
```

## Schedule payload

Generic appliance actions live under `domains.appliances[applianceId]` and only support:

```json
{ "on": true }
```

or

```json
{ "on": false }
```

No other keys are supported for the generic kind.

## Projection response

`helman/get_appliance_projections` now returns generic series points like:

```json
{
  "slotId": "2026-03-20T21:00:00+01:00",
  "energyKwh": 0.46,
  "projectionMethod": "fixed"
}
```

`projectionMethod` can be:

- `fixed`
- `history_average`
- `fixed_fallback`

`fixed_fallback` means the appliance was configured for history-average projection, but the backend did not have enough usable history and used the fixed hourly value instead.

## Projection behavior

- Generic projections do **not** depend on EV-only solar/battery projection inputs.
- The backend prorates hourly energy by the actual remaining slot duration.
- Internally, projections are sliced to canonical 15-minute buckets for demand aggregation, but the public series remains keyed by schedule slot.

## Runtime execution

- Generic appliance execution is simple switch control via `switch.turn_on` / `switch.turn_off`.
- When a scheduled slot ends and no next appliance action applies, Helman emits a slot-stop by turning the switch off.
