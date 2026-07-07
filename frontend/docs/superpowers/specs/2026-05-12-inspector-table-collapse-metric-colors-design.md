# Solar Inspector: Collapsible Training Table & Metric Card Colors — Design Spec

**Date:** 2026-05-12  
**File:** `src/helman-solar-inspector/helman-solar-inspector.ts`

---

## Goal

Two UX improvements to the solar inspector:

1. The training contribution table is collapsible and collapsed by default.
2. Metric card boxes have a soft colored background matching the chart line they represent, so each card doubles as a legend entry.

---

## Color Constants (DRY)

Add a module-level `const CHART_COLORS` object at the top of `helman-solar-inspector.ts` (before the class definition). All existing hardcoded hex colors for chart lines, legend swatches, and SVG fills/strokes are replaced with references to this object.

```ts
const CHART_COLORS = {
  raw:            '#64748b',
  corrected:      '#2563eb',
  actual:         '#f59e0b',
  house:          '#a855f7',
  battery:        '#14b8a6',
  impactPositive: '#16a34a',
  impactNegative: '#dc2626',
} as const;
```

All existing hardcoded hex occurrences of these values in SVG `stroke`/`fill` attributes and in CSS (`.swatch`, `.impact-swatch` classes) are replaced with `CHART_COLORS.<key>`. No other file changes.

---

## Metric Card Colored Backgrounds

### `_renderMetric` signature

```ts
private _renderMetric(label: string, value: string, color?: string)
```

If `color` is provided, apply it as an inline style on `.metric-card`:

```ts
style=${color ? `background: color-mix(in srgb, ${color} 15%, transparent);` : ""}
```

`color-mix` requires no utility function and degrades gracefully (transparent background) in unsupported browsers.

### Color assignments

| Metric | Color |
|---|---|
| Raw forecast | `CHART_COLORS.raw` |
| Corrected forecast | `CHART_COLORS.corrected` |
| Actual production | `CHART_COLORS.actual` |
| House forecast | `CHART_COLORS.house` |
| House actual | `CHART_COLORS.house` |
| Battery SoC forecast | `CHART_COLORS.battery` |
| Battery SoC actual | `CHART_COLORS.battery` |
| Correction impact | `CHART_COLORS.impactPositive` or `impactNegative` based on `impactWh` sign |
| Factor | `CHART_COLORS.impactPositive` or `impactNegative` based on selected slot's `impactWh` sign |

Applied in both `_renderTotals` and `_renderSelectedSlotDetails`. The correction impact and factor colors require computing the sign at call-site and passing the resolved color string.

Metric cards with no color mapping (e.g., placeholders) receive no `color` argument and render with no background.

---

## Collapsible Training Table

### State

```ts
@state private _trainingTableCollapsed = true;
```

Reset to `true` whenever a new slot is selected (in `_selectSlot`).

### Toggle UI

The existing `contribution-summary` header div gains a clickable chevron button (▶ collapsed / ▼ expanded). Clicking toggles `_trainingTableCollapsed`. The chevron uses CSS `transition: transform 0.2s` for a smooth rotate animation.

### Visibility

The `.contribution-table-wrap` div (the `<table>`) is conditionally rendered:

```ts
${this._trainingTableCollapsed ? "" : html`<div class="contribution-table-wrap">...</div>`}
```

The summary header (slot raw ratio, factor, interpolation note) remains always visible — only the table rows are hidden when collapsed.

---

## What Does Not Change

- Contribution table content, columns, row selection logic
- Impact strip SVG rendering (bars remain as-is)
- Any file outside `helman-solar-inspector.ts`
