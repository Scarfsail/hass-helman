# House Consumption Forecast

## References

- **Implementation plan**: [`implementation_plan.md`](./implementation_plan.md)
- **Implementation progress**: [`implementation_progress.md`](./implementation_progress.md)
- **History behavior explainer**: [`history_behavior_explained.md`](./history_behavior_explained.md)

## Status

This feature is implemented in `hass-helman` and exposed to `hass-helman-card`.

The backend owns forecast generation, persistence, and delivery through `helman/get_forecast`. The current UI is rendered in the house detail flow of `custom:helman-simple-card`.

## What the feature provides

- forecast the next **7 days** (`168` hourly points)
- predict **hourly energy consumption** in `kWh`
- expose both **baseline / non-deferrable** consumption and **per-consumer deferrable** consumption
- include a **confidence band** for each hourly value
- let the frontend derive user-facing totals from one normalized hourly payload

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

- `power_devices.house.forecast.total_energy_entity_id` — Required. Statistics-friendly cumulative energy entity used as the total house forecast source.
- `power_devices.house.forecast.min_history_days` — Optional. Minimum history span required from the oldest available hourly statistics row before forecast charts can be shown. Default: `14`.
- `power_devices.house.forecast.training_window_days` — Optional. Recorder/statistics lookback window used to build the forecast. Default: `56`. Keep this greater than or equal to `min_history_days`, otherwise the backend never queries far enough back to satisfy the threshold.
- `power_devices.house.forecast.deferrable_consumers` — Optional list of separately forecasted flexible loads.
  - `energy_entity_id` — Required. Statistics-friendly cumulative energy entity for the consumer.
  - `label` — Optional UI label shown in the breakdown view. If omitted, the entity ID is used.

Deferrable consumers are deduplicated by `energy_entity_id`.

Each configured deferrable consumer should already be included in `total_energy_entity_id` and should not overlap with other configured deferrables. The backend derives baseline consumption as `house total - sum(deferrables)`.

`house.entities.today_energy` is separate summary data for the house device. It is **not** used as a fallback source for this forecast.

## Data requirements

- `total_energy_entity_id` should be a cumulative energy sensor with usable Recorder statistics. The backend reads hourly `change` statistics in `kWh`.
- Deferrable consumers should also use compatible cumulative energy entities if you want them included in the breakdown view.
- There is **no fallback** to `house.entities.today_energy`.
- The default visibility threshold is **14 days** of history span from the oldest available hourly statistics row.
- v1 does not validate gaps or continuity inside that window; it only checks how far back the oldest available row is.

## Runtime behavior

- The forecast is built in the backend using an hour-of-week statistical baseline with an equal-weight winsorized mean center.
- The training window defaults to the last `56` days of hourly statistics.
- For each forecasted slot, the backend computes raw `p10` / `p90`, clips historical samples to that range for the point value, and returns the raw `p10` / `p90` as the lower/upper band.
- The forecast horizon is `168` hours and generation starts at the next full hour.
- The backend refreshes the house forecast snapshot once per hour.
- The latest snapshot is cached in the coordinator and persisted in Home Assistant storage.
- On startup, the persisted snapshot is loaded immediately and then refreshed in the background.
- Saving the relevant config invalidates the cached forecast and triggers a background refresh.
- `helman/get_forecast` returns live solar/grid data together with the cached `house_consumption` snapshot.
- After each refresh, today's already elapsed hours may be preserved from the previous snapshot so the frontend can render a full current-day profile.

## Forecast statuses

The house forecast currently uses these statuses:

- `not_configured` — `house.forecast` is absent or `total_energy_entity_id` is missing. The section stays hidden.
- `insufficient_history` — fewer than `requiredHistoryDays` of history span were found in the queried Recorder window. The house detail shows an informational message instead of charts.
- `unavailable` — the backend could not build the forecast, or a configured forecast does not have a compatible cached snapshot yet. The house detail shows an unavailable message.
- `available` — forecast metadata and hourly series are present.

If the payload is `available` but the series is empty, the frontend shows a no-data message.

## Returned payload overview

The house forecast is returned from `helman/get_forecast` under `house_consumption`.

```json
{
  "house_consumption": {
    "status": "available",
    "generatedAt": "2026-03-12T08:05:00+01:00",
    "unit": "kWh",
    "resolution": "hour",
    "horizonHours": 168,
    "trainingWindowDays": 56,
    "historyDaysAvailable": 31,
    "requiredHistoryDays": 14,
    "model": "hour_of_week_winsorized_mean",
    "series": [
      {
        "timestamp": "2026-03-12T08:00:00+01:00",
        "nonDeferrable": {
          "value": 1.2,
          "lower": 0.9,
          "upper": 1.6
        },
        "deferrableConsumers": [
          {
            "entityId": "sensor.ev_charging_energy_total",
            "label": "EV Charging",
            "value": 0.3,
            "lower": 0.0,
            "upper": 1.0
          }
        ]
      }
    ]
  }
}
```

Key points:

- `generatedAt` identifies when the current snapshot was built.
- `nonDeferrable` and each `deferrableConsumers[]` item include `value`, `lower`, and `upper`.
- The backend does **not** return `total` or `deferrableTotal`. The frontend derives them from the normalized hourly payload:

```text
total = nonDeferrable + sum(deferrableConsumers)
deferrableTotal = sum(deferrableConsumers)
```

## Frontend behavior

- The current UI is rendered inside the house detail dialog of `custom:helman-simple-card`.
- The 168-hour forecast is grouped by calendar day, so the UI usually shows today plus the next 7 dates rather than exactly 7 day cards. The expanded panel shows hourly detail with confidence-band markers.
- The available views are:
  - `Total` — baseline plus all deferrable consumers
  - `Baseline` — non-deferrable only
  - `Breakdown` — baseline row plus one row per configured deferrable consumer
- When no deferrable consumers are configured, total and baseline effectively match, and the breakdown view degrades to a baseline-only chart.
- `deferrable_consumers[].label` is user-visible in the breakdown summary and chart rows.

## Known limitations

- The current model uses a pure statistical baseline; there is no weather, occupancy, or schedule-aware model yet.
- Deferrable consumers are forecast from history only. Explicit future schedules are out of scope.
- Accuracy depends on Recorder data quality, stable entity configuration, and enough history span in the queried window.
