# Phase 7: Frontend Cleanup

## Goal
Remove all legacy data-fetching, tree-construction, and computation code from the
frontend. After this phase, the frontend is a pure rendering layer: it receives
pre-computed data from the backend via the HA entity state and WebSocket commands,
and renders it without any business logic.

**This is the breaking change phase.** A major semver bump and `BREAKING CHANGE:`
in the commit message is required.

## Prerequisite
All backend phases (1–6) must be stable and tested before this phase begins.
The card must have verified that the backend integration is installed and functional
before removing legacy mode.

## Files to Delete Entirely

| File | Why it can be deleted |
|---|---|
| `src/energy-data-helper.ts` | All fetching + tree build + history + ratio logic moved to backend |

## Files to Significantly Simplify

### `src/DeviceNode.ts`

Remove all mutable computation methods. `DeviceNode` becomes a plain data container:

```typescript
// REMOVE these methods:
// - updateHistoryBuckets()
// - updateLivePower()
// - appendHistoryBucket()

// KEEP:
// - All data properties (powerValue, powerHistory, sourcePowerHistory, etc.)
// - Static sort helper
// - Tree walk helpers
```

### `src/helman-card.ts`

Remove the entire lifecycle of the history interval and legacy fetching:

```typescript
// REMOVE:
// - _historyInterval property
// - connectedCallback interval setup
// - disconnectedCallback clearInterval
// - All imports from energy-data-helper.ts
// - Legacy mode branching

// KEEP:
// - hass setter (simplified: reads from sensor.helman_power_summary attributes)
// - setConfig() – now just validates that the entity is configured
// - Render tree (unchanged)
// - _requestTree() on connect: calls helman/get_device_tree
```

Simplified `helman-card.ts` connect lifecycle:

```typescript
connectedCallback() {
  super.connectedCallback();
  this._loadBackendData();
}

private async _loadBackendData(): Promise<void> {
  if (!this._hass) return;
  // 1. Fetch tree structure (once on connect)
  const treePayload = await this._hass.connection.sendMessagePromise({
    type: "helman/get_device_tree",
  });
  this._deviceTree = hydrateDeviceNodes(treePayload);

  // 2. History is already in sensor attributes; no second request needed
  //    (backend includes last N buckets in sensor.helman_power_summary.attributes)
}

public set hass(hass: HomeAssistant) {
  this._hass = hass;
  if (!this._deviceTree) return;

  const summary = hass.states["sensor.helman_power_summary"];
  if (summary) {
    this._applySnapshot(summary.attributes);
  }

  this.requestUpdate();
}

private _applySnapshot(attrs: Record<string, any>): void {
  for (const node of walkTree(this._deviceTree)) {
    const d = attrs.devices?.[node.id];
    if (d) {
      node.powerValue = d.power;
      node.powerHistory = d.history ?? [];
      node.sourcePowerHistory = d.source_ratios ?? [];
    }
  }
}
```

### `src/HelmanCardConfig.ts`

Remove all power device configuration fields. The card config shrinks to:

```typescript
export interface HelmanCardConfig {
  type: string;
  entity: string;  // "sensor.helman_power_summary"
}
```

All other config fields are now in the backend storage.

### `src/power-device-info.ts`

Remove all computation of battery ETA. Simplify to reading the sensor value:

```typescript
// REMOVE: _computeBatteryEta() (60+ line calculation)
// KEEP: _renderBatteryInfo() – reads from sensor.helman_battery_time_to_target
```

### `src/power-house-devices-section.ts`

The `_groupByCategory()` virtual aggregation method can be simplified: the backend
now provides `labelBadgeTexts` on each device node, so the frontend only needs to
filter and group, not compute power sums from scratch.

However, the virtual group power aggregation (summing children for the "grouped
view") is a lightweight UI operation (not registry lookups, not history computation)
and can remain in the frontend without issues. Only remove it if it causes
observable performance problems.

## Simplified Card YAML

After this phase, a minimal working card config is:

```yaml
type: custom:helman-card
entity: sensor.helman_power_summary
```

All labels, group names, device configs, regex patterns, etc. are configured once
in the integration's storage and apply automatically.

## Bundle Size Reduction

Rough estimate of code removed:

| File | Current Size | After Phase 7 |
|---|---|---|
| `energy-data-helper.ts` | ~550 lines | 0 (deleted) |
| `helman-card.ts` | ~200 lines | ~80 lines |
| `DeviceNode.ts` | ~120 lines | ~60 lines |
| `HelmanCardConfig.ts` | ~80 lines | ~15 lines |
| `power-device-info.ts` | ~230 lines | ~170 lines |

Total estimated reduction: ~650–700 lines of TypeScript, likely translating to
~15–20 KB reduction in the minified bundle.

## Migration Instructions for Users

Before applying the Phase 7 breaking change update, users must:

1. Have `hass-helman` backend integration installed and set up.
2. Have migrated their card YAML config to backend storage (Phase 2 migration step).
3. Confirm that `sensor.helman_power_summary` exists and is non-unavailable in HA.

A warning banner can be shown in the card during Phase 2–6 if the backend entity
is not detected, guiding users to install the backend before updating.

## BREAKING CHANGE Commit

```
feat(card): remove all legacy data fetching and computation

BREAKING CHANGE: The helman-card now requires the hass-helman backend integration
to be installed. The card no longer accepts power_devices, device_label_text,
power_sensor_name_cleaner_regex, history_buckets, or any other configuration
directly in YAML. All configuration must be migrated to the backend integration
via the HA integrations UI.

Minimum config:
  type: custom:helman-card
  entity: sensor.helman_power_summary
```

## Verification Checklist

After Phase 7, verify:

- [ ] Card loads and renders without any YAML other than `entity:`
- [ ] Power values update in real-time (driven by `hass` setter)
- [ ] History bars render correctly (from backend-provided history buckets)
- [ ] Source-color segments in history bars are correct (from backend source ratios)
- [ ] Battery ETA shows correct value and matches `sensor.helman_battery_time_to_target`
- [ ] Unmeasured power node shows in house section
- [ ] Category chips filter devices correctly
- [ ] Show-more toggle works
- [ ] Device switches (power control) still work via `hass.callService`
- [ ] No errors in browser console
- [ ] No errors in HA logs
- [ ] Card works in multiple simultaneous dashboard views without duplication issues
