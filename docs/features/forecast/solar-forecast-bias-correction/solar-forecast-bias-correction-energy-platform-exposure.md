# Solar Forecast Bias Correction - Home Assistant Energy Platform Exposure

## Status

**Deferred — stub only.** Companion to `solar-forecast-bias-correction-requirements.md` and `solar-forecast-bias-correction-v1-implementation-design.md`.

Full architecture for this exposure is not written yet. It depends on the v1 correction engine stabilizing, and committing to specifics now risks being invalidated by implementation learnings. This stub only records the intent and the v1 constraint the correction engine must honor so that exposure remains feasible.

## Goal

Allow Home Assistant Energy to consume Helman's corrected solar forecast as a selectable solar forecast provider, using the existing `async_get_solar_forecast(hass, config_entry_id)` contract, without maintaining a parallel corrected-forecast model.

## V1 constraint on the correction engine

The correction engine must expose the effective internal solar variant through a single service seam, so a later Energy-platform adapter can derive the hourly `{"wh_hours": {...}}` payload from that same source of truth — no independently maintained forecast, no duplicated correction logic.

## Out of scope

- sensor-entity re-exposure of the corrected forecast
- any alternative Energy provider contract

Detailed design lands in a dedicated document once v1 is in place.
