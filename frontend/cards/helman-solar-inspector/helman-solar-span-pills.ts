import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { helmanColorVars } from "../color-vars";
import { buildSpanPills, type SpanPill, type SpanPillMode } from "./span-pill-model";

/**
 * The aggregate views' span picker: one pill per month, or per year.
 *
 * Deliberately *not* a variant of `helman-solar-day-pills`, and it imports
 * nothing from it. That element is a day gauge — a forecast loader, a schedule
 * owner, a normalized-schedule cache and three strips — and every one of those
 * describes something that only exists inside a day. A month has no schedule to
 * draw and no forecast to compare against. What the two share is a scrollable
 * row with a selected state, so that is what is shared: the row's shape, not
 * its machinery. A pill here is its label and nothing else.
 */

/** The span a pill was clicked for, as its first day. The inspector loads it. */
export interface SpanPillSelectDetail {
    date: string;
}

@customElement("helman-solar-span-pills")
export class HelmanSolarSpanPills extends LitElement {
    static styles = [helmanColorVars, css`
        :host {
            display: block;
            min-width: 0;
        }

        .pill-row {
            display: flex;
            align-items: stretch;
            gap: 6px;
            overflow-x: auto;
            scrollbar-width: thin;
        }

        /* Sized by its label rather than to a fixed width: a month is three
           letters and a year is four digits, so pills that reserved a day
           pill's 74px would leave the row mostly empty. */
        .pill {
            flex: 0 0 auto;
            box-sizing: border-box;
            padding: 5px 10px;
            border: 1px solid var(--divider-color);
            border-radius: 8px;
            background: var(--card-background-color);
            color: var(--primary-text-color);
            font: inherit;
            font-size: 0.78rem;
            font-weight: 600;
            line-height: 1.2;
            white-space: nowrap;
            cursor: pointer;
            transition: border-color 120ms ease, background-color 120ms ease;
        }

        .pill:hover {
            border-color: color-mix(in srgb, var(--primary-color, #2563eb) 45%, var(--divider-color));
        }

        /* The fallback matches the card's other active controls, so a theme
           without --primary-color still shows which span is on screen. */
        .pill.selected {
            border-color: var(--primary-color, #2563eb);
            background: color-mix(in srgb, var(--primary-color, #2563eb) 14%, var(--card-background-color));
            box-shadow: inset 0 0 0 1px var(--primary-color, #2563eb);
            color: var(--primary-color, #2563eb);
        }
    `];

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** Which span one pill stands for; the day view uses its own row. */
    @property({ type: String }) public viewMode: SpanPillMode = "month";
    /** The date the card is browsing, `YYYY-MM-DD`. */
    @property({ type: String }) public selectedDate = "";
    /** The oldest date the aggregate views may reach, `YYYY-MM-DD`. */
    @property({ type: String }) public minDate = "";
    /** Today in the house's time zone, `YYYY-MM-DD`. The row's far end. */
    @property({ type: String }) public todayKey = "";

    private _localizeFn?: LocalizeFunction;
    /** The span the row was last scrolled to, so a re-render does not re-scroll. */
    private _scrolledTo: string | null = null;

    protected willUpdate(): void {
        if (this.hass) {
            this._localizeFn = getLocalizeFunction(this.hass);
        }
    }

    protected updated(): void {
        this._revealSelectedPill();
    }

    render() {
        const pills = this._pills();
        if (pills.length === 0) {
            return nothing;
        }

        return html`
            <div
                class="pill-row"
                role="group"
                aria-label=${this._localize("bias_correction.inspector.span_pills")}
            >
                ${pills.map((pill) => this._renderPill(pill))}
            </div>
        `;
    }

    private _renderPill(pill: SpanPill) {
        return html`
            <button
                class="pill ${pill.selected ? "selected" : ""}"
                type="button"
                data-span=${pill.key}
                aria-pressed=${pill.selected ? "true" : "false"}
                @click=${() => this._select(pill.key)}
            >${pill.label}</button>
        `;
    }

    private _pills(): SpanPill[] {
        return buildSpanPills({
            viewMode: this.viewMode,
            minDate: this.minDate,
            todayKey: this.todayKey,
            selectedDate: this.selectedDate,
            locale: this._locale,
        });
    }

    /** Re-selecting the span already on screen would reload it for nothing. */
    private _select(spanKey: string): void {
        if (spanKey === this.selectedDate) {
            return;
        }

        this.dispatchEvent(new CustomEvent<SpanPillSelectDetail>("span-pill-select", {
            bubbles: true,
            composed: true,
            detail: { date: spanKey },
        }));
    }

    /**
     * Bring the browsed span into view when the row is too narrow to hold every
     * pill — two years of months is twenty-four of them, so the selected one is
     * usually off-screen until it is scrolled to.
     *
     * Only ever on a change of span: re-running it on every render would fight
     * whoever is scrolling the row by hand, and the point is to follow the
     * selection, not to own the scroll position.
     */
    private _revealSelectedPill(): void {
        if (this._scrolledTo === this._scrollKey()) {
            return;
        }

        const root = this.renderRoot as unknown as ParentNode;
        const row = root.querySelector(".pill-row") as HTMLElement | null;
        const pill = root.querySelector(".pill.selected") as HTMLElement | null;
        if (row === null || pill === null) {
            return;
        }

        this._scrolledTo = this._scrollKey();
        const rowBox = row.getBoundingClientRect();
        const pillBox = pill.getBoundingClientRect();
        // A pill's own margin of daylight, so a revealed pill does not sit flush
        // against the edge looking like it is the last one.
        const margin = 8;
        const short = pillBox.left - rowBox.left - margin;
        const over = pillBox.right - rowBox.right + margin;
        if (short < 0) {
            row.scrollBy({ left: short, behavior: "smooth" });
        } else if (over > 0) {
            row.scrollBy({ left: over, behavior: "smooth" });
        }
    }

    /**
     * What counts as "already scrolled there".
     *
     * The view mode is part of it: switching from months to years rebuilds the
     * row into an entirely different set of pills, and the same date then means
     * a different pill.
     */
    private _scrollKey(): string {
        return `${this.viewMode}:${this.selectedDate}`;
    }

    private get _localize(): LocalizeFunction {
        return this._localizeFn ?? ((key: string) => key);
    }

    private get _locale(): string | undefined {
        if (this.hass?.locale?.language) {
            return this.hass.locale.language;
        }

        return typeof navigator !== "undefined" ? navigator.language : undefined;
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-span-pills": HelmanSolarSpanPills;
    }
}
