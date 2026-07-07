# Solar Inspector: Full-Slot Selection & Chart Highlight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make any click in the solar inspector chart select the 15-min slot at that x position, and highlight the selected slot with a bordered band spanning the full chart height and impact strip.

**Architecture:** All changes are in a single LitElement component. Three new private methods are added (`_findClosestImpactSlot`, `_handleChartClick`, `_renderSlotHighlight`) and two existing render methods are updated (`_renderChart`, `_renderImpactStrip`). The chart's existing `_lastLayoutForStrip` field (already set during render) provides layout info to the click handler.

**Tech Stack:** LitElement, TypeScript, SVG via lit-html's `svg` tag template, Vite build (`npm run build-dev`)

---

## File Map

| File | Change |
|---|---|
| `src/helman-solar-inspector/helman-solar-inspector.ts` | Add 3 methods, modify `_renderChart` and `_renderImpactStrip` |

No other files change.

---

## Task 1: Add `_findClosestImpactSlot` helper

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts` (private helpers section, after `_sortContributionRows`)

- [ ] **Step 1: Add the method**

Open `src/helman-solar-inspector/helman-solar-inspector.ts`. Find the `_sortContributionRows` method (around line 1393). Insert the following **after** that method's closing brace:

```ts
private _findClosestImpactSlot(minutes: number, impacts: ImpactPoint[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const point of impacts) {
    const m = /^(\d{2}):(\d{2})$/.exec(point.slot);
    if (!m) continue;
    const slotMinutes = Number(m[1]) * 60 + Number(m[2]);
    const dist = Math.abs(slotMinutes - minutes);
    if (dist < bestDist) {
      bestDist = dist;
      best = point.slot;
    }
  }
  return best;
}
```

- [ ] **Step 2: Verify it builds**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: build succeeds with no TypeScript errors.

---

## Task 2: Add `_handleChartClick` handler

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts` (after `_findClosestImpactSlot`)

- [ ] **Step 1: Add the method** directly after `_findClosestImpactSlot`:

```ts
private _handleChartClick(event: MouseEvent, payload: InspectorPayload) {
  const layout = this._lastLayoutForStrip;
  if (!layout) return;
  const svgEl = event.currentTarget as SVGSVGElement;
  const rect = svgEl.getBoundingClientRect();
  const svgX = ((event.clientX - rect.left) / rect.width) * layout.width;
  if (svgX < layout.margin.left || svgX > layout.width - layout.margin.right) {
    this._deselectSlot();
    return;
  }
  const minutes = ((svgX - layout.margin.left) / layout.plotWidth) * 1440;
  const slot = this._findClosestImpactSlot(minutes, payload.series.impact);
  if (slot) {
    this._selectSlot(slot);
  } else {
    this._deselectSlot();
  }
}
```

- [ ] **Step 2: Verify it builds**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: no errors.

---

## Task 3: Add `_renderSlotHighlight` helper

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts` (after `_handleChartClick`)

- [ ] **Step 1: Add the method** directly after `_handleChartClick`:

```ts
private _renderSlotHighlight(
  layout: ChartLayout,
  y: number,
  height: number,
  selectedSlot: string | null,
) {
  if (!selectedSlot) return "";
  const m = /^(\d{2}):(\d{2})$/.exec(selectedSlot);
  if (!m) return "";
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  const x = layout.xForMinutes(minutes);
  const w = Math.max(3, layout.plotWidth / 96);
  return svg`
    <rect
      x=${x} y=${y} width=${w} height=${height}
      fill="rgba(37,99,235,0.13)"
      stroke="#2563eb" stroke-width="1" stroke-opacity="0.5"
      rx="1"
      pointer-events="none"
    ></rect>
  `;
}
```

- [ ] **Step 2: Verify it builds**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: no errors.

---

## Task 4: Wire up `_renderChart`

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts` — `_renderChart` method (around line 661)

- [ ] **Step 1: Replace `_renderChart`**

Find the existing `_renderChart` method and replace it entirely with:

```ts
private _renderChart(payload: InspectorPayload) {
  const layout = this._computeChartLayout(payload);
  this._lastLayoutForStrip = layout;
  const selectedSlot = resolveSelectedImpactSlot(payload.series.impact, this._selectedSlot);
  return svg`
    <svg
      viewBox="0 0 ${layout.width} ${layout.height}"
      role="img"
      aria-label=${this._t("bias_correction.inspector.title")}
      style="cursor: pointer;"
      @click=${(e: MouseEvent) => this._handleChartClick(e, payload)}
    >
      ${this._renderChartBackground(layout)}
      ${this._renderSlotHighlight(layout, layout.margin.top, layout.plotHeight, selectedSlot)}
      ${this._renderLeftAxis(layout)}
      ${this._renderXAxis(layout)}
      ${this._renderSolarLayer(payload, layout)}
      ${this._renderHouseLayer(payload, layout)}
      ${this._renderRightAxis(layout)}
      ${this._renderBatteryLayer(payload, layout)}
    </svg>
  `;
}
```

Key changes from the original:
- `@click` now calls `_handleChartClick` instead of `_deselectSlot`
- `resolveSelectedImpactSlot` is computed and passed to `_renderSlotHighlight`
- `_renderSlotHighlight` is inserted between background and axes so grid lines render on top of the band

