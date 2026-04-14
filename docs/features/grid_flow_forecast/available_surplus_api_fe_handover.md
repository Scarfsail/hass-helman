# FE Handover: `availableSurplusKwh`

## Purpose

`availableSurplusKwh` is a new forecast field exposed from `helman/get_forecast`.

It answers this question for each forecast bucket:

> How much solar-origin excess energy remains after house consumption and effective battery behavior, and could therefore be redirected to another local consumer?

This field exists because `exportedToGridKwh` is not sufficient for that purpose. `exportedToGridKwh` describes what is expected to be exported after inverter/export policy is applied. When export is intentionally blocked, actual export can be `0.0` even though usable local surplus still exists.

## Public API shape

The field is exposed on `grid.series[]`:

```json
{
  "grid": {
    "series": [
      {
        "timestamp": "2026-03-20T21:45:00+01:00",
        "durationHours": 0.25,
        "importedFromGridKwh": 0.0,
        "exportedToGridKwh": 0.0,
        "availableSurplusKwh": 0.18
      }
    ]
  }
}
```

## Contract

- unit: `kWh`
- always non-negative
- present on effective `grid.series[]`
- not exposed on `battery_capacity.series[]`
- not exposed on nested grid `baseline` entries in v1
- follows the requested forecast granularity the same way as other grid energy fields

## Meaning of each related field

- `availableSurplusKwh`: energy that remains locally available to redirect after house load and effective battery behavior
- `exportedToGridKwh`: energy expected to actually leave to grid after export policy is applied

These fields can be equal, but they are intentionally not the same thing.

## How it is calculated

`availableSurplusKwh` is derived from the effective schedule-adjusted forecast simulation.

It reflects:

- solar production
- adjusted house forecast
- effective battery charging/discharging behavior
- manual schedule actions already present in the working schedule
- earlier automation effects already written into the working schedule

It does not get forced to zero only because export is blocked.

In practical terms:

- if the slot is in normal export mode, `availableSurplusKwh` will usually match `exportedToGridKwh`
- if the slot is under `stop_export`, `exportedToGridKwh` can be `0.0` while `availableSurplusKwh` stays positive

## Aggregation

For aggregated responses, `availableSurplusKwh` is summed the same way as `importedFromGridKwh` and `exportedToGridKwh`.

## Intended interpretation

This field is the backend's factual answer for "redirectable surplus".

It should be treated as distinct from actual export. If the frontend needs to reason about blocked-but-still-available excess energy, that can be derived from the difference between:

- `availableSurplusKwh`
- `exportedToGridKwh`
