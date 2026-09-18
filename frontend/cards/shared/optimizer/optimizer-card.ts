import { html, nothing, type TemplateResult } from "lit";

import { stopSummaryToggle } from "../config/sortable-list";
import type { JsonObject, PathSegment } from "../config/types";
import {
    renderConditionGroups,
    type ConditionGroupsOptions,
} from "./optimizer-condition-groups";
import { renderSchemaFields } from "./optimizer-field-renderer";
import type {
    OptimizerConfigBucket,
    OptimizerEditorHost,
    OptimizerSchema,
} from "./optimizer-schema";

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
    /** Which bucket this optimizer lives in -- roots every path the card builds. */
    bucket: OptimizerConfigBucket;
    index: number;
    enabled: boolean;
    /** Card heading — kinds with an appliance target show the appliance's name. */
    title: string;
    /**
     * A validation warning against this optimizer, shown as a badge beside the
     * title. `required_appliance_planned_later` is the one case today: the
     * card itself is where reordering fixes it.
     */
    warning?: string | null;
    /**
     * Whether the card starts open.
     *
     * Collapsed in a list, where the summary line is how you find the one you
     * want. Open where the card *is* the screen -- the edit dialog opens on one
     * optimizer the reader has already chosen, and asking them to click it open
     * would be asking twice.
     */
    open?: boolean;
    renderSvgIcon(path: string, className: string): TemplateResult;
    /** The card's own pipeline row -- drag, enable, remove -- or nothing. */
    renderListActions(basePath: PathSegment[]): TemplateResult;
    /**
     * The card's Visual / YAML switch, drawn beside the pipeline row.
     *
     * Rendered by the editing element rather than by its mounter, because YAML
     * mode edits this one optimizer and nothing else: both hosts get the switch
     * without plumbing anything through.
     */
    modeToggle: TemplateResult;
    conditionGroups: Omit<ConditionGroupsOptions, "host" | "schema" | "bucket" | "optimizerIndex">;
}

export function renderOptimizerCard(options: OptimizerCardOptions): TemplateResult {
    const { host, schema, bucket, index, enabled, title, warning } = options;
    const basePath: PathSegment[] = ["automation", bucket, index];

    return html`
        <details
            class=${`list-card optimizer-card optimizer-card--${enabled ? "enabled" : "disabled"}`}
            data-kind=${schema.kind}
            ?open=${options.open ?? false}
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
                        ${warning
                            ? html`<span class="optimizer-warning-badge" title=${warning}
                                  >${host.t("editor.badges.optimizer_warning")}</span
                              >`
                            : nothing}
                    </div>
                    <div class="summary-actions" @click=${stopSummaryToggle}>
                        ${options.modeToggle} ${options.renderListActions(basePath)}
                    </div>
                </div>
            </summary>
            <div class="appliance-body">${renderCardBody(options, basePath)}</div>
        </details>
    `;
}

/** Everything below the summary in visual mode. */
function renderCardBody(
    options: OptimizerCardOptions,
    basePath: PathSegment[],
): TemplateResult {
    const { host, schema, bucket, index } = options;
    return html`
        <div class="field-grid">
            ${host.renderRequiredTextField(
                [...basePath, "id"],
                "editor.fields.optimizer_id",
                undefined,
                "editor.help.automation_optimizer_id",
            )}
            ${host.renderControllableTargetFields(index, schema.kind)}
            ${renderSchemaFields(host, schema.params, {
                basePath: [...basePath, "params"],
                kind: schema.kind,
            })}
        </div>
        ${schema.conditionTypes.length || schema.params.length
            ? renderConditionGroups({
                  host,
                  schema,
                  bucket,
                  optimizerIndex: index,
                  ...options.conditionGroups,
              })
            : nothing}
    `;
}
