# Helman Manual Schedule FE Handover - `setBy`
 cd "/home/ondra/dev/hass/hass-helman-card"
 
This increment adds optional `setBy` metadata to authored scheduler actions so FE can distinguish whether an action came from a user or from automation.

## What changed

`setBy` is now supported on individual authored actions:

- `domains.inverter`
- `domains.appliances[applianceId]`

Supported values:

- `user`
- `automation`

Important: `setBy` is **per action**, not per slot.

## FE mental model

- Treat `setBy` as **authorship metadata** for authored schedule actions.
- Read authored state from `slots[].domains`.
- Do not infer authorship from runtime executor behavior.
- If `setBy` is missing, treat that as **no explicit authorship metadata present**.

Missing `setBy` can still happen for:

- implicit default slots returned from materialization
- older persisted schedule data
- any non-authored/default state that has no explicit action metadata

## Websocket write behavior

For `helman/set_schedule`:

-if FE sends an explicit `setBy`, backend preserves it
- if FE omits `setBy`, backend fills it as `user`

That means normal user-driven FE writes can simply omit `setBy` and rely on the backend default.

If FE ever needs to send automation-authored actions through the same websocket path, it can send `setBy: "automation"` explicitly and that value is preserved.

## Request examples

### User-authored write with implicit defaulting

FE may send:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "2026-04-10T21:30:00+02:00",
      "domains": {
        "inverter": {
          "kind": "stop_charging"
        },
        "appliances": {}
      }
    }
  ]
}
```

Backend stores and later returns:

```json
{
  "id": "2026-04-10T21:30:00+02:00",
  "domains": {
    "inverter": {
      "kind": "stop_charging",
      "setBy": "user"
    },
    "appliances": {}
  }
}
```

### Explicit automation-authored write

FE may send:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "2026-04-10T21:30:00+02:00",
      "domains": {
        "inverter": {
          "kind": "normal",
          "setBy": "automation"
        },
        "appliances": {}
      }
    }
  ]
}
```

Backend preserves:

```json
{
  "id": "2026-04-10T21:30:00+02:00",
  "domains": {
    "inverter": {
      "kind": "normal",
      "setBy": "automation"
    },
    "appliances": {}
  }
}
```

## Appliance examples

The same rule applies to appliance actions.

Example:

```json
{
  "id": "2026-04-10T21:30:00+02:00",
  "domains": {
    "inverter": {
      "kind": "empty"
    },
    "appliances": {
      "garage-ev": {
        "charge": true,
        "vehicleId": "kona",
        "useMode": "Fast",
        "setBy": "automation"
      },
      "dishwasher": {
        "on": true
      }
    }
  }
}
```

Returned authored slot:

```json
{
  "id": "2026-04-10T21:30:00+02:00",
  "domains": {
    "inverter": {
      "kind": "empty",
      "setBy": "user"
    },
    "appliances": {
      "garage-ev": {
        "charge": true,
        "vehicleId": "kona",
        "useMode": "Fast",
        "setBy": "automation"
      },
      "dishwasher": {
        "on": true,
        "setBy": "user"
      }
    }
  }
}
```

The defaulting happens independently for each missing authored action.

## Live behavior that was validated

Validated against the local Home Assistant websocket API:

1. explicit inverter write with `setBy: "automation"` came back as `automation`
2. inverter write without `setBy` came back as `user`
3. original slot state was restored after the live check
