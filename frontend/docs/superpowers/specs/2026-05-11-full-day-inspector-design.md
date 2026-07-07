# Full Day Inspector — Design

Status: draft for review
Date: 2026-05-11
Scope: hass-helman (BE) + hass-helman-card (FE)

## Goal

Expand the existing **solar inspector** (`helman-solar-inspector`) from a solar-bias-only view into a per-day **full inspector** that, for any inspectable day, shows:

- **Solar**: raw forecast, corrected forecast, actual production (existing)
- **House consumption**: forecast vs actual (new)
- **Battery state of charge (SoC)**: actual SoC trajectory (past portion) + future SoC forecast (future portion only) (new)

At the same time, tone down the per-slot correction-impact visualization, which becomes too heavy once the chart carries five-plus series.

The endpoint name `helman/solar_bias/inspector` and the component name stay as-is for this iteration; a future rename to `helman/inspector_day` / `helman-day-inspector` is out of scope.

## Non-goals

- Consumption-bias correction (analogous to solar bias). House forecast is shown raw; no correction layer.
- Backfilling pre-feature history. The new house forecast sensor only retains state from the moment it is deployed forward.
- Inspecting battery SoC forecast retrospectively. By definition the per-slot SoC forecast for "now" is just the current SoC, so storing it adds no signal — battery forecast is shown only for slots `>= now` of today/future dates.

## BE design (hass-helman)

### New sensor: house consumption forecast (current value)

Add **one** sensor that publishes the *current* forecasted house consumption — no attributes, just a numeric state updated by the coordinator on every forecast refresh. Reading past values comes for free from HA recorder: querying the sensor's state changes during `target_date` yields a time series of "what we forecasted at each moment of that day".

- Single entity, e.g. `sensor.helman_house_consumption_forecast_current`.
- **State value semantics:** the forecasted energy for the **current 15-min slot**, expressed in *Wh-per-hour* (W) units. The published number is the slot's Wh stated as a per-hour rate — *not* divided by anything at read time. Concretely: a slot forecast of 250 Wh is published as `1000` (because that 250 Wh corresponds to 1000 Wh/h, i.e. 1000 W). When the active slot rolls over, the state steps to the new slot's value, producing a stair-step history.
- Unit: `W` (1 Wh/h ≡ 1 W). Device class / state class: `POWER` / `MEASUREMENT`. This keeps the value directly comparable to live power sensors and aligns visually with how the inspector renders kW lines.
- Updated on every coordinator tick from `ConsumptionForecastBuilder`'s current-slot Wh forecast.

Reconstructing a past day's per-15-min house forecast: read the sensor's recorder state changes during `target_date`, group each state value into the 15-min slot it falls in (each slot will typically have one stable state value reflecting the forecast active at that wall-clock time). The slot value in Wh-per-hour is the rendered y-value as-is; if a Wh number is needed (e.g. for daily totals), multiply by `0.25 h`.

**Caveat:** HA recorder default retention is 10 days. Users wanting the full `usable_days` range must configure recorder retention upward. Document in README; no code workaround.

### Extend inspector endpoint payload

Endpoint `helman/solar_bias/inspector` stays. The Python payload model (`SolarBiasInspectorDay` / `inspector_day_to_payload`) gains:

```
series.houseForecast: list[InspectorPoint]   # per 15-min slot, Wh
series.houseActual:   list[InspectorPoint]   # per 15-min slot, Wh
series.batterySocForecast: list[BatterySocPoint]  # {slot, pct}, only slots >= now
series.batterySocActual:   list[BatterySocPoint]  # {slot, pct}, only slots <= now

totals.houseForecastWh: float | None
totals.houseActualWh:   float | None

availability.hasHouseForecast:    bool
availability.hasHouseActual:      bool
availability.hasBatterySocForecast: bool
availability.hasBatterySocActual:   bool
```

Existing fields (raw/corrected/actual solar, impact, training explainability, totals, availability flags) are preserved.

### Data sources per series

