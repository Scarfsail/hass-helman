# Solar Bias Correction Visual Inspector - High-Level Proposal

## Goal

Add a collapsible visual inspector inside the existing solar forecast bias correction config section. The inspector should help verify what the trained correction model is doing by showing, one day at a time:

- the original raw solar forecast
- the corrected forecast produced by the current bias profile
- actual solar energy for past days when recorder data is available
- the learned slot-of-day correction model, either as an overlay or as a compact companion chart

The first version should be diagnostic and read-only. It should not change the correction model, retrain parameters, or forecast behavior.

## Placement

The inspector belongs inside the existing nested solar bias correction section, below the current "Status and training" card. It should be collapsed by default to keep the config editor quiet for normal setup work.

```text
Solar
└─ Forecast
   ├─ Daily energy entities
   └─ Bias correction                         [expanded/collapsed section]
      ├─ Enable bias correction               [toggle]
      ├─ Min history days                     [number]
      ├─ Training time                        [HH:MM]
      ├─ Clamp min / clamp max                [numbers]
      ├─ Total energy entity                  [entity picker]
      │
      ├─ Status and training                  [existing]
      │  ├─ Enabled: Yes
      │  ├─ Current status: Applied
      │  ├─ Trained at: 2026-04-25 03:00
      │  ├─ Training days used: 12 / 10
      │  ├─ Train now                         [button]
      │  └─ Refresh status                    [button]
      │
      └─ Visual inspector                     [collapsed by default]
         └─ ... chart UI ...
```

## User Experience

The inspector shows exactly one local day at a time. The user can move backward and forward across a bounded day range, for example recent past days through the currently available forecast horizon.

Recommended default: open on today. Today is useful because it can show the current raw/corrected forecast and partial actual production if available.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ▾ Visual inspector                                                         │
│                                                                            │
│  ◀  Fri, 2026-04-24                         Today  Sat, 2026-04-25   ▶    │
│                                                                            │
│  Legend:  ━ Raw forecast   ━ Corrected forecast   ● Actual production      │
│           ░ Correction factor                                               │
│                                                                            │
│  kWh                                                                       │
│  4.0 |                            corrected                                │
│      |                         .-''''''''-.                                │
│  3.0 |                     .-''            ''-.                            │
│      |                  .-'                    '-.                         │
│  2.0 |              raw /                          \                       │
│      |             .---'                            '---.                  │
│  1.0 |         .--'          actual ● ● ● ● ●             '--.             │
│      |_____.--'____●___●___●______________●___●________________'__._______│
│        00   03   06   09   12   15   18   21   24                         │
│                                                                            │
│  Daily totals                                                              │
│  Raw forecast:       18.4 kWh                                               │
│  Corrected forecast: 15.9 kWh                                               │
│  Actual:             16.3 kWh                                               │
└────────────────────────────────────────────────────────────────────────────┘
```

For future days, actuals are absent by definition. The chart should keep the same layout but omit the actual series and label the day as forecast-only.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ▾ Visual inspector                                                         │
│                                                                            │
│  ◀  Mon, 2026-04-27                                      Forecast only  ▶   │
│                                                                            │
│  Legend:  ━ Raw forecast   ━ Corrected forecast   ░ Correction factor      │
│                                                                            │
│  kWh                                                                       │
│  4.0 |                         corrected                                  │
│      |                      .-'''''''-.                                    │
│  3.0 |                   .-'           '-.                                 │
│      |                .-'                 '-.                              │
│  2.0 |           raw /                       \                             │
│      |        .-----'                         '----.                       │
│  1.0 |    .--'                                     '--.                    │
│      |___'_____________________________________________'___________________│
│        00   03   06   09   12   15   18   21   24                         │
│                                                                            │
│  Daily totals                                                              │
│  Raw forecast:       21.0 kWh                                               │
│  Corrected forecast: 18.7 kWh                                               │
│  Actual:             not available                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

## Showing The Correction Model

There are two reasonable visual treatments.

### Option A: Forecast chart plus small factor chart

This keeps energy and model values on separate axes, which is easier to read and avoids a confusing dual-axis chart.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Solar energy                                                               │
│  kWh                                                                       │
│  4.0 |                         corrected                                  │
│  3.0 |                     .-''''''''-.                                    │
│  2.0 |              raw .-'            '-.                                 │
│  1.0 |          .----'                    '----.       actual ● ●          │
│  0.0 |_________'______________________________'___________________________│
│        00   03   06   09   12   15   18   21   24                         │
│                                                                            │
│ Correction factor                                                          │
│  2.0 |                       ▂▂▂▂▂                                         │
│  1.5 |                  ▃▃▃▃     ▃▃▃                                      │
│  1.0 |________________▅▅_____________▅▅________________ baseline _________│
│  0.5 |            ▁▁▁                    ▁▁▁                              │
│        00   03   06   09   12   15   18   21   24                         │
└────────────────────────────────────────────────────────────────────────────┘
```

