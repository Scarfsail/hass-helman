# Analysis: Icon & Color Complexity in helman-simple and helman Cards

**Date:** 2026-03-04
**Scope:** `src/helman-simple/simple-card-*.ts`, `src/helman/power-device-icon.ts`,
`src/helman-simple/helman-simple-card.ts`, `src/helman-simple/node-detail-dialog.ts`,
`src/color-utils.ts`

---

## Summary

The icon system spans two cards and a shared set of animated components. The goal is that all four energy nodes (solar, battery, grid, house) always render using the animated `simple-card-*` components, regardless of context (main card, helman-card icon, node-detail dialog). Currently this is **not fully achieved** due to several DRY violations, one confirmed bug, and several inconsistencies.

---

## Issue 1 — BUG: `sourceType` not set in `helman-simple-card._hydrateNode`

**Files:** `src/helman-simple/helman-simple-card.ts:606`, `src/helman/helman-card.ts:177`

`helman-card._hydrateNode` sets `node.sourceType = dto.sourceType` (line 181).
`helman-simple-card._hydrateNode` does **not** set it — the property is silently omitted.

```typescript
// helman-card.ts — correct
node.isSource = dto.isSource;
node.sourceType = dto.sourceType;   // ← present

// helman-simple-card.ts — BUG
node.isSource = dto.isSource;
// node.sourceType is never set → remains undefined
```

**Consequence:** Nodes passed into the node-detail-dialog (`solarNode`, `batteryProducerNode`, `batteryConsumerNode`, `gridProducerNode`, `gridConsumerNode`) lack `sourceType`. When `power-device-icon._renderAnimatedNode()` checks `device.sourceType === 'solar'` etc., all checks fail and it falls through to `_renderDeviceIcon()`, showing the old non-animated `<ha-icon>` / `mdi:battery-XX` icon instead of the animated SVG.

This is the direct cause of the user-observed behaviour: "the helman node doesn't show the icon from helman-simple, but shows the old not animated icon."

---

## Issue 2 — DRY: Color Constants Defined in Multiple Places

**Files:** `helman-simple-card.ts:20–22`, `simple-card-solar.ts` (CSS), `simple-card-grid.ts` (CSS), `simple-card-battery.ts` (CSS)

The three semantic energy colors are declared as non-exported module-level constants in `helman-simple-card.ts`:

```typescript
const SOLAR_COLOR = '#facc15';
const GRID_COLOR  = '#38bdf8';
const BATT_COLOR  = '#22c55e';
```

The **same hex values** are hardcoded again inside the CSS `<style>` blocks of each icon component:

| Hex value   | Canonical meaning | Found duplicated in |
|-------------|-------------------|---------------------|
| `#facc15`   | Solar active      | `simple-card-solar.ts` CSS (`.core.active { fill: #facc15 }`, `.power-label.active { color: #facc15 }`) |
| `#38bdf8`   | Grid import       | `simple-card-grid.ts` CSS (`.pole.import`, `.power-label.import/export`) |
| `#22c55e`   | Battery active    | `simple-card-battery.ts` CSS (`.battery-body.active-charge/discharge`, `.fill-green`, `.power-label.charge/discharge`) |

There is no single source of truth for these colors. Changing one requires edits in at least 4 files.

---

## Issue 3 — Inconsistency: `sourceColor` Computed Differently in Two Contexts

**Files:** `helman-simple-card.ts:272–286` (render), `power-device-icon.ts:90–96`

**In `helman-simple-card.ts` (main card view):** `sourceColor` is computed from the current instantaneous power balance using `blendHex`:

```typescript
const battSourceColor = battCharge
    ? blendHex([{ hex: SOLAR_COLOR, weight: solarToBattPower }, { hex: GRID_COLOR, weight: gridToBattPower }])
    : undefined;
```

**In `power-device-icon.ts` (helman-card + dialog icons):** `sourceColor` is computed from the last bucket of `sourcePowerHistory`:

```typescript
private _computeSourceColor(): string | undefined {
    const lastBucket = history[history.length - 1];
    const entries = Object.values(lastBucket).map(({ power, color }) => ({ hex: color, weight: power }));
    return entries.some(e => e.weight > 0) ? blendHex(entries) : undefined;
}
```

The two methods use different inputs (realtime math vs. history array) and can produce different colors for the same state, causing visual inconsistency between the main card view and the dialog/helman-card icon.

