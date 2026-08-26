import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { property } from "lit/decorators.js";

import {
    renderHelpIcon,
    setOptionalString,
    setRequiredString,
    stringValue,
    type FormFieldHost,
} from "../cards/shared/config/form-fields";
import {
    MISSING_TRANSLATION_PREFIX,
    getLocalizeFunction,
} from "../cards/shared/config/localize/localize";
import type { PathSegment } from "../cards/shared/config/types";

/**
 * One entity, its settings, and what it currently reads -- as one control.
 *
 * ## The one rule this element exists to keep
 *
 * **It knows nothing about what an entity means.** It is handed a list of
 * facts, each naming a translation token, its placeholders and a severity, and
 * it localizes the token, picks a badge class from the severity, and renders
 * the list in the order it arrived. There is no branch here on a polarity, a
 * sign, a unit or an entity domain, and there must never be one: the moment a
 * reading is derived in TypeScript there are two implementations of it to keep
 * in step, which is exactly what `custom_components/helman/entity_inspection/`
 * exists to prevent. A new evaluation kind on the backend must cost this file
 * nothing but new strings in the translation files.
 *
 * A token with no string in any locale renders *nothing* rather than the raw
 * key. The backend and the editor bundle are versioned independently -- a
 * backend that learns to say something new must not spray key names across an
 * editor that has not caught up.
 *
 * ## What is a frontend concern
 *
 * Which config paths the group *owns* -- the entity path plus the paths of the
 * settings slotted into it -- is declared by the call site, in `ownedPaths`.
 * The backend decides what a path *means*; the call site already writes those
 * fields' labels, types and help keys, so it is where "these belong together"
 * is cheapest to state. `ownedPaths` is what a revert restores.
 *
 * ## What it does not own
 *
 * It does not fetch. One collector in `helman-config-editor.ts` batches every
 * mounted group's path into a single `helman/inspect_entities` call, and
 * pushes the answer down through `inspection`; twenty groups fetching their
 * own status would be twenty round trips per tick. The group announces itself
 * on connect so that collector can poll it without waiting out a whole tick,
 * and asks for a revert by event rather than reaching into the document
 * itself -- the editor is what holds both the draft and the saved document.
 */

/** One localizable statement about a picked entity, as the backend sends it. */
export interface EntityFact {
    id: string;
    token: string;
    params?: Record<string, string | number>;
    severity?: string;
}

/** What one config path currently amounts to. */
export interface EntityInspection {
    entityId: string | null;
    status: string;
    facts: EntityFact[];
}

/** One row of the `helman/inspect_entities` answer. */
export interface EntityInspectionResult {
    key: string;
    draft: EntityInspection | null;
    saved: EntityInspection | null;
}

/**
 * A mounted group announcing itself, so the collector can poll it promptly.
 *
 * There is deliberately **no matching disconnect event**. `disconnectedCallback`
 * runs after the browser has already detached the element (or the ancestor
 * subtree holding it), and an event dispatched on a detached node propagates
 * only within that detached subtree -- it would never reach the panel, and a
 * collector that trusted it would poll for groups that are gone forever. The
 * collector enumerates the groups actually in its own shadow root instead, so
 * "mounted" is read from the DOM rather than from a bookkeeping set that can
 * silently fall out of step.
 */
export const ENTITY_GROUP_CONNECTED = "helman-entity-group-connected";
/** A group asking the editor to restore its owned paths from the saved doc. */
export const ENTITY_GROUP_REVERT = "helman-entity-group-revert";

export interface EntityGroupRegistrationDetail {
    key: string;
    path: PathSegment[];
}

export interface EntityGroupRevertDetail {
    paths: PathSegment[][];
}

/**
 * The id a group is known by in one poll, derived from its own path.
 *
 * A path is already unique within a document, so nothing has to be invented or
 * kept in a counter that a re-render would disturb.
 */
export function entityGroupKey(path: readonly PathSegment[]): string {
    return path.join(".");
}

