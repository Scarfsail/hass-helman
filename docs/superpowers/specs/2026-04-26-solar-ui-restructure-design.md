# Solar UI Section Restructure — Design Spec

**Date:** 2026-04-26
**Scope:** UI-only — no YAML schema changes, no backend changes.

---

## Goal

Reorganise the Power Devices → Solar section in the Helman config editor into a clearer two-level hierarchy that separates entity configuration from forecast configuration, and restructures the Bias Correction card to expose the configuration editor, status, and visual inspector as distinct sibling sections.

---

## New Section Hierarchy

```
Solar (collapsed by default)                         ← existing scope, adapter unchanged
├── General (collapsed by default)                   ← NEW scope
│   └── entities: power, today_energy,
│       remaining_today_energy_forecast
└── Forecast (collapsed by default)                  ← NEW scope
    ├── General (collapsed by default)               ← NEW scope
    │   └── forecast: total_energy_entity_id,
    │       daily_energy_entity_ids list
    └── Bias Correction (collapsed by default)       ← existing scope, parent re-pointed
        ├── Configuration (collapsed by default)     ← NEW scope
        │   ├── enabled, min_history_days,
        │   │   max_training_window_days,
        │   │   training_time, clamp_min,
        │   │   clamp_max, total_energy_entity_id
        │   └── Slot Invalidation (collapsed)        ← existing scope, parent unchanged
        └── Status and training                      ← existing helman-bias-correction-status
            (state rows + actions + visual inspector,
             visual inspector expanded by default)
```

---

## Scope System Changes (`config-editor-scopes.ts`)

### New ScopeId values

| Scope ID | Kind | Parent | Adapter |
|---|---|---|---|
| `section:power_devices.solar.general` | section | `section:power_devices.solar` | `createPathScopeAdapter(["power_devices", "solar", "entities"], { emptyValue: {}, rootKind: "object" })` |
| `section:power_devices.solar.forecast` | section | `section:power_devices.solar` | `createPathScopeAdapter(["power_devices", "solar", "forecast"], { emptyValue: {}, rootKind: "object" })` |
| `section:power_devices.solar.forecast.general` | section | `section:power_devices.solar.forecast` | `createProjectionScopeAdapter` over `total_energy_entity_id` and `daily_energy_entity_ids` projected from document paths `["power_devices","solar","forecast","total_energy_entity_id"]` and `["power_devices","solar","forecast","daily_energy_entity_ids"]` |
| `section:power_devices.solar.bias_correction.config` | section | `section:power_devices.solar.bias_correction` | `createProjectionScopeAdapter` over the 7 direct config keys of `bias_correction` (enabled, min_history_days, max_training_window_days, training_time, clamp_min, clamp_max, total_energy_entity_id) — excludes `slot_invalidation` so YAML mode shows a clean object |

### Changed parent pointer

- `section:power_devices.solar.bias_correction`: parent changes from `section:power_devices.solar` → `section:power_devices.solar.forecast`

### Icons

Add icon entries in `SECTION_ICONS` for all four new scope IDs (can reuse suitable MDI icon paths, or leave as no-icon — to be decided during implementation).

### Labels (`en.json` and `cs.json`)

New `editor.sections` keys needed:
- `solar_general` — "General"
- `solar_forecast` — "Forecast"
- `solar_forecast_general` — "General"
- `bias_correction_config` — "Configuration"

---

## Rendering Changes (`helman-config-editor.ts`)

### Solar section body

Replace the current flat rendering (entity fields + forecast field + list + nested bias correction) with:

1. `_renderSectionScope(SECTION_SCOPE_IDS.power_devices.solar_general, ...)` — contains the three entity fields
2. `_renderSectionScope(SECTION_SCOPE_IDS.power_devices.solar_forecast, ...)` — contains:
   - `_renderSectionScope(SECTION_SCOPE_IDS.power_devices.solar_forecast_general, ...)` — contains total_energy_entity_id field + daily energy entity list + Add button
   - `_renderSectionScope(SECTION_SCOPE_IDS.power_devices.solar_bias_correction, ...)` — contains:
     - `_renderSectionScope(SECTION_SCOPE_IDS.power_devices.solar_bias_correction_config, ...)` — contains the 7 config fields + nested slot_invalidation section
     - The existing `div.list-card` for "Status and training" (helman-bias-correction-status), unchanged

All new sections default to `{ initialOpen: false }`.

---

## Visual Inspector Change (`bias-correction-inspector.ts`)

Change the `_expanded` state default from `false` to `true`:

```typescript
@state() private _expanded = true;
```

---

## What Does Not Change

- The YAML structure of the config document — no keys moved, renamed, or removed.
- The `helman-bias-correction-status` component internals.
- The `section:power_devices.solar.bias_correction.slot_invalidation` scope and its adapter.
- All existing field renderers — they are lifted verbatim into the new sections.
- All other tabs and sections.

---

## Files to Touch

1. `frontend/src/config-editor-scopes.ts` — add 4 new scope IDs, update parent of `solar_bias_correction`, add icons, add projection members
2. `frontend/src/helman-config-editor.ts` — restructure the solar section render block
3. `frontend/src/bias-correction-inspector.ts` — flip `_expanded` default to `true`
4. `frontend/src/localize/translations/en.json` — add 4 new section label keys
5. `frontend/src/localize/translations/cs.json` — same 4 keys in Czech
6. `frontend/dist/helman-config-editor.js` — rebuild after all source changes
