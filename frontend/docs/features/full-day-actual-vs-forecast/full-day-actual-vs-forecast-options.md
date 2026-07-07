# Full-Day Actual vs Forecast Options

## Goal

We want the battery forecast detail for **today** to show the full day, not only the remaining hours.

The expected behavior is:

- past hours show **actual battery SoC**
- future hours show the existing **battery forecast**

Longer term, we want the same concept to work for:

- **solar**
- **house consumption**

That means the UI should be able to show **actual past hours + forecast future hours** in one coherent day view.

## Verified current state

### Frontend

- Battery detail currently renders only the backend `battery_capacity.series` for today.
  - `src/helman-simple/node-detail/battery-capacity-forecast-detail-model.ts`
  - `src/helman-simple/node-detail/battery-capacity-forecast-chart-model.ts`
- Battery has **no today-padding logic**, so if the backend series starts at the current time, the chart only shows the remaining hours.
- House detail pads today to 24 hours, but the missing past hours are synthetic zero placeholders, not real actuals.
  - `src/helman-simple/node-detail/house-forecast-detail-model.ts`
- Solar detail looks like a full day only because the backend already returns forecast points for earlier hours of today, and the unified forecast UI reuses that merged day model.
  - `src/helman-simple/node-detail/forecast-detail-model.ts`
  - `src/helman-forecast/helman-unified-forecast-detail.ts`
- The existing actual-history pipeline is **not** suitable for actual-vs-forecast detail charts:
  - `helman/get_history` returns `Record<string, number[]>`
  - frontend stores that as `DeviceNode.powerHistory`
  - those arrays are **power buckets**, not timestamped hourly series
  - they do not match the units or shape of the forecast DTOs
  - relevant files:
    - `src/helman-api.ts`
    - `src/helman/history-engine.ts`
    - `src/helman/DeviceNode.ts`

### Entities already available in the frontend

- Battery detail already has:
  - `power`
  - `capacity` / current SoC
  - `min_soc`
  - `max_soc`
  - `remaining_energy`
  - current SoC is available only as a **single live scalar**, not as history
- Solar detail already has:
  - `power`
  - `today_energy`
  - `remaining_today_energy_forecast`
- House config already supports:
  - `power`
  - `today_energy`
  - forecast `total_energy_entity_id`
  - forecast `deferrable_consumers`
- House `today_energy` exists in config, but it is not currently wired into the detail chart flow.
  - `src/helman/DeviceConfig.ts`
  - `src/helman-simple/helman-simple-card.ts`

### Backend

- `helman/get_forecast` is the main frontend forecast API.
  - `custom_components/helman/websockets.py`
  - `custom_components/helman/coordinator.py`
- Battery forecast is intentionally **now-based** and starts with a fractional first slot.
  - `custom_components/helman/battery_capacity_forecast_builder.py`
- Battery backend currently exposes:
  - live battery state
  - future battery forecast
  - **no historical battery SoC API**
- House backend already queries Recorder hourly `change` statistics for:
  - total house energy
  - each configured deferrable consumer
  - `custom_components/helman/consumption_forecast_builder.py`
- House currently preserves elapsed hours from the previous forecast snapshot so the frontend can render a full day, but those past hours are still **old forecast**, not actuals.
  - `custom_components/helman/coordinator.py`
- Solar backend currently reads forecast data from forecast entities (`wh_period`) and does **not** expose actual hourly solar production.
  - `custom_components/helman/forecast_builder.py`

## Important constraint

The current forecast charts are not really "power" charts.

- battery chart = **SoC**
- house chart = **hourly energy consumption**
- solar chart = **hourly energy production**

Because of that, the clean generalized solution should use:

- **actual hourly SoC** for battery
- **actual hourly energy** for house
- **actual hourly energy** for solar

It should **not** use the existing frontend `powerHistory` buckets as the truth source for these charts.

## Recommended direction - additive `actualHistory` on the existing forecast payload

### Summary

Keep `helman/get_forecast` as the single endpoint, but extend each relevant forecast section with an additive field for actual elapsed hours:

- `battery_capacity.actualHistory`
- `house_consumption.actualHistory`
- `solar.actualHistory`

The existing forecast fields stay untouched:

- battery keeps `series`
- house keeps `series`
- solar keeps `points`

Frontend model builders then merge:

