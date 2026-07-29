import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";

import { asJsonArray, asJsonObject } from "./config-document";
import type { PathSegment } from "./types";
import {
    renderInheritedNote,
    renderSchemaFields,
} from "./optimizer-field-renderer";
import {
    fieldChoiceLabel,
    fieldHelpKey,
    fieldLabelKey,
    type OptimizerEditorHost,
    type OptimizerSchema,
} from "./optimizer-schema";

/** Rotates when the group opens, so the marker and the name share one line. */
const GROUP_CHEVRON = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
const PENCIL_ICON =
    "M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z";

/**
 * The repeatable list of ORed condition groups on an optimizer card.
 *
 * Widgets are keyed by condition *type*, not by optimizer kind, so the
 * day-classification picker is one component wherever `run_when` appears and
 * the numeric thresholds share one widget. Adding a condition type to a kind is
 * one entry in a Python tuple — nothing here changes.
 *
 * Zero groups is an invalid automation, so removing the last group is disabled
 * and new optimizers are seeded with one. The UI cannot reach the unsavable
 * state in the first place.
 */

export interface ConditionGroupsOptions {
    host: OptimizerEditorHost;
    schema: OptimizerSchema;
    /** Index of the optimizer inside `automation.optimizers`. */
    optimizerIndex: number;
    addGroup(): void;
    removeGroup(groupIndex: number): void;
    moveGroup(groupIndex: number, targetIndex: number): void;
}

export function renderConditionGroups(
    options: ConditionGroupsOptions,
): TemplateResult {
    const { host, optimizerIndex } = options;
    const groupsPath: PathSegment[] = [
        "automation",
        "optimizers",
        optimizerIndex,
        "conditions",
    ];
    const groups = asJsonArray(host.getValue(groupsPath)) ?? [];

    return html`
        <div class="condition-groups">
            <div class="condition-groups-head">
                <strong>${host.t("editor.fields.condition_groups")}</strong>
                <span class="helper">${host.t("editor.helpers.condition_groups")}</span>
            </div>
            ${groups.map((_group, groupIndex) =>
                renderGroup(options, groupsPath, groupIndex, groups.length),
            )}
            <button type="button" class="add-button" @click=${() => options.addGroup()}>
                ${host.t("editor.actions.add_condition_group")}
            </button>
        </div>
    `;
}

function renderGroup(
    options: ConditionGroupsOptions,
    groupsPath: PathSegment[],
    groupIndex: number,
    total: number,
): TemplateResult {
    const { host, schema } = options;
    const groupPath: PathSegment[] = [...groupsPath, groupIndex];
    const group = asJsonObject(host.getValue(groupPath)) ?? {};
    const overridePath: PathSegment[] = [...groupPath, "params"];
    const hasOverride = Object.keys(asJsonObject(group.params) ?? {}).length > 0;
    const paramsPath: PathSegment[] = [
        "automation",
        "optimizers",
        options.optimizerIndex,
        "params",
    ];
    // A param the reader refuses per group must not appear in the override form
    // — offering it would produce a config that cannot be saved. The schema is
    // the single source for that, so nothing here names a field.
    const overridableParams = schema.params.filter(
        (field) => field.overridable !== false,
    );

    return html`
        <details class="condition-group" ?open=${groupIndex === 0}>
            <summary>
                <div class="appliance-summary-row">
                    <div class="appliance-summary-left">
                        ${host.renderSvgIcon(GROUP_CHEVRON, "appliance-chevron")}
                        ${renderGroupName(options, groupPath, groupIndex)}
                    </div>
                    <div class="list-actions" @click=${stopSummaryToggle}>
                        <button
                            type="button"
                            ?disabled=${groupIndex === 0}
                            @click=${() => options.moveGroup(groupIndex, groupIndex - 1)}
                        >${host.t("editor.actions.up")}</button>
                        <button
                            type="button"
                            ?disabled=${groupIndex === total - 1}
                            @click=${() => options.moveGroup(groupIndex, groupIndex + 1)}
                        >${host.t("editor.actions.down")}</button>
                        <button
                            type="button"
                            class="danger remove-condition-group"
                            ?disabled=${total <= 1}
                            title=${total <= 1
                                ? host.t("editor.helpers.last_condition_group")
                                : ""}
                            @click=${() => options.removeGroup(groupIndex)}
                        >${host.t("editor.actions.remove")}</button>
                    </div>
                </div>
            </summary>
            <div class="condition-group-body">
                <div class="field-grid">
                    ${schema.conditionTypes.map((condition) =>
                        renderConditionWidget(host, schema, condition, groupPath),
                    )}
                </div>

                ${overridableParams.length
                    ? html`
                          <details class="param-override" ?open=${hasOverride}>
                              <summary>${host.t("editor.fields.group_params_override")}</summary>
                              <div class="condition-group-body">
                                  ${renderInheritedNote(host, hasOverride)}
                                  <div class="field-grid">
                                      ${renderSchemaFields(host, overridableParams, {
                                          basePath: overridePath,
                                          kind: schema.kind,
                                          inheritFrom: paramsPath,
                                      })}
                                  </div>
                              </div>
                          </details>
                      `
                    : nothing}

                <details class="condition-section" ?open=${(asJsonArray(group.custom) ?? []).length > 0}>
                    <summary>${host.t("editor.fields.custom_conditions")}</summary>
                    <div class="condition-body">
                        ${host.renderCustomConditions([...groupPath, "custom"])}
                        <div class="helper">${host.t("editor.helpers.custom_conditions")}</div>
                    </div>
                </details>
            </div>
        </details>
    `;
}

