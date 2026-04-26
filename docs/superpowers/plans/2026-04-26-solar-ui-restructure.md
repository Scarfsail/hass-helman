# Solar UI Section Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganise the Power Devices → Solar section into a two-level hierarchy (General + Forecast, with Forecast containing General + Bias Correction sub-sections), and restructure the Bias Correction card to expose Configuration, Status and training, and Visual inspector as distinct sibling sections — all UI-only, no YAML schema changes.

**Architecture:** Four new section scopes are added to the scope system; two use path adapters, two use projection adapters (so YAML mode shows only the relevant keys). The solar section render block in the editor is rewritten to use nested `_renderSectionScope` calls matching the new hierarchy. The visual inspector's `_expanded` default flips to `true`.

**Tech Stack:** TypeScript, Lit (web components), esbuild/vite (`npm run build` in `custom_components/helman/frontend/`)

---

## Files

| File | Change |
|---|---|
| `frontend/src/localize/translations/en.json` | Add 4 new `editor.sections` keys |
| `frontend/src/localize/translations/cs.json` | Same 4 keys in Czech |
| `frontend/src/config-editor-scopes.ts` | Add 4 ScopeId values, 4 SECTION_SCOPE_IDS entries, 4 SECTION_ICONS entries, 2 projection member arrays, 4 EDITOR_SCOPES entries, update `solar_bias_correction` parentId |
| `frontend/src/helman-config-editor.ts` | Replace solar section render block (~lines 1505–1652) |
| `frontend/src/bias-correction-inspector.ts` | Flip `_expanded` default to `true` |
| `frontend/dist/helman-config-editor.js` | Rebuilt by `npm run build` |

---

## Task 1 — Add translation keys

**Files:**
- Modify: `frontend/src/localize/translations/en.json`
- Modify: `frontend/src/localize/translations/cs.json`

- [ ] **Step 1: Add 4 keys to `en.json` inside the `editor.sections` object**

  Find the `"bias_correction_status": "Status and training"` line (~line 68) and insert after it:

  ```json
  "solar_general": "General",
  "solar_forecast": "Forecast",
  "solar_forecast_general": "General",
  "bias_correction_config": "Configuration"
  ```

- [ ] **Step 2: Add the same 4 keys to `cs.json` inside `editor.sections`**

  Find `"bias_correction_status": "Stav a trénování"` and insert after it:

  ```json
  "solar_general": "Obecné",
  "solar_forecast": "Předpověď",
  "solar_forecast_general": "Obecné",
  "bias_correction_config": "Konfigurace"
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add frontend/src/localize/translations/en.json frontend/src/localize/translations/cs.json
  git commit -m "i18n(solar-ui): add section label keys for solar restructure"
  ```

---

## Task 2 — Extend the scope system

**Files:**
- Modify: `frontend/src/config-editor-scopes.ts`

- [ ] **Step 1: Add 4 new values to the `ScopeId` union type (lines ~17–35)**

  The union currently ends with `"section:power_devices.solar.bias_correction.slot_invalidation"`. Add four more lines inside the union:

  ```typescript
  | "section:power_devices.solar.general"
  | "section:power_devices.solar.forecast"
  | "section:power_devices.solar.forecast.general"
  | "section:power_devices.solar.bias_correction.config"
  ```

- [ ] **Step 2: Add 4 entries to `SECTION_ICONS` (after the existing `slot_invalidation` entry)**

  ```typescript
  "section:power_devices.solar.general": "M14,17H7V15H14M17,13H7V11H17M17,9H7V7H17M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3Z",
  "section:power_devices.solar.forecast": "M16,11.78L20.24,4.45L21.97,5.45L16.74,14.5L10.23,10.27L5.46,19H22V21H2V3H4V17.54L9.5,8L16,11.78Z",
  "section:power_devices.solar.forecast.general": "M14,17H7V15H14M17,13H7V11H17M17,9H7V7H17M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3Z",
  "section:power_devices.solar.bias_correction.config": "M5,14V3H3V14H5M5,21V16H3V21H5M11,21V10H9V21H11M11,8V3H9V8H11M17,21V14H15V21H17M17,12V3H15V12H17Z",
  ```

- [ ] **Step 3: Add 4 entries to `SECTION_SCOPE_IDS.power_devices` (after `slot_invalidation`)**

  ```typescript
  solar_general: "section:power_devices.solar.general",
  solar_forecast: "section:power_devices.solar.forecast",
  solar_forecast_general: "section:power_devices.solar.forecast.general",
  solar_bias_correction_config: "section:power_devices.solar.bias_correction.config",
  ```

