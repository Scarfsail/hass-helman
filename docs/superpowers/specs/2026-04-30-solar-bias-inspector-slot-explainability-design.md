# Solar Bias Inspector Slot Explainability Design

## Goal

Improve the solar bias visual inspector so it can answer why a specific slot has its correction. The current color-band factor overlay is useful as a quick visual cue, but it does not show the impact size for the selected day or the historical training evidence behind the factor.

The new inspector remains read-only. It does not change training, factors, slot invalidation, or forecast correction behavior.

## Current Context

The existing inspector is implemented by `custom_components/helman/frontend/src/bias-correction-inspector.ts` and backed by the existing `helman/solar_bias/inspector` websocket command. The backend already returns one selected day at a time, including raw forecast, corrected forecast, actual production, invalidated actual points, and slot factors.

Training currently computes slot factors in `custom_components/helman/solar_bias_correction/trainer.py` from historical forecast and actual Wh values. The persisted profile stores factors and metadata, but not the per-day slot contribution rows needed to explain the exact stored factor after training finishes.

## Data Model

Training will persist an explainability snapshot alongside the profile metadata. For each trained forecast slot, store:

```text
slot
factor
rawRatio
clamped
forecastSumWh
actualSumWh
contributionRows[]
```

Each contribution row represents one training candidate day for that slot:

```text
date
forecastWh
actualWh
ratio
status
reason
```

Supported row statuses:

- `included`: day contributed to the slot calculation.
- `trimmed`: day had a valid slot ratio, but `trimmed_mean` removed it before averaging.
- `invalidated`: slot was excluded by slot invalidation.
- `forecast_zero`: day had no useful forecast for this slot.
- `dropped_day`: the whole day was dropped by training day gates.
- `omitted_slot`: the slot failed the overall forecast-sum floor.

For `ratio_of_sums`, the slot summary explains `actualSumWh / forecastSumWh`, then clamp. For `trimmed_mean`, the rows still show per-day ratios, and rows removed before averaging use the `trimmed` status.

## UI Behavior

The inspector keeps the existing day navigation and forecast chart, but replaces the current correction-color bands with clickable impact columns overlaid in the same chart.

Column height is `abs(correctedWh - rawWh)` for the displayed day’s slot. Column color keeps the current meaning: positive correction and negative correction use the existing colors.

Clicking a column selects that slot. Below the chart, the inspector shows selected-day slot details above the training contribution table.

Selected-day slot details:

```text
slot time
raw forecast
corrected forecast
actual production, when available
correction impact
factor
```

Training contribution table:

```text
date
forecast Wh
actual Wh
ratio
status / reason
```

The table is read-only and explains the exact stored profile from the last successful training run. If no slot is selected, the inspector defaults to the slot with the largest absolute impact column for the displayed day, because that immediately answers what changed most.

## Day Switching

The selected slot is independent of the selected day. If the user selects `12:00`, then moves to another day, `12:00` remains selected.

On day change:

- The chart refreshes raw, corrected, actual, and invalidated series for the new day.
- The selected column remains highlighted if that slot exists in the new day.
- Selected-day slot details update to the new day’s raw, corrected, actual, impact, and factor values.
- The training contribution table remains tied to the selected slot and current stored training snapshot.

If the selected slot is missing from the displayed day, the details panel shows the selected slot with unavailable day values while still showing the training contribution table.

## Backend Contract

Extend the existing `helman/solar_bias/inspector` response instead of adding a second endpoint. The endpoint remains selected-day oriented: the request still takes a `date`, and the day series, totals, and impact columns belong only to that requested date.

Add selected-day impact data:

```json
"series": {
  "impact": [
    {
      "slot": "12:00",
      "rawWh": 840,
      "correctedWh": 1120,
      "impactWh": 280,
      "factor": 1.34
    }
  ]
}
```

Add stored training explainability for all slots in the same response:

```json
"trainingExplainability": {
  "trainedAt": "2026-04-25T03:00:00+02:00",
  "aggregationMethod": "ratio_of_sums",
  "slots": {
    "12:00": {
      "factor": 1.34,
      "rawRatio": 1.34,
      "clamped": false,
      "forecastSumWh": 1500,
      "actualSumWh": 2010,
      "rows": [
        {
          "date": "2026-04-21",
          "forecastWh": 520,
          "actualWh": 610,
          "ratio": 1.17,
          "status": "included",
          "reason": null
        }
      ]
    }
  }
}
```

The explainability snapshot is profile-specific, not selected-day-specific. Including all slots in the selected-day response keeps column switching instant and avoids a second websocket request.

## Error Handling And Empty States

The inspector should degrade without breaking the settings panel:

- No usable profile: show raw and corrected data as today does, no impact columns, and a no-trained-profile note.
- Profile exists but no explainability snapshot, such as an old stored profile: show impact columns from factors if possible, but the contribution table says the current profile predates stored explainability and needs retraining.
- Selected day has no forecast: show the selected date empty state. If a slot remains selected, keep the training table visible but mark selected-day values unavailable.
- Selected day has no actuals: selected-day detail shows actual production as unavailable.
- Training failed but preserved a previous profile: show the preserved profile’s explainability if it exists, matching the existing applied-factor behavior.
- Stale config: table still explains the stored profile; the status line should make clear the profile is pending retrain, matching current behavior.

## Testing

Backend tests should cover:

- Explainability dataclasses and serialization.
- Training snapshot creation for `ratio_of_sums`.
- Training snapshot creation for `trimmed_mean`, including trimmed rows.
- Invalidated slot rows and dropped-day rows.
- Inspector response shape with selected-day impact columns.
- Backward compatibility for stored profiles that lack explainability.

Frontend tests should cover:

- Impact column generation from raw/corrected selected-day values.
- Default selected slot chooses the largest absolute impact.
- Selected slot persists across day changes.
- Selected-day details render raw, corrected, actual, impact, and factor.
- Contribution table renders included, invalidated, dropped, omitted, and unavailable states.

## Out Of Scope

- Editing or overriding factors from the inspector.
- A slot-specific websocket endpoint.
- Changing the training algorithm.
- Changing slot invalidation behavior.
- Persisting UI selection across browser reloads.
