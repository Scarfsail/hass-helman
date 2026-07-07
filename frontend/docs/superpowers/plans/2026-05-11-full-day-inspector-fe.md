# Full Day Inspector — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `helman-solar-inspector` from a solar-bias-only view into a per-day full inspector that also shows forecasted vs actual house consumption, actual battery SoC, and future-only battery SoC forecast. Move the per-slot correction-impact bars from the main plot into a thin strip below.

**Architecture:** All work is local to `src/helman-solar-inspector/`. The card consumes the extended `helman/solar_bias/inspector` payload (see BE plan) without endpoint changes. The chart becomes a single SVG with dual Y-axis (left kW, right SoC %); the impact strip is a sibling SVG below it sharing the same x-mapping. Existing slot-selection state and helpers are reused; new finder helpers + types are added to `solar-inspector-model.ts`.

**Tech Stack:** TypeScript, Lit, Vite, SVG.

**Cross-references:**
- Design spec: `../specs/2026-05-11-full-day-inspector-design.md`
- BE plan (producer of the payload): `../../../../hass-helman/docs/superpowers/plans/2026-05-11-full-day-inspector-be.md`

**Payload field names (must match BE):**

```
series.houseForecast: { timestamp: string; valueWh: number }[]
series.houseActual:   { timestamp: string; valueWh: number }[]
series.batterySocForecast: { slot: string; pct: number }[]   // future only
series.batterySocActual:   { slot: string; pct: number }[]
totals.houseForecastWh: number | null
totals.houseActualWh:   number | null
availability.hasHouseForecast:    boolean
availability.hasHouseActual:      boolean
availability.hasBatterySocForecast: boolean
availability.hasBatterySocActual:   boolean
```

---

## File map

**Modified files:**
- `src/helman-solar-inspector/solar-inspector-model.ts` — add types (`BatterySocPoint`) + finder helpers.
- `src/helman-solar-inspector/helman-solar-inspector.ts` — extend `InspectorPayload`, add chart layers (house + battery), dual Y-axis, impact strip extraction, legend grouping, metric grid extension.
- `src/localize/translations/cs.json` — add new translation keys for legend items, metric labels, and tooltips.

**No new files.** The card stays one component; the chart is refactored into private methods within the same class.

---

## Task 1: Extend model types and finder helpers

**Files:**
- Modify: `src/helman-solar-inspector/solar-inspector-model.ts`

- [ ] **Step 1: Add `BatterySocPoint` type and finder helpers**

Append to `solar-inspector-model.ts`:

```ts
export type BatterySocPoint = { slot: string; pct: number };

export function findHouseForecastForSlot(
  points: InspectorPoint[],
  slot: string | null,
): InspectorPoint | null {
  return findPointForSlot(points, slot);
}

export function findHouseActualForSlot(
  points: InspectorPoint[],
  slot: string | null,
): InspectorPoint | null {
  return findPointForSlot(points, slot);
}

export function findBatterySocForecastForSlot(
  points: BatterySocPoint[],
  slot: string | null,
): BatterySocPoint | null {
  if (!slot) return null;
  return points.find((p) => p.slot === slot) ?? null;
}

export function findBatterySocActualForSlot(
  points: BatterySocPoint[],
  slot: string | null,
): BatterySocPoint | null {
  if (!slot) return null;
  return points.find((p) => p.slot === slot) ?? null;
}
```

(The two house finders wrap `findPointForSlot` so the call sites in the card read symmetrically with the battery ones.)

- [ ] **Step 2: Commit**

```bash
git add src/helman-solar-inspector/solar-inspector-model.ts
git commit -m "feat(solar-inspector): add battery SoC point type and finder helpers"
```

---

