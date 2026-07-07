# Implementation Proposal: Simple Node Detail Modal

**Based on:** `feasibility-analysis.md`
**Scope:** Iteration 1 — all "✅ Ready" items only. Items marked "❓ User config" or "⚠️ Minor config gap" are deferred.

---

## 1. Goal

Show a detail modal when the user taps any of the four energy node icons (Solar, Battery, Grid, House) in `helman-simple-card`. A single shared `node-detail-dialog` component handles all four node types, rendering type-specific rows from data already available in `hass.states` and `sourceConfig`.

---

## 2. Scope

### Included (Iteration 1)

| Node     | Rows included |
|----------|---------------|
| Battery  | Current power, SoC, Mode, Min SoC, Max SoC (optional), Remaining energy (optional), Time to full/empty, Target SoC & time |
| Solar    | Current power, Today's energy (optional), Remaining forecast (optional) |
| Grid     | Current power, Today's import (optional), Today's export (optional) |
| House    | Current power only |

### Deferred

- Battery today's charged/discharged kWh (needs new `BatteryDeviceConfig` fields)
- House today's energy (needs new `HouseDeviceConfig` field)

---

## 3. Component Architecture

### New file

```
src/helman-simple/node-detail-dialog.ts    ← NEW
```

### Modified file

```
src/helman-simple/helman-simple-card.ts    ← ADD click handling, DTO storage, dialog render
```

Everything else (node SVG components, API types, DeviceConfig) stays **unchanged**.

---

## 4. Data Flow

```
helman/get_device_tree
        │
        ▼
_buildEntityMap()  ──────────────────────────────────────┐
        │                                                 │
        │  stores entity IDs in EnergyEntityMap           │ also stores DTOs:
        ▼                                                 │   _solarDTO, _gridDTO,
_readEnergyValues()  →  _energy (EnergyValues)            │   _batteryDTO, _houseDTO
        │                                                 │
        ▼                                                 ▼
render()  →  node-cell @click  →  _dialogNodeType state
                                        │
                                        ▼
                             _buildDialogParams()
                              (casts DTO.sourceConfig to typed config,
                               reads current power from _energy)
                                        │
                                        ▼
                           <node-detail-dialog
                               .hass  .open  .params  .localize>
                                        │
                                        ▼
                             hass.states[entityId]
                           (read secondary entity values at render time)
```

---

## 5. Types

### `NodeType`

```typescript
export type NodeType = 'solar' | 'battery' | 'grid' | 'house';
```

### `NodeDetailParams` — discriminated union

Defined at the top of `node-detail-dialog.ts`. All entity ID fields are `string | null` (null means "not configured", row is hidden). Every params type carries the **power entity ID** so the power row is also clickable.

```typescript
export interface BatteryDetailParams {
    nodeType: 'battery';
    power: number;                       // watts, signed (positive = charging)
    powerEntityId: string | null;        // for More Info click-through
    soc: number;                         // %
    socEntityId: string | null;          // for More Info click-through
    minSoc: number;                      // %
    minSocEntityId: string | null;       // for More Info click-through
    maxSocEntityId: string | null;
    remainingEnergyEntityId: string | null;
}

export interface SolarDetailParams {
    nodeType: 'solar';
    power: number;                       // watts
    powerEntityId: string | null;        // for More Info click-through
    todayEnergyEntityId: string | null;
    forecastEntityId: string | null;
}

export interface GridDetailParams {
    nodeType: 'grid';
    power: number;                       // watts, signed (positive = importing)
    powerEntityId: string | null;        // for More Info click-through
    todayImportEntityId: string | null;
    todayExportEntityId: string | null;
}

export interface HouseDetailParams {
    nodeType: 'house';
    power: number;                       // watts
    powerEntityId: string | null;        // for More Info click-through
}

export type NodeDetailParams =
    | BatteryDetailParams
    | SolarDetailParams
    | GridDetailParams
    | HouseDetailParams;
```

---

## 6. Changes to `helman-simple-card.ts`

### 6.1 Store DTOs alongside EnergyEntityMap

Add four private fields (not `@state` — no reactivity needed, set once after backend load):

