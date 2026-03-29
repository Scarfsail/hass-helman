# Grid Forecast FE Handover

`helman/get_forecast().grid` changed from a **price forecast** payload to an **energy flow** payload.

Common envelope fields such as `status`, `generatedAt`, `resolution`, and `horizonHours` still exist. The breaking change is the meaning and shape of the `grid` body.

## Previous contract

- `grid.currentSellPrice`
- `grid.points[]`
  - `{ timestamp, value }`
- meaning: sell price timeline

## New contract

- `grid.startedAt`
- `grid.partialReason`
- `grid.coverageUntil`
- optional `grid.scheduleAdjusted`
- optional `grid.scheduleAdjustmentCoverageUntil`
- `grid.series[]`
  - `{ timestamp, durationHours, importedFromGridKwh, exportedToGridKwh }`
  - optional `baseline`
    - `{ importedFromGridKwh, exportedToGridKwh }`

## FE impact

- `grid` is now a bidirectional energy chart, not a price chart.
- `grid` no longer carries sell-price values.
- `points[]` is gone; use `series[]`.
- `value` is replaced by two directional fields:
  - `importedFromGridKwh`
  - `exportedToGridKwh`
- The first item can be a partial current slot, so use `durationHours` for rendering/tooltips.
- `baseline` is present only when scheduler execution changes the forecast, so FE can compare adjusted vs passive flow.