/** Severity to badge class. The only mapping this element performs. */
const BADGE_CLASSES: Record<string, string> = {
    neutral: "badge-neutral",
    info: "badge-info",
    ok: "badge-success",
    warn: "badge-warning",
};

export class HelmanEntityGroup extends LitElement {
    @property({ attribute: false }) hass: any;
    /** The editor, for translation, reads and writes. */
    @property({ attribute: false }) fieldHost?: FormFieldHost;
    /** Where the entity id lives in the config document. */
    @property({ attribute: false }) path: PathSegment[] = [];
    /** Every path this group owns, entity path included. Revert restores these. */
    @property({ attribute: false }) ownedPaths: PathSegment[][] = [];
    @property({ attribute: false }) labelKey = "";
    @property({ attribute: false }) helpKey?: string;
    @property({ attribute: false }) helperKey?: string;
    @property({ attribute: false }) includeDomains?: string[];
    /** A blank is written through rather than removing the key. */
    @property({ type: Boolean }) required = false;
    /** Pushed down by the editor's collector; null until the first poll lands. */
    @property({ attribute: false }) inspection: EntityInspectionResult | null = null;

    static styles = css`
        :host {
            display: block;
            min-width: 0;
        }

        .entity-group {
            display: grid;
            gap: 10px;
            padding: 12px;
            border-radius: 12px;
            border: 1px solid var(--divider-color);
            background: var(--secondary-background-color);
            min-width: 0;
        }

        .field-label-row {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .field-label-row label {
            flex: 1;
            min-width: 0;
            font-weight: 600;
            font-size: 0.93rem;
        }

        .help-btn {
            flex-shrink: 0;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            border: 1px solid var(--secondary-text-color);
            background: transparent;
            color: var(--secondary-text-color);
            cursor: pointer;
            font: inherit;
            font-size: 0.72rem;
            font-weight: 700;
            line-height: 1;
            padding: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .help-btn:hover {
            border-color: var(--primary-color);
            color: var(--primary-color);
        }

        ha-entity-picker {
            display: block;
            width: 100%;
            min-width: 0;
            max-width: 100%;
        }

        .helper {
            color: var(--secondary-text-color);
            font-size: 0.86rem;
            line-height: 1.4;
        }

        .facts {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
        }

        .badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 0.82rem;
            font-weight: 600;
        }

        .badge-neutral {
            background: var(--card-background-color);
            color: var(--primary-text-color);
            border: 1px solid var(--divider-color);
        }

        .badge-info {
            background: rgba(33, 150, 243, 0.2);
            color: #1976d2;
        }

        .badge-success {
            background: rgba(46, 125, 50, 0.2);
            color: #2e7d32;
        }

        .badge-warning {
            background: rgba(245, 127, 23, 0.2);
            color: #f57f17;
        }

        .saved-reading {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
            padding-top: 8px;
            border-top: 1px dashed var(--divider-color);
        }

        .saved-label {
            color: var(--secondary-text-color);
            font-size: 0.82rem;
        }

        .revert {
            margin-left: auto;
            padding: 4px 12px;
            border: 1px solid var(--divider-color);
            border-radius: 12px;
            background: var(--card-background-color);
            color: var(--primary-text-color);
            font: inherit;
            font-size: 0.82rem;
            cursor: pointer;
        }

        .revert:hover {
            border-color: var(--primary-color);
            color: var(--primary-color);
        }
    `;

    connectedCallback(): void {
        super.connectedCallback();
        this._announce(ENTITY_GROUP_CONNECTED);
    }

    /** The key the editor's collector knows this group by. */
    get key(): string {
        return entityGroupKey(this.path);
    }

