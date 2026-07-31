import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import "./scheduling-logic-diagram";
import {
    getWinningExplanationCell,
    parseScheduleExplanation,
    type ExplanationCell,
    type ExplanationColumn,
    type ScheduleExplanationModel,
} from "../model/schedule-explanation-model";
import { formatScheduleTime } from "../model/schedule-time";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

const KEY_PREFIX = "scheduling.explanation";

/** One optimizer's account of the selected slot, as a tab. */
interface ExplanationTab {
    column: ExplanationColumn;
    cell: ExplanationCell;
}

/**
 * Why one slot of one lane looks the way it does.
 *
 * The panel is the whole explanation surface now: the day editor's Explain mode
 * puts a slot grid on the band and this underneath it, so the question is asked
 * by pointing at a slot rather than by reading a day-sized table of them. The
 * grid this replaced is gone; what it encoded -- that a verdict is not an
 * outcome -- moved onto the tab badges, which is where a slot's several
 * optimizers now sit side by side.
 *
 * **One tab per optimizer that had something to say about the slot**, in
 * pipeline order, each carrying its own outcome as a glyph and a word. An
 * optimizer that said nothing (`absent`) or whose step never ran
 * (`step_skipped`) has no matrix behind it and so gets no tab. With exactly one
 * tab there is no tab strip: a single chip above a diagram names what the
 * heading above it already said.
 *
 * The tab that opens is the *winning* one -- writing is last-writer-wins, so
 * the account matching what the schedule shows is the winner's, not the first
 * optimizer that decided `execute`.
 */
@customElement("scheduling-explanation-panel")
export class SchedulingExplanationPanel extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            .explanation-panel {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            .tab-strip {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
            }

            /* The day switcher's chips, in the same shape: a row of choices
               where exactly one is current reads the same everywhere. */
            .tab {
                display: inline-flex;
                align-items: baseline;
                gap: 6px;
                padding: 4px 10px;
                border: 1px solid var(--divider-color);
                border-radius: 999px;
                background: var(--card-background-color);
                color: inherit;
                font: inherit;
                font-size: 0.8rem;
                cursor: pointer;
            }

            /* A step that never ran: on the strip so it is not mistaken for an
               optimizer that was never configured, but nothing to open. */
            .tab.inert {
                cursor: default;
                opacity: 0.55;
            }

            .tab.selected {
                border-color: color-mix(in srgb, var(--primary-color) 44%, var(--divider-color));
                background: color-mix(in srgb, var(--primary-color) 12%, var(--card-background-color));
            }

            .tab-outcome {
                display: inline-flex;
                align-items: baseline;
                gap: 3px;
                font-size: 0.74rem;
                color: var(--secondary-text-color);
            }

            /* Outcome is carried by glyph *and* colour, never colour alone. */
            .glyph {
                font-variant-numeric: tabular-nums;
            }

