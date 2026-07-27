import { html, nothing, type TemplateResult } from "lit";

import type { JsonObject, PathSegment } from "./types";
import {
    fieldHelpKey,
    fieldLabelKey,
    type OptimizerEditorHost,
    type SchemaField,
} from "./optimizer-schema";

/**
 * Schema node -> the form primitives the editor already has.
 *
 * This sits on top of `_renderRequiredTextField` and friends, so it is a
 * re-wiring of the form layer rather than a rewrite of it. Crucially it is the
 * *same* renderer for a kind's master params and for a condition group's
 * override — the override just passes a different base path plus the inherited
 * value as placeholder. That is where the "every optimizer edits the same way"
 * property comes from: it is true by construction, not by discipline.
 */

export interface RenderFieldsOptions {
    /** Base path the field keys hang off, e.g. `[..., "params"]`. */
    basePath: PathSegment[];
    /** Optimizer kind, for per-kind help keys. */
    kind: string;
    /**
     * When set, fields render as *overrides*: nothing is required, and an unset
     * field shows what it inherits from this path as a placeholder.
     */
    inheritFrom?: PathSegment[];
    /** Label key prefix segments, for nested objects (`window` -> `window_start`). */
    parents?: string[];
}

export function renderSchemaFields(
    host: OptimizerEditorHost,
    fields: SchemaField[],
    options: RenderFieldsOptions,
): TemplateResult[] {
    return fields.map((field) => renderSchemaField(host, field, options));
}

export function renderSchemaField(
    host: OptimizerEditorHost,
    field: SchemaField,
    options: RenderFieldsOptions,
): TemplateResult {
    const parents = options.parents ?? [];
    const path: PathSegment[] = [...options.basePath, field.key];
    const inheritFrom = options.inheritFrom
        ? [...options.inheritFrom, field.key]
        : undefined;

    if (field.type === "object") {
        const children = html`${renderSchemaFields(host, field.fields ?? [], {
            ...options,
            basePath: path,
            inheritFrom,
            parents: [...parents, field.key],
        })}`;
        // An optional object is a *mode*, not a set of blank fields: its members
        // are required once it exists, so it gets one toggle rather than letting
        // a half-filled group reach the reader. Overrides are exempt — there
        // nothing is required and the object is only ever partially set.
        if (field.required === false && inheritFrom === undefined) {
            return renderOptionalGroup(host, field, {
                path,
                labelKey: fieldLabelKey(host, field, parents),
                helpKey: fieldHelpKey(host, options.kind, field, parents),
                children,
            });
        }
        // Otherwise objects flatten into the same grid rather than nesting a
        // sub-card: `window.start` reads as one more field, not a form within a
        // form.
        return children;
    }

    const labelKey = fieldLabelKey(host, field, parents);
    const helpKey = fieldHelpKey(host, options.kind, field, parents);
    const inherited =
        inheritFrom === undefined ? undefined : host.getValue(inheritFrom);

    if (field.type === "day_classifications") {
        return host.renderDayClassificationField(path, labelKey, helpKey);
    }
    if (field.type === "time" || field.type === "string") {
        return renderTextField(host, {
            path,
            labelKey,
            helpKey,
            inherited,
            isOverride: inheritFrom !== undefined,
        });
    }
    // number | integer
    if (inheritFrom !== undefined) {
        return host.renderOptionalNumberField(path, labelKey, undefined, helpKey, {
            min: field.minimum,
            max: field.maximum,
        });
    }
    return host.renderRequiredNumberField(
        path,
        labelKey,
        undefined,
        field.type === "integer" ? "1" : "any",
        helpKey,
    );
}

/**
 * A whole optional param object, behind an on/off toggle.
 *
 * Turning it on seeds every child from its schema default (or a blank the user
 * must fill), because the reader requires them all once the object exists.
 */
function renderOptionalGroup(
    host: OptimizerEditorHost,
    field: SchemaField,
    options: {
        path: PathSegment[];
        labelKey: string;
        helpKey: string;
        children: TemplateResult;
    },
): TemplateResult {
    const { path, labelKey, helpKey, children } = options;
    const present = host.getValue(path) !== undefined && host.getValue(path) !== null;
    return html`
        <div class="optional-param-group">
            <div class="field-label-row">
                <label>
                    <input
                        type="checkbox"
                        .checked=${present}
                        @change=${(event: Event) => {
                            const on = (event.currentTarget as HTMLInputElement).checked;
                            host.setValue(path, on ? seedObject(field) : undefined);
                        }}
                    />
                    ${host.t(labelKey)}
                </label>
                ${host.renderHelpIcon(labelKey, helpKey)}
            </div>
            ${present ? children : nothing}
        </div>
    `;
}

function seedObject(field: SchemaField): JsonObject {
    const seeded: JsonObject = {};
    for (const child of field.fields ?? []) {
        if (child.default !== undefined) seeded[child.key] = child.default;
        else if (child.type === "object") seeded[child.key] = seedObject(child);
    }
    return seeded;
}

function renderTextField(
    host: OptimizerEditorHost,
    options: {
        path: PathSegment[];
        labelKey: string;
        helpKey: string;
        inherited: unknown;
        isOverride: boolean;
    },
): TemplateResult {
    const { path, labelKey, helpKey, inherited, isOverride } = options;
    if (!isOverride) {
        return host.renderRequiredTextField(path, labelKey, undefined, helpKey);
    }
    const current = host.getValue(path);
    return html`
        <div class="field">
            <div class="field-label-row">
                <label>${host.t(labelKey)}</label>
                ${host.renderHelpIcon(labelKey, helpKey)}
            </div>
            <input
                .value=${typeof current === "string" ? current : ""}
                placeholder=${inherited === undefined || inherited === null
                    ? ""
                    : String(inherited)}
                @change=${(event: Event) => {
                    const raw = (event.currentTarget as HTMLInputElement).value.trim();
                    host.setValue(path, raw.length ? raw : undefined);
                }}
            />
        </div>
    `;
}

/** A group override's "inherited" hint, shown when nothing in it is set. */
export function renderInheritedNote(
    host: OptimizerEditorHost,
    hasOverride: boolean,
): TemplateResult | typeof nothing {
    if (hasOverride) return nothing;
    return html`<div class="helper">${host.t("editor.helpers.group_params_inherited")}</div>`;
}