/**
 * The group's name in the summary line: a label with an edit affordance, or the
 * input once that is clicked.
 *
 * Renaming lives here rather than in a field in the body because the name *is*
 * the group's heading — editing it anywhere else means looking at one string
 * while typing another.
 */
function renderGroupName(
    options: ConditionGroupsOptions,
    groupPath: PathSegment[],
    groupIndex: number,
): TemplateResult {
    const { host, optimizerIndex } = options;
    const group = asJsonObject(host.getValue(groupPath)) ?? {};
    const name = typeof group.name === "string" ? group.name : "";
    // The position-based label a group falls back to. It is what the input is
    // seeded with, so renaming starts from what the user is looking at rather
    // than from an empty box.
    const displayed = name || defaultGroupName(host, groupIndex);
    const editing =
        host.editingGroupName?.optimizerIndex === optimizerIndex &&
        host.editingGroupName?.groupIndex === groupIndex;

    // Escape swaps the input back for the label, and removing a focused input
    // fires `blur` on the way out — which would commit the text the user just
    // abandoned. One flag per render, so it lives exactly as long as this input.
    let abandoned = false;

    const commit = (raw: string): void => {
        if (abandoned) return;
        const trimmed = raw.trim();
        // Committing the untouched fallback keeps the name implicit, so a group
        // that is still "Group 2" renumbers when it moves instead of freezing.
        const next =
            trimmed.length && trimmed !== defaultGroupName(host, groupIndex)
                ? trimmed
                : undefined;
        host.setValue([...groupPath, "name"], next);
        host.setEditingGroupName(null);
    };

    if (!editing) {
        return html`
            <strong class="condition-group-name">${displayed}</strong>
            <button
                type="button"
                class="icon-button rename-condition-group"
                aria-label=${host.t("editor.actions.rename_condition_group")}
                title=${host.t("editor.actions.rename_condition_group")}
                @click=${(event: Event) => {
                    stopSummaryToggle(event);
                    host.setEditingGroupName({ optimizerIndex, groupIndex });
                }}
            >
                ${host.renderSvgIcon(PENCIL_ICON, "icon-button-glyph")}
            </button>
        `;
    }

    return html`
        <input
            class="condition-group-name-input"
            .value=${displayed}
            ${ref((element) => {
                const input = element as HTMLInputElement | undefined;
                if (!input) return;
                // Next frame, not now: `ref` fires while the element is still
                // being committed, and focusing a not-yet-connected node is a
                // no-op. Re-checked inside because `ref` also runs on every
                // later render, and re-selecting mid-edit would fight the caret.
                requestAnimationFrame(() => {
                    if (input.isConnected && !input.matches(":focus")) input.select();
                });
            })}
            @click=${stopSummaryToggle}
            @blur=${(event: Event) =>
                commit((event.currentTarget as HTMLInputElement).value)}
            @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    commit((event.currentTarget as HTMLInputElement).value);
                } else if (event.key === "Escape") {
                    event.preventDefault();
                    abandoned = true;
                    host.setEditingGroupName(null);
                }
            }}
        />
    `;
}

function defaultGroupName(host: OptimizerEditorHost, groupIndex: number): string {
    return host.tFormat("editor.dynamic.condition_group", { index: groupIndex + 1 });
}

function renderConditionWidget(
    host: OptimizerEditorHost,
    schema: OptimizerSchema,
    condition: { key: string; field: import("./optimizer-schema").SchemaField },
    groupPath: PathSegment[],
): TemplateResult {
    const path: PathSegment[] = [...groupPath, condition.key];
    const labelKey = fieldLabelKey(host, condition.field);
    const helpKey = fieldHelpKey(host, schema.kind, condition.field);
    if (condition.field.type === "day_classifications") {
        return host.renderDayClassificationField(path, labelKey, helpKey);
    }
    // Dispatch on `choices` before type, because a choices field is a picker
    // whatever it is made of. Falling through to the number input rendered
    // `ensure_self_sustainability` — a string of "soft" | "strict" — as a
    // numeric box the value could not be typed into at all.
    if (condition.field.choices?.length) {
        return host.renderOptionalSelectField(
            path,
            labelKey,
            condition.field.choices.map((choice) => ({
                value: choice,
                label: fieldChoiceLabel(host, condition.field, choice),
            })),
            helpKey,
        );
    }
    return host.renderRequiredNumberField(
        path,
        labelKey,
        host.getValue(path) ?? condition.field.default,
        condition.field.type === "integer" ? "1" : "any",
        helpKey,
    );
}

function stopSummaryToggle(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
}
