import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import {
    parseScheduleExplanation,
    type ExplanationCell,
    type ExplanationColumn,
    type ExplanationRow,
    type ScheduleExplanationModel,
} from "../model/schedule-explanation-model";
import { formatScheduleTime } from "../model/schedule-time";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

const KEY_PREFIX = "scheduling.explanation";

/**
 * Which cell of the grid was pressed. This is the level-2 seam: the condition
 * matrix for that optimizer and that slot is opened from here.
 */
export interface ScheduleExplanationCellSelectDetail {
    targetKey: string;
    date: string;
    optimizerId: string;
    slotId: string;
    rowIndex: number;
}

/**
 * Why one lane's day looks the way it does.
 *
 * Level 1 of a three-level drill: rows are half-hour slots, one column per
 * optimizer that touched the lane in pipeline order, and a Result column last.
 *
 * The Result column exists because a verdict is not an outcome.
 * `ScheduleWriter.set_inverter` is last-writer-wins among optimizers, so an
 * optimizer can decide `execute`, write, and lose the slot to a later step
 * without ever being told. Result names who actually landed the write; the
 * losers read `overwritten` in their own column.
 *
 * The layout does not adapt to the lane. An appliance lane with a single
 * optimizer is one column plus Result -- the same table, narrower. A lane whose
 * shape changes with its content is a lane you have to re-learn every time you
 * open it.
 */