- `actualHistory` for past hours
- existing forecast data for current/future hours

### Naming recommendation

I recommend **`actualHistory`**.

Why this is the best name:

- it pairs naturally with `forecast`
- it does not lock us to just **today**
- it still accurately describes the first implementation, even if the first version only returns current-day elapsed hours
- it is clearer and more standard than `realHistory`

Alternative names I would consider:

- `historicalActuals`
- `observedHistory`

Names I would avoid:

- `realHistory` - understandable, but vague and not common forecasting terminology
- `history` - too generic and easy to confuse with the existing power-history model
- `actualToday` - too narrow for future extension

### Why this fits the current architecture

- Forecast generation is already backend-owned.
- Frontend already follows a good pattern:
  - DTO
  - pure model builder
  - Lit detail component
- The existing detail components already refresh from `helman/get_forecast`, so this does not require a new loader pattern.

### Proposed data shape direction

The exact field names can vary, but the shape should be domain-specific and explicit:

- Battery `actualHistory` should contain actual SoC history.
- House `actualHistory` should contain actual hourly consumption values.
- Solar `actualHistory` should contain actual hourly solar energy values.

I would keep these separate from the existing forecast arrays instead of mixing actual and forecast entries into one array.

### Domain notes

#### Battery

Source:

- Recorder state history for the configured battery `capacity` entity
- optionally also `remaining_energy` if we want richer summaries

Use:

- actual elapsed hours drive the past portion of the battery chart
- existing `battery_capacity.series` continues to drive the forecast portion

#### House

Source:

- the same Recorder hourly statistics the backend already uses internally today

Use:

- actual past hours replace the current fake past-hour behavior
- forecast future hours keep the existing confidence-band model

This is the easiest domain after battery because the backend already has the right historical source.

#### Solar

Source:

- this is the current weak spot
- to do this cleanly we need an **actual cumulative solar energy entity** with Recorder statistics

Recommendation:

- first validate whether `solar.entities.today_energy` is Recorder/statistics-friendly enough to provide hourly slices for actual history
- if that works, reuse it in the first implementation
- if that does not work reliably, add an explicit field such as `power_devices.solar.forecast.total_energy_entity_id`

### Example payloads

These are **illustrative examples** for the recommended Option 2 shape. The exact field names can still be refined during implementation, but the important idea is:

- `actualHistory` holds past actual hours
- the existing forecast fields keep future forecast hours

#### Battery example

```json
{
  "battery_capacity": {
    "status": "available",
    "generatedAt": "2026-03-15T14:07:00+01:00",
    "startedAt": "2026-03-15T14:07:00+01:00",
    "unit": "kWh",
    "resolution": "hour",
    "horizonHours": 168,
    "model": "battery_capacity_v1",
    "nominalCapacityKwh": 12.0,
    "currentRemainingEnergyKwh": 5.17,
    "currentSoc": 43.1,
    "minSoc": 20.0,
    "maxSoc": 95.0,
    "actualHistory": [
      {
        "timestamp": "2026-03-15T11:00:00+01:00",
        "socPct": 46.2,
        "remainingEnergyKwh": 5.54
      },
      {
        "timestamp": "2026-03-15T12:00:00+01:00",
        "socPct": 44.8,
        "remainingEnergyKwh": 5.38
      },
      {
        "timestamp": "2026-03-15T13:00:00+01:00",
        "socPct": 43.1,
        "remainingEnergyKwh": 5.17
      }
    ],
    "series": [
      {
        "timestamp": "2026-03-15T14:07:00+01:00",
        "durationHours": 0.8833,
        "solarKwh": 0.72,
        "baselineHouseKwh": 0.41,
        "netKwh": 0.31,
        "chargedKwh": 0.29,
        "dischargedKwh": 0.0,
        "remainingEnergyKwh": 5.46,
        "socPct": 45.5,
        "importedFromGridKwh": 0.0,
        "exportedToGridKwh": 0.02,
        "hitMinSoc": false,
        "hitMaxSoc": false,
        "limitedByChargePower": false,
        "limitedByDischargePower": false
      },
      {
        "timestamp": "2026-03-15T15:00:00+01:00",
        "durationHours": 1.0,
        "solarKwh": 1.48,
        "baselineHouseKwh": 0.56,
        "netKwh": 0.92,
        "chargedKwh": 0.87,
        "dischargedKwh": 0.0,
        "remainingEnergyKwh": 6.33,
        "socPct": 52.8,
        "importedFromGridKwh": 0.0,
        "exportedToGridKwh": 0.0,
        "hitMinSoc": false,
        "hitMaxSoc": false,
        "limitedByChargePower": false,
        "limitedByDischargePower": false
      },
      {
        "timestamp": "2026-03-15T16:00:00+01:00",
        "durationHours": 1.0,
        "solarKwh": 0.94,
        "baselineHouseKwh": 0.62,
        "netKwh": 0.32,
        "chargedKwh": 0.3,
        "dischargedKwh": 0.0,
        "remainingEnergyKwh": 6.63,
        "socPct": 55.2,
        "importedFromGridKwh": 0.0,
        "exportedToGridKwh": 0.01,
        "hitMinSoc": false,
        "hitMaxSoc": false,
        "limitedByChargePower": false,
        "limitedByDischargePower": false
      }
    ]
  }
}
```

