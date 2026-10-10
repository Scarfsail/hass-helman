import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

/** Fired by the question header: the host opens it and closes every other one. */
export const QUESTION_TOGGLE_EVENT = "question-toggle";
/** Fired by the evidence toggle inside an open question. */
export const EVIDENCE_TOGGLE_EVENT = "evidence-toggle";

export interface QuestionToggleDetail {
    id: string;
}

/**
 * One question of a node detail: a header with the question and a one-line
 * answer preview, the answer one disclosure away and its evidence (how it is
 * calculated, the technical readings) a second one away.
 *
 * Controlled: the host owns which question is open and whether its evidence
 * is, and renders the `answer` and `evidence` slots only while they are open,
 * so a closed answer mounts nothing and requests nothing. Opening one question
 * closes the previous one; that rule lives in the host, which knows them all.
 *
 * The header is a real button spanning the row, carrying `aria-expanded`, so it
 * works by touch, mouse and keyboard alike, and keeps its focus across renders.
 */
@customElement("helman-node-question")
export class HelmanNodeQuestion extends LitElement {
    static styles = css`
        :host {
            display: block;
            border-top: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
        }
        h3 {
            margin: 0;
            font: inherit;
        }
        button {
            font: inherit;
            color: inherit;
            background: none;
            border: none;
            cursor: pointer;
            text-align: left;
        }
        button:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: -2px;
            border-radius: 4px;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            min-height: 48px;
            padding: 8px 4px;
            box-sizing: border-box;
        }
        .text {
            display: flex;
            flex-direction: column;
            gap: 2px;
            flex: 1;
            min-width: 0;
        }
        .question {
            font-weight: 600;
            font-size: 0.95rem;
        }
        .preview {
            color: var(--secondary-text-color);
            font-size: 0.85rem;
            overflow-wrap: anywhere;
        }
        .chevron {
            flex: none;
            width: 20px;
            height: 20px;
            fill: var(--secondary-text-color);
            transition: transform 0.15s;
        }
        :host([open]) .chevron {
            transform: rotate(180deg);
        }
        .answer {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 0 4px 12px;
        }
        .evidence-toggle {
            display: flex;
            align-items: center;
            gap: 4px;
            min-height: 40px;
            padding: 4px 0;
            color: var(--primary-color);
            font-size: 0.85rem;
            font-weight: 600;
        }
        .evidence-toggle .chevron {
            width: 18px;
            height: 18px;
            fill: var(--primary-color);
        }
        .evidence-toggle[aria-expanded="true"] .chevron {
            transform: rotate(180deg);
        }
        .evidence {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 8px 10px;
            border-radius: 8px;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
        }
    `;

    /** The id the toggle events carry. */
    @property({ attribute: "question-id" }) public questionId = "";
    @property() public question = "";
    /** One short answer line, shown open or closed; omitted when unsupported. */
    @property() public preview: string | null = null;
    @property({ type: Boolean, reflect: true }) public open = false;
    @property({ type: Boolean, attribute: "evidence-open" }) public evidenceOpen = false;
    /** The second disclosure's label; without one the question has no evidence. */
    @property({ attribute: "evidence-label" }) public evidenceLabel: string | null = null;

    render() {
        return html`
            <h3>
                <button
                    class="header"
                    aria-expanded=${this.open ? "true" : "false"}
                    aria-controls="answer"
                    @click=${() => this._fire(QUESTION_TOGGLE_EVENT)}
                >
                    <span class="text">
                        <span class="question">${this.question}</span>
                        ${this.preview ? html`<span class="preview">${this.preview}</span>` : nothing}
                    </span>
                    ${chevron}
                </button>
            </h3>
            ${this.open ? html`
                <div class="answer" id="answer" role="region" aria-label=${this.question}>
                    <slot name="answer"></slot>
                    ${this.evidenceLabel ? html`
                        <button
                            class="evidence-toggle"
                            aria-expanded=${this.evidenceOpen ? "true" : "false"}
                            aria-controls="evidence"
                            @click=${() => this._fire(EVIDENCE_TOGGLE_EVENT)}
                        >
                            ${chevron}
                            <span>${this.evidenceLabel}</span>
                        </button>
                        ${this.evidenceOpen ? html`
                            <div class="evidence" id="evidence">
                                <slot name="evidence"></slot>
                            </div>
                        ` : nothing}
                    ` : nothing}
                </div>
            ` : nothing}
        `;
    }

    private _fire(type: string): void {
        this.dispatchEvent(new CustomEvent<QuestionToggleDetail>(type, {
            detail: { id: this.questionId },
            bubbles: true,
            composed: true,
        }));
    }
}

const chevron = html`
    <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"></path>
    </svg>
`;

declare global {
    interface HTMLElementTagNameMap {
        "helman-node-question": HelmanNodeQuestion;
    }
}
