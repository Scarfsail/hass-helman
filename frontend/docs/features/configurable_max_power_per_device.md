# Feature: Configurable Max Power Per Device (Flow Width Scaling)

## Status: ✅ Agreed — ready for implementation

---

## Goal

Scale the visual **thickness of flow connectors** in `helman-simple-card` proportionally to the current power of each device. Low power → thin flow track; peak power → thick flow track.

The scaling reference (`max_power`) is configured **per device** in the Helman backend storage, so each device type (solar, grid, battery, house) can have its own realistic maximum.

---

## Current Behaviour

- The flow tracks in `helman-simple-card` have a **fixed size**: 6 px height (horizontal) / 6 px width (vertical), with fixed 6 × 6 px dots.
- The flow is either visible (power > threshold) or hidden — no proportional scaling.

---

## Proposed Behaviour

- Flows are **hidden** when power is **below 20 W** (same threshold for all devices).
- Above 20 W, the track height/width and dot size **scale linearly** between a minimum (2 px) and a maximum (12 px) based on:
  ```
  intensity = clamp(currentPower / maxPower, 0, 1)
  trackThickness = MIN_THICKNESS + intensity * (MAX_THICKNESS - MIN_THICKNESS)
  ```
- For the SVG diagonal overlay lines (`stroke-width`), the same intensity is applied: `strokeWidth = 1 + intensity × 5` (range: 1 – 6 px).
- `maxPower` is read from each device's `sourceConfig.max_power` in the DTO sent by the backend.
- If `max_power` is not set, a **sensible default** is used per device type:
  | Device  | Default max_power |
  |---------|-------------------|
  | solar   | 5 000 W           |
  | grid    | 11 500 W (1-phase 50A) |
  | battery | 5 000 W           |
  | house   | 11 500 W          |

---

## Data Flow

```
BE storage config
  └─ power_devices.solar.max_power  = 6000  (new optional field)
  └─ power_devices.grid.max_power   = 11500
  └─ power_devices.battery.max_power = 5000
  └─ power_devices.house.max_power  = 11500

     ↓  (already passed through unchanged in sourceConfig)

DeviceNodeDTO.sourceConfig.max_power  (no BE code change needed)

     ↓  _buildEntityMap() in helman-simple-card.ts

EnergyEntityMap  ← add maxPower fields per device

     ↓  render()

_flowH(colorClass, reverse, thickness)
_flowV(colorClass, reverse, thickness)
_renderFlowOverlay(gridImport, battDischarge, gridThickness, battThickness)
```

---

## Backend Changes (`hass-helman`)

### `storage.py`
- **No Python code change required.** The `sourceConfig` field in `DeviceNodeDTO` passes the raw config dict verbatim to the frontend. Adding `max_power` to the YAML/UI config automatically makes it available on the FE as `sourceConfig.max_power`.
- The `DEFAULT_CONFIG` dict does **not** need updating (the field is optional and device-specific).

### What a user-configured entry looks like in storage:
```json
{
  "power_devices": {
    "solar": {
      "entities": { "power": "sensor.solar_power" },
      "max_power": 6000
    },
    "grid": {
      "entities": { "power": "sensor.grid_power" },
      "max_power": 11500
    },
    "battery": {
      "entities": { "power": "sensor.battery_power" },
      "max_power": 5000
    },
    "house": {
      "entities": { "power": "sensor.house_power" },
      "max_power": 11500
    }
  }
}
```

> **Note for future UI editor**: When the Helman settings panel is built, expose `max_power` as an optional numeric field for each power device section.

---

## Frontend Changes (`hass-helman-card`)

### `src/helman-simple-card.ts`

#### 1. Add `maxPower` fields to `EnergyEntityMap`
```typescript
interface EnergyEntityMap {
    // ... existing fields ...
    solarMaxPower:   number;
    gridMaxPower:    number;
    batteryMaxPower: number;
    houseMaxPower:   number;
}
```