#### House consumption example

```json
{
  "house_consumption": {
    "status": "available",
    "generatedAt": "2026-03-15T14:07:00+01:00",
    "unit": "kWh",
    "resolution": "hour",
    "horizonHours": 168,
    "trainingWindowDays": 56,
    "historyDaysAvailable": 43,
    "requiredHistoryDays": 14,
    "model": "hour_of_week_winsorized_mean",
    "actualHistory": [
      {
        "timestamp": "2026-03-15T11:00:00+01:00",
        "nonDeferrable": {
          "value": 0.74
        },
        "deferrableConsumers": [
          {
            "entityId": "sensor.ev_charging_energy_total",
            "label": "EV Charging",
            "value": 0.18
          }
        ]
      },
      {
        "timestamp": "2026-03-15T12:00:00+01:00",
        "nonDeferrable": {
          "value": 0.69
        },
        "deferrableConsumers": [
          {
            "entityId": "sensor.ev_charging_energy_total",
            "label": "EV Charging",
            "value": 0.0
          }
        ]
      },
      {
        "timestamp": "2026-03-15T13:00:00+01:00",
        "nonDeferrable": {
          "value": 0.77
        },
        "deferrableConsumers": [
          {
            "entityId": "sensor.ev_charging_energy_total",
            "label": "EV Charging",
            "value": 0.24
          }
        ]
      }
    ],
    "currentHour": {
      "timestamp": "2026-03-15T14:00:00+01:00",
      "nonDeferrable": {
        "value": 0.81,
        "lower": 0.68,
        "upper": 0.96
      },
      "deferrableConsumers": [
        {
          "entityId": "sensor.ev_charging_energy_total",
          "label": "EV Charging",
          "value": 0.12,
          "lower": 0.0,
          "upper": 0.34
        }
      ]
    },
    "series": [
      {
        "timestamp": "2026-03-15T15:00:00+01:00",
        "nonDeferrable": {
          "value": 0.84,
          "lower": 0.71,
          "upper": 1.02
        },
        "deferrableConsumers": [
          {
            "entityId": "sensor.ev_charging_energy_total",
            "label": "EV Charging",
            "value": 0.31,
            "lower": 0.12,
            "upper": 0.56
          }
        ]
      },
      {
        "timestamp": "2026-03-15T16:00:00+01:00",
        "nonDeferrable": {
          "value": 0.79,
          "lower": 0.66,
          "upper": 0.93
        },
        "deferrableConsumers": [
          {
            "entityId": "sensor.ev_charging_energy_total",
            "label": "EV Charging",
            "value": 0.0,
            "lower": 0.0,
            "upper": 0.09
          }
        ]
      }
    ]
  }
}
```

#### Solar example

```json
{
  "solar": {
    "status": "available",
    "unit": "Wh",
    "remainingTodayEnergyEntityId": "sensor.pv_remaining_today_forecast",
    "actualHistory": [
      {
        "timestamp": "2026-03-15T11:00:00+01:00",
        "value": 420
      },
      {
        "timestamp": "2026-03-15T12:00:00+01:00",
        "value": 860
      },
      {
        "timestamp": "2026-03-15T13:00:00+01:00",
        "value": 1210
      }
    ],
    "points": [
      {
        "timestamp": "2026-03-15T14:00:00+01:00",
        "value": 1540
      },
      {
        "timestamp": "2026-03-15T15:00:00+01:00",
        "value": 1330
      },
      {
        "timestamp": "2026-03-15T16:00:00+01:00",
        "value": 740
      }
    ]
  }
}
```