| Series                | Past day                                                    | Today/future                                           |
|-----------------------|-------------------------------------------------------------|--------------------------------------------------------|
| Solar raw fc          | recorder replay of solar daily sensor (existing)            | current solar forecast snapshot (existing)             |
| Solar corrected fc    | adjusted via stored profile (existing)                      | from coordinator's canonical corrected points          |
| Solar actual          | `load_actuals_for_day` (existing)                           | partial today via same loader                          |
| House forecast        | recorder state changes of new sensor, bucketed to 15-min slots | current state of new sensor (and recent history)    |
| House actual          | `ConsumptionForecastBuilder` actual history at 15-min slots | partial today via same path                            |
| Battery SoC actual    | `build_battery_actual_history(interval_minutes=15)`         | partial today via same                                 |
| Battery SoC forecast  | not emitted                                                 | filtered to slots `>= now` from current battery snapshot |

`battery_actual_history_builder.build_battery_actual_history` already accepts `interval_minutes`; passing 15 reuses existing slot-boundary state queries.

### Inspector service changes

In `solar_bias_correction/service.py::async_get_inspector_day`:

- After existing solar/actuals/factors/impact assembly, gather:
  - `house_forecast_points` via a new `load_house_forecast_points_for_day(hass, target_date, local_now)` — query recorder for state changes of the new house forecast sensor during `target_date`, bucket into 15-min slots (avg power → Wh).
  - `house_actual_points` via `ConsumptionForecastBuilder` 15-min actual history for `target_date`.
  - `battery_soc_actual` via `build_battery_actual_history(interval_minutes=15)` constrained to `target_date`.
  - `battery_soc_forecast` only when `target_date >= today`: filter coordinator's current battery capacity forecast to slots `>= local_now`, project to {slot, pct}.
- Populate the new fields on `SolarBiasInspectorDay`.

No changes to the websocket schema or auth; the response just grows.

### New helpers (BE)

- `solar_bias_correction/house_forecast_history.py` (or a more neutral module path) — query recorder for the new house forecast sensor's state changes during `target_date` and bucket into 15-min slot points.
- Slot-projection helper for battery forecast → SoC points.

## FE design (hass-helman-card)

All changes are in `src/helman-solar-inspector/`.

### Model file: `solar-inspector-model.ts`

Add types and tiny finder helpers (one per series, matching the existing `findPointForSlot` shape):

```ts
export type BatterySocPoint = { slot: string; pct: number };
export function findHouseForecastForSlot(points, slot): InspectorPoint | null;
export function findHouseActualForSlot(points, slot): InspectorPoint | null;
export function findBatterySocActualForSlot(points, slot): BatterySocPoint | null;
export function findBatterySocForecastForSlot(points, slot): BatterySocPoint | null;
```

Extend the `InspectorPayload` type in `helman-solar-inspector.ts` to include the new `series.*`, `totals.house*`, and `availability.has*` fields.

### Chart: single plot, dual Y-axis

- Left Y-axis: kW (existing solar lines + new house lines). Auto-scaled to combined max.
- Right Y-axis: SoC % (0–100), only rendered when any battery point exists.
- Right axis labels: 0/25/50/75/100 on the right edge; faint right-side tick label color.
- Shared x-axis (0..1440 minutes) unchanged.
- The `_renderChart` method is split for readability:
  - `_renderLeftAxisTicks` (existing logic, factored out)
  - `_renderRightAxisTicks` (new, SoC %)
  - `_renderSolarLayer` (existing raw/corrected/actual/invalidated)
  - `_renderHouseLayer` (new — two lines: forecast dashed, actual solid)
  - `_renderBatteryLayer` (new — two SoC lines mapped via right axis: forecast dashed, actual solid)
  - `_renderImpactStrip` (new — replaces inline impact-column rendering)

### Line styles

