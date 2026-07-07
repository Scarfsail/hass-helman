# Inspector: Collapsible Training Table & Metric Card Colors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add colored backgrounds to metric cards (matching chart line colors, serving as legend) and make the training contribution table collapsible (collapsed by default).

**Architecture:** All changes are in one file. A module-level `CHART_COLORS` const becomes the single source of truth for chart colors used in SVG attrs and metric card backgrounds. `_renderMetric` gains an optional `color` param. A new `@state _trainingTableCollapsed` controls table visibility. CSS swatch classes stay hardcoded (Lit `static styles` can't interpolate JS consts) but coincide with `CHART_COLORS` values.

**Tech Stack:** LitElement, TypeScript, Lit html/svg templates, Vite (`npm run build-dev`)

---

## File Map

| File | Change |
|---|---|
| `src/helman-solar-inspector/helman-solar-inspector.ts` | All changes — add `CHART_COLORS` const, update SVG attrs, update `_renderMetric`, update `_renderTotals`, update `_renderSelectedSlotDetails`, add collapsible table |

No other files change.

---

## Task 1: Add `CHART_COLORS` constant and update SVG stroke/fill references

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts`

- [ ] **Step 1: Add `CHART_COLORS` before the class definition**

Find the line `type RatioBounds = ...` (around line 25). Insert the following **before** it:

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

- [ ] **Step 2: Update `_renderSolarLayer` SVG attrs**

Find `_renderSolarLayer` (around line 726). Replace all hardcoded hex strings in that method's `return svg\`` block:

- `stroke="#64748b"` → `stroke=${CHART_COLORS.raw}`
- `fill="#64748b"` → `fill=${CHART_COLORS.raw}`
- `stroke="#2563eb"` → `stroke=${CHART_COLORS.corrected}`
- `fill="#2563eb"` → `fill=${CHART_COLORS.corrected}`
- `fill="#f59e0b"` → `fill=${CHART_COLORS.actual}`

Leave `fill="#9ca3af"` (invalidated dots) as-is — invalidated is a neutral muted state, not a legend color.

- [ ] **Step 3: Update `_renderHouseLayer` SVG attrs**

Find `_renderHouseLayer`. Replace:
- `stroke="#a855f7"` → `stroke=${CHART_COLORS.house}` (both occurrences: dashed forecast and solid actual)

- [ ] **Step 4: Update `_renderBatteryLayer` SVG attrs**

Find `_renderBatteryLayer`. Replace:
- `stroke="#14b8a6"` → `stroke=${CHART_COLORS.battery}` (both occurrences)

- [ ] **Step 5: Update `_renderChartBackground` defs**

Find `_renderChartBackground`. The `<defs>` block has two patterns. Replace:
- Both `fill="#16a34a"` → `fill=${CHART_COLORS.impactPositive}`
- Both `stroke="#16a34a"` → `stroke=${CHART_COLORS.impactPositive}`
- Both `fill="#dc2626"` → `fill=${CHART_COLORS.impactNegative}`
- Both `stroke="#dc2626"` → `stroke=${CHART_COLORS.impactNegative}`

- [ ] **Step 6: Update `_renderImpactStrip` defs and bar fills**

Find `_renderImpactStrip`. It has the same `<defs>` block (duplicate of the one in `_renderChartBackground`). Apply the same replacements as Step 5. Also update the `fill` variables computed for each bar:

```ts
const fill = untrained
  ? "#9ca3af"
  : interpolated
    ? positive ? "url(#impact-interpolated-positive)" : "url(#impact-interpolated-negative)"
    : positive ? CHART_COLORS.impactPositive : CHART_COLORS.impactNegative;
```

- [ ] **Step 7: Update `_renderImpactColumns` bar fills**

Find `_renderImpactColumns` (around line 887). Apply the same fill variable update:

```ts
const fill = untrained
  ? "#9ca3af"
  : interpolated
    ? positive
      ? "url(#impact-interpolated-positive)"
      : "url(#impact-interpolated-negative)"
    : positive
      ? CHART_COLORS.impactPositive
      : CHART_COLORS.impactNegative;
```

Also update the `strokeColor` computed value in the same method (the selected stroke color references `#16a34a` / `#dc2626` — replace those too):

```ts
const strokeColor = selected
  ? "var(--primary-text-color)"
  : untrained
    ? "#9ca3af"
    : interpolated
      ? positive ? CHART_COLORS.impactPositive : CHART_COLORS.impactNegative
      : "transparent";
```

- [ ] **Step 8: Verify build**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "refactor(solar-inspector): centralize chart colors in CHART_COLORS const"
```

---

## Task 2: Update `_renderMetric` to accept and apply a color

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts` — `_renderMetric` method (around line 1057)

- [ ] **Step 1: Replace `_renderMetric`**

Find and replace the existing method:

```ts
private _renderMetric(label: string, value: string) {
  return html`
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
    </div>
  `;
}
```

with:

```ts
private _renderMetric(label: string, value: string, color?: string) {
  return html`
    <div class="metric-card" style=${color ? `background: color-mix(in srgb, ${color} 15%, transparent);` : ""}>
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
    </div>
  `;
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: no errors. No visual change yet (no callers pass color yet).

- [ ] **Step 3: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): add optional color background to metric cards"
```

---

## Task 3: Colorize metric cards in `_renderTotals`

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts` — `_renderTotals` method (around line 996)

- [ ] **Step 1: Replace `_renderTotals`**

Find and replace the existing method:

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

with:

```ts
private _renderTotals(payload: InspectorPayload) {
  return html`
    <div class="metrics-section">
      <strong>${this._t("bias_correction.inspector.daily_totals")}</strong>
      <div class="metric-grid">
        ${this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(payload.totals.rawWh), CHART_COLORS.raw)}
        ${this._renderMetric(this._t("bias_correction.inspector.corrected_forecast"), this._formatWh(payload.totals.correctedWh), CHART_COLORS.corrected)}
        ${this._renderMetric(this._t("bias_correction.inspector.actual_production"), this._formatWh(payload.totals.actualWh), CHART_COLORS.actual)}
        ${this._renderMetric(this._t("bias_correction.inspector.house_forecast"), this._formatWh(payload.totals.houseForecastWh), CHART_COLORS.house)}
        ${this._renderMetric(this._t("bias_correction.inspector.house_actual"), this._formatWh(payload.totals.houseActualWh), CHART_COLORS.house)}
      </div>
    </div>
  `;
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): colorize daily totals metric cards by chart line color"
```

---

## Task 4: Colorize metric cards in `_renderSelectedSlotDetails`

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts` — `_renderSelectedSlotDetails` method (around line 1011)

The correction impact and factor cards get green or red based on the selected slot's `impactWh` sign. Compute `impactColor` once at the top of the method and pass it to both.

- [ ] **Step 1: Replace the metric-grid block inside `_renderSelectedSlotDetails`**

Find the `<div class="metric-grid wide">` block inside `_renderSelectedSlotDetails` (starting after the `interpolated` note block) and replace it with:

```ts
const impactColor = (impact?.impactWh ?? null) === null
  ? undefined
  : (impact!.impactWh! >= 0 ? CHART_COLORS.impactPositive : CHART_COLORS.impactNegative);
```

Add this `const impactColor` line at the top of the `_renderSelectedSlotDetails` method body, after the existing `const` declarations (after `const batterySocAc = ...` and `const interpolated = ...`). Then update the `metric-grid` div:

```ts
<div class="metric-grid wide">
  ${this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(raw?.valueWh ?? impact?.rawWh ?? null), CHART_COLORS.raw)}
  ${this._renderMetric(this._t("bias_correction.inspector.corrected_forecast"), this._formatWh(corrected?.valueWh ?? impact?.correctedWh ?? null), CHART_COLORS.corrected)}
  ${this._renderMetric(this._t("bias_correction.inspector.actual_production"), this._formatWh(actual?.valueWh ?? null), CHART_COLORS.actual)}
  ${this._renderMetric(this._t("bias_correction.inspector.correction_impact"), this._formatSignedWh(impact?.impactWh ?? null), impactColor)}
  ${this._renderMetric(this._t("bias_correction.inspector.factor"), this._formatFactor(impact?.factor ?? trainingSlot?.factor ?? null), impactColor)}
  ${this._renderMetric(this._t("bias_correction.inspector.house_forecast"), this._formatWh(houseFc?.valueWh ?? null), CHART_COLORS.house)}
  ${this._renderMetric(this._t("bias_correction.inspector.house_actual"), this._formatWh(houseAc?.valueWh ?? null), CHART_COLORS.house)}
  ${this._renderMetric(this._t("bias_correction.inspector.battery_soc_forecast"), this._formatPct(batterySocFc?.pct ?? null), CHART_COLORS.battery)}
  ${this._renderMetric(this._t("bias_correction.inspector.battery_soc_actual"), this._formatPct(batterySocAc?.pct ?? null), CHART_COLORS.battery)}
</div>
```

- [ ] **Step 2: Verify build**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): colorize selected slot metric cards by chart line color"
```

---

## Task 5: Collapsible training contribution table

**Files:**
- Modify: `src/helman-solar-inspector/helman-solar-inspector.ts`

- [ ] **Step 1: Add `_trainingTableCollapsed` state property**

Find the `@state` properties block (around line 91–96). Add after `@state() private _selectedTrainingDate`:

```ts
@state() private _trainingTableCollapsed = true;
```

- [ ] **Step 2: Reset `_trainingTableCollapsed` when a slot is selected**

Find `_selectSlot` (around line 966). Add a reset line after `this._selectedTrainingDate = ...`:

```ts
private _selectSlot(slot: string, event?: Event) {
  event?.stopPropagation();
  const previous = this._selectedSlot;
  this._selectedSlot = slot;
  this._selectedTrainingDate = this._resolveSelectedTrainingDate(slot);
  this._trainingTableCollapsed = true;
  this.requestUpdate("_selectedSlot", previous);
}
```

- [ ] **Step 3: Add CSS for the toggle button**

Find `.contribution-summary` in the static `styles` block (around line 453). Add these rules after it:

```css
.contribution-toggle {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--primary-text-color);
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  font: inherit;
  font-weight: bold;
  text-align: left;
}

