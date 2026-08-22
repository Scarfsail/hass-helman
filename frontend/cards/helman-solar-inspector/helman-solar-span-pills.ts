import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { helmanColorVars } from "../color-vars";
import {
    buildSpanPillRows,
    spanKeyForYear,
    type SpanPill,
    type SpanPillMode,
} from "./span-pill-model";

/**
 * The aggregate views' span picker: a row of years over a row of months.
 *
 * Deliberately *not* a variant of `helman-solar-day-pills`, and it imports
 * nothing from it. That element is a day gauge — a forecast loader, a schedule
 * owner, a normalized-schedule cache and three strips — and every one of those
 * describes something that only exists inside a day. A month has no schedule to
 * draw and no forecast to compare against. What the two share is a scrollable
 * row with a selected state, so that is what is shared: the row's shape, not
 * its machinery. A pill here is its label and nothing else.
 */

/**
 * The span a pill was clicked for, as its first day, and the view that should
 * be showing it.
 *
 * The mode travels with the date because picking a month is also a change of
 * granularity: a year view has months for columns, so clicking one is asking to
 * open it — the same move drilling into a column makes. Picking a year never
 * changes the mode; it moves within whichever view is on screen.
 */
export interface SpanPillSelectDetail {
    date: string;
    viewMode: SpanPillMode;
}

/**
 * The month under the pointer, or null on leaving one.
 *
 * Only the month row raises it. A year is not a bucket in either view, so
 * there is never a column for it to correspond with.
 */
export interface SpanPillHoverDetail {
    date: string | null;
}