Additionally, the source node `color` property (set from backend config, e.g. `src.color`) is used as the `color` field in `sourcePowerHistory` buckets, while `helman-simple-card.ts` hardcodes `SOLAR_COLOR`, `GRID_COLOR`, `BATT_COLOR`. If the backend assigns a custom color to a source node, the dialog icon will reflect it while the main card will not.

---

## Issue 4 — Inconsistency: `minSoc` Not Passed in `power-device-icon`

**Files:** `helman-simple-card.ts:322–328`, `power-device-icon.ts:139–148`

`simple-card-battery` has a `minSoc` prop that controls the low-SoC warning threshold (border turns red/orange when SoC drops below minSoc).

In the main card (`helman-simple-card.ts`), minSoc is read from an entity and passed:
```typescript
<simple-card-battery
    .power=${batteryPower}
    .soc=${batterySoc}
    .minSoc=${batteryMinSoc}    // ← entity-driven threshold
    .sourceColor=${battSourceColor}
></simple-card-battery>
```

In `power-device-icon.ts`, `minSoc` is never passed:
```typescript
<simple-card-battery
    .power=${signedPower}
    .soc=${soc}
    .sourceColor=${sourceColor}
    ?compact=${true}
    // minSoc omitted → defaults to 10 always
></simple-card-battery>
```

The battery warning threshold is hardcoded to 10% in the helman-card and dialog contexts, even if the user has configured a different minimum SoC.

---

## Issue 5 — Inconsistency: House Detection Uses Dual Condition

**File:** `power-device-icon.ts:151`

```typescript
if (device.sourceType === 'house' || device.id === 'house') {
```

All other node types (`solar`, `grid`, `battery`) check only `sourceType`. The `house` check includes an `|| device.id === 'house'` fallback, which signals that `sourceType` cannot be relied upon for the house node. This is a symptom of Issue 1 — because `helman-simple-card._hydrateNode` doesn't set `sourceType`, the fallback to `device.id` was added as a workaround. The result is an inconsistent and fragile detection pattern.

---

## Issue 6 — Dead/Conflated Code: Old Battery Icon Fallback

**File:** `power-device-icon.ts:167–190`

`_renderDeviceIcon()` still contains battery-specific logic (rendering `mdi:battery-XX` with SoC level detection):

```typescript
private _renderDeviceIcon(): TemplateResult {
    const battConfig = (this.device.deviceConfig as BatteryDeviceConfig);
    if (battConfig?.entities.capacity) {
        // ... renders mdi:battery-XX
    }
    return html`<ha-icon .icon=${this.device.icon}></ha-icon>`;
}
```

This code was the original battery icon and should be dead now that `sourceType === 'battery'` routes to `simple-card-battery`. However, because of Issue 1, it is NOT dead — hydrated nodes from `helman-simple-card` fall through to this path. The old battery icon consequently still appears in the dialog. This creates an implicit dependency between the two bugs: fixing Issue 1 would properly retire this battery fallback, but until then this code remains actively used in an unintended way.

---

## Issue 7 — DRY: `_hydrateNode` Duplicated Across Both Cards

**Files:** `helman-card.ts:177–197`, `helman-simple-card.ts:606–624`

Both cards have a near-identical `_hydrateNode(dto, historyBuckets)` private method. The two versions differ only in:

1. `helman-card` sets `node.sourceType = dto.sourceType` (helman-simple does not — the root of Issue 1)
2. `helman-card` does not accept a `historyBuckets` parameter (reads from `this._uiConfig`)

Every other line is structurally identical (15+ lines of property assignments). Any future DTO field addition must be applied in both places.

---

## Issue 8 — Minor: SVG Path IDs in `simple-card-grid` Are Not Instance-Unique

**File:** `src/helman-simple/simple-card-grid.ts:147–151`

```typescript
<defs>
    <path id="wl" d="M17,29 Q14,46 13,58"/>
    <path id="wc" d="M40,24 Q40,44 40,58"/>
    <path id="wr" d="M63,29 Q66,46 67,58"/>
</defs>
```

And referenced as:
```typescript
<mpath href="#wl"/>
<mpath href="#wc"/>
<mpath href="#wr"/>
```

`simple-card-battery` solved an analogous problem with `_clipId = 'batt-clip-' + random`. The grid component doesn't. The `href="#wl"` reference in `<animateMotion><mpath>` may resolve outside the shadow root depending on browser, potentially causing animation paths to be incorrect when multiple grid icons exist on the same page (e.g., two helman-simple-cards, or one helman-card with a grid icon plus the node-detail dialog open).

---

## Issue 9 — Minor: sourceColor Not Supplied via Props for Main Card Nodes in Dialog