- [ ] **Step 4: Add 2 projection member arrays (after the `AUTOMATION_SETTINGS_MEMBERS` block, before `EDITOR_SCOPES`)**

  ```typescript
  const SOLAR_FORECAST_GENERAL_PROJECTION_MEMBERS = [
    {
      yamlKey: "total_energy_entity_id",
      documentPath: ["power_devices", "solar", "forecast", "total_energy_entity_id"],
    },
    {
      yamlKey: "daily_energy_entity_ids",
      documentPath: ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
    },
  ] satisfies ScopeProjectionMember[];

  const SOLAR_BIAS_CORRECTION_CONFIG_PROJECTION_MEMBERS = [
    { yamlKey: "enabled", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "enabled"] },
    { yamlKey: "min_history_days", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "min_history_days"] },
    { yamlKey: "max_training_window_days", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "max_training_window_days"] },
    { yamlKey: "training_time", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "training_time"] },
    { yamlKey: "clamp_min", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "clamp_min"] },
    { yamlKey: "clamp_max", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "clamp_max"] },
    { yamlKey: "total_energy_entity_id", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "total_energy_entity_id"] },
  ] satisfies ScopeProjectionMember[];
  ```

- [ ] **Step 5: Change `solar_bias_correction` parentId in `EDITOR_SCOPES`**

  Find the `[SECTION_SCOPE_IDS.power_devices.solar_bias_correction]` entry. Change its `parentId` line from:

  ```typescript
  parentId: SECTION_SCOPE_IDS.power_devices.solar,
  ```

  to:

  ```typescript
  parentId: SECTION_SCOPE_IDS.power_devices.solar_forecast,
  ```

- [ ] **Step 6: Add 4 new entries to `EDITOR_SCOPES` (after the `solar_bias_correction` entry, before the `slot_invalidation` entry)**

  ```typescript
  [SECTION_SCOPE_IDS.power_devices.solar_general]: {
    id: SECTION_SCOPE_IDS.power_devices.solar_general,
    kind: "section",
    parentId: SECTION_SCOPE_IDS.power_devices.solar,
    tabId: "power_devices",
    labelKey: "editor.sections.solar_general",
    adapter: createPathScopeAdapter(["power_devices", "solar", "entities"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [SECTION_SCOPE_IDS.power_devices.solar_forecast]: {
    id: SECTION_SCOPE_IDS.power_devices.solar_forecast,
    kind: "section",
    parentId: SECTION_SCOPE_IDS.power_devices.solar,
    tabId: "power_devices",
    labelKey: "editor.sections.solar_forecast",
    adapter: createPathScopeAdapter(["power_devices", "solar", "forecast"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [SECTION_SCOPE_IDS.power_devices.solar_forecast_general]: {
    id: SECTION_SCOPE_IDS.power_devices.solar_forecast_general,
    kind: "section",
    parentId: SECTION_SCOPE_IDS.power_devices.solar_forecast,
    tabId: "power_devices",
    labelKey: "editor.sections.solar_forecast_general",
    adapter: createProjectionScopeAdapter(SOLAR_FORECAST_GENERAL_PROJECTION_MEMBERS),
  },
  [SECTION_SCOPE_IDS.power_devices.solar_bias_correction_config]: {
    id: SECTION_SCOPE_IDS.power_devices.solar_bias_correction_config,
    kind: "section",
    parentId: SECTION_SCOPE_IDS.power_devices.solar_bias_correction,
    tabId: "power_devices",
    labelKey: "editor.sections.bias_correction_config",
    adapter: createProjectionScopeAdapter(SOLAR_BIAS_CORRECTION_CONFIG_PROJECTION_MEMBERS),
  },
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add frontend/src/config-editor-scopes.ts
  git commit -m "feat(solar-ui): add solar section scopes (general, forecast, bias config)"
  ```

---

## Task 3 — Restructure solar render block

**Files:**
- Modify: `frontend/src/helman-config-editor.ts` (lines ~1505–1652)