## Task 2: Extend `InspectorPayload` type in the card

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts`

- [ ] **Step 1: Extend the `InspectorPayload` type at the top of the file**

Update `InspectorPayload` (currently `helman-solar-inspector.ts:22-57`):

```ts
type InspectorPayload = {
  date: string;
  timezone: string;
  status: string;
  effectiveVariant: string | null;
  trainedAt: string | null;
  range: { /* unchanged */ };
  series: {
    raw: InspectorPoint[];
    corrected: InspectorPoint[];
    actual: InspectorPoint[];
    invalidated: InspectorPoint[];
    factors: FactorPoint[];
    impact: ImpactPoint[];
    houseForecast: InspectorPoint[];
    houseActual: InspectorPoint[];
    batterySocForecast: BatterySocPoint[];
    batterySocActual: BatterySocPoint[];
  };
  totals: {
    rawWh: number | null;
    correctedWh: number | null;
    actualWh: number | null;
    houseForecastWh: number | null;
    houseActualWh: number | null;
  };
  availability: {
    hasRawForecast: boolean;
    hasCorrectedForecast: boolean;
    hasActuals: boolean;
    hasInvalidated: boolean;
    hasProfile: boolean;
    hasHouseForecast: boolean;
    hasHouseActual: boolean;
    hasBatterySocForecast: boolean;
    hasBatterySocActual: boolean;
  };
  trainingExplainability: TrainingExplainability | null;
};
```

Import `BatterySocPoint` at the top:

```ts
import {
  // existing imports...
  type BatterySocPoint,
} from "./solar-inspector-model.js";
```

- [ ] **Step 2: Build and verify type-check**

```bash
npm run build-dev
```

Expected: succeeds (BE may not yet emit fields, but card is permissive on missing arrays — we'll defend that in Task 3).

- [ ] **Step 3: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): extend InspectorPayload with house and battery fields"
```

---

## Task 3: Defensive defaults for missing fields

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts::_load`

- [ ] **Step 1: Normalize the payload right after fetch**

In `_load` (around `helman-solar-inspector.ts:899`), after `const payload = await this.hass.callWS<InspectorPayload>(...)`, normalize so missing fields default to empty arrays / false:

```ts
payload.series.houseForecast ??= [];
payload.series.houseActual ??= [];
payload.series.batterySocForecast ??= [];
payload.series.batterySocActual ??= [];
payload.totals.houseForecastWh ??= null;
payload.totals.houseActualWh ??= null;
payload.availability.hasHouseForecast ??= false;
payload.availability.hasHouseActual ??= false;
payload.availability.hasBatterySocForecast ??= false;
payload.availability.hasBatterySocActual ??= false;
```

- [ ] **Step 2: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "fix(solar-inspector): default new payload fields when BE omits them"
```

---

## Task 4: Refactor `_renderChart` into per-layer methods

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts::_renderChart`

This is a pure refactor; no visual change. It prepares for the next tasks.

- [ ] **Step 1: Extract pure helpers**

Inside the class, split `_renderChart` into:

```ts
private _renderChart(payload: InspectorPayload) {
  const layout = this._computeChartLayout(payload);
  return svg`
    <svg viewBox="0 0 ${layout.width} ${layout.height}"
         role="img"
         aria-label=${this._t("bias_correction.inspector.title")}
         @click=${() => this._deselectSlot()}>
      ${this._renderChartBackground(layout)}
      ${this._renderLeftAxis(layout)}
      ${this._renderXAxis(layout)}
      ${this._renderSolarLayer(payload, layout)}
    </svg>
  `;
}
```

Where `ChartLayout` is:

```ts
type ChartLayout = {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  plotWidth: number;
  plotHeight: number;
  maxKw: number;
  yTicks: number[];
  xForMinutes: (m: number) => number;
  yForW: (w: number) => number;
};
```

Move the existing y-tick / x-tick / axis label / line-path / impact-column rendering into the corresponding `_render*` methods, preserving exact pixel positions and visuals.

- [ ] **Step 2: Build + verify visually**

```bash
npm run build-dev
```

Open the card in HA, check the chart looks identical to before.

- [ ] **Step 3: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "refactor(solar-inspector): split _renderChart into per-layer methods"
```

---