```typescript
// 3. Private properties
private _solarDTO:   DeviceNodeDTO | null = null;
private _gridDTO:    DeviceNodeDTO | null = null;
private _batteryDTO: DeviceNodeDTO | null = null;
private _houseDTO:   DeviceNodeDTO | null = null;
```

In `_buildEntityMap()` (or immediately after the `.find()` calls), assign:

```typescript
this._solarDTO   = solarNode   ?? null;
this._gridDTO    = gridNode    ?? null;
this._batteryDTO = batteryNode ?? null;
this._houseDTO   = houseNode   ?? null;
```

### 6.2 Add dialog state

```typescript
@state() private _dialogNodeType: NodeType | null = null;
```

### 6.3 Click handlers on node cells

Wrap each `.node-cell` div with `@click`. Add `cursor: pointer` to `.node-cell` in static styles.

```typescript
// In render(), change the four node-cell divs:
<div class="node-cell" @click=${() => this._dialogNodeType = 'solar'}>
    <simple-card-solar .power=${solarPower}></simple-card-solar>
</div>

<div class="node-cell" @click=${() => this._dialogNodeType = 'grid'}>
    <simple-card-grid ...></simple-card-grid>
</div>

<div class="node-cell" @click=${() => this._dialogNodeType = 'house'}>
    <simple-card-house ...></simple-card-house>
</div>

<div class="node-cell" @click=${() => this._dialogNodeType = 'battery'}>
    <simple-card-battery ...></simple-card-battery>
</div>
```

### 6.4 Build dialog params

Add private helper method. Uses both `this._energy` (current watt values) and `this._entityMap` (entity IDs for click-through):

```typescript
private _buildDialogParams(nodeType: NodeType): NodeDetailParams {
    const e = this._energy;
    const em = this._entityMap!;
    switch (nodeType) {
        case 'battery': {
            const cfg = (this._batteryDTO?.sourceConfig?.entities ?? {}) as BatteryDeviceConfig['entities'];
            return {
                nodeType: 'battery',
                power: e.batteryPower,
                powerEntityId: em.batteryPowerEntityId,
                soc: e.batterySoc,
                socEntityId: em.batterySocEntityId,
                minSoc: e.batteryMinSoc,
                minSocEntityId: em.batteryMinSocEntityId,
                maxSocEntityId: cfg.max_soc ?? null,
                remainingEnergyEntityId: cfg.remaining_energy ?? null,
            };
        }
        case 'solar': {
            const cfg = (this._solarDTO?.sourceConfig?.entities ?? {}) as SolarDeviceConfig['entities'];
            return {
                nodeType: 'solar',
                power: e.solarPower,
                powerEntityId: em.solarPowerEntityId,
                todayEnergyEntityId: cfg.today_energy ?? null,
                forecastEntityId: cfg.remaining_today_energy_forecast ?? null,
            };
        }
        case 'grid': {
            const cfg = (this._gridDTO?.sourceConfig?.entities ?? {}) as GridDeviceConfig['entities'];
            return {
                nodeType: 'grid',
                power: e.gridPower,
                powerEntityId: em.gridPowerEntityId,
                todayImportEntityId: cfg.today_import ?? null,
                todayExportEntityId: cfg.today_export ?? null,
            };
        }
        case 'house':
            return { nodeType: 'house', power: e.housePower, powerEntityId: em.housePowerEntityId };
    }
}
```

Import `BatteryDeviceConfig`, `SolarDeviceConfig`, `GridDeviceConfig` from `../helman/DeviceConfig`.

### 6.5 Render dialog

Add at the bottom of `render()` (inside `ha-card`, after the energy-grid div):

```typescript
import "./node-detail-dialog"; // at top of file

// In render():
${this._dialogNodeType !== null ? html`
    <node-detail-dialog
        .hass=${this._hass!}
        .localize=${this._localize!}
        .open=${true}
        .params=${this._buildDialogParams(this._dialogNodeType)}
        @closed=${() => { this._dialogNodeType = null; }}
    ></node-detail-dialog>
` : ''}
```

---

## 7. `node-detail-dialog.ts` Design

### 7.1 Component skeleton

Follow the 13-step LitElement structural pattern from the project conventions.

