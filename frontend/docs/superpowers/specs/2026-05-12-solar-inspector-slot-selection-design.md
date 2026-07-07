# Solar Inspector: Full-Slot Selection & Chart Highlight

**Date:** 2026-05-12  
**Status:** Approved

## Problem

Slot selection in the solar inspector is currently triggered only by clicking the small bars in the impact strip. The main power chart is not clickable for selection — clicking it deselects. Once a slot is selected, only the contribution table row and the impact bar outline are highlighted; there is no visual indicator inside the main chart itself.

## Goal

Make the entire chart area clickable for slot selection, and visually highlight the selected slot with a bordered band that spans both the main chart and the impact strip.

## Interaction Design

### Selection

- Clicking anywhere in the **plot area** of the main chart SVG (i.e. between the left and right axis margins) selects the 15-min slot at that horizontal position.
- Clicking anywhere in the **impact strip** also selects the slot at that x position (not just the bar rect).
- Clicking in the **axis margins** (left/right) or outside the plot bounds deselects.
- The existing `stopPropagation` on individual impact bar rects is removed; the strip-level handler takes over.

### Coordinate Mapping

1. On SVG click, compute `svgX = (event.clientX - svgRect.left) / svgRect.width * layout.width` to convert from screen to viewBox coordinates.
2. If `svgX < layout.margin.left` or `svgX > layout.width - layout.margin.right` → deselect.
3. Compute `minutes = ((svgX - layout.margin.left) / layout.plotWidth) * 1440`.
4. Find the impact point whose slot is closest to `minutes` (comparing `|slotMinutes - minutes|`).
5. If a closest point is found → select it; otherwise deselect.
6. `_lastLayoutForStrip` (already stored on the component) is used to access layout in the click handler.

## Visual Design

### Selected slot highlight — Option C (approved)

A slot-width bordered band is rendered at the selected slot's position in both the main chart SVG and the impact strip SVG.

**Band properties:**
- **Width:** `layout.plotWidth / 96` (one 15-min slot = 1/96th of the day's plot width)
- **X position:** `layout.xForMinutes(slotStartMinutes)` where `slotStartMinutes = hour*60 + minute`
- **Fill:** `rgba(37, 99, 235, 0.13)` (matches `contribution-row.selected` blue theme)
- **Stroke:** `#2563eb`, opacity `0.5`, width `1px`
- **Border radius:** `1`

**In the main chart SVG:**
- Y: `layout.margin.top`, Height: `layout.plotHeight`
- Rendered as the first layer after the background rect — data lines and dots render on top

**In the impact strip SVG:**
- Y: `0`, Height: `stripHeight` (24px)
- Rendered before the bar rects — bars render on top
- The existing individual bar stroke highlight (when selected) is kept as-is

## Implementation Scope

**Single file changed:** `src/helman-solar-inspector/helman-solar-inspector.ts`

### New private methods

```
_handleChartClick(event: MouseEvent, payload: InspectorPayload): void
  - Maps click → minutes → closest impact slot → select/deselect

_findClosestImpactSlot(minutes: number, impacts: ImpactPoint[]): string | null
  - Returns the slot string of the closest impact point, or null if none
```

### Modified methods

| Method | Change |
|---|---|
| `_renderChart` | Replace `@click=${() => this._deselectSlot()}` with `@click=${(e) => this._handleChartClick(e, payload)}`; add slot highlight band as first SVG child after background |
| `_renderImpactStrip` | Replace catch-all `@click=${() => this._deselectSlot()}` with `@click=${(e) => this._handleChartClick(e, payload)}`; add slot highlight band before bar rects |

### No changes needed

- `_selectSlot` / `_deselectSlot` — unchanged
- `solar-inspector-model.ts` — unchanged
- `chart-power.ts` — unchanged
- All other files — unchanged

## Edge Cases

- **No impact points:** `_findClosestImpactSlot` returns `null` → click deselects.
- **Click exactly on margin boundary:** treated as outside plot → deselect.
- **Slot with `impactWh === null`:** still selectable (closest slot matching any impact point), detail panel handles missing data gracefully already.
- **Chart not yet rendered / layout null:** `_lastLayoutForStrip` is null → click handler returns early without crashing.