**Context:** When the node-detail dialog opens, `_buildDialogParams` passes `DeviceNode` objects (`solarNode`, `batteryProducerNode`, etc.) to the dialog. The dialog renders these via `power-device` → `power-device-icon` → `_computeSourceColor()` from history.

For **source nodes** (`isSource=true`: solar producer, battery producer), `_applyHistory` explicitly skips `sourcePowerHistory` population:

```typescript
if (node.isSource) continue;  // sourcePowerHistory never filled for sources
```

`_computeSourceColor()` returns `undefined` for source nodes, so the solar/battery-discharging icons will always have no `sourceColor`. This is arguably correct (sources don't receive from other sources), but it means the battery-discharging icon will never tint its border with a color.
However, battery-charging and grid-exporting (both non-source) will correctly derive `sourceColor` from history — but only if `sourcePowerHistory` is populated, which requires Issue 1 to be fixed first.

---

## Summary Table

| Issue # | Type | Severity | File(s) | Description | Fix # |
|---------|------|----------|---------|-------------|-------|
| 1 | **Bug** | High | `helman-simple-card.ts:606` | `sourceType` not set in hydration → dialog shows old icons | Fix 1 |
| 2 | **DRY** | Medium | `helman-simple-card.ts`, `simple-card-*.ts` | Color constants duplicated in 4+ locations | Fix 2 |
| 3 | **Inconsistency** | Medium | `helman-simple-card.ts`, `power-device-icon.ts` | `sourceColor` computed from different inputs in the two cards | Fix 7 |
| 4 | **Inconsistency** | Medium | `power-device-icon.ts` | `minSoc` not passed to battery icon; always defaults to 10 | Fix 3 |
| 5 | **Inconsistency** | Low | `power-device-icon.ts:151` | House detection uses dual condition as fallback for Issue 1 | Fix 4 |
| 6 | **Dead/Conflated** | Low | `power-device-icon.ts:167` | Old battery `mdi:battery-XX` fallback still reachable due to Issue 1 | Fix 4 |
| 7 | **DRY** | Medium | `helman-card.ts:177`, `helman-simple-card.ts:606` | `_hydrateNode` duplicated across both cards | Fix 5 |
| 8 | **Minor Bug** | Low | `simple-card-grid.ts:147` | SVG path IDs `wl/wc/wr` not instance-unique (unlike battery's `_clipId`) | Fix 6 |
| 9 | **Minor** | Low | `node-detail-dialog.ts`, `power-device-icon.ts` | Source nodes never get `sourceColor` in dialog (by design, but worth noting) | — |

---

## Recommended Fixes (Not Implemented Here)

1. **(Issues 1, 5, 6) Fix missing `sourceType` in hydration** — add `node.sourceType = dto.sourceType;` to `helman-simple-card._hydrateNode`. This single line fixes the dialog icons and unblocks cleanup of Issues 5 and 6.

2. **(Issue 2) Extract a shared color module** — export `SOLAR_COLOR`, `GRID_COLOR`, `BATT_COLOR` from a single `src/helman-simple/node-colors.ts` and import in both `helman-simple-card.ts` and the simple-card components (as JS constants or CSS custom properties).

3. **(Issue 4) Pass `minSoc` in `power-device-icon`** — read `battCfg.entities.min_soc` and pass it to `simple-card-battery` (same pattern already used for `soc`).

4. **(Issues 5, 6, depends on Fix 1) Remove dead fallbacks** — remove the `|| device.id === 'house'` fallback from `power-device-icon.ts:151` and delete the battery-specific `mdi:battery-XX` logic from `_renderDeviceIcon`.

5. **(Issue 7) Extract shared `_hydrateNode`** — move to a standalone utility function in `src/helman/device-node-hydrator.ts` and import from both cards.

6. **(Issue 8) Fix grid SVG path IDs** — follow the battery `_clipId` pattern: generate unique `_wireLId`, `_wireCId`, `_wireRId` per instance.

7. **(Issue 3) Unify `sourceColor` computation on ratio sensors in both cards** — see detailed proposal below.

---

## Fix 7 — Detailed Proposal: Unified `sourceColor` from Ratio Sensors

### Problem recap

`helman-simple-card` computes `sourceColor` for its node icons from power balance math:
```typescript
// helman-simple-card.ts render()
const battSourceColor = battCharge
    ? blendHex([{ hex: SOLAR_COLOR, weight: solarToBattPower }, { hex: GRID_COLOR, weight: gridToBattPower }])
    : undefined;
```

`power-device-icon` computes it from `device.sourcePowerHistory[last]`, which is already maintained by `_advanceTree` using the ratio sensors from `hass.states`. The two approaches can diverge.

Crucially, `helman-simple-card` already maintains `sourcePowerHistory` on its consumer nodes (`_batteryConsumerNode`, `_gridConsumerNode`, `_houseNode`) via the same `_applyHistory` / `_advanceTree` machinery. The render method simply ignores this data and re-derives the same concept from scratch using power math. The fix is to use the already-computed history data instead.

### Three coordinated steps

#### Step A — Standardise the color stored in `sourcePowerHistory` buckets (both cards)

Currently both `_applyHistory` and `_advanceTree` store `src.color || 'grey'` as the color per source.
`src.color` is a backend-configured field that is often not set, collapsing to grey. The canonical colors should be derived from `src.sourceType` instead.

Add a helper to `src/color-utils.ts` (ties with Fix 2, the shared color module):

```typescript
// src/color-utils.ts
export function canonicalSourceColor(sourceType: string | null | undefined, fallback?: string): string {
    switch (sourceType) {
        case 'solar':   return SOLAR_COLOR;
        case 'grid':    return GRID_COLOR;
        case 'battery': return BATT_COLOR;
        default:        return fallback ?? '#6b7280';
    }
}
```

Replace `src.color || 'grey'` with `canonicalSourceColor(src.sourceType, src.color)` at every `sourcePowerHistory` bucket construction site:

- `helman-simple-card.ts:669` (`_applyHistory`)
- `helman-simple-card.ts:716` (`_advanceTree`)
- `helman-card.ts:277` (`_applyHistory`)
- `helman-card.ts:340` (`_advanceTree`)

This makes the colors stored in history consistent with the icon component colors and independent of backend configuration.

#### Step B — Extract `computeSourceColor` as a shared utility (both cards)

Move the logic currently private to `power-device-icon._computeSourceColor()` into `src/color-utils.ts`:

```typescript
// src/color-utils.ts
export function computeSourceColor(node: DeviceNode): string | undefined {
    const history = node.sourcePowerHistory;
    if (!history?.length) return undefined;
    const lastBucket = history[history.length - 1];
    const entries = Object.values(lastBucket).map(({ power, color }) => ({ hex: color, weight: power }));
    return entries.some(e => e.weight > 0) ? blendHex(entries) : undefined;
}
```

`power-device-icon._computeSourceColor()` becomes a one-line call to this utility.

#### Step C — Replace power balance math in `helman-simple-card` render with `computeSourceColor`

Delete the power-balance-derived `battSourceColor`, `gridSourceColor`, `houseSourceColor` variables and replace with calls to the shared utility:

```typescript
// helman-simple-card.ts render() — before
const battSourceColor = battCharge
    ? blendHex([{ hex: SOLAR_COLOR, weight: solarToBattPower }, { hex: GRID_COLOR, weight: gridToBattPower }])
    : undefined;
const gridSourceColor = ...;
const houseSourceColor = ...;

// after
const battSourceColor  = this._batteryConsumerNode ? computeSourceColor(this._batteryConsumerNode) : undefined;
const gridSourceColor  = this._gridConsumerNode    ? computeSourceColor(this._gridConsumerNode)    : undefined;
const houseSourceColor = this._houseNode           ? computeSourceColor(this._houseNode)           : undefined;
```

The flow overlay arrows (`_renderFlowOverlay`, `_flowH`, `_flowV`) continue to receive these values and remain unchanged.

### Why the latest history bucket is sufficient

`_advanceTree` runs every bucket interval and immediately overwrites `sourcePowerHistory[last]` with current `hass.states` ratio sensor readings. The staleness is bounded by the bucket duration (typically 1–60 s), the same interval at which `hass.states` itself is polled. There is no meaningful lag difference compared to the power balance math, which also reads `hass.states` indirectly via `_energy`.

### Works in helman-card too

`helman-card` already populates `sourcePowerHistory` for all consumer nodes via the same `_applyHistory` / `_advanceTree` pattern. After Step A, the colors stored there will be canonical. `power-device-icon` will continue to call `computeSourceColor(device)` (now the shared utility), reading the same data — so the icons in `helman-card` automatically pick up the unified colors.

### Tradeoff

The power balance approach in `helman-simple-card` works without ratio sensors configured (it derives contributions from the power readings alone). The ratio sensor approach produces `undefined` (no color tinting) when no ratio sensors are present. This is an acceptable regression: if ratio sensors are not configured, there is no energy-mix information available anyway, so not tinting is the correct fallback.
