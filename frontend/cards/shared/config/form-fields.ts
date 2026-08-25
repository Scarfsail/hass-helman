import { html, nothing, type TemplateResult } from "lit";

import type { JsonValue, PathSegment } from "./types";

/**
 * The form primitives every Helman config surface draws with.
 *
 * These were methods on `HelmanConfigEditorPanel` until the optimizer card
 * became an element of its own. Plain functions over a small host interface
 * rather than a base class, for the same reason the schema-driven renderers in
 * `../optimizer/` are: the two consumers are unrelated elements -- a full-page
 * panel and a dialog body -- and neither wants the other's lifecycle.
 *
 * The markup here is paired with `configFormStyles`; a host that renders these
 * without adopting that stylesheet gets unstyled boxes.
 */

export interface FormFieldHost {
    /** Translate a key. */
    t(key: string): string;
    getValue(path: PathSegment[]): unknown;
    /** `undefined` removes the path rather than writing a blank. */
    setValue(path: PathSegment[], value: JsonValue | undefined): void;
    /** Open the host's help dialog. */
    openHelp(labelKey: string, contentKey: string): void;
}

/** The day classes an optimizer can be restricted to, in reading order. */
export const DAY_CLASSIFICATIONS = ["surplus", "tight", "deficit"] as const;

export function stringValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number") {
        return String(value);
    }
    return "";
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

/** A field the reader must fill: blank is written through as blank, not removed. */
export function setRequiredString(
    host: FormFieldHost,
    path: PathSegment[],
    rawValue: string,
): void {
    host.setValue(path, rawValue.trim());
}

export function setOptionalString(
    host: FormFieldHost,
    path: PathSegment[],
    rawValue: string,
): void {
    const nextValue = rawValue.trim();
    host.setValue(path, nextValue ? nextValue : undefined);
}

export function setOptionalNumber(
    host: FormFieldHost,
    path: PathSegment[],
    rawValue: string,
): void {
    const normalized = rawValue.trim();
    if (!normalized) {
        host.setValue(path, undefined);
        return;
    }
    const numericValue = Number(normalized);
    host.setValue(path, Number.isFinite(numericValue) ? numericValue : normalized);
}

/**
 * A required number, cleared to `null` rather than removed.
 *
 * The difference matters: an absent key reads as "not configured" and a `null`
 * reads as "configured wrong", and only the second is something validation can
 * complain about.
 */
export function setRequiredNumber(
    host: FormFieldHost,
    path: PathSegment[],
    rawValue: string,
): void {
    const normalized = rawValue.trim();
    if (!normalized) {
        host.setValue(path, null);
        return;
    }
    const numericValue = Number(normalized);
    host.setValue(path, Number.isFinite(numericValue) ? numericValue : normalized);
}

export function renderSvgIcon(path: string, className: string): TemplateResult {
    return html`<svg class=${className} viewBox="0 0 24 24" aria-hidden="true"><path d=${path}/></svg>`;
}

export function renderHelpIcon(
    host: FormFieldHost,
    labelKey: string,
    contentKey: string,
): TemplateResult {
    return html`
        <button
            type="button"
            class="help-btn"
            aria-label=${host.t("editor.help.aria_label")}
            @click=${(event: Event) => {
                event.stopPropagation();
                host.openHelp(labelKey, contentKey);
            }}
        >?</button>
    `;
}

/** The help text itself, over whatever the host is drawing. */
export function renderHelpDialog(
    host: FormFieldHost,
    help: { labelKey: string; contentKey: string } | null,
    close: () => void,
): TemplateResult | typeof nothing {
    if (!help) {
        return nothing;
    }
    return html`
        <div class="help-overlay" @click=${close}>
            <div class="help-dialog" @click=${(event: Event) => event.stopPropagation()}>
                <div class="help-dialog-header">
                    <strong>${host.t(help.labelKey)}</strong>
                    <button
                        type="button"
                        class="help-dialog-close"
                        aria-label=${host.t("editor.help.close")}
                        @click=${close}
                    >✕</button>
                </div>
                <p class="help-dialog-body">${host.t(help.contentKey)}</p>
            </div>
        </div>
    `;
}

function renderLabelRow(
    host: FormFieldHost,
    labelKey: string,
    helpKey?: string,
): TemplateResult {
    return html`
        <div class="field-label-row">
            <label>${host.t(labelKey)}</label>
            ${helpKey ? renderHelpIcon(host, labelKey, helpKey) : nothing}
        </div>
    `;
}

export function renderRequiredTextField(
    host: FormFieldHost,
    path: PathSegment[],
    labelKey: string,
    explicitValue?: unknown,
    helpKey?: string,
): TemplateResult {
    const value = explicitValue === undefined ? host.getValue(path) : explicitValue;
    return html`
        <div class="field">
            ${renderLabelRow(host, labelKey, helpKey)}
            <input
                .value=${stringValue(value)}
                @change=${(event: Event) =>
                    setRequiredString(host, path, (event.currentTarget as HTMLInputElement).value)}
            />
        </div>
    `;
}

