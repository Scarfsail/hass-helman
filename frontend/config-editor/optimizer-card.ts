import { html, nothing, type TemplateResult } from "lit";

import type { JsonObject, PathSegment } from "./types";
import {
    renderConditionGroups,
    type ConditionGroupsOptions,
} from "./optimizer-condition-groups";
import { renderSchemaFields } from "./optimizer-field-renderer";
import type { OptimizerEditorHost, OptimizerSchema } from "./optimizer-schema";

/**
 * One card renderer for every optimizer kind.
 *
 * The five per-kind renderers it replaces were ~90 lines each and diverged in
 * the small ways hand-written duplicates always do. Editing any optimizer feels
 * the same now because the layout is *derived* from the served schema — a sixth
 * kind needs no new TypeScript at all.
 */

export const OPTIMIZER_CHEVRON = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";

export interface OptimizerCardOptions {
    host: OptimizerEditorHost;
    schema: OptimizerSchema;
    optimizer: JsonObject;
    index: number;
    total: number;
    enabled: boolean;
    /** Card heading — kinds with an appliance target show the appliance's name. */
    title: string;
    renderSvgIcon(path: string, className: string): TemplateResult;
    renderListActions(
        basePath: PathSegment[],
        index: number,
        total: number,
        enabled: boolean,
    ): TemplateResult;
    conditionGroups: Omit<ConditionGroupsOptions, "host" | "schema" | "optimizerIndex">;
}

export function renderOptimizerCard(options: OptimizerCardOptions): TemplateResult {
    const { host, schema, index, total, enabled, title } = options;
    const basePath: PathSegment[] = ["automation", "optimizers", index];

    return html`
        <details
            class=${`list-card optimizer-card optimizer-card--${enabled ? "enabled" : "disabled"}`}
            data-kind=${schema.kind}
        >
            <summary>
                <div class="appliance-summary-row">
                    <div class="appliance-summary-left">
                        ${options.renderSvgIcon(OPTIMIZER_CHEVRON, "appliance-chevron")}
                        <div class="card-title">
                            <strong>${title}</strong>
                            <span class="card-subtitle">
                                ${host.t(`editor.values.${schema.kind}`)}
                            </span>
                        </div>
                    </div>
                    ${options.renderListActions(basePath, index, total, enabled)}
                </div>
            </summary>
            <div class="appliance-body">
                <div class="field-grid">
                    ${host.renderRequiredTextField(
                        [...basePath, "id"],
                        "editor.fields.optimizer_id",
                        undefined,
                        "editor.help.automation_optimizer_id",
                    )}
                    ${host.renderApplianceTargetFields(index, schema.kind)}
                    ${renderSchemaFields(host, schema.params, {
                        basePath: [...basePath, "params"],
                        kind: schema.kind,
                    })}
                </div>
                ${schema.conditionTypes.length || schema.params.length
                    ? renderConditionGroups({
                          host,
                          schema,
                          optimizerIndex: index,
                          ...options.conditionGroups,
                      })
                    : nothing}
            </div>
        </details>
    `;
}
