# House Consumption Forecast — Implementation Progress

## References

- **Implementation plan**: [`implementation_plan.md`](./implementation_plan.md) in this folder
- **Backend repo**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Frontend repo**: `/home/ondra/dev/hass/hass-helman-card/src/`

## Increment status

| Increment | Description | Status |
|-----------|-------------|--------|
| 1 | Shared contract and safe scaffolding | Done |
| 2 | Persistence, scheduler, source resolution, visibility rule | **Next** |
| 3 | Backend statistical model and final forecast payload | Pending |
| 4 | House forecast UI: total and baseline views | Pending |
| 5 | Per-consumer deferrable breakdown | Pending |
| 6 | Docs, config examples, and cleanup | Pending |

## Increment 1 — Done

### What was implemented

**Backend** — new `consumption_forecast_builder.py` + wired into `forecast_builder.py`:
- `ConsumptionForecastBuilder` class with defensive config reading (same `_read_dict` / `_read_entity_id` pattern as `HelmanForecastBuilder`)
- `helman/get_forecast` now returns `house_consumption` alongside `solar` and `grid`
- Always returns `status: "not_configured"` with empty `series` in this increment
- Config path: `power_devices.house.forecast.total_energy_entity_id`

**Frontend** — types, placeholder component, wiring:
- `helman-api.ts`: new DTOs (`HouseConsumptionForecastDTO`, `ForecastBandValueDTO`, `HouseConsumptionForecastHourDTO`, `DeferrableConsumerHourValueDTO`), `insufficient_history` added to `ForecastStatus`, `ForecastPayload` extended with `house_consumption`
- `DeviceConfig.ts`: `HouseForecastConfig` and `HouseForecastDeferrableConsumerConfig` interfaces, `forecast?` added to `HouseDeviceConfig`
- `helman-house-forecast-detail.ts` (new): self-loading LitElement placeholder — loads forecast, hides when `not_configured`, shows status messages for `insufficient_history` / `unavailable`
- `node-detail-house-content.ts`: renders `<helman-house-forecast-detail>` below existing content
- `cs.json`: `node_detail.house_forecast.*` keys added

### Files touched

Backend:
- `consumption_forecast_builder.py` (new)
- `forecast_builder.py` (import + 1 line in `build()`)

Frontend:
- `src/helman-api.ts`
- `src/helman/DeviceConfig.ts`
- `src/helman-simple/node-detail/helman-house-forecast-detail.ts` (new)
- `src/helman-simple/node-detail/node-detail-house-content.ts`
- `src/localize/translations/cs.json`

### Design decisions

- `ForecastStatus` is a shared type (extended with `insufficient_history` for all forecast types, not just house)
- `ForecastPayload.house_consumption` uses snake_case key to match the backend wire format (same as `solar` / `grid`)
- Increment 1 calls `ConsumptionForecastBuilder` directly from `forecast_builder.py` (no coordinator involvement yet — that comes in Increment 2)
- `_read_deferrable_consumers` helper exists in the builder but is not called until Increment 2+

### Known items deferred to Increment 2

- The `insufficient_history` translation string hardcodes "14 days" — should be made dynamic using `requiredHistoryDays` from the DTO once the `insufficient_history` status is reachable
- Both `helman-forecast-detail` and `helman-house-forecast-detail` independently fetch the full forecast payload — a shared forecast context/store could deduplicate this in the future

## What's next: Increment 2

**Goal**: Persistence, scheduler, source resolution, and the 14-day minimum visibility rule. No forecast model yet — just data readiness.

The next session should read the **Increment 2** section of [`implementation_plan.md`](./implementation_plan.md) for full details. Summary:

### Backend

- **`storage.py`**: add a persisted store for the house forecast snapshot (separate from config)
- **`const.py`**: add storage key/version constants for the forecast snapshot
- **`coordinator.py`**: load persisted snapshot on startup, keep in memory, schedule hourly refresh, trigger non-blocking refresh on startup, return cached snapshot from `get_forecast()` instead of recalculating live
- **`consumption_forecast_builder.py`**: query HA Recorder/statistics for `total_energy_entity_id`, convert to local-time hourly buckets, compute `historyDaysAvailable`, return `not_configured` / `insufficient_history` / `available` based on data readiness, still return empty `series` (no prediction model yet)

### Frontend

- **`helman-house-forecast-detail.ts`**: show status note for `insufficient_history` / `unavailable`, keep chart hidden when no points exist
- Make the `insufficient_history` message dynamic using `requiredHistoryDays`

### Key architectural change in Increment 2

The house forecast shifts from the live-on-every-request pattern (used by solar/grid in `forecast_builder.py`) to a **persisted cached snapshot** pattern owned by the coordinator. This means `coordinator.get_forecast()` will return a mix: live-built solar/grid + cached house_consumption.

### Validation

Increment 2 requires **user validation** — see the implementation plan for the full checklist. Key points: confirm persistence survives HA restart, confirm `historyDaysAvailable` looks reasonable, confirm status transitions work.
