# Grid Forecast FE Handover

`helman/get_forecast().grid` is now a **combined grid forecast**: energy flow plus explicit export price fields.

Common envelope fields such as `status`, `generatedAt`, `resolution`, and `horizonHours` still exist. This is a breaking contract change for FE: the old price fields are renamed, and the `grid` body now also includes flow data.

## Previous contract

- `grid.currentSellPrice`
- `grid.points[]`
  - `{ timestamp, value }`
- meaning: sell price timeline

## New contract

- `grid.unit` - energy unit for `series[]` (`kWh`)
- `grid.startedAt`
- `grid.partialReason`
- `grid.coverageUntil`
- optional `grid.scheduleAdjusted`
- optional `grid.scheduleAdjustmentCoverageUntil`
- `grid.currentExportPrice`
- `grid.exportPriceUnit`
- `grid.exportPricePoints[]`
  - `{ timestamp, value }`
- `grid.series[]`
  - `{ timestamp, durationHours, importedFromGridKwh, exportedToGridKwh }`
  - optional `baseline`
    - `{ importedFromGridKwh, exportedToGridKwh }`

## FE impact

- `grid` is now a combined energy + export price payload.
- The old price fields are gone:
  - `currentSellPrice`
  - `points[]`
- Use the renamed price fields instead:
  - `currentExportPrice`
  - `exportPriceUnit`
  - `exportPricePoints[]`
- Render flow from `series[]`:
  - `importedFromGridKwh`
  - `exportedToGridKwh`
- The first item can be a partial current slot, so use `durationHours` for rendering/tooltips.
- `baseline` is present only when scheduler execution changes the forecast, so FE can compare adjusted vs passive flow.
- `grid.unit` now belongs to energy flow. Price unit moved to `exportPriceUnit`.