## Task 5: Add house consumption layer (left axis, kW)

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts`

- [ ] **Step 1: Include house Wh values in the left-axis maxKw computation**

In `_computeChartLayout`, after the existing `allPower` array, append:

```ts
const houseForecastPower = toAveragePower(payload.series.houseForecast, { bucketMinutes: 15 });
const houseActualPower = toAveragePower(payload.series.houseActual, { bucketMinutes: 15 });
const allPower = [
  ...rawPoints.map((e) => e.powerW),
  ...correctedPoints.map((e) => e.powerW),
  ...actualPoints.map((e) => e.powerW),
  ...invalidatedPoints.map((e) => e.powerW),
  ...houseForecastPower.map((e) => e.powerW),
  ...houseActualPower.map((e) => e.powerW),
];
```

- [ ] **Step 2: Add `_renderHouseLayer`**

```ts
private _renderHouseLayer(payload: InspectorPayload, layout: ChartLayout) {
  if (!payload.availability.hasHouseForecast && !payload.availability.hasHouseActual) {
    return "";
  }
  const fc = toAveragePower(payload.series.houseForecast, { bucketMinutes: 15 });
  const ac = toAveragePower(payload.series.houseActual, { bucketMinutes: 15 });
  const path = (points: ChartEntry[]) =>
    points.map((e, i) =>
      `${i === 0 ? "M" : "L"}${layout.xForMinutes(e.minutes).toFixed(1)},${layout.yForW(e.powerW).toFixed(1)}`,
    ).join(" ");
  return svg`
    ${fc.length > 1 ? svg`<path d=${path(fc)} fill="none" stroke="#a855f7" stroke-width="2" stroke-dasharray="4 3"></path>` : ""}
    ${ac.length > 1 ? svg`<path d=${path(ac)} fill="none" stroke="#a855f7" stroke-width="2"></path>` : ""}
  `;
}
```

- [ ] **Step 3: Wire it into `_renderChart`**

Add `${this._renderHouseLayer(payload, layout)}` after `${this._renderSolarLayer(payload, layout)}`.

- [ ] **Step 4: Build + verify**

```bash
npm run build-dev
```

Load the card, check that on a day with house data, two purple lines appear (dashed = forecast, solid = actual) sharing the kW axis.

- [ ] **Step 5: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): render house consumption forecast and actual lines"
```

---

## Task 6: Add battery SoC layer with right-side Y-axis (%)

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts`

- [ ] **Step 1: Extend `ChartLayout` and compute right-axis mapping**

```ts
type ChartLayout = {
  // ... existing fields
  hasSocAxis: boolean;
  yForPct: (pct: number) => number;
};
```

In `_computeChartLayout`:

```ts
const hasSocAxis =
  payload.availability.hasBatterySocForecast ||
  payload.availability.hasBatterySocActual;
const yForPct = (pct: number) =>
  margin.top + plotHeight - (Math.max(0, Math.min(100, pct)) / 100) * plotHeight;