export function renderRequiredNumberField(
    host: FormFieldHost,
    path: PathSegment[],
    labelKey: string,
    explicitValue?: unknown,
    step = "any",
    helpKey?: string,
): TemplateResult {
    const value = explicitValue === undefined ? host.getValue(path) : explicitValue;
    return html`
        <div class="field">
            ${renderLabelRow(host, labelKey, helpKey)}
            <input
                type="number"
                .step=${step}
                .value=${stringValue(value)}
                @change=${(event: Event) =>
                    setRequiredNumber(host, path, (event.currentTarget as HTMLInputElement).value)}
            />
        </div>
    `;
}

export function renderOptionalNumberField(
    host: FormFieldHost,
    path: PathSegment[],
    labelKey: string,
    helperKey?: string,
    helpKey?: string,
    options: { min?: number; max?: number; suffix?: string } = {},
): TemplateResult {
    return html`
        <div class="field">
            ${renderLabelRow(host, labelKey, helpKey)}
            <div class="number-input-wrap">
                <input
                    type="number"
                    step="any"
                    min=${options.min ?? nothing}
                    max=${options.max ?? nothing}
                    .value=${stringValue(host.getValue(path))}
                    @change=${(event: Event) =>
                        setOptionalNumber(host, path, (event.currentTarget as HTMLInputElement).value)}
                />
                ${options.suffix
                    ? html`<span class="number-input-suffix">${options.suffix}</span>`
                    : nothing}
            </div>
            ${helperKey ? html`<div class="helper">${host.t(helperKey)}</div>` : nothing}
        </div>
    `;
}

/**
 * A select whose blank state *shows* the default rather than showing nothing.
 *
 * For a setting that always has an effective value, an empty select is a lie:
 * the config is unset, but something is still in force, and the reader cannot
 * see what. So an absent value renders as the default option selected, and
 * there is no blank option to pick -- the field can be changed, never emptied.
 *
 * The config itself stays untouched until the user actually chooses, which is
 * what keeps "unset" and "set to the default" the same document.
 */
export function renderSelectFieldWithDefault(
    host: FormFieldHost,
    path: PathSegment[],
    labelKey: string,
    options: { value: string; label: string }[],
    defaultValue: string,
    helpKey?: string,
): TemplateResult {
    const stored = stringValue(host.getValue(path));
    const shown = stored === "" ? defaultValue : stored;
    return html`
        <div class="field">
            ${renderLabelRow(host, labelKey, helpKey)}
            <select
                .value=${shown}
                @change=${(event: Event) =>
                    setOptionalString(host, path, (event.currentTarget as HTMLSelectElement).value)}
            >
                ${options.map(
                    (option) => html`
                        <option value=${option.value} ?selected=${option.value === shown}>${option.label}</option>
                    `,
                )}
            </select>
        </div>
    `;
}

export function renderOptionalSelectField(
    host: FormFieldHost,
    path: PathSegment[],
    labelKey: string,
    options: { value: string; label: string }[],
    helpKey?: string,
): TemplateResult {
    const value = stringValue(host.getValue(path));
    return html`
        <div class="field">
            ${renderLabelRow(host, labelKey, helpKey)}
            <select
                .value=${value}
                @change=${(event: Event) =>
                    setOptionalString(host, path, (event.currentTarget as HTMLSelectElement).value)}
            >
                <option value=""></option>
                ${options.map(
                    (option) => html`
                        <option value=${option.value} ?selected=${option.value === value}>${option.label}</option>
                    `,
                )}
            </select>
        </div>
    `;
}

/**
 * The day-class picker: a checkbox per class, written back in schema order.
 *
 * Order is normalised rather than preserved from the clicks, so two configs
 * that restrict to the same days compare equal in YAML.
 */
export function renderDayClassificationField(
    host: FormFieldHost,
    path: PathSegment[],
    labelKey: string,
    helpKey: string,
): TemplateResult {
    const raw = host.getValue(path);
    const selected = (Array.isArray(raw) ? raw : []).map((value) => stringValue(value));
    const toggle = (classification: string, checked: boolean): void => {
        const next = checked
            ? [...selected, classification]
            : selected.filter((item) => item !== classification);
        host.setValue(
            path,
            DAY_CLASSIFICATIONS.filter((candidate) => next.includes(candidate)),
        );
    };

    return html`
        <div class="field">
            ${renderLabelRow(host, labelKey, helpKey)}
            <div class="checkbox-group">
                ${DAY_CLASSIFICATIONS.map(
                    (classification) => html`
                        <label class="checkbox-option">
                            <input
                                type="checkbox"
                                .checked=${selected.includes(classification)}
                                @change=${(event: Event) =>
                                    toggle(
                                        classification,
                                        (event.currentTarget as HTMLInputElement).checked,
                                    )}
                            />
                            ${host.t(`editor.values.classification_${classification}`)}
                        </label>
                    `,
                )}
            </div>
        </div>
    `;
}