@customElement("helman-solar-span-pills")
export class HelmanSolarSpanPills extends LitElement {
    static styles = [helmanColorVars, css`
        :host {
            display: block;
            min-width: 0;
        }

        .pill-rows {
            display: flex;
            flex-direction: column;
            gap: 4px;
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

        /* The fallback matches the card's other active controls, so a theme
           without --primary-color still shows which span is on screen. */
        .pill.selected {
            border-color: var(--primary-color, #2563eb);
            background: color-mix(in srgb, var(--primary-color, #2563eb) 14%, var(--card-background-color));
            box-shadow: inset 0 0 0 1px var(--primary-color, #2563eb);
            color: var(--primary-color, #2563eb);
        }

        /* The column the reader clicked in the chart, in the amber that column
           is already filled with -- same token, same 18 %, because it is the
           same fact drawn twice. After .selected on purpose: when both land on
           one pill the amber takes the fill and the blue keeps its inner ring,
           so neither claim is lost. */
        .pill.bucket-selected {
            border-color: var(--helman-selection);
            background: color-mix(in srgb, var(--helman-selection) 18%, var(--card-background-color));
        }

        /* The chart's own hover treatment, and last so it reads over either
           selected state. .hovered comes from the card, so a hover that
           started on a chart column is indistinguishable from one that started
           here -- which is the whole point of routing both through the card. */
        .pill:hover,
        .pill.hovered {
            border-color: var(--helman-selection);
            background: color-mix(in srgb, var(--helman-selection) 14%, var(--card-background-color));
        }

        /* Shown, not hidden: a month the recorder has nothing for is a fact
           worth seeing, and a row that dropped it would move the other eleven
           around every time the year changed. */
        .pill:disabled {
            cursor: not-allowed;
            opacity: 0.4;
        }

        /* Highlighted like any other, and dimmed like any other: the pointer
           never enters a disabled pill, but the chart can still name it, and
           following the reader is what the highlight is for. The opacity is
           what says it cannot be opened. */
        .pill:disabled.hovered {
            opacity: 0.4;
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
    /**
     * The bucket under the pointer and the one clicked in the chart, as month
     * keys, or null when the columns on screen are not months.
     *
     * Both come from the card rather than being worked out here, because the
     * chart is drawing the same months a few pixels away and one of the two has
     * to be the single answer to "which month is hot".
     */
    @property({ type: String }) public hoveredKey: string | null = null;
    @property({ type: String }) public selectedBucket: string | null = null;

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
        const { years, months } = buildSpanPillRows(this._options());
        if (years.length === 0) {
            return nothing;
        }

        return html`
            <div class="pill-rows">
                <div
                    class="pill-row years"
                    role="group"
                    aria-label=${this._localize("bias_correction.inspector.span_pills_years")}
                >
                    ${years.map((pill) => this._renderPill(pill, () => this._selectYear(pill)))}
                </div>
                <div
                    class="pill-row months"
                    role="group"
                    aria-label=${this._localize("bias_correction.inspector.span_pills_months")}
                >
                    ${months.map((pill) => this._renderPill(
                        pill,
                        () => this._selectMonth(pill),
                        true,
                    ))}
                </div>
            </div>
        `;
    }

    private _renderPill(pill: SpanPill, select: () => void, correlated = false) {
        const classes = [
            "pill",
            pill.selected ? "selected" : "",
            correlated && pill.key === this.selectedBucket ? "bucket-selected" : "",
            correlated && pill.key === this.hoveredKey ? "hovered" : "",
        ].filter((name) => name !== "").join(" ");
        return html`
            <button
                class=${classes}
                type="button"
                data-span=${pill.key}
                ?disabled=${pill.disabled}
                aria-pressed=${pill.selected ? "true" : "false"}
                @click=${select}
                @mouseenter=${correlated ? () => this._hover(pill.key) : nothing}
                @mouseleave=${correlated ? () => this._hover(null) : nothing}
            >${pill.label}</button>
        `;
    }

    /**
     * Report the month under the pointer.
     *
     * No guard on the value being unchanged: `mouseenter` and `mouseleave` fire
     * once per pill crossed rather than per pointer move, and the card skips
     * its own redundant writes. A disabled pill sends nothing -- the browser
     * dispatches no mouse events on one -- but the chart can still light it
     * through `hoveredKey`, which is right: naming the month the reader is
     * looking at is not a claim that it can be opened.
     */
    private _hover(key: string | null): void {
        this.dispatchEvent(new CustomEvent<SpanPillHoverDetail>("span-pill-hover", {
            bubbles: true,
            composed: true,
            detail: { date: key },
        }));
    }

    private _options() {
        return {
            viewMode: this.viewMode,
            minDate: this.minDate,
            todayKey: this.todayKey,
            selectedDate: this.selectedDate,
            locale: this._locale,
        };
    }

    /**
     * Move to another year, keeping whatever else is being browsed.
     *
     * The month row's choice survives it -- that is what the second row is for
     * -- and the view mode survives it too: a year view stays a year view.
     */
    private _selectYear(pill: SpanPill): void {
        const key = spanKeyForYear(this._options(), Number(pill.key.slice(0, 4)));
        if (key !== null) {
            this._emit(key, this.viewMode);
        }
    }

    /**
     * Pick a month, which always means showing that month's days.
     *
     * From the month view it is a move within the row. From the year view it is
     * also a change of granularity: the year view's columns are months, so
     * clicking one asks to open it, exactly as drilling into that column does.
     */
    private _selectMonth(pill: SpanPill): void {
        this._emit(pill.key, "month");
    }

    /**
     * Raise the choice; the card decides whether it is a move.
     *
     * No guard here on the span already being shown. The card owns that
     * question -- it is the one that knows a mode change is a move even when
     * the date does not shift -- and answering it in two places is how the two
     * answers drift apart.
     */
    private _emit(spanKey: string, viewMode: SpanPillMode): void {
        this.dispatchEvent(new CustomEvent<SpanPillSelectDetail>("span-pill-select", {
            bubbles: true,
            composed: true,
            detail: { date: spanKey, viewMode },
        }));
    }

    /**
     * Bring each row's lit pill into view when that row is too narrow to hold
     * all of its pills — a long history is many years, and twelve months rarely
     * fit a narrow card either.
     *
     * Only ever on a change of span: re-running it on every render would fight
     * whoever is scrolling a row by hand, and the point is to follow the
     * selection, not to own the scroll position. Both rows are done together,
     * under one key, because one selection moves both.
     */
    private _revealSelectedPill(): void {
        if (this._scrolledTo === this._scrollKey()) {
            return;
        }

        const root = this.renderRoot as unknown as ParentNode;
        const rows = [...root.querySelectorAll(".pill-row")] as HTMLElement[];
        if (rows.length === 0) {
            return;
        }
        // A row with no width yet cannot be scrolled meaningfully, and stamping
        // the key here would spend the one reveal this span gets on a
        // measurement of nothing. Leave it unstamped and catch the next render.
        if (rows.some((row) => row.getBoundingClientRect().width === 0)) {
            return;
        }

        this._scrolledTo = this._scrollKey();
        for (const row of rows) {
            // The year view lights nothing in the month row, which is not a
            // failure -- there is simply nothing there to scroll to.
            const pill = row.querySelector(".pill.selected") as HTMLElement | null;
            if (pill !== null) {
                this._revealWithin(row, pill);
            }
        }
    }

    private _revealWithin(row: HTMLElement, pill: HTMLElement): void {
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
     * The view mode is part of it: it decides whether the month row has a lit
     * pill at all, so the same date means different rows to scroll.
     *
     * So is the floor, and that one is not hypothetical. The card switches into
     * an aggregate view before the span load has told it where history begins,
     * so the row's first render is the one year an unknown floor collapses
     * to. Keying on the date alone, that render would spend the reveal, and the
     * rebuild into two years of months a moment later would find the key
     * unchanged and leave the row parked at its far end with the lit pill off
     * screen -- the exact thing this method exists to prevent.
     */
    private _scrollKey(): string {
        return `${this.viewMode}:${this.minDate}:${this.selectedDate}`;
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