            .tab-outcome.wrote .glyph {
                color: var(--success-color, #2e7d32);
            }

            .tab-outcome.overwritten {
                text-decoration: line-through;
            }

            .tab-outcome.candidate .glyph {
                color: var(--info-color, var(--primary-color));
            }

            .tab-outcome.not-eligible .glyph {
                color: var(--error-color, #c62828);
            }

            .tab-outcome.blocked .glyph {
                color: var(--warning-color, #ef6c00);
            }

            .placeholder {
                padding: 12px 2px;
                color: var(--secondary-text-color);
            }
        `,
    ];

    @property({ attribute: false }) public localize!: LocalizeFunction;
    /** The raw `helman/get_schedule_explanation` payload, or null for none. */
    @property({ attribute: false }) public payload: unknown = null;
    /** Which slot of it is being asked about, or null for none. */
    @property({ type: String }) public slotId: string | null = null;
    @property({ type: Boolean }) public loading = false;
    @property({ type: Boolean }) public failed = false;
    @property({ type: String }) public locale = "cs";
    @property({ type: String }) public timeZone = "UTC";

    /**
     * The tab the user picked, if they picked one.
     *
     * Null means "whichever won", which is what a fresh slot opens on. Cleared
     * whenever the question changes, so a pick never travels to a slot it was
     * not made about.
     */
    @state() private _pickedOptimizerId: string | null = null;
    /** The parsed payload, rebuilt only when the payload itself changes. */
    @state() private _model: ScheduleExplanationModel | null = null;

    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        if (changedProperties.has("payload")) {
            this._model = parseScheduleExplanation(this.payload);
        }
        if (changedProperties.has("payload") || changedProperties.has("slotId")) {
            this._pickedOptimizerId = null;
        }
    }

    render() {
        if (this.loading) {
            return html`<div class="placeholder loading">${this._text("loading")}</div>`;
        }
        if (this.failed) {
            return html`<div class="placeholder error">${this._text("error")}</div>`;
        }
        if (this.slotId === null) {
            return html`<div class="placeholder no-slot">${this._text("no_slot")}</div>`;
        }

        const tabs = this._tabs();
        const inactive = this._inactiveColumns();
        if (tabs.length === 0 && inactive.length === 0) {
            return html`<div class="placeholder empty">${this._text("empty")}</div>`;
        }

        // One automation and nothing else to say gets no strip: a lone chip
        // over a diagram names what the diagram is already about.
        const showStrip = tabs.length > 1 || inactive.length > 0;
        const active = tabs.length === 0 ? null : this._activeTab(tabs);
        return html`
            <div class="explanation-panel">
                ${showStrip ? this._renderTabStrip(tabs, active, inactive) : nothing}
                ${active === null ? html`
                    <div class="placeholder empty">${this._text("empty")}</div>
                ` : html`
                    <scheduling-logic-diagram
                        .localize=${this.localize}
                        .cell=${active.cell}
                        .slotLabel=${this._slotLabel()}
                    ></scheduling-logic-diagram>
                `}
            </div>
        `;
    }

    private _renderTabStrip(
        tabs: readonly ExplanationTab[],
        active: ExplanationTab | null,
        inactive: readonly ExplanationColumn[],
    ) {
        return html`
            <div class="tab-strip" role="tablist">
                ${tabs.map((tab) => {
                    const selected = tab.column.optimizerId === active?.column.optimizerId;
                    return html`
                        <button
                            class=${`tab${selected ? " selected" : ""}`}
                            type="button"
                            role="tab"
                            aria-selected=${selected}
                            data-optimizer=${tab.column.optimizerId}
                            data-outcome=${tab.cell.outcome}
                            @click=${() => { this._pickedOptimizerId = tab.column.optimizerId; }}
                        >
                            <span class="tab-name">${this._optimizerLabel(tab.column.kind)}</span>
                            <span class=${`tab-outcome ${tab.cell.outcome.replace(/_/g, "-")}`}>
                                <span class="glyph">${this._glyph(tab.cell.outcome)}</span>
                                <span class="tab-outcome-label">${this._outcomeLabel(tab)}</span>
                            </span>
                        </button>
                    `;
                })}
                ${inactive.map((column) => html`
                    <span
                        class="tab inert"
                        data-optimizer=${column.optimizerId}
                        data-status=${column.status}
                    >
                        <span class="tab-name">${this._optimizerLabel(column.kind)}</span>
                        <span class="tab-outcome">
                            ${this._text(`status.${column.status}`)}${column.statusReason === null
                                ? nothing
                                : html` — ${this._labelled("status_reason", column.statusReason)}`}
                        </span>
                    </span>
                `)}
            </div>
        `;
    }

    /**
     * The optimizers whose whole step never ran, as chips that cannot be opened.
     *
     * "Never ran" and "every slot rejected" are the two answers a person most
     * needs to tell apart, and dropping a skipped step from the strip entirely
     * would make it indistinguishable from an optimizer that is not configured
     * for the lane at all. There is nothing behind it to draw, so it is a
     * label, not a tab.
     */
    private _inactiveColumns(): ExplanationColumn[] {
        return this._model === null
            ? []
            : this._model.columns.filter((column) => column.inactive);
    }

    /**
     * The optimizers with an account of this slot, in pipeline order.
     *
     * `absent` and `step_skipped` are dropped rather than shown as empty tabs:
     * there is no condition record behind either, so a tab would open on
     * nothing. A lane where every column is one of those has no explanation at
     * all, which the empty placeholder says in words.
     */
    private _tabs(): ExplanationTab[] {
        const model = this._model;
        const row = model === null
            ? undefined
            : model.rows.find((entry) => entry.slotId === this.slotId);
        if (model === null || row === undefined) {
            return [];
        }

        return model.columns.flatMap((column) => {
            const cell = column.cells[row.index];
            if (cell === undefined || cell.outcome === "absent" || cell.outcome === "step_skipped") {
                return [];
            }

            return [{ column, cell }];
        });
    }

    private _activeTab(tabs: readonly ExplanationTab[]): ExplanationTab {
        const picked = tabs.find((tab) => tab.column.optimizerId === this._pickedOptimizerId);
        if (picked !== undefined) {
            return picked;
        }

        const model = this._model;
        const winning = model === null || this.slotId === null
            ? null
            : getWinningExplanationCell(model, this.slotId);
        const winningTab = winning === null
            ? undefined
            : tabs.find((tab) => tab.column.optimizerId === winning.optimizerId);
        return winningTab ?? tabs[0];
    }

    private _slotLabel(): string {
        const row = this._model?.rows.find((entry) => entry.slotId === this.slotId);
        return row === undefined || Number.isNaN(row.startMs)
            ? this.slotId ?? ""
            : formatScheduleTime(row.startMs, this.locale, this.timeZone);
    }

    /**
     * Each outcome gets its own mark, so a tab reads without colour. What the
     * tab says is the *cell's* outcome, never the optimizer's action: a
     * candidate is placed and displayed and only executes if its conditions
     * come true, so naming the action there would assert a run.
     */
    private _glyph(outcome: string): string {
        switch (outcome) {
            case "wrote":
                return "✓";
            case "overwritten":
                return "⤫";
            case "candidate":
                return "~";
            case "not_eligible":
                return "✗";
            case "blocked":
                return "⛨";
            default:
                return "–";
        }
    }

    private _outcomeLabel(tab: ExplanationTab): string {
        switch (tab.cell.outcome) {
            case "wrote":
                return this._actionLabel(tab.column.kind);
            case "overwritten":
                return this._text("outcome.overwritten");
            case "candidate":
                return this._text("outcome.candidate");
            case "blocked":
                return this._text("outcome.blocked");
            default:
                // The failing condition is named where the record named one: a
                // tab that only says "no" is the guesswork this exists to end.
                return tab.cell.decisiveKey === null
                    ? this._text("outcome.not_eligible")
                    : this._conditionLabel(tab.cell.decisiveKey);
        }
    }

    private _text(suffix: string): string {
        return this.localize(`${KEY_PREFIX}.${suffix}`);
    }

    /** A localized label, falling back to the raw backend key when unknown. */
    private _labelled(group: string, key: string | null): string {
        if (key === null || key.length === 0) {
            return "";
        }
        const full = `${KEY_PREFIX}.${group}.${key}`;
        const translated = this.localize(full);
        return translated === full || translated === undefined ? key : translated;
    }

    private _optimizerLabel(kind: string | null): string {
        return this._labelled("optimizer", kind);
    }

    private _actionLabel(kind: string | null): string {
        return this._labelled("action", kind);
    }

    private _conditionLabel(key: string): string {
        return this._labelled("condition", key);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "scheduling-explanation-panel": SchedulingExplanationPanel;
    }
}
