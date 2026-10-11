import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { helmanColorVars } from "../color-vars";
import { QUESTION_TOGGLE_EVENT, type QuestionToggleDetail } from "./node-question";

/** Fired by the Now/Today switch; the host owns which scope is shown. */
export const FLOW_SCOPE_EVENT = "flow-scope";

export type FlowScope = "now" | "today";

export interface FlowScopeDetail {
    scope: FlowScope;
}

/** One source or destination of a node's flow. */
export interface FlowItem {
    /** The `data-flow` key, such as `solar` or `grid`. */
    id: string;
    /** What it is, such as "Solar". */
    label: string;
    /** In the scale's unit; `null` when not known, drawn as nothing flowing. */
    value: number | null;
    /** The value as shown, bold. */
    display: string;
    /** The colour of the node at the ribbon's other end. */
    color: string;
    /** An optional short note under the label: a share, a cost. */
    note?: string | null;
}

/** The diagram's height, px, and the ribbon thickness at the full scale. */
const HEIGHT = 152;
const FULL = 120;
/** A flow that is not zero is never thinner than this, px. */
const MIN_RIBBON = 1.5;

/**
 * A node's energy flow: its sources come in on the left, the node's glyph sits
 * in the centre (the `centre` slot) and its destinations go out on the right.
 *
 * Ribbon widths share one fixed scale on every node, `scale` at full height,
 * so the views stay comparable: a small flow is a thin ribbon, by design. Each
 * ribbon takes the colour of the node at its other end. A source or
 * destination with nothing flowing, or none known, stays as a greyed label,
 * so the layout never moves.
 *
 * Controlled: the host owns the scope and redraws on `flow-scope`. A tap on
 * either side fires the question toggle for `question-id`, the question the
 * flow answers; the centre's own control is the host's.
 */
@customElement("helman-node-flow")
export class HelmanNodeFlow extends LitElement {
    static styles = [helmanColorVars, css`
        :host {
            display: block;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            flex-wrap: wrap;
        }
        .scope {
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--secondary-text-color);
        }
        .toggle {
            display: inline-flex;
            border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
            border-radius: 999px;
            overflow: hidden;
        }
        .toggle button {
            font: inherit;
            font-size: 0.8rem;
            min-height: 28px;
            padding: 2px 12px;
            border: none;
            background: none;
            color: var(--secondary-text-color);
            cursor: pointer;
        }
        .toggle button[aria-pressed="true"] {
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
            color: var(--primary-text-color);
            font-weight: 600;
        }
        button:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: -2px;
        }
        .totals {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            margin-top: 6px;
            font-size: 0.75rem;
            color: var(--secondary-text-color);
        }
        .diagram {
            display: flex;
            align-items: stretch;
            height: ${HEIGHT}px;
            margin-top: 2px;
        }
        .side {
            flex: 1 1 0;
            min-width: 0;
            display: flex;
            align-items: stretch;
            padding: 0;
            border: none;
            background: none;
            color: inherit;
            font: inherit;
            cursor: pointer;
            text-align: inherit;
            border-radius: 6px;
        }
        .side.out {
            flex-direction: row-reverse;
        }
        .side svg {
            flex: 1 1 auto;
            min-width: 8px;
            height: 100%;
        }
        .labels {
            flex: 0 0 auto;
            width: 4.3rem;
            display: flex;
            flex-direction: column;
        }
        .side.out .labels {
            text-align: right;
        }
        .item {
            flex: 1 1 0;
            min-height: 0;
            display: flex;
            flex-direction: column;
            justify-content: center;
            line-height: 1.2;
            overflow-wrap: anywhere;
        }
        .item.none {
            opacity: 0.45;
        }
        .value {
            font-weight: 700;
            font-size: 0.85rem;
        }
        .name,
        .item-note {
            font-size: 0.72rem;
            color: var(--secondary-text-color);
        }
        .ribbon {
            fill-opacity: 0.5;
        }
        .centre {
            flex: none;
            display: flex;
            align-items: center;
        }
        .notes {
            display: flex;
            flex-direction: column;
            gap: 2px;
            margin-top: 6px;
        }
        .note {
            margin: 0;
            font-size: 0.78rem;
            color: var(--secondary-text-color);
        }
    `];

