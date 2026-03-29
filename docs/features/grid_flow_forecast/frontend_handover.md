# Grid Forecast FE Handover

This increment adds **import price fields** to the existing `helman/get_forecast().grid` payload.

Existing grid flow and export price fields are unchanged.

## Added fields

```json
{
  "currentImportPrice": 5.03,
  "importPriceUnit": "CZK/kWh",
  "importPricePoints": [
    { "timestamp": "ISO datetime", "value": 5.03 }
  ]
}
```

## Semantics

- `currentImportPrice` mirrors `currentExportPrice`, but for import tariff.
- `importPriceUnit` mirrors `exportPriceUnit`.
- `importPricePoints[]` mirrors `exportPricePoints[]`.
- Values follow requested forecast granularity (`15` / `30` / `60` min).
- Aggregated buckets can average across a tariff switch.
- If import prices are not configured, `currentImportPrice` / `importPriceUnit` are `null` and `importPricePoints[]` is empty.
