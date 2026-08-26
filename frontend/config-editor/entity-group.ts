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
 * ## What a revert restores
 *
 * Exactly the paths the backend says the reading depended on, which arrive as
 * `dependsOn` on the inspection itself. The call site decides what *renders*
 * inside a group, but it is in no position to say what the reading was made
 * of: the house forecast group holds a training window in its slot because it
 * is the same entity's setting, and nothing about the badge depends on it.
 * Reverting it along with the rest would be a silent edit -- a value that
 * could never have made the revert control appear, reset by pressing it.
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
    /**
     * The config paths this reading was made of, as the backend read them.
     *
     * Not a list of everything in the group: a setting that rides in the slot
     * without shaping the reading is absent, and a revert therefore leaves it
     * alone. Only the evaluator knows the difference, which is why the list
     * comes from there rather than from the call site.
     */
    dependsOn?: PathSegment[][];
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
            /*
             * A faint wash of the theme's own accent over the card ground,
             * rather than a fixed colour: --rgb-primary-color is what HA gives
             * a theme to tint with, so a group reads as the same "picked
             * entity" surface on a light theme and a dark one instead of the
             * bright silver --secondary-background-color paints on a dark one.
             * The overlay is a gradient rather than an rgba background-color
             * because it has to composite over a *known* ground -- an alpha
             * colour would blend with whatever section happens to be behind it.
             */
            background-color: var(--card-background-color);
            background-image: linear-gradient(
                rgba(var(--rgb-primary-color, 3, 169, 244), 0.09),
                rgba(var(--rgb-primary-color, 3, 169, 244), 0.09)
            );
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
            /*
             * Declared on every badge, transparent by default, so that the
             * button form below can set nothing about the border and the
             * colour classes keep owning it. A reset that touched border
             * would have to out-specify them, and then a neutral badge would
             * lose its outline the moment it became clickable.
             */
            border: 1px solid transparent;
            border-radius: 12px;
            font-size: 0.82rem;
            font-weight: 600;
        }

        /*
         * Severity is carried by the fill and the outline, never by the text.
         *
         * These used to set the severity hue as the *text* colour over a wash
         * of itself -- a mid-tone on a pale tint. Measured against the group
         * ground that lands at 2.2:1 for a warning on a light theme and 2.8:1
         * for info on a dark one, well under the 4.5:1 that text this size
         * needs, and no alpha nudge fixes both themes at once because the two
         * grounds move in opposite directions. The text is now the theme's own
         * text colour, which is the one colour guaranteed to read on the
         * theme's own ground, and the four severities stay apart by their fill
         * and a 1px outline of the full-strength colour.
         *
         * The hues come from HA's state variables so a theme restyles them
         * with everything else; the fallbacks are HA's own defaults, so a theme
         * that defines neither looks exactly as it would have.
         */
        .badge-neutral {
            background: var(--card-background-color);
            color: var(--primary-text-color);
            border-color: var(--divider-color);
        }

        .badge-info {
            background: rgba(var(--rgb-info-color, 3, 155, 229), 0.18);
            color: var(--primary-text-color);
            border-color: var(--info-color, #039be5);
        }

        .badge-success {
            background: rgba(var(--rgb-success-color, 67, 160, 71), 0.18);
            color: var(--primary-text-color);
            border-color: var(--success-color, #43a047);
        }

        .badge-warning {
            background: rgba(var(--rgb-warning-color, 255, 166, 0), 0.18);
            color: var(--primary-text-color);
            border-color: var(--warning-color, #ffa600);
        }

        /*
         * A fact that names an entity is a way into that entity.
         *
         * A real <button>, not a span with a click handler: this opens a
         * dialog, so it has to be reachable by keyboard and announce itself as
         * something that does. Only the properties the UA gets wrong are
         * reset -- background, colour and border stay with the severity
         * classes, which is what keeps a clickable badge looking exactly like
         * the one beside it that has nothing to open.
         */
        button.badge {
            font-family: inherit;
            line-height: inherit;
            text-align: inherit;
            cursor: pointer;
        }

        button.badge:hover {
            border-color: var(--primary-color);
        }

        button.badge:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: 2px;
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
                // The backend's own list of what it read. The fallback covers a
                // response that carries none -- an older backend, or a path
                // with no evaluator -- where the entity itself is all this
                // element can honestly claim to own.
                detail: { paths: this._revertPaths() },
                bubbles: true,
                composed: true,
            }),
        );
    };

    /** The paths a revert writes: what the reading was actually made of. */
    private _revertPaths(): PathSegment[][] {
        const reported =
            this.inspection?.draft?.dependsOn ?? this.inspection?.saved?.dependsOn;
        return reported?.length ? reported.map((path) => [...path]) : [this.path];
    }

    /**
     * One row of badges, all of them about the same entity.
     *
     * The entity id comes from the *inspection* rather than from a fact,
     * which is what lets a draft row and a saved row open different entities:
     * changing the picker is exactly the edit that makes the two differ, and
     * the saved row is then the only place the old entity is still named.
     */
    private _renderFacts(inspection: EntityInspection | null): TemplateResult | typeof nothing {
        const entityId = stringValue(inspection?.entityId ?? "");
        const badges = (inspection?.facts ?? [])
            .map((fact) => this._renderFact(fact, entityId))
            .filter((badge): badge is TemplateResult => badge !== null);
        if (badges.length === 0) {
            return nothing;
        }
        return html`<div class="facts">${badges}</div>`;
    }

    /**
     * A fact, and -- when it is the entity's value -- a way into the entity.
     *
     * Only the value badge opens the dialog. The reading badges beside it
     * ("Charging", "206 d historie", the polarity note) are statements about
     * the entity, not the entity, and making them all controls put four tab
     * stops on one row that all did the same thing.
     *
     * Gating on the fact's `id` is not this element interpreting a fact: the
     * backend assigns that identity itself -- `value_fact()` and `text_fact()`
     * both emit `value`, readings are `reading`, history is `history` and
     * problems are `state` -- so this reads a label rather than inferring one.
     * Nothing here decides what a badge *means*; it only asks which one the
     * backend called the value.
     *
     * An inspection with no entity id -- an unset picker, a path no evaluator
     * claims -- renders a plain span even for its value. A dialog opened on
     * nothing is worse than no dialog, and a control that does nothing when
     * pressed is worse still.
     */
    private _renderFact(fact: EntityFact, entityId: string): TemplateResult | null {
        const text = this._factText(fact);
        if (text === null) {
            return null;
        }
        const badgeClass = BADGE_CLASSES[fact.severity ?? "neutral"] ?? BADGE_CLASSES.neutral;
        if (!entityId || fact.id !== "value") {
            return html`<span class="badge ${badgeClass}">${text}</span>`;
        }
        return html`
            <button
                type="button"
                class="badge ${badgeClass}"
                aria-label=${this._moreInfoLabel(entityId)}
                title=${entityId}
                @click=${() => this._showMoreInfo(entityId)}
            >${text}</button>
        `;
    }

    /**
     * Ask Home Assistant for its more-info dialog.
     *
     * `hass-more-info` is HA's own protocol and its dialog manager listens for
     * it on the root `home-assistant` element, which is several shadow roots
     * above this one -- hence `composed`, without which the event stops at the
     * group's own boundary and nothing happens at all.
     */
    private _showMoreInfo(entityId: string): void {
        this.dispatchEvent(
            new CustomEvent("hass-more-info", {
                detail: { entityId },
                bubbles: true,
                composed: true,
            }),
        );
    }

    /** "Show details of sensor.x", with the id substituted if the string asks. */
    private _moreInfoLabel(entityId: string): string {
        const template = this._t("editor.entity_group.more_info_aria");
        return template.includes("{entity}")
            ? template.split("{entity}").join(entityId)
            : `${template} ${entityId}`;
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