    @property({ attribute: false }) public inputs: FlowItem[] = [];
    @property({ attribute: false }) public outputs: FlowItem[] = [];
    /** The value drawn at full height, in the items' unit. */
    @property({ type: Number }) public scale = 1;
    @property() public scope: FlowScope = "now";
    /** What is shown and when, such as "Now · 21:08". */
    @property({ attribute: false }) public scopeLabel = "";
    @property({ attribute: false }) public nowLabel = "Now";
    @property({ attribute: false }) public todayLabel = "Today";
    @property({ attribute: false }) public totalIn: string | null = null;
    @property({ attribute: false }) public totalOut: string | null = null;
    /** Footnotes: unresolved energy, an estimate. */
    @property({ attribute: false }) public notes: string[] = [];
    /** The question a tap on the flow opens. */
    @property({ attribute: "question-id" }) public questionId = "";
    @property({ attribute: false }) public questionLabel = "";

    render() {
        return html`
            <div class="header">
                <span class="scope" data-scope-label>${this.scopeLabel}</span>
                <span class="toggle" role="group">
                    ${this._scopeButton("now", this.nowLabel)}
                    ${this._scopeButton("today", this.todayLabel)}
                </span>
            </div>
            ${this.totalIn !== null || this.totalOut !== null ? html`
                <div class="totals">
                    <span data-total="in">${this.totalIn ?? ""}</span>
                    <span data-total="out">${this.totalOut ?? ""}</span>
                </div>
            ` : nothing}
            <div class="diagram">
                ${this._side("in", this.inputs)}
                <div class="centre"><slot name="centre"></slot></div>
                ${this._side("out", this.outputs)}
            </div>
            ${this.notes.length ? html`
                <div class="notes">${this.notes.map((note) => html`<p class="note" data-flow-note>${note}</p>`)}</div>
            ` : nothing}
        `;
    }

    private _scopeButton(scope: FlowScope, label: string) {
        return html`
            <button
                data-scope=${scope}
                aria-pressed=${this.scope === scope ? "true" : "false"}
                @click=${() => {
                    if (this.scope === scope) return;
                    this.dispatchEvent(new CustomEvent<FlowScopeDetail>(FLOW_SCOPE_EVENT, {
                        detail: { scope },
                        bubbles: true,
                        composed: true,
                    }));
                }}
            >${label}</button>
        `;
    }

    /** One side: its labels and the ribbons between them and the centre. */
    private _side(side: "in" | "out", items: FlowItem[]) {
        const thickness = this._thicknesses(items);
        const total = thickness.reduce((sum, t) => sum + t, 0);
        let stacked = HEIGHT / 2 - total / 2;
        const ribbons = items.map((item, index) => {
            const t = thickness[index];
            const at = stacked;
            stacked += t;
            if (t <= 0) return nothing;
            // The label end is at x 0 for inputs; outputs mirror it.
            const labelTop = (index + 0.5) / items.length * HEIGHT - t / 2;
            const [x0, x1] = side === "in" ? [0, 100] : [100, 0];
            const d = `M${x0},${labelTop} C50,${labelTop} 50,${at} ${x1},${at} L${x1},${at + t} C50,${at + t} 50,${labelTop + t} ${x0},${labelTop + t} Z`;
            return svg`<path class="ribbon" data-ribbon=${item.id} d=${d} style="fill: ${item.color}"></path>`;
        });
        return html`
            <button class="side ${side}" data-side=${side} title=${this.questionLabel || nothing} @click=${this._tap}>
                <span class="labels">
                    ${items.map((item) => html`
                        <span class="item ${item.value ? "" : "none"}" data-flow=${item.id}>
                            <span class="value">${item.display}</span>
                            <span class="name">${item.label}</span>
                            ${item.note ? html`<span class="item-note">${item.note}</span>` : nothing}
                        </span>
                    `)}
                </span>
                <svg viewBox="0 0 100 ${HEIGHT}" preserveAspectRatio="none" aria-hidden="true">${ribbons}</svg>
            </button>
        `;
    }

    /**
     * Each item's ribbon thickness on the fixed scale, px; zero for nothing.
     * A side whose total would overflow the centre is drawn to fit it.
     */
    private _thicknesses(items: FlowItem[]): number[] {
        const scale = this.scale > 0 ? this.scale : 1;
        const raw = items.map((item) => !item.value || item.value <= 0 ? 0 : Math.max(MIN_RIBBON, item.value / scale * FULL));
        const total = raw.reduce((sum, t) => sum + t, 0);
        return total > FULL ? raw.map((t) => t * FULL / total) : raw;
    }

    private _tap = (): void => {
        if (!this.questionId) return;
        this.dispatchEvent(new CustomEvent<QuestionToggleDetail>(QUESTION_TOGGLE_EVENT, {
            detail: { id: this.questionId },
            bubbles: true,
            composed: true,
        }));
    };
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-node-flow": HelmanNodeFlow;
    }
}