### Pros

- additive and backward-compatible
- no extra websocket roundtrip
- reuses the existing detail component loading flow
- good balance between delivery speed and long-term reuse
- strong fit for:
  - battery first
  - house next
  - solar after new actual-energy config

### Cons

- `helman/get_forecast` becomes slightly more detail-oriented
- the payload grows a bit
- battery, house, and solar still need different actual shapes

### Verdict

This is the best balance for the current product direction.

It solves the battery requirement cleanly and gives us a clear path for house and solar without introducing a whole second detail API.

### Why

- It directly supports the requested battery behavior.
- It generalizes well to house and solar.
- It stays close to the current architecture.
- It avoids a battery-only dead end.
- It avoids the cost of a brand-new detail-series API.

## Rollout

### Phase 1 - Battery

- Add `battery_capacity.actualHistory`
- Query Recorder SoC history for the current local day
- Merge past actual SoC with future battery forecast in the frontend battery model

### Phase 2 - House

- Add `house_consumption.actualHistory`
- Populate it from the same Recorder history the backend already uses for house forecasting
- Replace the current fake past-hour behavior with real actuals

### Phase 3 - Solar

- Add `solar.actualHistory`
- Require or introduce a proper actual cumulative solar energy entity
- Merge actual past solar production with forecast future production

## Suggested implementation touchpoints

### Frontend

- `src/helman-api.ts`
- `src/helman-simple/node-detail/battery-capacity-forecast-detail-model.ts`
- `src/helman-simple/node-detail/battery-capacity-forecast-chart-model.ts`
- `src/helman-simple/node-detail/house-forecast-detail-model.ts`
- `src/helman-simple/node-detail/house-forecast-chart-model.ts`
- `src/helman-simple/node-detail/forecast-detail-model.ts`
- `src/helman-forecast/unified-forecast-model.ts`
- `src/helman-forecast/unified-forecast-detail-model.ts`
- `src/helman-forecast/helman-unified-forecast-detail.ts`

### Backend

- `custom_components/helman/battery_capacity_forecast_builder.py`
- `custom_components/helman/battery_state.py`
- `custom_components/helman/consumption_forecast_builder.py`
- `custom_components/helman/forecast_builder.py`
- `custom_components/helman/coordinator.py`
- possibly one new shared helper for Recorder-to-hourly-series normalization

## Product decisions captured

### 1. House and solar stay hourly energy charts

The implementation plan should keep these charts as:

- actual hourly energy vs forecast hourly energy

not:

- instantaneous power vs forecast

That keeps the current visualization model aligned with the existing forecast UI.

### 2. Battery past hours should include real SoC and flow-related datapoints if derivable

The requested direction is:

- past battery hours show real SoC
- and if charge/discharge flow datapoints can be derived cleanly, include them in the past-hour data as well

The implementation plan should therefore evaluate:

- what historical battery movement data already exists
- what can be reconstructed reliably
- what should be included in the actual history DTO even if the first UI iteration uses only part of it

### 3. House actual history should reuse a forecast-like shape

For house, the implementation plan should prefer a contract that keeps frontend reuse high by matching the existing forecast structure closely enough to reuse the same shaping/rendering logic.

### 4. `actualHistory` should stay a plain array in v1

The name should stay future-proof, but the first implementation can keep the field simple:

- plain array in v1
- no `from` / `to` / `points` wrapper yet

## Solar planning assumption captured

For solar, the implementation plan should assume:

- try to reuse `solar.entities.today_energy` first
- validate whether it is Recorder/statistics-friendly enough for hourly actual-history slices
- if that fails, add an explicit `power_devices.solar.forecast.total_energy_entity_id`

That keeps the first implementation simpler while still leaving a clean fallback path if the existing entity is not good enough.

## Final conclusion

The real blocker is not chart rendering.

The real blocker is that the current system has:

- forecast data in one model
- actual history in another model
- and for battery actual SoC history, no frontend contract at all

The best next step is therefore:

1. add **actualHistory** support in the backend payload
2. start with **battery**
3. reuse the same pattern for **house**
4. add a proper solar actual-energy source and then bring **solar** onto the same model
