import type { TemplateResult } from "lit";
import type { JsonObject, JsonValue, PathSegment } from "./types";
import { MISSING_TRANSLATION_PREFIX } from "./localize/localize";

/**
 * The optimizer config schema, served by the backend over
 * `helman/get_optimizer_schema`.
 *
 * Defined once, in Python, and read by both the config reader and this editor.
 * A hand-maintained parallel schema here would guarantee drift between what the
 * editor lets you build and what the reader accepts — which is how the editor
 * came to render a `hold_action` field no Python code has ever read.
 */

export interface SchemaField {
    key: string;
    type: "number" | "integer" | "time" | "string" | "day_classifications" | "object";
    required?: boolean;
    default?: JsonValue;
    minimum?: number;
    minimumExclusive?: boolean;
    maximum?: number;
    choices?: string[];
    fields?: SchemaField[];
}

export interface SchemaConditionType {
    key: string;
    scope: "slot" | "day" | "run";
    field: SchemaField;
}

export interface OptimizerSchema {
    kind: string;
    target: SchemaField[];
    params: SchemaField[];
    conditionTypes: SchemaConditionType[];
    /** What "Add <kind>" seeds, authored beside the schema in Python. */
    newDraft: JsonObject;
}

export interface OptimizerSchemaDocument {
    version: number;
    kinds: OptimizerSchema[];
}

interface HassLike {
    callWS<T>(request: { type: string }): Promise<T>;
}

/**
 * Fetch the schema once per editor session.
 *
 * The editor already awaits a config fetch on open, so this costs no extra
 * user-visible latency. A failure resolves to `null` rather than throwing: the
 * card falls back to a raw view of each optimizer instead of rendering nothing.
 */
export async function fetchOptimizerSchema(
    hass: HassLike | undefined,
): Promise<OptimizerSchemaDocument | null> {
    if (!hass) return null;
    try {
        return await hass.callWS<OptimizerSchemaDocument>({
            type: "helman/get_optimizer_schema",
        });
    } catch {
        return null;
    }
}

/**
 * The editor capabilities the schema-driven renderers need.
 *
 * An interface rather than a subclass so the renderers stay plain functions —
 * they are about turning schema nodes into the form primitives the editor
 * already has, not about owning editor state.
 */
export interface OptimizerEditorHost {
    /** Translate a key. Falls back visibly, so a new field cannot ship unnamed. */
    t(key: string): string;
    tFormat(key: string, values: Record<string, string | number>): string;
    getValue(path: PathSegment[]): unknown;
    setValue(path: PathSegment[], value: JsonValue | undefined): void;

    renderRequiredTextField(
        path: PathSegment[],
        labelKey: string,
        explicitValue?: unknown,
        helpKey?: string,
    ): TemplateResult;
    renderRequiredNumberField(
        path: PathSegment[],
        labelKey: string,
        explicitValue?: unknown,
        step?: string,
        helpKey?: string,
    ): TemplateResult;
    renderOptionalNumberField(
        path: PathSegment[],
        labelKey: string,
        helperKey?: string,
        helpKey?: string,
        options?: { min?: number; max?: number; suffix?: string },
    ): TemplateResult;
    renderHelpIcon(labelKey: string, contentKey: string): TemplateResult;
    renderDayClassificationField(
        path: PathSegment[],
        labelKey: string,
        helpKey: string,
    ): TemplateResult;
    /** The appliance picker, which needs live registry state the schema cannot carry. */
    renderApplianceTargetFields(
        optimizerIndex: number,
        kind: string,
    ): TemplateResult | typeof import("lit").nothing;
    /** Home Assistant's own condition builder, for a group's `custom` list. */
    renderCustomConditions(path: PathSegment[]): TemplateResult;
}

/**
 * Translation key for a field's label, most specific first.
 *
 * `window.start` looks for `window_start` before `start`; `battery_first.margin_pct`
 * finds the shared `margin_pct`. So a field that means the same thing everywhere
 * needs one string, not five, while a field that needs disambiguating can have it.
 */
export function fieldLabelKey(
    host: OptimizerEditorHost,
    field: SchemaField,
    parents: string[] = [],
): string {
    return firstTranslated(host, "editor.fields", [
        [...parents, field.key].join("_"),
        field.key,
    ]);
}

/**
 * Translation key for a field's help text: per kind, then shared.
 *
 * The last candidate is returned even when it too is missing, so an
 * undocumented field renders the loud missing-translation marker rather than
 * silently looking finished.
 */
export function fieldHelpKey(
    host: OptimizerEditorHost,
    kind: string,
    field: SchemaField,
    parents: string[] = [],
): string {
    const qualified = [...parents, field.key].join("_");
    return firstTranslated(host, "editor.help", [
        `${kind}_${qualified}`,
        `${kind}_${field.key}`,
        qualified,
        field.key,
    ]);
}

function firstTranslated(
    host: OptimizerEditorHost,
    prefix: string,
    names: string[],
): string {
    const keys = names.map((name) => `${prefix}.${name}`);
    return keys.find((key) => isTranslated(host, key)) ?? keys[keys.length - 1];
}

/** Whether a key resolves to real text rather than the visible missing-key marker. */
function isTranslated(host: OptimizerEditorHost, key: string): boolean {
    return !host.t(key).startsWith(MISSING_TRANSLATION_PREFIX);
}
