# Helman Manual Schedule FE Handover - Inverter `empty`

This increment changes inverter schedule authoring to match appliance semantics more closely.

The key change is: **inverter now supports `kind: "empty"`**, and `empty` is the default authored state.

## What FE should change

- Treat inverter `empty` as the **cleared / default / no override** state.
- Keep inverter `normal` as a separate **explicit authored action**.
- If a slot only has appliance actions, inverter should still be rendered as `empty`.
- When the user clears a previously selected inverter action, FE should send `empty`, not `normal`.

## Authored slot shape

`domains.inverter.kind` now accepts:

- `empty`
- `normal`
- `charge_to_target_soc`
- `discharge_to_target_soc`
- `stop_charging`
- `stop_discharging`
- `stop_export`

Example default slot from `helman/get_schedule`:

```json
{
  "id": "2026-04-10T20:00:00+02:00",
  "domains": {
    "inverter": {
      "kind": "empty"
    },
    "appliances": {}
  }
}
```

Example explicit Normal slot:

```json
{
  "id": "2026-04-10T20:00:00+02:00",
  "domains": {
    "inverter": {
      "kind": "normal"
    },
    "appliances": {}
  }
}
```

## Runtime semantics

Important: **authored state** and **runtime executed action** are no longer always the same.

For an authored `empty` slot:

- common steady-state runtime:
  - `actionKind = "noop"`
  - `outcome = "skipped"`
  - `executedAction.kind = "empty"`
- if the previous slot had a real inverter override and that override needs cleanup:
  - `actionKind = "slot_stop"`
  - `outcome = "success"`
  - `executedAction.kind = "normal"`

That means FE should:

- render the authored schedule from `slots[].domains`
- render executor behavior from top-level `runtime`
- **not** rewrite the authored slot to `normal` just because runtime reports `executedAction.kind = "normal"`

## Forecast meaning

- `empty` means **no inverter schedule effect**
- forecast/baseline behavior should treat `empty` as the neutral state
- explicit `normal` is also baseline-like from a battery forecast perspective, but it remains a real authored command

## Live behavior that was validated

Validated against a restarted local HA instance:

1. authored `empty` slot -> runtime `noop`, mode entity stayed `Standardni`
2. authored `stop_charging` slot -> runtime `apply`, mode entity changed to `Zakaz nabijeni`
3. restoring that same slot back to authored `empty` -> runtime `slot_stop` with executed action `normal`, mode entity returned to `Standardni`

So the intended FE mental model is:

- `empty` = no scheduled inverter override
- `normal` = explicitly command Normal
- runtime `slot_stop -> normal` = cleanup, not authored Normal