- [ ] **Step 2: Verify it builds**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): add helpers and wire chart click for slot selection"
```

---

## Task 5: Wire up `_renderImpactStrip`

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts` — `_renderImpactStrip` method (around line 821)

- [ ] **Step 1: Replace `_renderImpactStrip`**

Find the existing `_renderImpactStrip` method and replace it entirely with:

```ts
private _renderImpactStrip(payload: InspectorPayload, layout: ChartLayout) {
  if (!payload.series.impact.length) return "";
  const stripHeight = 24;
  const stripWidth = layout.width;
  const xLeft = layout.margin.left;
  const xRight = layout.width - layout.margin.right;
  const plotWidth = xRight - xLeft;
  const values = payload.series.impact
    .map((p) => Math.abs(p.impactWh ?? 0))
    .filter((v) => Number.isFinite(v));
  const maxImpact = Math.max(1, ...values);
  const selectedSlot = resolveSelectedImpactSlot(payload.series.impact, this._selectedSlot);
  const explainability = payload.trainingExplainability;
  return svg`
    <svg
      viewBox="0 0 ${stripWidth} ${stripHeight}"
      role="img"
      aria-label=${this._t("bias_correction.inspector.correction_impact")}
      style="cursor: pointer;"
      @click=${(e: MouseEvent) => this._handleChartClick(e, payload)}
    >
      ${this._renderSlotHighlight(layout, 0, stripHeight, selectedSlot)}
      ${payload.series.impact.map((point) => {
        if (point.impactWh === null || !Number.isFinite(point.impactWh)) return "";
        const m = /^(\d{2}):(\d{2})$/.exec(point.slot);
        if (!m) return "";
        const minutes = Number(m[1]) * 60 + Number(m[2]);
        const x = xLeft + (minutes / 1440) * plotWidth;
        const w = Math.max(3, plotWidth / 96);
        const h = Math.max(2, (Math.abs(point.impactWh) / maxImpact) * (stripHeight - 4));
        const y = stripHeight - h - 2;
        const trainingSlot = explainability?.slots[point.slot] ?? null;
        const interpolated = trainingSlot?.interpolated === true;
        const untrained = !interpolated && (trainingSlot === null || trainingSlot.factor === null);
        const positive = point.impactWh >= 0;
        const selected = selectedSlot === point.slot;
        const fill = untrained
          ? "#9ca3af"
          : interpolated
            ? positive ? "url(#impact-interpolated-positive)" : "url(#impact-interpolated-negative)"
            : positive ? "#16a34a" : "#dc2626";
        const fillOpacity = untrained ? "0.45" : interpolated ? "1" : "0.55";
        const strokeColor = selected ? "var(--primary-text-color)" : "transparent";
        const strokeWidth = selected ? "1.5" : "0";
        return svg`
          <rect x=${x} y=${y} width=${w} height=${h}
                fill=${fill} fill-opacity=${fillOpacity}
                stroke=${strokeColor} stroke-width=${strokeWidth}
                style="pointer-events: none;">
            <title>${point.slot} ${this._formatSignedWh(point.impactWh)}</title>
          </rect>
        `;
      })}
      <defs>
        <pattern id="impact-interpolated-positive" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="#16a34a" fill-opacity="0.12"></rect>
          <line x1="0" y1="0" x2="0" y2="4" stroke="#16a34a" stroke-width="1.6" stroke-opacity="0.85"></line>
        </pattern>
        <pattern id="impact-interpolated-negative" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="#dc2626" fill-opacity="0.12"></rect>
          <line x1="0" y1="0" x2="0" y2="4" stroke="#dc2626" stroke-width="1.6" stroke-opacity="0.85"></line>
        </pattern>
      </defs>
    </svg>
  `;
}
```

Key changes from the original:
- `@click` now calls `_handleChartClick` instead of `_deselectSlot`
- `_renderSlotHighlight` inserted before bar rects (bars render on top)
- Bar rects: `@click` handler and `stopPropagation` removed; `pointer-events: none` added so all clicks reach the SVG handler

- [ ] **Step 2: Verify it builds**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): highlight selected slot across chart and impact strip"
```

---

## Task 6: Manual verification

- [ ] **Step 1: Deploy to HA dev environment**

Copy the built file to your Home Assistant custom components directory (however you normally deploy — e.g. copying `dist/helman-card-dev.js` to the HA www folder and reloading the browser).

- [ ] **Step 2: Verify clicking the chart area selects a slot**

1. Open the solar inspector in HA
2. Click on an area of the chart that has data (solar production peak area)
3. Verify: a bordered blue band appears in the chart at that slot's x position
4. Verify: the same band appears in the impact strip below
5. Verify: the "Selected slot" detail section appears below the totals

- [ ] **Step 3: Verify clicking the impact strip area selects a slot**

1. Click on an empty area of the impact strip (between bars, not on a bar)
2. Verify: a slot is selected based on the x position of the click

- [ ] **Step 4: Verify clicking the axis area deselects**

1. Select any slot first
2. Click on the left axis area (Y labels / left margin)
3. Verify: slot is deselected, band disappears

- [ ] **Step 5: Verify no regression on contribution table**

1. Select a slot that has training data
2. Verify the contribution table still appears and rows are still clickable