    render(): TemplateResult {
        return html`
            <div class="entity-group">
                <div class="field-label-row">
                    <label>${this._t(this.labelKey)}</label>
                    ${this.helpKey && this.fieldHost
                        ? renderHelpIcon(this.fieldHost, this.labelKey, this.helpKey)
                        : nothing}
                </div>
                <ha-entity-picker
                    .hass=${this.hass}
                    .value=${stringValue(this.fieldHost?.getValue(this.path))}
                    .includeDomains=${this.includeDomains}
                    @value-changed=${this._handleEntityChanged}
                ></ha-entity-picker>
                ${this.helperKey
                    ? html`<div class="helper">${this._t(this.helperKey)}</div>`
                    : nothing}
                <slot></slot>
                ${this._renderFacts(this.inspection?.draft ?? null)}
                ${this._renderSaved()}
            </div>
        `;
    }

    private _handleEntityChanged = (event: Event): void => {
        const host = this.fieldHost;
        if (!host) return;
        const nextValue = (event as CustomEvent<{ value?: string }>).detail?.value ?? "";
        if (this.required) {
            setRequiredString(host, this.path, nextValue);
        } else {
            setOptionalString(host, this.path, nextValue);
        }
    };

    private _renderSaved(): TemplateResult | typeof nothing {
        const saved = this.inspection?.saved ?? null;
        if (!saved) {
            return nothing;
        }
        // `saved` is non-null only because the *backend* judged that the stored
        // document reads differently. The editor never compares the two
        // documents itself: only the evaluator knows which keys its answer
        // depends on.
        return html`
            <div class="saved-reading">
                <span class="saved-label">${this._t("editor.entity_group.saved_reading")}</span>
                ${this._renderFacts(saved)}
                <button
                    type="button"
                    class="revert"
                    aria-label=${this._t("editor.entity_group.revert_aria")}
                    @click=${this._handleRevert}
                >${this._t("editor.entity_group.revert")}</button>
            </div>
        `;
    }

    private _handleRevert = (): void => {
        this.dispatchEvent(
            new CustomEvent<EntityGroupRevertDetail>(ENTITY_GROUP_REVERT, {
                detail: { paths: this.ownedPaths.length ? this.ownedPaths : [this.path] },
                bubbles: true,
                composed: true,
            }),
        );
    };

    private _renderFacts(inspection: EntityInspection | null): TemplateResult | typeof nothing {
        const badges = (inspection?.facts ?? [])
            .map((fact) => this._renderFact(fact))
            .filter((badge): badge is TemplateResult => badge !== null);
        if (badges.length === 0) {
            return nothing;
        }
        return html`<div class="facts">${badges}</div>`;
    }

    private _renderFact(fact: EntityFact): TemplateResult | null {
        const text = this._factText(fact);
        if (text === null) {
            return null;
        }
        const badgeClass = BADGE_CLASSES[fact.severity ?? "neutral"] ?? BADGE_CLASSES.neutral;
        return html`<span class="badge ${badgeClass}">${text}</span>`;
    }

    /**
     * A fact as one localized string, or `null` when no locale knows the token.
     *
     * Rendering the raw key would leak backend vocabulary into the UI the first
     * time the two halves ship out of step, so an unknown token is simply not
     * drawn -- its siblings still are.
     */
    private _factText(fact: EntityFact): string | null {
        const key = "editor.entity_status." + fact.token;
        const localize = getLocalizeFunction(this.hass ?? undefined);
        const template = localize(key);
        if (!template || template === key || template.startsWith(MISSING_TRANSLATION_PREFIX)) {
            return null;
        }
        let text = template;
        for (const [name, value] of Object.entries(fact.params ?? {})) {
            text = text.split("{" + name + "}").join(String(value));
        }
        text = text.trim();
        return text ? text : null;
    }

    private _t(key: string): string {
        return this.fieldHost ? this.fieldHost.t(key) : getLocalizeFunction(this.hass ?? undefined)(key);
    }

    private _announce(type: string): void {
        this.dispatchEvent(
            new CustomEvent<EntityGroupRegistrationDetail>(type, {
                detail: { key: this.key, path: this.path },
                bubbles: true,
                composed: true,
            }),
        );
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-entity-group": HelmanEntityGroup;
    }
}

if (!customElements.get("helman-entity-group")) {
    customElements.define("helman-entity-group", HelmanEntityGroup);
}