.contribution-toggle-icon {
  display: inline-block;
  font-style: normal;
  transition: transform 0.2s;
  font-size: 0.7em;
  opacity: 0.7;
}

.contribution-toggle-icon.expanded {
  transform: rotate(90deg);
}
```

- [ ] **Step 4: Replace `_renderContributionTable` — header becomes toggle, table is conditional**

Find `_renderContributionTable`. Replace the `return html\`` block (from the opening `<div class="contribution-summary">` through the closing `</div>`) with:

```ts
return html`
  <div class="contribution-summary">
    <button
      class="contribution-toggle"
      aria-expanded=${!this._trainingTableCollapsed}
      @click=${() => { this._trainingTableCollapsed = !this._trainingTableCollapsed; }}
    >
      <span class="contribution-toggle-icon ${this._trainingTableCollapsed ? "" : "expanded"}">▶</span>
      ${this._t("bias_correction.inspector.training_contribution")}
    </button>
    <div class="day-state">
      ${this._tFormat("bias_correction.inspector.training_contribution_meta", {
        ratio: this._formatFactor(trainingSlot.rawRatio),
        factor: this._formatFactor(trainingSlot.factor),
      })}
    </div>
    ${interpolated
      ? html`<div class="day-state">
          ${this._tFormat("bias_correction.inspector.interpolated_meta", {
            left: anchors?.left ?? this._t("bias_correction.inspector.interpolated_anchor_zero"),
            right: anchors?.right ?? this._t("bias_correction.inspector.interpolated_anchor_zero"),
          })}
        </div>`
      : ""}
  </div>
  ${this._trainingTableCollapsed ? "" : html`
    <div class="contribution-table-wrap">
      <table class="contribution-table">
        <thead>
          <tr>
            <th>${this._t("bias_correction.inspector.date")}</th>
            <th class="numeric">${this._t("bias_correction.inspector.forecast_wh")}</th>
            <th class="numeric">${this._t("bias_correction.inspector.actual_wh")}</th>
            <th class="numeric">${this._t("bias_correction.inspector.ratio")}</th>
            <th>${this._t("bias_correction.inspector.status")}</th>
          </tr>
        </thead>
        <tbody>
          ${this._sortContributionRows(trainingSlot.rows).map((row) => {
            if (row.status === "interpolated") {
              return html`
                <tr class="contribution-row synthetic" aria-disabled="true">
                  <td>—</td>
                  <td class="numeric">—</td>
                  <td class="numeric">—</td>
                  <td class="ratio">—</td>
                  <td>${this._formatContributionStatus(row.status, row.reason)}</td>
                </tr>
              `;
            }
            const selected = row.date === selectedTrainingDate;
            const muted = row.status === "invalidated";
            const classes = [
              "contribution-row",
              selected ? "selected" : "",
              muted ? "muted" : "",
            ].filter(Boolean).join(" ");
            return html`
            <tr
              class=${classes}
              aria-selected=${selected ? "true" : "false"}
              tabindex="0"
              @click=${() => this._selectTrainingDate(row.date)}
              @keydown=${(event: KeyboardEvent) => this._handleContributionRowKeydown(event, row.date)}
            >
              <td>${row.date || "-"}</td>
              <td class="numeric">${this._formatWh(row.forecastWh)}</td>
              <td class="numeric">${this._formatWh(row.actualWh)}</td>
              <td class="ratio">${muted ? this._formatFactor(row.ratio) : this._renderRatioGauge(row.ratio, ratioBounds)}</td>
              <td>${this._formatContributionStatus(row.status, row.reason)}</td>
            </tr>
          `;})}
        </tbody>
      </table>
    </div>
  `}
`;
```

- [ ] **Step 5: Verify build**

```bash
npm run build-dev 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/helman-solar-inspector/helman-solar-inspector.ts
git commit -m "feat(solar-inspector): make training contribution table collapsible, collapsed by default"
```

---

## Task 6: Manual verification

- [ ] Deploy `dist/helman-card-dev.js` to your HA dev environment and reload the browser.

- [ ] Open the solar inspector. Verify: daily totals cards have soft colored backgrounds (gray-blue for raw, blue for corrected, amber for actual, purple for house forecast/actual).

- [ ] Select a slot. Verify: slot detail cards are colored. Correction impact and factor cards are green (positive impact) or red (negative impact).

- [ ] Verify: the training contribution section shows a "▶ Training contribution" toggle button. Table is hidden by default.

- [ ] Click the toggle. Verify: table expands, icon rotates to ▼.

- [ ] Select a different slot. Verify: table collapses again (reset to default).

- [ ] Verify no regression: contribution table rows are still clickable and the ratio gauge renders correctly when expanded.
