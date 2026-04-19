# House Consumption Forecast

## Status

Implemented in `hass-helman` and served through `helman/get_forecast`.

The backend now stores the house forecast as a **canonical 15-minute snapshot** and aggregates it to `15`, `30`, or `60` minute responses on demand. The current frontend compatibility path still requests `60`-minute responses.

## References

- **Implementation plan**: [`implementation-plan.md`](./implementation-plan.md)
- **Implementation progress**: [`implementation-progress.md`](./implementation-progress.md)
- **History behavior explainer**: [`history-behavior-explained.md`](./history-behavior-explained.md)

## Configuration

House consumption forecast is configured under `power_devices.house.forecast`.

```yaml
power_devices:
  house:
    entities:
      power: sensor.house_power
      today_energy: sensor.house_energy_today
    forecast:
      total_energy_entity_id: sensor.house_energy_total
      min_history_days: 14
      training_window_days: 56
      deferrable_consumers:
        - energy_entity_id: sensor.ev_charging_energy_total
          label: EV Charging
        - energy_entity_id: sensor.pool_heating_energy_total
          label: Pool Heating
```

### Config fields

- `power_devices.house.forecast.total_energy_entity_id` — Required. Statistics-friendly cumulative energy entity used as the total forecast source.
- `power_devices.house.forecast.min_history_days` — Optional. Minimum Recorder history span required before the forecast becomes available. Default: `14`.
- `power_devices.house.forecast.training_window_days` — Optional. Hourly Recorder/statistics lookback window used to build the model. Default: `56`.
- `power_devices.house.forecast.deferrable_consumers` — Optional list of separately forecasted flexible loads.
  - `energy_entity_id` — Required. Statistics-friendly cumulative energy entity for the consumer.
  - `label` — Optional user-facing label. If omitted, the entity ID is used.

Deferrable consumers are deduplicated by `energy_entity_id`.

## Request contract

`helman/get_forecast` accepts these optional forecast parameters:

- `granularity`: `15 | 30 | 60` — default `60`
- `forecast_days`: integer `1..14` — default `7`

The house section always comes from the same canonical 15-minute snapshot. The requested `granularity` only changes the returned bucket size.

## What the feature provides

- predicted house consumption in `kWh`
- one `nonDeferrable` band plus optional per-consumer `deferrableConsumers`
- `currentSlot`, `actualHistory`, and future `series`
- `resolution` and `horizonHours` fields that match the returned payload granularity
- `15`, `30`, or `60` minute responses aggregated from one canonical backend model

## Runtime behavior

- The training model is still **hourly**: an hour-of-week winsorized-mean baseline built from Recorder hourly `change` statistics.
- Each modeled hour is divided evenly into four canonical 15-minute forecast slots.
- Deferrable consumer values and confidence bands follow the same split-and-sum rule as the baseline.
- The backend snapshot covers up to `14` days and refreshes every `15` minutes.
- The latest snapshot is cached in the coordinator and persisted in Home Assistant storage.
- On startup, the persisted snapshot is loaded immediately. Stale or incompatible snapshots are rebuilt in the background.
- The response layer aggregates canonical 15-minute data back to the requested `15` / `30` / `60` minute payload.

### Bucket semantics

- `currentSlot` represents the **current returned bucket**.
  - for `granularity=15`, this is the current quarter-hour slot
  - for `granularity=30`, this is the current half-hour bucket
  - for `granularity=60`, this is the current hour bucket
- `series` starts **after** `currentSlot`.
- `actualHistory` contains only **completed past buckets** and uses the same granularity as the returned response.

## Forecast statuses

The house forecast uses these statuses:

- `not_configured` — `house.forecast` is absent or `total_energy_entity_id` is missing.
- `insufficient_history` — fewer than `requiredHistoryDays` of history span were found in the queried Recorder window.
- `unavailable` — the backend could not build the forecast, or there is no compatible cached snapshot yet.
- `available` — forecast metadata, `currentSlot`, `actualHistory`, and future `series` are present.

## Returned payload overview

The house forecast is returned from `helman/get_forecast` under `house_consumption`.

```json
{
  "house_consumption": {
    "status": "available",
    "generatedAt": "2026-03-20T21:16:00+01:00",
    "unit": "kWh",
    "resolution": "hour",
    "horizonHours": 24,
    "trainingWindowDays": 56,
    "historyDaysAvailable": 31,
    "requiredHistoryDays": 14,
    "model": "hour_of_week_winsorized_mean",
    "currentSlot": {
      "timestamp": "2026-03-20T21:00:00+01:00",
      "nonDeferrable": {
        "value": 1.2,
        "lower": 0.9,
        "upper": 1.6
      },
      "deferrableConsumers": []
    },
    "actualHistory": [
      {
        "timestamp": "2026-03-20T20:00:00+01:00",
        "nonDeferrable": {
          "value": 1.0,
          "lower": 0.7,
          "upper": 1.3
        },
        "deferrableConsumers": []
      }
    ],
    "series": [
      {
        "timestamp": "2026-03-20T22:00:00+01:00",
        "nonDeferrable": {
          "value": 1.1,
          "lower": 0.8,
          "upper": 1.4
        },
        "deferrableConsumers": []
      }
    ]
  }
}
```

Key points:

- `currentSlot` replaced the older `currentHour` name.
- `resolution` reflects the returned payload granularity (`quarter_hour`, `half_hour`, or `hour`).
- `horizonHours` reflects the requested `forecast_days`.
- The backend still does **not** return `total` or `deferrableTotal`; the frontend derives them from the normalized payload.

## Frontend compatibility

- `hass-helman-card` currently requests `granularity: 60` and `forecast_days: 7`.
- The UI remains hour-oriented for now even though the backend snapshot is canonical 15-minute data.
- Quarter-hour rendering is intentionally a separate frontend follow-up.

## Known limitations

- The statistical model is still hourly; there is no sub-hourly training model.
- There is no weather, occupancy, or schedule-aware input yet.
- Accuracy still depends on Recorder data quality, stable entity configuration, and enough history in the training window.
