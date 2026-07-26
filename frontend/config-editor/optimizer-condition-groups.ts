import { html, nothing, type TemplateResult } from "lit";

import { asJsonArray, asJsonObject } from "./config-document";
import type { PathSegment } from "./types";
import {
    renderInheritedNote,
    renderSchemaFields,
} from "./optimizer-field-renderer";
import {
    fieldHelpKey,
    fieldLabelKey,
    type OptimizerEditorHost,
    type OptimizerSchema,
} from "./optimizer-schema";

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
    const name = typeof group.name === "string" ? group.name : "";
    const overridePath: PathSegment[] = [...groupPath, "params"];
    const hasOverride = Object.keys(asJsonObject(group.params) ?? {}).length > 0;
    const paramsPath: PathSegment[] = [
        "automation",
        "optimizers",
        options.optimizerIndex,
        "params",
    ];

    return html`
        <details class="condition-group" ?open=${groupIndex === 0}>
            <summary>
                <div class="appliance-summary-row">
                    <div class="appliance-summary-left">
                        <strong>
                            ${name ||
                            host.tFormat("editor.dynamic.condition_group", {
                                index: groupIndex + 1,
                            })}
                        </strong>
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
                    ${host.renderRequiredTextField(
                        [...groupPath, "name"],
                        "editor.fields.condition_group_name",
                        name,
                        "editor.help.condition_group_name",
                    )}
                    ${schema.conditionTypes.map((condition) =>
                        renderConditionWidget(host, schema, condition, groupPath),
                    )}
                </div>

                ${schema.params.length
                    ? html`
                          <details class="param-override" ?open=${hasOverride}>
                              <summary>${host.t("editor.fields.group_params_override")}</summary>
                              <div class="condition-group-body">
                                  ${renderInheritedNote(host, hasOverride)}
                                  <div class="field-grid">
                                      ${renderSchemaFields(host, schema.params, {
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
