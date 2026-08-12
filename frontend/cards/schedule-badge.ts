import { LitElement, PropertyValues, TemplateResult, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../hass-frontend/src/types";
import { getLocalizeFunction } from "./localize/localize";
import {
    OPEN_SCHEDULE_EDITOR_EVENT,
    type OpenScheduleEditorDetail,
} from "./shared/schedule/dialogs/scheduling-day-editor-host";
import { summarizeScheduleAuthorship } from "./shared/schedule/model/schedule-authorship";
import {
    getSharedScheduleBadgeSource,
    type SharedScheduleBadgeSource,
} from "./shared/schedule/schedule-badge-source";
import type { ScheduleActionAuthorshipSummary } from "./shared/schedule/schedule-types";

const AUTHORSHIP_COLORS: Record<ScheduleActionAuthorshipSummary["state"], string> = {
    user: "var(--schedule-authorship-user-color, #c49012)",
    automation: "var(--schedule-authorship-automation-color, #2563eb)",
    mixed: "var(--schedule-authorship-mixed-color, #ea7a18)",
    none: "var(--schedule-authorship-none-color, #7b8798)",
};

/**
 * The scheduling badge for a shiftable house consumer.
 *
 * Shared by the power card's device rows and the solar inspector's house
 * composition panel, so a deferrable appliance is marked the same way wherever
 * it appears. It replaced a static "deferrable" word: the glyph says the same
 * thing, and its tint says what the word could not — whether the slot running
 * right now has this appliance planned, and who planned it.
 *
 * The colours are the scheduling UI's own authorship hooks, not literals of
 * this element's own, so a theme override moves the band, the action chips and
 * this badge together.
 */
@customElement("helman-schedule-badge")
export class ScheduleBadge extends LitElement {
    static get styles() {
        return css`
            :host {
                display: flex;
                align-items: center;
                flex-shrink: 0;
            }

            ha-icon {
                --mdc-icon-size: 28px;
                display: flex;
                cursor: pointer;
            }
        `;
    }

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** The controllable this box is; null for a group row. */
    @property({ attribute: false }) public controllableId: string | null = null;
    /**
     * The controllables a group row stands for.
     *
     * Only read when {@link controllableId} is null: a group is not itself a
     * controllable, so it folds its children's states into one tint rather than
     * picking one of them to speak for the rest.
     */
    @property({ attribute: false }) public controllableIds: readonly string[] = [];

    /** Bumped by the shared source to re-read authorship; the value is unused. */
    @state() private _revision = 0;

    private _source: SharedScheduleBadgeSource | null = null;
    private _unsubscribe: (() => void) | null = null;

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("hass")) {
            this._syncSource();
        }
    }

    connectedCallback(): void {
        super.connectedCallback();
        this._syncSource();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._unsubscribe?.();
        this._unsubscribe = null;
        this._source = null;
    }

    render(): TemplateResult | typeof nothing {
        const ids = this._resolvedIds();
        if (ids.length === 0 || !this.hass) {
            return nothing;
        }

        const label = getLocalizeFunction(this.hass)("house_section.deferrable_tag");
        return html`
            <ha-icon
                icon="mdi:calendar-clock"
                style="color: ${AUTHORSHIP_COLORS[this._authorshipState(ids)]}"
                title=${label}
                aria-label=${label}
                @click=${this._requestEditor}
            ></ha-icon>
        `;
    }

    /**
     * Ask for the day editor; the host decides where it opens.
     *
     * Following `helman-appliance-switch-badge`'s rule that a badge asks rather
     * than acts. A group row sends no target at all, which the editor already
     * handles: it opens on the whole stack with its "pick an entity" hint,
     * rather than the badge guessing which of the children the press meant.
     */
    private _requestEditor(event: Event): void {
        event.stopPropagation();
        this.dispatchEvent(
            new CustomEvent<OpenScheduleEditorDetail>(OPEN_SCHEDULE_EDITOR_EVENT, {
                bubbles: true,
                composed: true,
                detail: { target: this.controllableId },
            }),
        );
    }

    private _resolvedIds(): readonly string[] {
        return this.controllableId !== null ? [this.controllableId] : this.controllableIds;
    }

    /**
     * One tint for however many controllables the box stands for.
     *
     * A group whose children disagree reads "mixed" rather than arbitrarily
     * taking a side, which is what the shared authorship summary already decides
     * for the schedule band's own rows.
     */
    private _authorshipState(ids: readonly string[]): ScheduleActionAuthorshipSummary["state"] {
        const source = this._source;
        if (source === null) {
            return "none";
        }

        return summarizeScheduleAuthorship(ids.map((id) => source.getAuthorship(id))).state;
    }

    private _syncSource(): void {
        const hass = this.hass;
        if (!hass || !this.isConnected) {
            return;
        }

        const source = getSharedScheduleBadgeSource(hass);
        if (this._source === source) {
            return;
        }

        this._unsubscribe?.();
        this._source = source;
        this._unsubscribe = source.subscribe(() => {
            this._revision += 1;
        });
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-schedule-badge": ScheduleBadge;
    }
}