- [ ] **Step 1: Replace the entire solar `_renderSectionScope` block**

  The block to replace starts at the line:
  ```typescript
  ${this._renderSectionScope(
    SECTION_SCOPE_IDS.power_devices.solar,
  ```
  and ends at the matching `{ initialOpen: false },` / closing `)}` at ~line 1652, just before the battery section starts.

  Replace it with:

  ```typescript
  ${this._renderSectionScope(
    SECTION_SCOPE_IDS.power_devices.solar,
    html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.power_devices.solar_general,
        html`
          <div class="field-grid field-grid--roomy">
            ${this._renderOptionalEntityField(
              ["power_devices", "solar", "entities", "power"],
              "editor.fields.power_entity",
              ["sensor"],
              undefined,
              "editor.help.solar_power_entity",
            )}
            ${this._renderOptionalEntityField(
              ["power_devices", "solar", "entities", "today_energy"],
              "editor.fields.today_energy_entity",
              ["sensor"],
              undefined,
              "editor.help.solar_today_energy_entity",
            )}
            ${this._renderOptionalEntityField(
              [
                "power_devices",
                "solar",
                "entities",
                "remaining_today_energy_forecast",
              ],
              "editor.fields.remaining_today_energy_forecast",
              ["sensor"],
              undefined,
              "editor.help.solar_remaining_today_energy_forecast",
            )}
          </div>
        `,
        { initialOpen: false },
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.power_devices.solar_forecast,
        html`
          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.power_devices.solar_forecast_general,
            html`
              <div class="field-grid field-grid--roomy">
                ${this._renderOptionalEntityField(
                  ["power_devices", "solar", "forecast", "total_energy_entity_id"],
                  "editor.fields.forecast_total_energy_entity",
                  ["sensor"],
                  undefined,
                  "editor.help.solar_forecast_total_energy_entity",
                )}
              </div>

              <div class="list-stack">
                ${dailyEnergyEntityIds.map((value, index) =>
                  this._renderDailyEnergyEntity(value, index, dailyEnergyEntityIds.length),
                )}
              </div>
              <div class="section-footer">
                <button type="button" class="add-button" @click=${this._handleAddDailyEnergyEntity}>
                  ${this._t("editor.actions.add_daily_energy_entity")}
                </button>
              </div>
            `,
            { initialOpen: false },
          )}

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.power_devices.solar_bias_correction,
            html`
              ${this._renderSectionScope(
                SECTION_SCOPE_IDS.power_devices.solar_bias_correction_config,
                html`
                  <div class="field-grid">
                    ${this._renderBooleanField(
                      ["power_devices", "solar", "forecast", "bias_correction", "enabled"],
                      "editor.fields.bias_correction_enabled",
                      false,
                    )}
                    ${this._renderOptionalNumberField(
                      ["power_devices", "solar", "forecast", "bias_correction", "min_history_days"],
                      "editor.fields.bias_correction_min_history_days",
                      "editor.helpers.bias_correction_min_history_days",
                      "editor.help.bias_correction_min_history_days",
                    )}
                    ${this._renderOptionalNumberField(
                      ["power_devices", "solar", "forecast", "bias_correction", "max_training_window_days"],
                      "editor.fields.max_training_window_days",
                      "editor.helpers.bias_correction_max_training_window_days",
                      "editor.help.bias_correction_max_training_window_days",
                    )}
                    ${this._renderOptionalTextField(
                      ["power_devices", "solar", "forecast", "bias_correction", "training_time"],
                      "editor.fields.bias_correction_training_time",
                      "editor.helpers.bias_correction_training_time",
                      "editor.help.bias_correction_training_time",
                    )}
                    ${this._renderOptionalNumberField(
                      ["power_devices", "solar", "forecast", "bias_correction", "clamp_min"],
                      "editor.fields.bias_correction_clamp_min",
                      undefined,
                      "editor.help.bias_correction_clamp_min",
                    )}
                    ${this._renderOptionalNumberField(
                      ["power_devices", "solar", "forecast", "bias_correction", "clamp_max"],
                      "editor.fields.bias_correction_clamp_max",
                      undefined,
                      "editor.help.bias_correction_clamp_max",
                    )}
                    ${this._renderOptionalEntityField(
                      ["power_devices", "solar", "forecast", "bias_correction", "total_energy_entity_id"],
                      "editor.fields.bias_correction_total_energy_entity",
                      ["sensor"],
                      undefined,
                      "editor.help.bias_correction_total_energy_entity",
                    )}
                  </div>

                  ${this._renderSectionScope(
                    SECTION_SCOPE_IDS.power_devices.slot_invalidation,
                    html`
                      <div class="field-grid">
                        ${this._renderOptionalNumberField(
                          [
                            "power_devices",
                            "solar",
                            "forecast",
                            "bias_correction",
                            "slot_invalidation",
                            "max_battery_soc_percent",
                          ],
                          "editor.fields.bias_correction_slot_invalidation_max_battery_soc_percent",
                          "editor.helpers.bias_correction_slot_invalidation_max_battery_soc_percent",
                          "editor.help.bias_correction_slot_invalidation_max_battery_soc_percent",
                          { min: 0, max: 100, suffix: "%" },
                        )}
                        ${this._renderOptionalEntityField(
                          [
                            "power_devices",
                            "solar",
                            "forecast",
                            "bias_correction",
                            "slot_invalidation",
                            "export_enabled_entity_id",
                          ],
                          "editor.fields.bias_correction_slot_invalidation_export_enabled_entity_id",
                          ["binary_sensor", "input_boolean", "switch"],
                          undefined,
                          "editor.help.bias_correction_slot_invalidation_export_enabled_entity_id",
                        )}
                      </div>
                    `,
                    { initialOpen: false },
                  )}
                `,
                { initialOpen: false },
              )}

              <div class="list-card">
                <div class="card-title" style="margin-bottom: 16px;">
                  <strong>${this._t("editor.sections.bias_correction_status")}</strong>
                  <span class="card-subtitle">${this._t("bias_correction.status_panel.subtitle")}</span>
                </div>
                <helman-bias-correction-status .hass=${this.hass}></helman-bias-correction-status>
              </div>
            `,
            { initialOpen: false },
          )}
        `,
        { initialOpen: false },
      )}
    `,
    { initialOpen: false },
  )}
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add frontend/src/helman-config-editor.ts
  git commit -m "feat(solar-ui): restructure solar section into general + forecast hierarchy"
  ```

---

## Task 4 — Visual inspector starts expanded

**Files:**
- Modify: `frontend/src/bias-correction-inspector.ts:45`

- [ ] **Step 1: Flip the `_expanded` default**

  Line 45 currently reads:
  ```typescript
  @state() private _expanded = false;
  ```

  Change to:
  ```typescript
  @state() private _expanded = true;
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add frontend/src/bias-correction-inspector.ts
  git commit -m "feat(solar-ui): visual inspector expanded by default"
  ```

---

## Task 5 — Build and verify

**Files:**
- Modify: `frontend/dist/helman-config-editor.js` (auto-generated)

- [ ] **Step 1: Build the frontend bundle**

  Run from the `frontend/` directory:

  ```bash
  cd custom_components/helman/frontend && npm run build
  ```

  Expected: Build completes with no TypeScript errors. The `dist/helman-config-editor.js` file is updated.

  If TypeScript errors appear — likely causes and fixes:
  - `Type '"section:power_devices.solar.general"' is not assignable to type 'ScopeId'` → the ScopeId union in Task 2 Step 1 is missing one of the 4 new values.
  - `Property 'solar_general' does not exist` → the SECTION_SCOPE_IDS entry from Task 2 Step 3 is missing.
  - `Object literal may only specify known properties ... 'solar_forecast_general'` → the EDITOR_SCOPES `satisfies` constraint fails because a ScopeId is missing from the union.

- [ ] **Step 2: Manually verify in the browser**

  Open the Helman config editor → Power Devices tab. Confirm:
  1. Solar section is collapsed by default.
  2. Opening Solar shows two sub-sections: **General** and **Forecast** — both collapsed.
  3. Opening **General** shows the three entity fields (power, today energy, remaining today energy forecast).
  4. Opening **Forecast** shows two sub-sections: **General** and **Bias Correction** — both collapsed.
  5. Opening Forecast → **General** shows the total energy entity field + daily energy entity list + Add button.
  6. Opening Forecast → **Bias Correction** shows two items: a **Configuration** section (collapsed) and a **Status and training** card.
  7. Opening **Configuration** shows the 7 config fields + nested **Invalidate training slot data** sub-section.
  8. The **Status and training** card shows the status rows, Train now / Refresh buttons, and the visual inspector — and the inspector is **open by default**.
  9. YAML mode toggle works on each section: switching Configuration to YAML shows only the 7 bias_correction config keys; switching Forecast → General to YAML shows only `total_energy_entity_id` and `daily_energy_entity_ids`.
  10. No regressions on other tabs (General, Scheduler, Automation, Appliances).

- [ ] **Step 3: Commit the built bundle**

  ```bash
  git add frontend/dist/helman-config-editor.js
  git commit -m "build(solar-ui): rebuild bundle after solar section restructure"
  ```
