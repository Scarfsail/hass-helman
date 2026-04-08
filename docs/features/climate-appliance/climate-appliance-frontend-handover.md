# Climate Appliance FE Handover

This increment adds backend support for `kind: "climate"` appliances and config-editor support in this repository.

For frontend, treat it as **very close to generic appliances**, with one important difference: the authored action is a **mode selection** instead of an on/off toggle.

## Config shape

Compared to generic:

- `kind` is `climate` instead of `generic`
- `controls.climate.entity_id` replaces `controls.switch.entity_id`
- `projection` is the same shape as generic

```json
{
  "kind": "climate",
  "id": "climate-home",
  "name": "Home AC",
  "controls": {
    "climate": {
      "entity_id": "climate.home_ac"
    }
  },
  "projection": {
    "strategy": "fixed",
    "hourly_energy_kwh": 1.0
  }
}
```

## get_appliances

Compared to generic:

- `metadata.scheduleCapabilities.modes` replaces `metadata.scheduleCapabilities.onOffToggle`
- `controls.climate.entityId` replaces `controls.switch.entityId`

```json
{
  "id": "climate-home",
  "name": "Home AC",
  "kind": "climate",
  "metadata": {
    "icon": "mdi:air-conditioner",
    "scheduleCapabilities": {
      "modes": ["heat", "cool"]
    }
  },
  "controls": {
    "climate": {
      "entityId": "climate.home_ac"
    }
  }
}
```

Notes:

- For now, FE only needs to support `heat` and `cool`.
- The backend can expose a subset, so FE should render exactly the returned `modes[]`.

## Schedule action DTO

Compared to generic:

- generic action: `{ "on": true }` / `{ "on": false }`
- climate action: `{ "mode": "heat" }` or `{ "mode": "cool" }`

Climate does **not** support an authored `"off"` action.

If FE wants the appliance to stop after a slot, keep the current slot authored and leave the following slot without a climate action. Backend then turns the climate entity off when the authored slot ends, same stop semantics as generic.

No extra action fields are supported for climate right now.

## Projection response

Compared to generic:

- same `slotId`
- same `energyKwh`
- same optional `projectionMethod`
- climate adds `mode`

```json
{
  "slotId": "2026-04-08T20:00:00+02:00",
  "energyKwh": 0.5,
  "mode": "cool",
  "projectionMethod": "fixed"
}
```
