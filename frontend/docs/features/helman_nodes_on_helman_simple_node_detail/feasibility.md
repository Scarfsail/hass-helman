# Feasibility Analysis: Helman Nodes in Helman-Simple Node Detail Dialogs

**Date:** 2026-03-01  
**Status:** Final — decisions incorporated  
**Scope:** Showing `power-device` helman nodes (with history bars and info rows) inside the `node-detail-dialog` that appears when tapping Solar, Battery, Grid, or House in `helman-simple-card`.

---

## 1. Goal Summary

When the user taps a node icon in `helman-simple-card`, the existing `node-detail-dialog` opens. The request is to **embed the full helman `power-device` rendering** (with history bars, icon, info rows, etc.) for the corresponding helman nodes directly within that dialog.

For nodes that act as both producer and consumer (Battery, Grid), two separate `power-device` visualizations should appear — one for the producer role and one for the consumer role — with separate histories and a clear title each.

---

## 2. Key Architectural Insight

The backend's `TreePayload` already separates every node by role:

```
payload.sources    → [solar, grid-producer (export), battery-producer (discharge)]
payload.consumers  → [house (+ children), grid-consumer (import), battery-consumer (charge)]
```

Each entry is a **separate `DeviceNodeDTO`** with its own `powerSensorId`, `valueType`, and hydrated `DeviceNode`. Battery and grid are NOT a single signed sensor split manually — the backend already models them as two distinct objects with separately tracked histories.

`helman-card` already uses both groups to show all four roles. `helman-simple-card` currently only extracts the source-side DTOs (`_solarDTO`, `_gridDTO`, `_batteryDTO`) and the house node from `payload.consumers`. The **battery-consumer and grid-consumer DTOs that exist inside `payload.consumers` are currently being discarded.**

---

## 3. What We Already Have vs. What's Missing

### Already available in `helman-simple-card`

| Node | Producer `DeviceNode` | Consumer `DeviceNode` |
|---|---|---|
| Solar | ✅ `_sourceNodes[solar]` (hydrated + history) | N/A — pure producer |
| Grid | ✅ `_sourceNodes[grid]` (hydrated + history) | ❌ not stored (exists in `payload.consumers`) |
| Battery | ✅ `_sourceNodes[battery]` (hydrated + history) | ❌ not stored (exists in `payload.consumers`) |
| House | N/A — pure consumer | ✅ `_houseNode` (hydrated + history + children) |

### What needs to be added

1. **Store grid-consumer and battery-consumer DTOs in `_buildEntityMap`** — search `payload.consumers` by `sourceType === 'battery'` and `sourceType === 'grid'` (the same way the house node is found by `sourceType === 'house'`).

2. **Hydrate them** in `_loadFromBackend` by calling `_hydrateNode` on them, exactly how `_sourceNodes` are built today.

3. **Apply history** to them — include them in the `_applyHistory` and `_advanceBuckets` walks (currently only `_sourceNodes` and `_houseNode` are walked).

4. **Pass the DeviceNodes to dialog params** and render `<power-device>` in the dialog.

---

## 4. Per-Node Feasibility

### 4.1 House — show house node itself above the consumer list

**Status: ✅ Trivial — no new data fetching, no new fields**

`_houseNode` is already fully hydrated with history. We just:

1. Add `houseNode: DeviceNode | null` to `HouseDetailParams`.
2. Pass `this._houseNode` in `_buildDialogParams('house')`.
3. Render `<power-device>` at the top of `_renderHouse()` in the dialog.

---

### 4.2 Solar — show solar node with history

**Status: ✅ Trivial — same pattern as house**

Solar is pure producer. The hydrated `DeviceNode` is already in `_sourceNodes`.

1. Add `solarNode: DeviceNode | null` to `SolarDetailParams`.
2. Pass the solar `DeviceNode` from `_sourceNodes` in `_buildDialogParams('solar')`.
3. Render `<power-device>` in `_renderSolar()`.

---

### 4.3 Battery — producer (discharging) and consumer (charging)

**Status: ✅ Easy — backend already provides both as separate nodes**

The backend sends the battery-producer in `payload.sources` (already stored as `_batteryDTO`) and the battery-consumer in `payload.consumers` (currently discarded).

Changes:
1. In `_buildEntityMap`, search `payload.consumers` for `sourceType === 'battery'`:
   ```typescript
   const batteryConsumerNode = payload.consumers.find(n => n.sourceType === 'battery');
   this._batteryConsumerDTO = batteryConsumerNode ?? null;
   ```
2. In `_loadFromBackend`, hydrate it and include in history walks:
   ```typescript
   this._batteryConsumerNode = this._batteryConsumerDTO
       ? this._hydrateNode(this._batteryConsumerDTO, histBuckets)
       : null;
   ```
   Include `this._batteryConsumerNode` in both `_applyHistory` and `_advanceBuckets`.
3. Add `batteryProducerNode: DeviceNode | null` and `batteryConsumerNode: DeviceNode | null` to `BatteryDetailParams`.
4. Pass both in `_buildDialogParams('battery')`.
5. Render two `<power-device>` sections in `_renderBattery()` — "Producer" first, "Consumer" second.

---

### 4.4 Grid — producer (exporting) and consumer (importing)

**Status: ✅ Easy — identical pattern to battery**

Grid-producer is in `payload.sources` (already stored as `_gridDTO`).  
Grid-consumer is in `payload.consumers` (currently discarded).