| Series                       | Color     | Style              |
|------------------------------|-----------|--------------------|
| Solar raw forecast           | `#64748b` | solid 2.4px (unchanged) |
| Solar corrected forecast     | `#2563eb` | solid 2.4px (unchanged) |
| Solar actual                 | `#f59e0b` | dots (unchanged)   |
| Solar actual (invalidated)   | `#9ca3af` | dots faded (unchanged) |
| House forecast               | `#a855f7` | dashed 2px         |
| House actual                 | `#a855f7` | solid 2px          |
| Battery SoC forecast         | `#14b8a6` | dashed 2px (right axis) |
| Battery SoC actual           | `#14b8a6` | solid 2px (right axis)  |

### Impact strip (replaces inline impact columns)

- Render in a new SVG group positioned directly under the main plot, height ≈ 24px, sharing the same x-mapping (`xForMinutes`).
- One bar per slot, full-strip height for `|impactWh|`-proportional fill (clipped). Colors and semantics (positive/negative/interpolated pattern/untrained) preserved from current code.
- Selected slot: thicker outline + retained-color fill, no tall overlay on the main plot anymore.
- Clicking a strip bar still calls `_selectSlot`. Clicking the main plot still deselects.
- The strip is rendered in its own `<svg>` sibling, not inside the main chart svg, so the main chart's `viewBox`/aspect ratio doesn't have to grow. Total card height stays similar to today.

### Legend

Replace the flat legend with grouped rows (or one row of inline groups separated by subtle dividers):

- **Solar**: raw, corrected, actual, invalidated
- **House**: forecast, actual
- **Battery (SoC)**: forecast, actual
- **Correction**: positive impact, negative impact, interpolated, untrained

Each group only renders entries with corresponding `availability.has*` true.

### Selected slot details

Extend the metric grid from 5 columns to 4×2 (8 cells) on wide layouts, falling back to 4×N stack on narrow. Add:

- House forecast (Wh)
- House actual (Wh)
- Battery SoC forecast (%) — empty for past dates
- Battery SoC actual (%) — empty for slots > now

Existing 5 metrics (raw, corrected, actual, impact, factor) stay; placeholders removed.

### Totals row

Add two metrics: house forecast Wh, house actual Wh.

## Data flow

```
HA recorder ─┬─> solar daily sensors  ──┐
             └─> NEW house fc sensor  ──┤
                                        ├──> service.async_get_inspector_day
ConsumptionForecastBuilder.actuals  ────┤        │
build_battery_actual_history(15min) ────┤        │
coordinator current battery snapshot ───┘        ▼
                                       payload (extended)
                                                 │
                                                 ▼
                                   FE: helman-solar-inspector
                                   - dual-axis chart
                                   - impact strip
                                   - extended slot detail
```

## Test plan

BE:
- Unit test `load_house_forecast_points_for_day` buckets recorder state changes correctly into 15-min slots (past day, today partial, day with no states, day with sparse states).
- Service test: `async_get_inspector_day` populates all new series fields and availability flags for: past day with full data, past day missing house forecast, today with future battery forecast, future-only day.
- 15-min battery actual: `build_battery_actual_history(interval_minutes=15)` returns 96 slot boundaries for a complete past day.

FE:
- Render tests on `solar-inspector-model.ts` finder helpers (mirror existing patterns).
- Visual smoke: dev build, load card, navigate past/today/future days, click slot.

## Risks / open issues

- **Recorder retention** (BE caveat): out-of-the-box HA retains 10 days. Note in README.
- **House actual at 15-min granularity** — confirm `ConsumptionForecastBuilder` per-slot actual history is reachable as a public method (or expose one). If only consumer-bucketed totals are public today, add a thin wrapper that returns the per-slot totals already computed internally.
- **Battery actual 15-min cost** — querying recorder 96× per day for one or a few sensors is fine but should be cached for the inspector request lifetime (BE already does coordinator caching; verify the actual-history builder caches or is acceptable on cold load).
- **Dual-axis legibility** — if in practice the SoC line dominates the chart visually, fallback option is to draw battery as a thin shaded area on a dedicated mini-band instead. Decide after seeing real data.
