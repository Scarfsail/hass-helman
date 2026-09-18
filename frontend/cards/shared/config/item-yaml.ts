import { html, nothing, type TemplateResult } from "lit";

import type { JsonValue } from "./types";
import { normalizeYamlValue } from "./yaml-codec";

/**
 * The per-item Visual / YAML switch, and the editor behind it.
 *
 * Written for the controllable cards, which have had the switch since the
 * editor's first version, and split out here the moment a second card wanted
 * it: an optimizer's raw YAML is the only way to fix a kind the served schema
 * does not describe, and `helman-optimizer-editor` renders in the config panel
 * *and* in the inspector's edit dialog, neither of which could reach ~150 lines
 * of private methods on the panel.
 *
 * Render helpers over a small host, like `form-fields.ts` and
 * `sortable-list.ts`: the two callers are unrelated elements -- a full-page
 * panel and a card -- and where the mode *lives* differs between them (the
 * panel keys it by list index, the card holds its own), so only the markup and
 * the validation are shared.
 *
 * Section-level YAML scopes (`_renderModeToggle` in the panel) are a different
 * mechanism on a different state and are deliberately left alone.
 *
 * The markup here is paired with `configFormStyles`.
 */

/** All these helpers need of their caller: translations, and HA for the editor. */
export interface ItemYamlHost {
    t(key: string): string;
    /** Handed straight to `ha-yaml-editor`, which is the only reader of it. */
    hass?: unknown;
}

export type ItemEditorMode = "visual" | "yaml";

/** `ha-yaml-editor`'s `value-changed` payload. */
export interface YamlEditorValueChangedDetail {
    value: unknown;
    isValid: boolean;
    errorMsg?: string;
}

/**
 * The two-button switch, for a list item's summary row.
 *
 * It stops the click from reaching the `<summary>` it sits in, which would
 * otherwise collapse the card out from under the mode it just changed.
 */
export function renderItemModeToggle(
    host: ItemYamlHost,
    mode: ItemEditorMode,
    onChange: (mode: ItemEditorMode) => void,
): TemplateResult {
    const button = (target: ItemEditorMode, labelKey: string) => html`
        <button
            type="button"
            class=${mode === target ? "active" : ""}
            aria-pressed=${mode === target}
            @click=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange(target);
            }}
        >
            ${host.t(labelKey)}
        </button>
    `;
    return html`
        <div class="mode-toggle">
            ${button("visual", "editor.mode.visual")}
            ${button("yaml", "editor.mode.yaml")}
        </div>
    `;
}

export interface ItemYamlEditorOptions {
    /** Distinguishes this editor's helper and error ids from its neighbours'. */
    id: string;
    value: JsonValue | undefined;
    /** Already translated, or nothing to show. */
    error?: string | null;
    onChange(detail: YamlEditorValueChangedDetail): void;
}

/** The YAML editor a card shows in place of its body. */
export function renderItemYamlEditor(
    host: ItemYamlHost,
    options: ItemYamlEditorOptions,
): TemplateResult {
    const { id, error } = options;
    const helperId = `${id}-yaml-helper`;
    const errorId = `${id}-yaml-error`;
    return html`
        <div class="yaml-surface">
            <div class="field yaml-field">
                <label>${host.t("editor.yaml.field_label")}</label>
                <div id=${helperId} class="helper">${host.t("editor.yaml.helpers.section")}</div>
                <ha-yaml-editor
                    .hass=${host.hass}
                    .defaultValue=${options.value}
                    .showErrors=${false}
                    aria-describedby=${error ? `${helperId} ${errorId}` : helperId}
                    @value-changed=${(event: CustomEvent<YamlEditorValueChangedDetail>) => {
                        event.stopPropagation();
                        options.onChange(event.detail);
                    }}
                ></ha-yaml-editor>
            </div>
            ${error ? html`<div id=${errorId} class="message error">${error}</div>` : nothing}
        </div>
    `;
}

export type ItemYamlParseResult =
    | { ok: true; value: JsonValue }
    | { ok: false; errorKey: string };

/**
 * What a `value-changed` means for the item being edited.
 *
 * Three ways it can fail, and the caller reports all three the same way: the
 * YAML does not parse, it parses to something JSON cannot carry (a date, a
 * function), or it parses to something other than a mapping. `errorKey` is a
 * translation key; for invalid YAML the caller prefers the editor's own
 * `errorMsg`, which names the line.
 *
 * Every item edited through these helpers -- a controllable, an optimizer -- is
 * an object, so a list, a bare scalar and `null` are all rejected. Accepting one
 * would be unrecoverable rather than merely wrong: the hosts render from
 * `asJsonObject(...)` and draw nothing at all when it is undefined, taking the
 * mode toggle and the YAML surface down with the card and leaving a dirty draft
 * no one can edit their way out of. Pasting a `system_optimizers:` list into an
 * optimizer is the easy way to do it by accident.
 */
export function parseItemYaml(detail: YamlEditorValueChangedDetail): ItemYamlParseResult {
    if (!detail.isValid) {
        return { ok: false, errorKey: "editor.yaml.errors.parse_failed" };
    }
    const normalized = normalizeYamlValue(detail.value);
    if (!normalized.ok) {
        return { ok: false, errorKey: "editor.yaml.errors.non_json_value" };
    }
    if (
        normalized.value === null ||
        typeof normalized.value !== "object" ||
        Array.isArray(normalized.value)
    ) {
        return { ok: false, errorKey: "editor.yaml.errors.expected_object" };
    }
    return { ok: true, value: normalized.value };
}
