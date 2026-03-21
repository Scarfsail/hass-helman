# Helman Manual Schedule - Live Smoke Scenarios

## Purpose

This document records a safe, reversible way to validate manual schedule runtime behavior against a running local Home Assistant instance.

Use it after backend changes that affect:

- `helman/get_schedule`
- `helman/set_schedule`
- `helman/set_schedule_execution`
- executor action resolution
- active-slot runtime metadata

## Preconditions

Before mutating the live instance:

- restart Home Assistant with the local integration changes loaded
- verify `helman/get_config` and `helman/get_schedule` succeed
- prefer starting from:
  - `executionEnabled = false`
  - current slot action `normal`
  - mode entity `Standardní`
- confirm the following entities exist and return state:
  - `input_select.rezim_fv`
  - `sensor.solax_battery_capacity`
  - `sensor.solax_battery_power_charge`
  - `sensor.solax_grid`
  - `sensor.house_load`
  - `sensor.solax_pv_power_total`

## Safety rules

- Always fetch the current slot fresh with `helman/get_schedule` immediately before applying a scenario. The active slot can advance while the session is running.
- Mutate only the current slot during live smoke checks.
- After every scenario, revert the same slot to `normal` and disable execution again.
- Do not trust the first power-flow sensor read immediately after a mode change. Wait about `10` seconds and read again.
- The API can already be back to baseline while the physical flows are still settling. Verify both.

## Websocket calls to use

### 1. Optional config sanity check

```json
{
  "type": "helman/get_config"
}
```

Useful to confirm the live mapping under top-level `scheduler.control`.

### 2. Read the current slot

```json
{
  "type": "helman/get_schedule"
}
```

Take `slots[0].id` as the current slot to mutate.

### 3. Apply the scenario to the current slot

Example for `charge_to_target_soc(90)`:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "<currentSlotId>",
      "action": {
        "kind": "charge_to_target_soc",
        "targetSoc": 90
      }
    }
  ]
}
```

### 4. Enable execution

```json
{
  "type": "helman/set_schedule_execution",
  "enabled": true
}
```

### 5. Verify the active slot runtime

Call `helman/get_schedule` again and inspect `slots[0]`. The requested action should stay unchanged, while `runtime` describes what the executor actually applied for the active slot.

### 6. Revert

Reset the current slot:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "<currentSlotId>",
      "action": {
        "kind": "normal"
      }
    }
  ]
}
```

Then disable execution:

```json
{
  "type": "helman/set_schedule_execution",
  "enabled": false
}
```

Finally, call `helman/get_schedule` again and confirm:

- `executionEnabled = false`
- `slots[0].action.kind = normal`
- no slot contains `runtime`

## REST entity checks to use

These state reads were useful during validation:

```bash
BASE_URL="http://127.0.0.1:8123"
TOKEN="<long-lived-access-token>"
AUTH_HEADER="Authorization: Bearer $TOKEN"

for entity in \
  input_select.rezim_fv \
  sensor.solax_battery_capacity \
  sensor.solax_battery_power_charge \
  sensor.solax_grid \
  sensor.house_load \
  sensor.solax_pv_power_total
do
  echo "=== $entity ==="
  curl -sS -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    "$BASE_URL/api/states/$entity"
  echo
done
```

Read once right after the mode change, then again after a short settle.

## Observed sensor sign conventions

During live testing on `2026-03-21`, the sensors behaved like this:

- `sensor.solax_battery_power_charge`
  - positive values behaved like charging
  - negative values behaved like discharging
- `sensor.solax_grid`
  - negative values behaved like grid import
  - positive values behaved like grid export
- `sensor.house_load`
  - usually tracked house demand
  - could briefly show odd values during transients right after a mode switch

These are observed conventions, not a formal contract. Re-check them if the entity source changes.

## Live scenarios

The scenarios below were validated against a live instance and are safe because each one targets only the current slot and is immediately reverted afterward.

### Scenario 1: `charge_to_target_soc(70)`

Use this when live SoC is already above the target.

Apply:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "<currentSlotId>",
      "action": {
        "kind": "charge_to_target_soc",
        "targetSoc": 70
      }
    }
  ]
}
```

Expected runtime on `helman/get_schedule`:

- `runtime.status = applied`
- `runtime.executedAction.kind = stop_discharging`
- `runtime.reason = target_soc_reached`

Expected mode:

- `input_select.rezim_fv = Zákaz vybíjení`

Expected flow pattern:

- battery discharge should drop toward zero
- grid should pick up the house load

Observed on `2026-03-21` with SoC around `80%`:

- battery moved from about `-596 W` to `2 W`
- grid moved to about `-702 W`
- house was about `700 W`
- PV was `0 W`

### Scenario 2: `charge_to_target_soc(90)`

Use this when live SoC is below the target.

Apply:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "<currentSlotId>",
      "action": {
        "kind": "charge_to_target_soc",
        "targetSoc": 90
      }
    }
  ]
}
```

Expected runtime on `helman/get_schedule`:

- `runtime.status = applied`
- `runtime.executedAction.kind = charge_to_target_soc`
- `runtime.reason = scheduled`

Expected mode:

- `input_select.rezim_fv = Nucené nabíjení`

Expected flow pattern:

- battery should charge strongly
- grid import should increase to supply charging and house load

Observed on `2026-03-21` with SoC around `80%`:

- battery about `10007 W`
- grid about `-11007 W`
- house about `1000 W`
- PV `0 W`

### Scenario 3: `discharge_to_target_soc(70)`

Use this when live SoC is above the target.

Apply:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "<currentSlotId>",
      "action": {
        "kind": "discharge_to_target_soc",
        "targetSoc": 70
      }
    }
  ]
}
```

Expected runtime on `helman/get_schedule`:

- `runtime.status = applied`
- `runtime.executedAction.kind = discharge_to_target_soc`
- `runtime.reason = scheduled`

Expected mode:

- `input_select.rezim_fv = Nucené vybíjení`

Expected flow pattern:

- battery should discharge strongly
- excess power should go out through the grid

Observed on `2026-03-21` with SoC around `80%`:

- battery about `-10110 W`
- grid about `9565 W`
- house about `545 W`
- PV `0 W`

### Scenario 4: `discharge_to_target_soc(90)`

Use this when live SoC is already below the target.

Apply:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "<currentSlotId>",
      "action": {
        "kind": "discharge_to_target_soc",
        "targetSoc": 90
      }
    }
  ]
}
```

Expected runtime on `helman/get_schedule`:

- `runtime.status = applied`
- `runtime.executedAction.kind = stop_charging`
- `runtime.reason = target_soc_reached`

Expected mode:

- `input_select.rezim_fv = Zákaz nabíjení`

Expected flow pattern:

- often little or no physical change if the battery is already discharging
- this scenario mainly proves the runtime metadata and mode-selection path

Observed on `2026-03-21` with SoC around `79%`:

- battery stayed around `-698 W`
- grid stayed `0 W`
- house stayed around `698 W`
- PV stayed `0 W`

## Recommended verification checklist

For each scenario:

1. Call `helman/get_schedule` and capture `slots[0].id`.
2. Apply the scenario to that slot with `helman/set_schedule`.
3. Enable execution with `helman/set_schedule_execution`.
4. Re-read `helman/get_schedule` and verify requested action plus `runtime`.
5. Read the mode entity and power sensors immediately.
6. Wait about `10` seconds and read the sensors again.
7. Revert the slot to `normal`.
8. Disable execution.
9. Re-read `helman/get_schedule` and confirm the API baseline is restored.
10. Wait again if needed and verify the physical flows have also returned to a normal-looking baseline.
