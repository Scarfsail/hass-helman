import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { scheduleActionToneStyles, type ScheduleActionTone } from "./schedule/action-tones";
import { QUESTION_TOGGLE_EVENT, type QuestionToggleDetail } from "./node-question";

/**
 * One question of a node detail as a tile: its answer's value large, an
 * optional mini graphic (the default slot, drawn only from data already
 * loaded) and the question as the caption.
 *
 * A tile is the closed face of a `helman-node-question`: tapping it fires the
 * same question toggle, and the host renders the opened answer and its
 * evidence full width under the tiles, one at a time. `tone` colours the tile
 * in a scheduler action's tone, for a tile that names an action; `accent`
 * colours its value, for a tile that names a flow, such as the import price.
 */
@customElement("helman-node-tile")
export class HelmanNodeTile extends LitElement {
    static styles = [scheduleActionToneStyles, css`
        :host {
            display: block;
            min-width: 0;
        }
        button {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 2px;
            width: 100%;
            height: 100%;
            min-height: 84px;
            box-sizing: border-box;
            padding: 8px 10px;
            font: inherit;
            color: inherit;
            text-align: left;
            cursor: pointer;
            border-radius: 10px;
            border: 1px solid var(--schedule-action-tone-border, var(--divider-color, rgba(0, 0, 0, 0.12)));
            background: var(--schedule-action-tone-bg, var(--secondary-background-color, rgba(0, 0, 0, 0.04)));
        }
        button:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: 1px;
        }
        :host([open]) button {
            border-color: var(--primary-color);
            box-shadow: inset 0 0 0 1px var(--primary-color);
        }
        .value {
            font-size: 1.15rem;
            font-weight: 700;
            line-height: 1.2;
            overflow-wrap: anywhere;
            color: var(--node-tile-accent, var(--schedule-action-tone-color, var(--primary-text-color)));
        }
        .detail {
            font-size: 0.78rem;
            line-height: 1.25;
            overflow-wrap: anywhere;
        }
        .graphic {
            display: block;
            width: 100%;
        }
        .caption {
            margin-top: auto;
            padding-top: 4px;
            font-size: 0.75rem;
            line-height: 1.25;
            color: var(--secondary-text-color);
            overflow-wrap: anywhere;
        }
    `];

    /** The id the toggle event carries. */
    @property({ attribute: "question-id" }) public questionId = "";
    @property() public question = "";
    @property() public value = "";
    @property() public detail: string | null = null;
    @property({ type: Boolean, reflect: true }) public open = false;
    @property() public tone: ScheduleActionTone | null = null;
    /** A colour for the value, for a tile that names a flow rather than an action. */
    @property() public accent: string | null = null;

    render() {
        return html`
            <button
                class=${this.tone ? `action-tone-${this.tone}` : ""}
                aria-expanded=${this.open ? "true" : "false"}
                style=${this.accent ? `--node-tile-accent: ${this.accent}` : nothing}
                @click=${this._toggle}
            >
                <span class="value">${this.value}</span>
                ${this.detail ? html`<span class="detail">${this.detail}</span>` : nothing}
                <span class="graphic"><slot></slot></span>
                <span class="caption">${this.question}</span>
            </button>
        `;
    }

    private _toggle = (): void => {
        this.dispatchEvent(new CustomEvent<QuestionToggleDetail>(QUESTION_TOGGLE_EVENT, {
            detail: { id: this.questionId },
            bubbles: true,
            composed: true,
        }));
    };
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-node-tile": HelmanNodeTile;
    }
}