```typescript
@customElement("node-detail-dialog")
export class NodeDetailDialog extends LitElement {
    // 2. Static styles
    static styles = css`...`;

    // 4. Public properties
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: NodeDetailParams;
    @property({ type: Boolean }) public open = false;

    // 10. Render method
    render() {
        if (!this.open || !this.params) return nothing;
        return html`
            <ha-dialog
                .open=${this.open}
                @closed=${this._onClosed}
                .heading=${this._title()}
            >
                <div class="content">
                    ${this._renderContent()}
                </div>
                <mwc-button slot="primaryAction" @click=${this._close}>
                    Close
                </mwc-button>
            </ha-dialog>
        `;
    }

    // 12. Private helpers
    private _title(): string { ... }
    private _renderContent(): TemplateResult { ... }
    private _renderBattery(p: BatteryDetailParams): TemplateResult { ... }
    private _renderSolar(p: SolarDetailParams): TemplateResult { ... }
    private _renderGrid(p: GridDetailParams): TemplateResult { ... }
    private _renderHouse(p: HouseDetailParams): TemplateResult { ... }
    private _close() { this.dispatchEvent(new CustomEvent('closed', { bubbles: true, composed: true })); }
    private _onClosed() { this._close(); }
    private _showMoreInfo(entityId: string | null) {
        if (!entityId) return;
        this.dispatchEvent(new CustomEvent('hass-more-info', {
            bubbles: true,
            composed: true,
            detail: { entityId },
        }));
    }
    private _readState(entityId: string | null): HassEntity | null { ... }
    private _readKWh(entityId: string | null): number | null { ... }
}
```

### 7.2 `ha-dialog` usage

`ha-dialog` is globally registered by HA at runtime — no import needed. Key attributes:

| Attribute | Value |
|-----------|-------|
| `.open` | boolean property |
| `.heading` | title string |
| `@closed` | fires when dialog closes (backdrop click or ESC) |

Slot `primaryAction` for the close button.

### 7.3 Content rows

Use a simple `.detail-row` layout (label on left, value on right). Rows that have an associated entity ID get the `.clickable` class — clicking fires `hass-more-info` for that entity. Rows with derived values (Mode, Remaining time) are **not** clickable.

```css
.content {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 240px;
    padding: 8px 0;
}
.detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
}
.detail-row.clickable {
    cursor: pointer;
    border-radius: 4px;
    padding: 2px 4px;
    margin: 0 -4px;
}
.detail-row.clickable:hover {
    background: var(--secondary-background-color);
}
.label {
    color: var(--secondary-text-color);
    font-size: 0.9rem;
}
.value {
    font-weight: 600;
    font-size: 0.9rem;
}
.section-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--secondary-text-color);
    letter-spacing: 0.05em;
    margin-top: 4px;
}
```

**Clickable row template pattern:**

```typescript
// Entity row — clickable
html`<div class="detail-row clickable" @click=${() => this._showMoreInfo(entityId)}>
    <span class="label">Label</span>
    <span class="value">value</span>
</div>`

// Derived row — not clickable
html`<div class="detail-row">
    <span class="label">Mode</span>
    <span class="value">Charging</span>
</div>`
```

### 7.4 Battery content rows

`[C]` = clickable (fires `hass-more-info`); `[-]` = derived value, not clickable.

```
[-] [Mode]            Charging / Discharging / Idle
[C] [Power]           ↑ 2.3 kW  (or ↓ for discharge) — clicks powerEntityId
[C] [State of Charge] 74%        — clicks socEntityId
[C] [Min SoC]         10%        — clicks minSocEntityId
[C] [Max SoC]         90%        — clicks maxSocEntityId   (hidden if null)
[C] [Remaining]       5.2 kWh   — clicks remainingEnergyEntityId (hidden if null)
── ETA ──  (entire section hidden if no ETA sensor or not charging/discharging)
[C] [Target SoC]      100%       — clicks the well-known ETA sensor ID
[C] [Target time]     14:30      — clicks the well-known ETA sensor ID
[-] [Remaining time]  2:15       — derived from sensor.state minutes
```