Recommendation: use this for v1. It makes the model visually inspectable without mixing units.

### Option B: Single chart with correction factor as shaded background

This is more compact but less precise. It is good for quickly seeing where corrections are stronger, but it is worse for inspecting exact factor shape.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Solar energy with correction intensity                                     │
│                                                                            │
│  4.0 |                         corrected                                  │
│      |                    ░░░.-''''''''-.░░░                              │
│  3.0 |                 ░░.-''            ''-.░░                           │
│      |              raw /                    \                            │
│  2.0 |           .-----'                      '----.                      │
│      |        ░░░                                  ░░░                    │
│  1.0 |_____.--________________________________________'__.________________│
│        00   03   06   09   12   15   18   21   24                         │
└────────────────────────────────────────────────────────────────────────────┘
```

This could be a later refinement if vertical space becomes a problem.

## Data Range

Recommended first version:

- Past: last 7 completed days, plus today
- Future: all days covered by the current solar forecast response
- Navigation: previous/next buttons with disabled states at the range boundaries
- One-day granularity only

This range keeps the UI useful while bounding websocket payload size and recorder work.

## Data Contract Sketch

Add a dedicated websocket endpoint for the inspector rather than overloading the existing status/profile endpoints.

```json
{
  "type": "helman/solar_bias/inspector",
  "date": "2026-04-25"
}
```

Response:

```json
{
  "date": "2026-04-25",
  "timezone": "Europe/Prague",
  "status": "applied",
  "effectiveVariant": "adjusted",
  "trainedAt": "2026-04-25T03:00:04+02:00",
  "series": {
    "raw": [
      {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 420}
    ],
    "corrected": [
      {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 510}
    ],
    "actual": [
      {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 480}
    ],
    "factors": [
      {"slot": "08:00", "factor": 1.21}
    ]
  },
  "totals": {
    "rawWh": 18400,
    "correctedWh": 15900,
    "actualWh": 16300
  },
  "availability": {
    "hasRawForecast": true,
    "hasCorrectedForecast": true,
    "hasActuals": true,
    "hasProfile": true
  }
}
```

The endpoint should return a valid response even when some series are unavailable. The frontend should render an empty-state note inside the inspector for missing pieces rather than failing the whole panel.

## Backend Shape

The implementation can reuse the existing bias correction package boundaries:

- `service.py`: expose `async_get_inspector_day(date)` as orchestration.
- `forecast_history.py`: provide past raw forecast daily values where available.
- `actuals.py`: provide per-slot actuals for the selected past day.
- `adjuster.py`: apply the current profile to raw points for the selected day.
- `websocket.py`: add the read-only inspector endpoint.

The inspector should not retrain. It should use the current in-memory profile and current correction status. If the profile is stale or missing, it should still show raw forecast and actuals, with corrected equal to raw only if that matches current runtime behavior.

## Frontend Shape

Add the visual inspector inside `helman-bias-correction-status` or as a child custom element owned by it.

Preferred split:

- `helman-bias-correction-status`: keeps status, training, and collapsible inspector placement.
- `helman-bias-correction-inspector`: owns date navigation, websocket loading, chart rendering, totals, and empty states.

The chart can be implemented with lightweight SVG in Lit. A chart library is unnecessary for the first version because the data is one day, three line series, and one factor series.

## Empty States

The inspector should handle these states explicitly:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ▾ Visual inspector                                                         │
│                                                                            │
│  No trained profile is available yet.                                      │
│  Raw forecast and actual history can still be shown when available.        │
└────────────────────────────────────────────────────────────────────────────┘
```

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ▾ Visual inspector                                                         │
│                                                                            │
│  No data is available for Sun, 2026-04-19.                                 │
│  Try a newer day or refresh after the next forecast update.                │
└────────────────────────────────────────────────────────────────────────────┘
```

## Open Questions

- Should the default selected day be today, yesterday, or the latest completed day with actuals?
- Should "past days" include only days used for training, or any recent day with raw forecast and actuals?
- Should actuals use bars while forecasts use lines, or should all energy series be lines?
- Should the factor model always be shown, or only when a profile is currently active and not stale?

## Recommendation

Build v1 as a collapsed "Visual inspector" under the existing bias correction status card:

- default day: today
- range: last 7 days through the forecast horizon
- chart: SVG with raw/corrected forecast lines, actual production points or bars, and a separate compact factor chart
- backend: one read-only websocket endpoint that returns all data for one local day
- model display: use the current profile factors by local slot; show stale/missing profile states clearly

This gives a practical diagnostic view without turning the config editor into a full analytics dashboard.

## Implementation Note

Implemented v1 uses Option B: a single solar energy SVG chart with correction factor intensity rendered as shaded background bands. The inspector remains read-only, collapsed by default, and fetches one local day at a time through `helman/solar_bias/inspector`.
