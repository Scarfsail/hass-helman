# Grid Forecast FE Handover

This increment adds **import price fields** and `availableSurplusKwh` to the existing `helman/get_forecast().grid` payload.

Existing import/export flow fields keep their current meaning. `availableSurplusKwh` is an additional effective-series field and does not add baseline support in v1.

## Added fields

```json
{
  "series": [
    {
      "timestamp": "ISO datetime",
      "durationHours": 0.25,
      "importedFromGridKwh": 0.0,
      "exportedToGridKwh": 0.0,
      "availableSurplusKwh": 0.18
    }
  ],
  "currentImportPrice": 5.03,
  "importPriceUnit": "CZK/kWh",
  "importPricePoints": [
    { "timestamp": "ISO datetime", "value": 5.03 }
  ]
}
```

## Semantics

- `availableSurplusKwh` means schedule-adjusted solar-origin excess energy that remains after house consumption and effective battery behavior and could be redirected to a controllable surplus appliance.
- `availableSurplusKwh` does **not** collapse to zero just because inverter policy blocks export.
- `exportedToGridKwh` remains the actual post-policy export forecast.
- In v1, `availableSurplusKwh` is exposed only on effective `grid.series[]`; nested `baseline` remains import/export-only.
- `currentImportPrice` mirrors `currentExportPrice`, but for import tariff.
- `importPriceUnit` mirrors `exportPriceUnit`.
- `importPricePoints[]` mirrors `exportPricePoints[]`.
- Values follow requested forecast granularity (`15` / `30` / `60` min).
- Aggregated buckets can average across a tariff switch.
- If import prices are not configured, `currentImportPrice` / `importPriceUnit` are `null` and `importPricePoints[]` is empty.