@customElement("scheduling-explanation-dialog")
export class SchedulingExplanationDialog extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            .dialog-content {
                display: flex;
                flex-direction: column;
                gap: 12px;
                width: min(920px, calc(100vw - 48px));
                max-width: 100%;
                padding-top: 4px;
            }

            .meta {
                display: flex;
                flex-wrap: wrap;
                gap: 4px 12px;
                font-size: 0.78rem;
                color: var(--secondary-text-color);
            }

            /* The grid can outgrow the dialog in both directions: a day is 48
               rows and the inverter lane is three optimizers wide. It scrolls
               inside its own box so the dialog's own chrome stays put. */
            .grid-scroll {
                overflow: auto;
                max-height: min(60vh, 520px);
                border: 1px solid var(--divider-color);
                border-radius: 10px;
            }

            table.grid {
                border-collapse: separate;
                border-spacing: 0;
                width: 100%;
                font-size: 0.76rem;
            }

            table.grid th,
            table.grid td {
                padding: 3px 8px;
                text-align: start;
                vertical-align: top;
                white-space: nowrap;
                border-bottom: 1px solid var(--divider-color);
            }

            thead th {
                position: sticky;
                top: 0;
                z-index: 2;
                background: var(--card-background-color, var(--primary-background-color));
                font-weight: 600;
            }

            /* The time is the row's identity; it has to stay readable while the
               optimizer columns scroll under it. */
            .time-cell {
                position: sticky;
                left: 0;
                z-index: 1;
                background: var(--card-background-color, var(--primary-background-color));
                font-variant-numeric: tabular-nums;
                color: var(--secondary-text-color);
            }

            thead .time-cell {
                z-index: 3;
            }

            th.optimizer-head.inactive,
            td.cell.step-skipped {
                opacity: 0.45;
            }

            .status-reason {
                display: block;
                font-weight: 400;
                font-size: 0.68rem;
                color: var(--warning-color, var(--secondary-text-color));
                white-space: normal;
            }

            .cell-body {
                display: inline-flex;
                align-items: baseline;
                gap: 4px;
                padding: 1px 4px;
                border: none;
                border-radius: 5px;
                background: none;
                color: inherit;
                font: inherit;
                text-align: start;
                cursor: pointer;
            }

            .cell-body:hover {
                background: var(--secondary-background-color);
            }

            .cell-body.selected {
                outline: 2px solid var(--primary-color);
            }

            .glyph {
                flex: 0 0 auto;
                font-variant-numeric: tabular-nums;
            }

            .detail {
                color: var(--secondary-text-color);
                font-size: 0.7rem;
            }

            /* Outcome is carried by glyph *and* colour, never colour alone. */
            .cell.wrote .glyph {
                color: var(--success-color, #2e7d32);
            }

            .cell.overwritten {
                color: var(--secondary-text-color);
                text-decoration: line-through;
            }

            .cell.candidate .glyph {
                color: var(--info-color, var(--primary-color));
            }

            .cell.not-eligible .glyph {
                color: var(--error-color, #c62828);
            }

            /* Not the same thing as false: the node exists and was never
               consulted, so it is neither red nor a cross. */
            .cell.not-eligible[data-condition-state="not_evaluated"] .glyph {
                color: var(--secondary-text-color);
            }

            .cell.blocked .glyph {
                color: var(--warning-color, #ef6c00);
            }

            .cell.absent {
                color: var(--disabled-text-color, var(--secondary-text-color));
                opacity: 0.55;
            }

            .result-cell {
                font-weight: 600;
            }

            .result-cell .detail {
                font-weight: 400;
            }

            .placeholder {
                padding: 12px 2px;
                color: var(--secondary-text-color);
            }
        `,
    ];

    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ type: Boolean }) public open = false;
    /** The raw `helman/get_schedule_explanation` payload, or null for none. */
    @property({ attribute: false }) public payload: unknown = null;
    @property({ type: String }) public laneName = "";
    @property({ type: Boolean }) public loading = false;
    @property({ type: Boolean }) public failed = false;
    @property({ type: String }) public locale = "cs";
    @property({ type: String }) public timeZone = "UTC";

    @state() private _model: ScheduleExplanationModel | null = null;
    @state() private _selected: { optimizerId: string; rowIndex: number } | null = null;

    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        if (changedProperties.has("payload")) {
            this._model = parseScheduleExplanation(this.payload);
            this._selected = null;
        }
    }

    render() {
        return html`
            <ha-dialog
                .open=${this.open}
                @closed=${this._handleClosed}
                .heading=${this._title()}
                .headerTitle=${this._title()}
            >
                <div class="dialog-content">
                    ${this._renderMeta()}
                    ${this._renderBody()}
                    ${this._renderConditionMatrix()}
                </div>
                <ha-dialog-footer slot="footer">
                    <ha-button slot="primaryAction" @click=${this._handleClose}>
                        ${this._text("close")}
                    </ha-button>
                </ha-dialog-footer>
            </ha-dialog>
        `;
    }

    private _renderMeta() {
        const model = this._model;
        if (model === null) {
            return nothing;
        }

        return html`
            <div class="meta">
                <span class="lane">${this.laneName || model.targetKey}</span>
                <span class="date">${model.date}</span>
                ${model.runAt === null ? nothing : html`
                    <span class="run-at">
                        ${this._text("run_at")}:
                        ${formatScheduleTime(model.runAt, this.locale, this.timeZone)}
                    </span>
                `}
            </div>
        `;
    }

    private _renderBody() {
        if (this.loading) {
            return html`<div class="placeholder loading">${this._text("loading")}</div>`;
        }
        if (this.failed) {
            return html`<div class="placeholder error">${this._text("error")}</div>`;
        }

        const model = this._model;
        if (model === null || model.rows.length === 0 || model.columns.length === 0) {
            return html`<div class="placeholder empty">${this._text("empty")}</div>`;
        }

        return html`
            <div class="grid-scroll">
                <table class="grid">
                    <thead>
                        <tr>
                            <th class="time-cell">${this._text("time_column")}</th>
                            ${model.columns.map((column) => this._renderHead(column))}
                            <th class="result-head">${this._text("result_column")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${model.rows.map((row) => this._renderRow(model, row))}
                    </tbody>
                </table>
            </div>
        `;
    }

    private _renderHead(column: ExplanationColumn) {
        // A skipped or failed step greys its whole column and says why: "every
        // slot false" and "never ran" look identical otherwise, and they are
        // the two answers a person most needs to tell apart.
        return html`
            <th
                class=${`optimizer-head ${column.inactive ? "inactive" : ""}`}
                data-optimizer=${column.optimizerId}
                data-kind=${column.kind}
                data-status=${column.status}
            >
                ${this._optimizerLabel(column.kind)}
                ${column.inactive ? html`
                    <span class="status-reason">
                        ${this._text(`status.${column.status}`)}${column.statusReason === null
                            ? nothing
                            : html` — ${this._statusReasonLabel(column.statusReason)}`}
                    </span>
                ` : nothing}
            </th>
        `;
    }

    private _renderRow(model: ScheduleExplanationModel, row: ExplanationRow) {
        return html`
            <tr data-slot=${row.slotId} data-row=${row.index}>
                <th class="time-cell">
                    ${Number.isNaN(row.startMs)
                        ? row.slotId
                        : formatScheduleTime(row.startMs, this.locale, this.timeZone)}
                </th>
                ${model.columns.map((column) => this._renderCell(column, column.cells[row.index]))}
                ${this._renderResult(row)}
            </tr>
        `;
    }

    private _renderCell(column: ExplanationColumn, cell: ExplanationCell | undefined) {
        if (cell === undefined) {
            return html`<td class="cell absent">${this._glyph("absent")}</td>`;
        }

        const classes = ["cell", cell.outcome.replace(/_/g, "-")].join(" ");
        const body = html`
            <span class="glyph">${this._glyph(cell.outcome)}</span>
            <span class="label">${this._outcomeLabel(column, cell)}</span>
        `;
        // Nothing to drill into where the optimizer said nothing and where the
        // step never ran: the matrix behind those cells does not exist.
        const inert = cell.outcome === "absent" || cell.outcome === "step_skipped";
        const selected = this._selected !== null
            && this._selected.optimizerId === column.optimizerId
            && this._selected.rowIndex === cell.rowIndex;

        return html`
            <td
                class=${classes}
                data-optimizer=${column.optimizerId}
                data-outcome=${cell.outcome}
                data-condition=${cell.decisiveKey ?? nothing}
                data-condition-state=${cell.decisiveState ?? nothing}
                data-condition-scope=${cell.decisiveScope ?? nothing}
            >
                ${inert ? body : html`
                    <button
                        class=${`cell-body ${selected ? "selected" : ""}`}
                        type="button"
                        @click=${() => this._handleCellClick(column, cell)}
                    >${body}</button>
                `}
            </td>
        `;
    }

    private _renderResult(row: ExplanationRow) {
        if (row.winnerOptimizerId === null) {
            return html`<td class="result-cell empty">${this._text("result_none")}</td>`;
        }

        return html`
            <td class="result-cell" data-winner=${row.winnerOptimizerId}>
                ${this._actionLabel(row.winnerKind)}
                <span class="detail">(${this._optimizerLabel(row.winnerKind)})</span>
            </td>
        `;
    }

    /**
     * ---------------------------------------------------------------------
     * LEVEL 2 SEAM.
     *
     * Pressing a level-1 cell selects it and publishes
     * `schedule-explanation-cell-select`. The condition matrix for that
     * optimizer and that slot mounts here: everything it needs is already
     * parsed and reachable as
     * `getExplanationCell(this._model, optimizerId, rowIndex)` -- the cell's
     * `groups` (params, `paramsSource`, `customResults`, condition nodes with
     * their `scope`) and `gates` -- and the union condition-column set is
     * `this._model.conditionKeys` (per optimizer: `column.conditionKeys`).
     *
     * Nothing else in this file needs to change to attach it.
     * ---------------------------------------------------------------------
     */
    private _renderConditionMatrix() {
        return nothing;
    }

    private _handleCellClick(column: ExplanationColumn, cell: ExplanationCell): void {
        this._selected = { optimizerId: column.optimizerId, rowIndex: cell.rowIndex };
        const model = this._model;
        this.dispatchEvent(new CustomEvent<ScheduleExplanationCellSelectDetail>(
            "schedule-explanation-cell-select",
            {
                bubbles: true,
                composed: true,
                detail: {
                    targetKey: model?.targetKey ?? "",
                    date: model?.date ?? "",
                    optimizerId: column.optimizerId,
                    slotId: cell.slotId,
                    rowIndex: cell.rowIndex,
                },
            },
        ));
    }

    private _handleClose = (): void => {
        this.open = false;
        this._handleClosed();
    };

    private _handleClosed = (): void => {
        this.dispatchEvent(new CustomEvent("schedule-explanation-close", {
            bubbles: true,
            composed: true,
        }));
    };

    private _title(): string {
        const title = this._text("title");
        return this.laneName ? `${title} — ${this.laneName}` : title;
    }

    /**
     * Each outcome gets its own mark, so the column reads without colour and
     * without the legend. `absent` and `step_skipped` are deliberately not the
     * same mark as `not_eligible`: nothing was rejected in either of them.
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

    private _outcomeLabel(column: ExplanationColumn, cell: ExplanationCell) {
        switch (cell.outcome) {
            case "wrote":
            case "overwritten":
                return html`
                    ${this._actionLabel(column.kind)}
                    ${cell.outcome === "overwritten" ? html`
                        <span class="detail">${this._text("outcome.overwritten")}</span>
                    ` : nothing}
                `;
            case "not_eligible":
                // The failing condition is named; a cell that only says "no"
                // is the guesswork this whole dialog exists to end.
                return cell.decisiveKey === null
                    ? this._text("outcome.not_eligible")
                    : html`
                        <span class="condition">${this._conditionLabel(cell.decisiveKey)}</span>
                        ${cell.decisiveState === "not_evaluated" ? html`
                            <span class="detail">${this._text("state.not_evaluated")}</span>
                        ` : nothing}
                    `;
            case "candidate":
                return this._text("outcome.candidate");
            case "blocked":
                return this._text("outcome.blocked");
            case "step_skipped":
                return this._text("outcome.step_skipped");
            default:
                return this._text("outcome.absent");
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

    private _statusReasonLabel(reason: string): string {
        return this._labelled("status_reason", reason);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "scheduling-explanation-dialog": SchedulingExplanationDialog;
    }
}