```

- [ ] **Step 2: Add `_renderRightAxis` for SoC %**

```ts
private _renderRightAxis(layout: ChartLayout) {
  if (!layout.hasSocAxis) return "";
  const ticks = [0, 25, 50, 75, 100];
  const xRight = layout.width - layout.margin.right;
  return ticks.map((pct) => {
    const y = layout.yForPct(pct);
    return svg`
      <text x=${xRight + 6} y=${y + 4} text-anchor="start"
            fill="var(--secondary-text-color)" font-size="11"
            opacity="0.75">${pct}%</text>
    `;
  });
}
```

(Right margin needs to grow to accommodate labels — bump `margin.right` from 24 to 40 when `hasSocAxis`.)

- [ ] **Step 3: Add `_renderBatteryLayer`**

```ts
private _renderBatteryLayer(payload: InspectorPayload, layout: ChartLayout) {
  if (!layout.hasSocAxis) return "";
  const fc = payload.series.batterySocForecast;
  const ac = payload.series.batterySocActual;
  const slotToMinutes = (slot: string) => {
    const m = /^(\d{2}):(\d{2})$/.exec(slot);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const path = (pts: BatterySocPoint[]) => {
    const valid = pts
      .map((p) => ({ m: slotToMinutes(p.slot), pct: p.pct }))
      .filter((p): p is { m: number; pct: number } => p.m !== null);
    return valid
      .map((p, i) =>
        `${i === 0 ? "M" : "L"}${layout.xForMinutes(p.m).toFixed(1)},${layout.yForPct(p.pct).toFixed(1)}`,
      )
      .join(" ");
  };
  return svg`
    ${fc.length > 1 ? svg`<path d=${path(fc)} fill="none" stroke="#14b8a6" stroke-width="2" stroke-dasharray="4 3"></path>` : ""}
    ${ac.length > 1 ? svg`<path d=${path(ac)} fill="none" stroke="#14b8a6" stroke-width="2"></path>` : ""}
  `;
}
```

- [ ] **Step 4: Wire layers in `_renderChart`**

```ts
${this._renderRightAxis(layout)}
${this._renderBatteryLayer(payload, layout)}
```

- [ ] **Step 5: Build + verify**

```bash
npm run build-dev
```

Load card on a day with battery SoC data. Teal lines should appear (dashed for future forecast, solid for actual). Right-side axis labels show 0/25/50/75/100%.

- [ ] **Step 6: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): render battery SoC with right-side % axis"
```

---

## Task 7: Move impact bars to a strip below the main chart

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts`

- [ ] **Step 1: Remove impact-column rendering from inside main SVG**

Delete the `_renderImpactColumns` call from `_renderChart` (it was inside the main `<svg>`).

- [ ] **Step 2: Add `_renderImpactStrip` rendering a sibling SVG**

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
      class="impact-strip"
      role="img"
      aria-label=${this._t("bias_correction.inspector.correction_impact")}
      @click=${() => this._deselectSlot()}
    >
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
                style="cursor: pointer;"
                @click=${(e: MouseEvent) => this._selectSlot(point.slot, e)}>
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

- [ ] **Step 3: Render the strip in `_renderContent`**

Where `_renderChart` is invoked (inside `_renderContent`), wrap them:

```ts
<div class="chart-wrap">${this._renderChart(payload)}</div>
<div class="impact-strip-wrap">${this._renderImpactStrip(payload, this._lastLayoutForStrip)}</div>
```

To pass layout to the strip, cache it on the component:

```ts
@state() private _lastLayoutForStrip!: ChartLayout;
```

And in `_renderChart`, after computing `layout`:

```ts
this._lastLayoutForStrip = layout;
```

(Cleaner alternative: derive a fresh layout in `_renderImpactStrip` using `_chartWidth`. Use whichever the maintainer prefers — both compile.)

- [ ] **Step 4: Add styles for `.impact-strip-wrap`**

In the `static styles` block:

```css
.impact-strip-wrap {
  margin-top: 4px;
  width: 100%;
}
.impact-strip-wrap svg {
  display: block;
  width: 100%;
  min-width: 360px;
  height: 24px;
}
```

- [ ] **Step 5: Build + verify**

```bash
npm run build-dev
```

Main chart now lacks the tall impact columns; a thin strip below shows them instead. Clicking a strip bar still selects the slot and highlights the bar's outline. Clicking the strip background deselects.

- [ ] **Step 6: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): move correction impact bars to strip below chart"
```

---

## Task 8: Group the legend by series family

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts::_renderLegend`

- [ ] **Step 1: Replace flat legend with grouped layout**

```ts
private _renderLegend(payload: InspectorPayload) {
  return html`
    <div class="legend grouped">
      ${this._renderLegendGroup(this._t("bias_correction.inspector.legend.solar"), [
        payload.availability.hasRawForecast
          ? html`<span class="legend-item"><span class="swatch raw"></span>${this._t("bias_correction.inspector.raw_forecast")}</span>` : null,
        payload.availability.hasCorrectedForecast
          ? html`<span class="legend-item"><span class="swatch corrected"></span>${this._t("bias_correction.inspector.corrected_forecast")}</span>` : null,
        payload.availability.hasActuals
          ? html`<span class="legend-item"><span class="dot"></span>${this._t("bias_correction.inspector.actual_production")}</span>` : null,
        payload.availability.hasInvalidated
          ? html`<span class="legend-item"><span class="dot invalidated"></span>${this._t("bias_correction.inspector.invalidated_production")}</span>` : null,
      ])}
      ${this._renderLegendGroup(this._t("bias_correction.inspector.legend.house"), [
        payload.availability.hasHouseForecast
          ? html`<span class="legend-item"><span class="swatch house-forecast"></span>${this._t("bias_correction.inspector.house_forecast")}</span>` : null,
        payload.availability.hasHouseActual
          ? html`<span class="legend-item"><span class="swatch house-actual"></span>${this._t("bias_correction.inspector.house_actual")}</span>` : null,
      ])}
      ${this._renderLegendGroup(this._t("bias_correction.inspector.legend.battery"), [
        payload.availability.hasBatterySocForecast
          ? html`<span class="legend-item"><span class="swatch battery-forecast"></span>${this._t("bias_correction.inspector.battery_soc_forecast")}</span>` : null,
        payload.availability.hasBatterySocActual
          ? html`<span class="legend-item"><span class="swatch battery-actual"></span>${this._t("bias_correction.inspector.battery_soc_actual")}</span>` : null,
      ])}
      ${payload.series.impact.length
        ? this._renderLegendGroup(this._t("bias_correction.inspector.legend.correction"), [
            html`<span class="legend-item"><span class="impact-swatch positive"></span>${this._t("bias_correction.inspector.positive_impact")}</span>`,
            html`<span class="legend-item"><span class="impact-swatch negative"></span>${this._t("bias_correction.inspector.negative_impact")}</span>`,
            this._hasInterpolatedSlots(payload)
              ? html`<span class="legend-item"><span class="impact-swatch interpolated"></span>${this._t("bias_correction.inspector.interpolated_label")}</span>` : null,
            this._hasUntrainedSlots(payload)
              ? html`<span class="legend-item"><span class="impact-swatch untrained"></span>${this._t("bias_correction.inspector.untrained_label")}</span>` : null,
          ])
        : ""}
    </div>
  `;
}

private _renderLegendGroup(title: string, items: Array<unknown>) {
  const visible = items.filter((x) => x);
  if (!visible.length) return "";
  return html`
    <div class="legend-group">
      <span class="legend-group-title">${title}</span>
      ${visible}
    </div>
  `;
}
```

- [ ] **Step 2: Add CSS for the new groups and swatches**

In `static styles`:

```css
.legend.grouped {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 6px 14px;
  row-gap: 4px;
}
.legend-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.legend-group-title {
  font-weight: 600;
  color: var(--primary-text-color);
  font-size: 0.78rem;
  margin-right: 4px;
}
.swatch.house-forecast { color: #a855f7; background: repeating-linear-gradient(90deg, #a855f7 0 4px, transparent 4px 7px); }
.swatch.house-actual { color: #a855f7; }
.swatch.battery-forecast { color: #14b8a6; background: repeating-linear-gradient(90deg, #14b8a6 0 4px, transparent 4px 7px); }
.swatch.battery-actual { color: #14b8a6; }
```

- [ ] **Step 3: Build + visual check**

```bash
npm run build-dev
```

- [ ] **Step 4: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): group legend by series family"
```

---

## Task 9: Extend totals row with house values

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts::_renderTotals`

- [ ] **Step 1: Replace the placeholder cells with house metrics**

```ts
private _renderTotals(payload: InspectorPayload) {
  return html`
    <div class="metrics-section">
      <strong>${this._t("bias_correction.inspector.daily_totals")}</strong>
      <div class="metric-grid">
        ${this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(payload.totals.rawWh))}
        ${this._renderMetric(this._t("bias_correction.inspector.corrected_forecast"), this._formatWh(payload.totals.correctedWh))}
        ${this._renderMetric(this._t("bias_correction.inspector.actual_production"), this._formatWh(payload.totals.actualWh))}
        ${this._renderMetric(this._t("bias_correction.inspector.house_forecast"), this._formatWh(payload.totals.houseForecastWh))}
        ${this._renderMetric(this._t("bias_correction.inspector.house_actual"), this._formatWh(payload.totals.houseActualWh))}
      </div>
    </div>
  `;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): show house totals in daily totals row"
```

---

## Task 10: Extend selected slot details with house + battery cells

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts::_renderSelectedSlotDetails`

- [ ] **Step 1: Add four new metric cells**

After the existing 5 metric cells, add:

```ts
import {
  // existing
  findHouseForecastForSlot,
  findHouseActualForSlot,
  findBatterySocForecastForSlot,
  findBatterySocActualForSlot,
} from "./solar-inspector-model.js";
```

In `_renderSelectedSlotDetails`, after computing `actual`/`trainingSlot`:

```ts
const houseFc = findHouseForecastForSlot(payload.series.houseForecast, selectedSlot);
const houseAc = findHouseActualForSlot(payload.series.houseActual, selectedSlot);
const batterySocFc = findBatterySocForecastForSlot(payload.series.batterySocForecast, selectedSlot);
const batterySocAc = findBatterySocActualForSlot(payload.series.batterySocActual, selectedSlot);
```

Extend the metric grid:

```ts
<div class="metric-grid wide">
  ${this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(raw?.valueWh ?? impact?.rawWh ?? null))}
  ${this._renderMetric(this._t("bias_correction.inspector.corrected_forecast"), this._formatWh(corrected?.valueWh ?? impact?.correctedWh ?? null))}
  ${this._renderMetric(this._t("bias_correction.inspector.actual_production"), this._formatWh(actual?.valueWh ?? null))}
  ${this._renderMetric(this._t("bias_correction.inspector.correction_impact"), this._formatSignedWh(impact?.impactWh ?? null))}
  ${this._renderMetric(this._t("bias_correction.inspector.factor"), this._formatFactor(impact?.factor ?? trainingSlot?.factor ?? null))}
  ${this._renderMetric(this._t("bias_correction.inspector.house_forecast"), this._formatWh(houseFc?.valueWh ?? null))}
  ${this._renderMetric(this._t("bias_correction.inspector.house_actual"), this._formatWh(houseAc?.valueWh ?? null))}
  ${this._renderMetric(this._t("bias_correction.inspector.battery_soc_forecast"), this._formatPct(batterySocFc?.pct ?? null))}
  ${this._renderMetric(this._t("bias_correction.inspector.battery_soc_actual"), this._formatPct(batterySocAc?.pct ?? null))}
</div>
```

- [ ] **Step 2: Add `_formatPct` helper**

```ts
private _formatPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return this._t("bias_correction.inspector.actual_not_available");
  }
  return `${value.toFixed(1)} %`;
}
```

- [ ] **Step 3: Update grid CSS for wide variant**

```css
.metric-grid.wide {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
@media (max-width: 720px) {
  .metric-grid.wide { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
```

- [ ] **Step 4: Build + verify**

```bash
npm run build-dev
```

Click a slot; the detail grid now contains house and battery cells where data exists.

- [ ] **Step 5: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): include house and battery in selected slot details"
```

---

## Task 11: Add Czech translations

**Files:**
- Modify: `src/localize/translations/cs.json`

- [ ] **Step 1: Add keys**

Add under `bias_correction.inspector`:

```json
"house_forecast": "Predikce spotřeby",
"house_actual": "Skutečná spotřeba",
"battery_soc_forecast": "Predikce SoC baterie",
"battery_soc_actual": "Skutečné SoC baterie",
"correction_impact": "Vliv korekce",
"legend": {
  "solar": "Solární",
  "house": "Spotřeba",
  "battery": "Baterie",
  "correction": "Korekce"
}
```

- [ ] **Step 2: Commit**

```bash
git add src/localize/translations/cs.json
git commit -m "i18n: czech strings for full day inspector"
```

---

## Task 12: Manual end-to-end check

- [ ] **Step 1: Build production bundle**

```bash
npm run build-prod
```

- [ ] **Step 2: Reload HA frontend (Ctrl+Shift+R) and open a dashboard with the inspector card**

- [ ] **Step 3: Verify**

  - On **today**: solar lines + house lines (where data exists) + battery actual (past portion) + battery forecast (future portion) + impact strip below.
  - On a **past day**: solar lines + house lines (forecast only if recorder has it) + battery actual; no battery forecast.
  - On a **future day**: solar (forecast only) + house forecast only + battery forecast for the whole day.
  - Click a slot in the impact strip: outline appears on that slot; the detail grid populates all relevant cells; clicking elsewhere deselects.
  - Resize the card horizontally: chart and strip stay aligned on the x-axis.

---

## Self-review checklist

- [ ] All BE payload field names (`houseForecast`, `houseActual`, `batterySocForecast`, `batterySocActual`, `houseForecastWh`, `houseActualWh`, `hasHouseForecast`, `hasHouseActual`, `hasBatterySocForecast`, `hasBatterySocActual`) are referenced in the FE code exactly as written.
- [ ] Card degrades gracefully when BE omits new fields (Task 3 defaults).
- [ ] Impact bars no longer overlay the main plot.
- [ ] Right-axis labels only render when battery data is present.
- [ ] No regressions to existing solar-only inspector behavior on days with no house/battery data.