Changes mirror battery exactly:
1. Search `payload.consumers` for `sourceType === 'grid'`, store as `_gridConsumerDTO`.
2. Hydrate → `_gridConsumerNode`, include in history walks.
3. Add `gridProducerNode` and `gridConsumerNode` to `GridDetailParams`.
4. Render two `<power-device>` sections in `_renderGrid()`.

---

## 5. Rendering in the Dialog

### Single-role nodes (house, solar)

```
┌─ dialog ──────────────────────────┐
│  Solar                             │
│                                    │
│  [power-device]  ← history + icon  │
│  ───────────────────────────────   │
│  Today     12.3 kWh  [clickable]   │  ← existing scalar rows
│  Forecast   4.1 kWh  [clickable]   │
│                           [Close]  │
└────────────────────────────────────┘
```

### Dual-role nodes (battery, grid)

Producer and consumer nodes are shown side-by-side in a flex row, wrapping to a second row only if there is not enough horizontal space.

```
┌─ dialog ────────────────────────────────────────┐
│  Battery                                         │
│                                                  │
│  Mode   Charging / Idle / Discharge              │  ← derived row
│  SoC    74%                    [clickable]       │  ← scalar rows
│  ───────────────────────────────────────────     │
│  ┌── Discharging ──────┐  ┌── Charging ────┐    │  ← flex row
│  │  [power-device]     │  │  [power-device] │    │
│  └────────────────────┘  └───────────────┘     │
│                                         [Close]  │
└──────────────────────────────────────────────────┘
```

For grid:
```
│  ┌── Export ───────────┐  ┌── Import ──────┐    │
│  │  [power-device]     │  │  [power-device] │    │
│  └────────────────────┘  └───────────────┘     │
```

Sections where the corresponding `DeviceNode` is `null` (i.e. not configured in the backend) are hidden entirely.

### CSS in dialog context

`power-device` uses host-based flex sizing. Inside the dialog's `flex-column` `.content`, a wrapper `<div style="display: flex; flex-direction: row; width: 100%">` restores horizontal flex layout for each `power-device`.

---

## 6. Implementation Plan

### Changes to `helman-simple-card.ts`

| What | Where | Effort |
|---|---|---|
| Add `_batteryConsumerDTO`, `_gridConsumerDTO` private fields | Class fields | Trivial |
| Add `_batteryConsumerNode`, `_gridConsumerNode` private fields | Class fields | Trivial |
| Store consumer DTOs in `_buildEntityMap` | `_buildEntityMap()` | Trivial |
| Hydrate consumer nodes in `_loadFromBackend` | `_loadFromBackend()` | Trivial |
| Include consumer nodes in `_applyHistory` walk | `_applyHistory()` | Trivial |
| Include consumer nodes in `_advanceBuckets` walk | `_advanceBuckets()` + `_advanceTree()` | Trivial |
| Pass nodes through dialog params | `_buildDialogParams()` | Trivial |

### Changes to `node-detail-dialog.ts`

| What | Effort |
|---|---|
| Add `houseNode`, `solarNode` to respective params types | Trivial |
| Add `batteryProducerNode`, `batteryConsumerNode` to `BatteryDetailParams` | Trivial |
| Add `gridProducerNode`, `gridConsumerNode` to `GridDetailParams` | Trivial |
| Render `<power-device>` in all four `_render*` methods | Small |
| Import `power-device` at top of file | Trivial |

### New localization keys

Section titles are node-specific for better readability:

```
node_detail.battery.section_producer  →  "Vybíjení"
node_detail.battery.section_consumer  →  "Nabíjení"
node_detail.grid.section_producer     →  "Export"
node_detail.grid.section_consumer     →  "Import"
```

### Implementation sequence

1. Extend `_buildEntityMap` to store battery/grid consumer DTOs from `payload.consumers`
2. Hydrate consumer nodes in `_loadFromBackend`, add to history walk
3. Update `_advanceBuckets` / `_advanceTree` to cover consumer nodes
4. Update all `*DetailParams` types with the new node fields
5. Update `_buildDialogParams` to pass them
6. Add `<power-device>` rendering in each `_render*` method of `node-detail-dialog`
7. Add two localization keys

---

## 7. Decisions

1. **Ordering:** Producer first, then consumer — side-by-side in a flex row, wrapping only if space is insufficient.

2. **Absent role:** Hidden entirely — no "not configured" indicator.

3. **Section titles:** Node-specific for readability:
   - Battery: **"Vybíjení"** (Discharging) / **"Nabíjení"** (Charging)
   - Grid: **"Export"** / **"Import"**

4. **Solar children:** Show them. The dialog is the only place in the app that can show the full solar sub-inverter/string tree, so it should leverage the native `power-device` child expansion.

---

## 8. Verdict

All four features are **straightforward**. No new backend calls, no new API types, no manual history splitting. The required data already exists in `payload.consumers`; it just needs to be stored and hydrated. The overall change size is small and contained to `helman-simple-card.ts` and `node-detail-dialog.ts`.

| Feature | Verdict |
|---|---|
| House dialog: house node with history | ✅ Trivial |
| Solar dialog: solar node with history | ✅ Trivial |
| Battery dialog: producer + consumer sections | ✅ Easy — backend already splits roles |
| Grid dialog: producer + consumer sections | ✅ Easy — backend already splits roles |