#### 2. Read from `sourceConfig` in `_buildEntityMap()`
```typescript
private _buildEntityMap(payload: TreePayload): EnergyEntityMap {
    const solarNode   = payload.sources.find(n => n.sourceType === "solar");
    const gridNode    = payload.sources.find(n => n.sourceType === "grid");
    const batteryNode = payload.sources.find(n => n.sourceType === "battery");
    const houseNode   = this._findHouseNode(payload.consumers);

    return {
        // ... existing fields ...
        solarMaxPower:   solarNode?.sourceConfig?.max_power   ?? 5000,
        gridMaxPower:    gridNode?.sourceConfig?.max_power    ?? 11500,
        batteryMaxPower: batteryNode?.sourceConfig?.max_power ?? 5000,
        houseMaxPower:   houseNode?.sourceConfig?.max_power   ?? 11500,
    };
}
```

#### 3. Store max powers alongside entity map
Store the max powers so they are available in `render()`:
```typescript
@state() private _maxPowers = { solar: 5000, grid: 11500, battery: 5000, house: 11500 };
```
Populated from `_entityMap` after `_loadFromBackend()`.

#### 4. Compute intensity in `render()`
```typescript
const intensity = (power: number, max: number) => Math.min(Math.abs(power) / max, 1);

const solarIntensity   = intensity(solarPower,   this._maxPowers.solar);
const gridIntensity    = intensity(gridPower,     this._maxPowers.grid);
const battIntensity    = intensity(batteryPower,  this._maxPowers.battery);
const houseIntensity   = intensity(housePower,    this._maxPowers.house);
```

#### 5. Compute `thickness` and pass to flow helpers
```typescript
const MIN_PX = 2;
const MAX_PX = 12;
const thick = (i: number) => MIN_PX + i * (MAX_PX - MIN_PX);

// e.g. solar → house vertical connector uses solar intensity
this._flowV("color-solar", false, thick(solarIntensity))
```

#### 6. Update `_flowH()`, `_flowV()`, `_renderFlowOverlay()`
Add a `thickness: number` parameter; apply it via inline styles to the track and dot:
```typescript
private _flowH(colorClass: string, reverse: boolean, thickness: number) {
    const dotSize = Math.round(thickness);
    const anim = reverse ? "flow-h-rev" : "flow-h";
    return html`
        <div class="flow-track flow-track-h" style="height: ${thickness}px">
            ${[0, 0.45, 0.9].map(delay => html`
                <div class="flow-dot flow-dot-h ${colorClass}"
                     style="width: ${dotSize}px; height: ${dotSize}px;
                            animation-name: ${anim}; animation-delay: ${delay}s"></div>
            `)}
        </div>`;
}
```

#### 7. Update CSS
- Remove the hardcoded `height: 6px` from `.flow-track-h` and `width: 6px` from `.flow-track-v` (replaced by inline styles).
- Keep the dot base class but remove its fixed `width`/`height` (will come from inline style).

---

## Connectors and which intensity to use

| Connector         | Path                  | Intensity source |
|-------------------|-----------------------|-----------------|
| Solar → House (V) | top-left → bottom-left | `solarIntensity` |
| Solar → Grid (H)  | top-left → top-right   | `solarIntensity` (solar is the source of export power) |
| Grid → Battery (V)| top-right → bottom-right | `gridIntensity` (import) |
| House → Battery (H)| bottom-left → bottom-right | `battIntensity` |
| Grid → House diagonal | overlay SVG line     | `gridIntensity` |
| Battery → House diagonal | overlay SVG line | `battIntensity` |

For the SVG overlay lines, scale `stroke-width` (currently 3) proportionally using the same intensity formula:
```
strokeWidth = 1 + intensity * 5   // range: 1 – 6
```

---

## Files Changed Summary

| File | Repo | Change |
|------|------|--------|
| `storage.py` | `hass-helman` | No code change; optional `max_power` field is pass-through |
| `src/helman-simple-card.ts` | `hass-helman-card` | Read `max_power`, compute intensity, pass thickness to flow helpers |

No changes required in `simple-card-solar.ts`, `simple-card-grid.ts`, `simple-card-house.ts`, `simple-card-battery.ts` for this feature.

---

## Agreed Decisions

1. **Threshold**: Flows are hidden below **20 W**. No minimum-thickness glow at very low power.
2. **Diagonal SVG overlays**: `stroke-width` scales with intensity (`1 + intensity × 5`, range 1–6 px).
3. **No global card-level `max_power`**: Per-device backend config only; no `HelmanSimpleCardConfig` fallback field.
4. **Solar → Grid connector**: Driven by **`solarIntensity`**, since solar is the source of the exported power.