Battery time-to-full/empty: read directly from well-known IDs exactly as `power-device-info.ts` does:
- `sensor.helman_battery_time_to_empty` when discharging (power < -50)
- `sensor.helman_battery_time_to_full` when charging (power > 50)

Attributes used: `target_time`, `target_soc`. The well-known sensor ID itself is used as the `entityId` for the ETA rows' More Info click.

### 7.5 Solar content rows

```
[C] [Power]    3.4 kW    — clicks powerEntityId
[C] [Today]    12.3 kWh  — clicks todayEnergyEntityId   (hidden if null)
[C] [Forecast] 4.1 kWh   — clicks forecastEntityId      (hidden if null)
```

Use `convertToKWh` + `getDisplayEnergyUnit` from `../helman/energy-unit-converter`.

### 7.6 Grid content rows

```
[C] [Power]          ← 1.2 kW / → 0.8 kW  — clicks powerEntityId
[C] [Today imported] 8.4 kWh               — clicks todayImportEntityId (hidden if null)
[C] [Today exported] 2.1 kWh               — clicks todayExportEntityId (hidden if null)
```

### 7.7 House content rows

```
[C] [Power]   2.1 kW  — clicks powerEntityId
```

(All other house details are deferred to iteration 2.)

### 7.8 Row helper

All rows follow the same "show if entity exists and has a parseable value, hide otherwise" pattern:

```typescript
private _readState(entityId: string | null): HassEntity | null {
    if (!entityId) return null;
    const state = this.hass.states[entityId];
    return state ?? null;
}

private _readKWh(entityId: string | null): number | null {
    const state = this._readState(entityId);
    if (!state) return null;
    const raw = parseFloat(state.state);
    if (isNaN(raw)) return null;
    return convertToKWh(raw, state.attributes.unit_of_measurement);
}
```

---

## 8. Localization

### 8.1 Approach

The `node-detail-dialog` receives a `localize: LocalizeFunction` property from `helman-simple-card`, which already creates this function in its `hass` setter via `getLocalizeFunction(value)`. The dialog imports `LocalizeFunction` from `../localize/localize` (type-only import). All user-visible strings in the dialog use `this.localize('key')`.

### 8.2 New localization keys

All new keys live under the `node_detail` namespace. Czech translations are added to `src/localize/translations/cs.json`.

**Titles**

| Key | Czech |
|-----|-------|
| `node_detail.title.solar` | `Solární panely` |
| `node_detail.title.battery` | `Baterie` |
| `node_detail.title.grid` | `Síť` |
| `node_detail.title.house` | `Dům` |

**Battery rows**

| Key | Czech |
|-----|-------|
| `node_detail.battery.mode` | `Režim` |
| `node_detail.battery.mode_charging` | `Nabíjení` |
| `node_detail.battery.mode_discharging` | `Vybíjení` |
| `node_detail.battery.mode_idle` | `Nečinnost` |
| `node_detail.battery.power` | `Výkon` |
| `node_detail.battery.soc` | `Nabití` |
| `node_detail.battery.min_soc` | `Min. nabití` |
| `node_detail.battery.max_soc` | `Max. nabití` |
| `node_detail.battery.remaining_energy` | `Zbývající energie` |
| `node_detail.battery.eta_section` | `Předpověď` |
| `node_detail.battery.target_soc` | `Cílové nabití` |
| `node_detail.battery.target_time` | `Čas dosažení` |
| `node_detail.battery.remaining_time` | `Zbývající čas` |

**Solar rows**

| Key | Czech |
|-----|-------|
| `node_detail.solar.power` | `Výkon` |
| `node_detail.solar.today_energy` | `Dnes` |
| `node_detail.solar.forecast` | `Zbývající předpověď` |

**Grid rows**

| Key | Czech |
|-----|-------|
| `node_detail.grid.power` | `Výkon` |
| `node_detail.grid.today_import` | `Dnes odebráno` |
| `node_detail.grid.today_export` | `Dnes dodáno` |

**House rows**

| Key | Czech |
|-----|-------|
| `node_detail.house.power` | `Výkon` |

### 8.3 `cs.json` additions

Add to `src/localize/translations/cs.json`:

