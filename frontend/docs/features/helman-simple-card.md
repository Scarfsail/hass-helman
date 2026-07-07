# Feature: helman-simple-card

## Overview

A compact, visually rich card (max 500×500px) showing the four core energy elements:
**Solar**, **Battery**, **Grid**, and **House**. Each element has an animated SVG/CSS
visualization that comes alive (animated + glowing) when it is active.

---

## Requirements

### Functional
| Element | Active condition | Info shown when active |
|---------|-----------------|------------------------|
| Solar | `power > 0` | Power (W / kW) |
| Battery | `power != 0` | Power (W / kW) + % + time to full/empty |
| Grid | `power != 0` | Power (W / kW), direction label (import/export) |
| House | `power > 0` | Power (W / kW) |

**Power formatting rule** (reused from existing card):
- `< 1000 W` → show as `"XXX W"`
- `≥ 1000 W` → show as `"X.X kW"`

**Battery time calculation**:
- Requires `battery_soc_entity` (%) and `battery_capacity_kwh`
- Charging: `time_hours = capacity * (1 - soc/100) / power`
- Discharging: `time_hours = capacity * (soc/100 - min_soc/100) / power`
- Display as `"Xh Ym"` or `"Xm"` if < 1 hour

### Visual Design

Layout: **2×2 grid** with connecting flow lines between active elements.

```
┌─────────────────────────────┐
│  [☀ Solar]    [⚡ Grid]      │
│     ↕              ↕        │
│  [🏠 House]  [🔋 Battery]   │
└─────────────────────────────┘
```

Each node tile: ~180–200px square.

#### Solar
- Circular sun with radiating rays
- Active: rays rotate slowly, golden/amber glow radiates outward
- Inactive: dim grey, no animation

#### Battery
- Rectangle with level fill (green gradient)
- Charging: fill animates upward with pulsing green glow
- Discharging: fill animates downward with amber/orange glow
- Percentage shown as label inside the battery, prominently
- Inactive (near 0W): static filled rectangle, no glow

#### Grid
- Stylised utility pole / transmission tower icon (SVG)
- Import: animated flow arrows pointing inward (blue/cyan)
- Export: animated flow arrows pointing outward (green)
- Inactive: dim, no animation

#### House
- Simple house silhouette with windows
- Active: soft warm-white window glow pulses with power level
- Inactive: dark, no glow

#### Flow connections
- Thin SVG lines between active source→destination pairs
- Animated dashes flowing in the direction of energy

---

## Architecture

### New files
| File | Purpose |
|------|---------|
| `src/power-format.ts` | Extracted power formatting utility (avoids duplication) |
| `src/HelmanSimpleCardConfig.ts` | Config interface |
| `src/simple-card-solar.ts` | Solar animated node component |
| `src/simple-card-battery.ts` | Battery animated node component |
| `src/simple-card-grid.ts` | Grid animated node component |
| `src/simple-card-house.ts` | House animated node component |
| `src/helman-simple-card.ts` | Main card (2×2 layout + flow lines) |

### Abstraction: `power-format.ts`
The power formatting logic currently lives inline in `power-device-power-display.ts`. 
Extract to a shared utility so both cards can use it:

```typescript
export function formatPower(watts: number): { value: string; unit: string }
```

`power-device-power-display.ts` is updated to import and use this function.

### Data fetching
The simple card reads entity states **directly from `hass.states`** — no backend 
WebSocket call needed. Configuration provides entity IDs explicitly. This keeps the 
card self-contained and usable without the helman backend integration.

---

## Configuration Interface

```typescript
interface HelmanSimpleCardConfig extends LovelaceCardConfig {
    solar_power_entity?: string;        // W, positive = producing
    battery_power_entity?: string;      // W, positive = charging, negative = discharging
    battery_soc_entity?: string;        // %, 0–100
    battery_capacity_kwh?: number;      // kWh total capacity
    battery_min_soc?: number;           // % minimum SoC, default 10
    grid_power_entity?: string;         // W, positive = import from grid, negative = export
    house_power_entity?: string;        // W, total house consumption
}
```

---

## Vite Build

The card is added as a separate entry point in `vite.config.ts`, producing:
- Dev: `dist/helman-simple-card-dev.js`
- Prod: `dist/helman-simple-card-prod.js`

---

## Implementation Status: ✅ Complete

### Files created
| File | Notes |
|------|-------|
| `src/power-format.ts` | Shared utility; also consumed by `power-device-power-display.ts` |
| `src/HelmanSimpleCardConfig.ts` | |
| `src/simple-card-solar.ts` | Rotating rays + amber glow |
| `src/simple-card-battery.ts` | Fill-level battery + time-to-full/empty |
| `src/simple-card-grid.ts` | Utility pole with animateMotion dots |
| `src/simple-card-house.ts` | House silhouette with window glow |
| `src/helman-simple-card.ts` | 3×3 CSS grid layout with flow connectors |

### Build output (dev)
```
dist/helman-simple-card-dev.js   ← load this as HA resource
dist/power-format-dev.mjs        ← must be deployed alongside the card
dist/helman-card-dev.js          ← original card (unchanged)
```

### Deployment note
Both `helman-simple-card-dev.js` and `power-format-dev.mjs` must be placed in
the same directory so the ES module relative import resolves correctly.

### HA card config example
```yaml
type: custom:helman-simple-card
solar_power_entity: sensor.solar_power
battery_power_entity: sensor.battery_power
battery_soc_entity: sensor.battery_soc
battery_capacity_kwh: 10
battery_min_soc: 10
grid_power_entity: sensor.grid_power   # positive = import, negative = export
house_power_entity: sensor.house_power
```
