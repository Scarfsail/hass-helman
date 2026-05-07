# Slot Interpolation — Frontend Handover

**Context:** `docs/superpowers/specs/2026-05-06-solar-bias-slot-interpolation-design.md`

## What changed in the inspector payload

Two new fields appear on every slot object inside `trainingExplainability.slots[slot]`:

```json
{
  "interpolated": false,
  "interpolationAnchors": null
}
```

For a slot that was filled by interpolation both fields are set:

```json
{
  "interpolated": true,
  "interpolationAnchors": {
    "left": "10:00",
    "right": "12:00"
  }
}
```

`left` or `right` is `null` when the slot is at the edge of the day and the anchor defaults to zero:

```json
{
  "interpolated": true,
  "interpolationAnchors": { "left": null, "right": "07:00" }
}
```

An interpolated slot also gets one synthetic row appended to its `rows` array:

```json
{
  "date": "",
  "forecastWh": null,
  "actualWh": null,
  "ratio": null,
  "status": "interpolated",
  "reason": "left=10:00,right=12:00"
}
```

`trainingExplainability` also carries a top-level metadata count (on the training metadata object returned alongside the profile, not inside `trainingExplainability` itself) — that is a backend-only concern and not surfaced in the inspector websocket payload.

## What an interpolated slot means

An interpolated slot had too few valid training days to compute its own factor, but its run of missing slots was short enough (≤ `max_interpolated_consecutive_slots`, default 2) to be filled. Its `factor` value is a linear interpolation between the two nearest healthy neighbor factors. It is **not** clamped. The slot is no longer in `omitted_slots`; it behaves like a normal trained slot for correction purposes.