```json
{
  "card": {
    "loading": "Načítání energetických dat…"
  },
  "house_section": {
    "group_by": "Seskupit podle",
    "others": "Ostatní"
  },
  "node_detail": {
    "title": {
      "solar":   "Solární panely",
      "battery": "Baterie",
      "grid":    "Síť",
      "house":   "Dům"
    },
    "battery": {
      "mode":               "Režim",
      "mode_charging":      "Nabíjení",
      "mode_discharging":   "Vybíjení",
      "mode_idle":          "Nečinnost",
      "power":              "Výkon",
      "soc":                "Nabití",
      "min_soc":            "Min. nabití",
      "max_soc":            "Max. nabití",
      "remaining_energy":   "Zbývající energie",
      "eta_section":        "Předpověď",
      "target_soc":         "Cílové nabití",
      "target_time":        "Čas dosažení",
      "remaining_time":     "Zbývající čas"
    },
    "solar": {
      "power":        "Výkon",
      "today_energy": "Dnes",
      "forecast":     "Zbývající předpověď"
    },
    "grid": {
      "power":        "Výkon",
      "today_import": "Dnes odebráno",
      "today_export": "Dnes dodáno"
    },
    "house": {
      "power": "Výkon"
    }
  }
}
```

### 8.4 Usage in dialog

```typescript
// Title
private _title(): string {
    return this.localize(`node_detail.title.${this.params.nodeType}`);
}

// Example label row
html`<div class="detail-row">
    <span class="label">${this.localize('node_detail.battery.mode')}</span>
    <span class="value">${this.localize(`node_detail.battery.mode_${modeKey}`)}</span>
</div>`
// where modeKey is 'charging' | 'discharging' | 'idle'
```

---

## 9. CSS / Styling Guidelines

- Use HA CSS custom properties throughout: `var(--primary-color)`, `var(--secondary-text-color)`, `var(--primary-text-color)`
- Status colors: use the same constants as the node components — `#22c55e` (green, battery active), `#facc15` (solar yellow), `#38bdf8` (grid blue)
- Keep the dialog minimal — no heavy styling, match the card's compact aesthetic
- No custom scrollbars; `ha-dialog` handles overflow

---

## 10. Implementation Sequence

1. **Add DTO storage to `helman-simple-card.ts`** — store the four node DTOs in `_buildEntityMap`
2. **Add `@state() _dialogNodeType`** and `_buildDialogParams()` helper
3. **Add Czech translations** to `cs.json` for all `node_detail.*` keys
4. **Create `node-detail-dialog.ts`** — scaffold the component with `localize` property and all four render methods, starting with the simplest (house, grid, solar) then battery (most complex)
5. **Add click handlers and dialog render** to `helman-simple-card.ts`, passing `.localize=${this._localize!}`
6. **Wire up `@closed` event** to reset `_dialogNodeType`
7. **Test each node type** by clicking each node icon

---

## 11. Files Summary

| File | Action | Reason |
|------|--------|--------|
| `src/helman-simple/helman-simple-card.ts` | Modify | Add DTO storage, click handlers, dialog state, dialog render, pass `localize` |
| `src/helman-simple/node-detail-dialog.ts` | Create | The modal component |
| `src/localize/translations/cs.json` | Modify | Add `node_detail.*` keys |
| `src/helman/DeviceConfig.ts` | Read-only | Import `BatteryDeviceConfig`, `SolarDeviceConfig`, `GridDeviceConfig` |
| `src/helman/energy-unit-converter.ts` | Read-only | Reuse `convertToKWh`, `getDisplayEnergyUnit` |
| `src/power-format.ts` | Read-only | Reuse `formatPower` |
| `src/helman-api.ts` | Read-only | Import `DeviceNodeDTO` |
| `src/localize/localize.ts` | Read-only | Import `LocalizeFunction` type |

No backend changes. No new config schema. No new API types.

---

## 12. Out of Scope (Iteration 2)

- Battery today's charged / today's discharged kWh (`BatteryDeviceConfig.entities.today_charged`, `today_discharged`)
- House today's energy (`HouseDeviceConfig.entities.today_energy` or `recorder/statistics_during_period`)
