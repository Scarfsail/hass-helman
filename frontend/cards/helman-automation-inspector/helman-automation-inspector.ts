import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import type {
    AutomationRunPayload,
    AutomationDayContextSummaryDTO,
    TraceStepDTO,
} from "../helman-api";
import {
    AutomationInspectorModel,
    RAIL_METRICS,
    type CellView,
    type RailDelta,
} from "./automation-inspector-model";

interface SelectedCell {
    stepIndex: number;
    slotIndex: number;
}

const STATE_GLYPH: Record<string, string> = {
    applied: "●",
    blocked: "🔒",
    rejected: "▢",
    out_of_scope: "·",
    derived: "·",
    unexplained: "?",
};

// Corner status accent shown alongside delta chips — the neutral "·" states are
// blanked so they don't add noise to a cell that already shows its effect.
const CORNER_GLYPH: Record<string, string> = {
    applied: "●",
    blocked: "🔒",
    rejected: "▢",
    unexplained: "?",
};

export class HelmanAutomationInspector extends LitElement {
    @property({ attribute: false }) hass?: HomeAssistant;

    @state() private _loading = false;
    @state() private _error = "";
    @state() private _payload: AutomationRunPayload | null = null;
    @state() private _model: AutomationInspectorModel | null = null;
    @state() private _selected: SelectedCell | null = null;
    @state() private _onlyActivity = true;
    @state() private _running = false;

    private _activeRequestId = 0;
    private _loadedOnce = false;

    private get _localize(): LocalizeFunction {
        return getLocalizeFunction(this.hass as HomeAssistant);
    }

    updated() {
        if (this.hass && !this._loadedOnce && !this._loading) {
            void this._load();
        }
    }

    private async _load() {
        if (!this.hass) return;
        // Owned here (not in updated()) so an explicit re-load — e.g. after Run
        // now — never leaves _loadedOnce false and triggers a second fetch.
        this._loadedOnce = true;
        const requestId = ++this._activeRequestId;
        this._loading = true;
        this._error = "";
        try {
            const payload = await this.hass.callWS<AutomationRunPayload>({
                type: "helman/get_last_automation_run",
            });
            if (requestId !== this._activeRequestId) return;
            this._payload = payload;
            this._model = payload ? AutomationInspectorModel.fromPayload(payload) : null;
        } catch (err) {
            if (requestId !== this._activeRequestId) return;
            this._error = String((err as any)?.message ?? err);
        } finally {
            if (requestId === this._activeRequestId) this._loading = false;
        }
    }

    private async _runNow() {
        if (!this.hass || this._running) return;
        this._running = true;
        try {
            await this.hass.callWS({ type: "helman/run_automation" });
            await this._load();
        } catch (err) {
            this._error = String((err as any)?.message ?? err);
        } finally {
            this._running = false;
        }
    }

    render() {
        const t = this._localize;
        if (this._loading && !this._payload) {
            return html`<div class="msg">${t("automation.inspector.loading")}</div>`;
        }
        if (this._error) {
            return html`<div class="msg error">${t("automation.inspector.load_failed")}: ${this._error}</div>`;
        }
        if (!this._payload) {
            return html`<div class="msg">${t("automation.inspector.no_run")}</div>`;
        }
        return html`
            ${this._renderHeader()}
            ${this._model ? this._renderMatrix(this._model) : html`<div class="msg">${t("automation.inspector.no_trace")}</div>`}
            ${this._renderPopover()}
        `;
    }

    private _renderHeader() {
        const t = this._localize;
        const p = this._payload!;
        const outcome = p.ranAutomation
            ? t("automation.inspector.completed")
            : (p.reason ?? t("automation.inspector.skipped"));
        return html`
            <div class="header">
                <div class="header-info">
                    <span class="outcome ${p.ranAutomation ? "ok" : "warn"}">${outcome}</span>
                    <span class="duration">${p.durationMs} ms</span>
                </div>
                <div class="header-actions">
                    <label class="filter">
                        <input
                            type="checkbox"
                            .checked=${this._onlyActivity}
                            @change=${(e: Event) => (this._onlyActivity = (e.target as HTMLInputElement).checked)}
                        />
                        ${t("automation.inspector.only_activity")}
                    </label>
                    <button class="run-now" ?disabled=${this._running} @click=${() => this._runNow()}>
                        ${this._running ? t("automation.inspector.running") : t("automation.inspector.run_now")}
                    </button>
                </div>
            </div>
        `;
    }

    private _renderMatrix(model: AutomationInspectorModel) {
        const t = this._localize;
        const steps = model.steps;
        const rows = this._visibleRowIndices(model);
        const dayContexts = this._dayContextByDate();

        let lastDay = "";
        const bodyRows: unknown[] = [];
        for (const slotIndex of rows) {
            const slotId = model.slotIds[slotIndex];
            const day = slotId.slice(0, 10);
            if (day !== lastDay) {
                lastDay = day;
                const ctx = dayContexts.get(day);
                bodyRows.push(html`
                    <tr class="day-header">
                        <td colspan=${3 + steps.length}>
                            ${this._formatDay(day)}
                            ${ctx ? html`<span class="classification">· ${t(`automation.inspector.classification.${ctx.classification}`)}</span>` : nothing}
                        </td>
                    </tr>
                `);
            }
            bodyRows.push(this._renderRow(model, slotIndex, steps));
        }

        return html`
            ${this._renderLegend()}
            <div class="matrix-scroll">
                <table class="matrix">
                    <thead>
                        <tr>
                            <th class="slot-col">${t("automation.inspector.slot")}</th>
                            <th class="rail-col" title=${t("automation.inspector.rail.import")}>↑</th>
                            <th class="rail-col" title=${t("automation.inspector.rail.export")}>↓</th>
                            ${steps.map((step, i) => html`
                                <th class="step-col ${step.status}">
                                    <div class="step-name">${step.optimizerId}</div>
                                    <div class="step-meta">
                                        <span class="kind">${step.kind}</span>
                                        ${this._statusBadge(step)}
                                    </div>
                                </th>
                            `)}
                        </tr>
                    </thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>
        `;
    }

    private _renderLegend() {
        const t = this._localize;
        return html`
            <div class="legend">
                <span class="legend-label">${t("automation.inspector.effects")}:</span>
                ${RAIL_METRICS.map(
                    (m) => html`
                        <span class="legend-item metric-${m.id}">
                            <span class="legend-swatch"></span>
                            ${t(`automation.inspector.metric.${m.id}`)}
                            <span class="legend-unit">${m.unit}</span>
                        </span>
                    `,
                )}
            </div>
        `;
    }

    private _renderRow(model: AutomationInspectorModel, slotIndex: number, steps: TraceStepDTO[]) {
        const importPrice = model.railValue(model.trace.staticRails.importPrice, slotIndex);
        const exportPrice = model.railValue(model.trace.staticRails.exportPrice, slotIndex);
        const isNow = slotIndex === 0;
        return html`
            <tr class=${isNow ? "now-row" : ""}>
                <th class="slot-col">
                    ${isNow ? html`<span class="now-marker">◀</span>` : nothing}
                    ${this._formatTime(model.slotIds[slotIndex])}
                </th>
                <td class="rail-cell">${fmt(importPrice)}</td>
                <td class="rail-cell">${fmt(exportPrice)}</td>
                ${steps.map((_step, stepIndex) => this._renderCell(model, stepIndex, slotIndex))}
            </tr>
        `;
    }

    private _renderCell(model: AutomationInspectorModel, stepIndex: number, slotIndex: number) {
        const cell = model.resolveCell(stepIndex, slotIndex, this._localize);
        const deltas = model.cellDeltas(stepIndex, slotIndex);
        const selected =
            this._selected?.stepIndex === stepIndex && this._selected?.slotIndex === slotIndex;
        const highlighted =
            !selected && this._isSiblingOfSelected(model, stepIndex, slotIndex);
        // The dominant changed metric tints the cell's inbound edge, giving the
        // sense of a value flowing in from the previous column.
        const edge = deltas.length ? ` metric-edge-${deltas[0].metric.id}` : "";
        return html`
            <td
                class="cell cell-${cell.state}${edge} ${selected ? "selected" : ""} ${highlighted ? "sibling" : ""}"
                title=${cell.reason.title}
                @click=${() => this._selectCell(stepIndex, slotIndex)}
            >
                ${deltas.length
                    ? html`<div class="deltas">
                          ${deltas.map((d) => this._renderDelta(d))}
                          <span class="glyph corner status-${cell.state}">${CORNER_GLYPH[cell.state] ?? ""}</span>
                      </div>`
                    : html`<span class="glyph">${STATE_GLYPH[cell.state] ?? "·"}</span>`}
            </td>
        `;
    }

    private _renderDelta(delta: RailDelta) {
        const { metric, before, after } = delta;
        return html`
            <span class="chip metric-${metric.id}" title=${this._deltaTitle(delta)}>
                <span class="v">${fmtMetric(before, metric.precision)}</span>
                <span class="arrow">→</span>
                <span class="v">${fmtMetric(after, metric.precision)}</span>
            </span>
        `;
    }

    private _deltaTitle(delta: RailDelta): string {
        const t = this._localize;
        const { metric, before, after } = delta;
        const name = t(`automation.inspector.metric.${metric.id}`);
        return `${name}: ${fmtMetric(before, metric.precision)} → ${fmtMetric(after, metric.precision)} ${metric.unit}`;
    }

    private _isSiblingOfSelected(
        model: AutomationInspectorModel,
        stepIndex: number,
        slotIndex: number,
    ): boolean {
        if (!this._selected || this._selected.stepIndex !== stepIndex) return false;
        const selectedCell = model.resolveCell(
            stepIndex,
            this._selected.slotIndex,
            this._localize,
        );
        return selectedCell.siblingSlotIndices.includes(slotIndex);
    }

    private _renderPopover() {
        if (!this._selected || !this._model) return nothing;
        const t = this._localize;
        const { stepIndex, slotIndex } = this._selected;
        const model = this._model;
        const step = model.steps[stepIndex];
        const cell = model.resolveCell(stepIndex, slotIndex, this._localize);
        const deltas = model.cellDeltas(stepIndex, slotIndex);
        const importPrice = model.railValue(model.trace.staticRails.importPrice, slotIndex);
        const exportPrice = model.railValue(model.trace.staticRails.exportPrice, slotIndex);
        return html`
            <div class="popover-backdrop" @click=${() => (this._selected = null)}></div>
            <div class="popover" @click=${(e: Event) => e.stopPropagation()}>
                <div class="popover-head">
                    <div>
                        <div class="popover-title">${cell.reason.title}</div>
                        <div class="popover-sub">${step.optimizerId} · ${this._formatTime(model.slotIds[slotIndex])}</div>
                    </div>
                    <button class="close" @click=${() => (this._selected = null)}>✕</button>
                </div>
                <div class="popover-body">
                    <div class="reason-detail">${cell.reason.detail || cell.reason.code}</div>
                    ${deltas.length
                        ? html`<div class="effects">
                              <div class="effects-head">${t("automation.inspector.effects")}</div>
                              ${deltas.map(
                                  (d) => html`<div class="effect-row metric-${d.metric.id}">
                                      <span class="effect-swatch"></span>
                                      <span class="effect-name">${t(`automation.inspector.metric.${d.metric.id}`)}</span>
                                      <span class="effect-val">
                                          ${fmtMetric(d.before, d.metric.precision)}
                                          <span class="arrow">→</span>
                                          ${fmtMetric(d.after, d.metric.precision)}
                                          <span class="effect-unit">${d.metric.unit}</span>
                                      </span>
                                  </div>`,
                              )}
                          </div>`
                        : html`<div class="effects-none">${t("automation.inspector.no_effect")}</div>`}
                    <div class="pins">
                        <div class="pin"><span>${t("automation.inspector.rail.import")}</span><b>${fmt(importPrice)}</b></div>
                        <div class="pin"><span>${t("automation.inspector.rail.export")}</span><b>${fmt(exportPrice)}</b></div>
                    </div>
                    ${cell.write
                        ? html`<div class="write">
                              <div>${t("automation.inspector.action_before")}: <code>${fmtAction(cell.write.before)}</code></div>
                              <div>${t("automation.inspector.action_after")}: <code>${fmtAction(cell.write.after)}</code></div>
                          </div>`
                        : nothing}
                    <div class="reason-code">${cell.reason.code}</div>
                </div>
            </div>
        `;
    }

    private _statusBadge(step: TraceStepDTO) {
        const t = this._localize;
        if (step.status === "skipped")
            return html`<span class="badge skipped">${t("automation.inspector.status.skipped")}</span>`;
        if (step.status === "failed")
            return html`<span class="badge failed">${t("automation.inspector.status.failed")}</span>`;
        if (!step.complete)
            return html`<span class="badge incomplete" title=${t("automation.inspector.status.incomplete")}>!</span>`;
        return nothing;
    }

    private _selectCell(stepIndex: number, slotIndex: number) {
        this._selected = { stepIndex, slotIndex };
    }

    private _visibleRowIndices(model: AutomationInspectorModel): number[] {
        const all = model.slotIds.map((_id, i) => i);
        if (!this._onlyActivity) return all;
        return all.filter((slotIndex) =>
            model.steps.some((_step, stepIndex) => {
                const cell = model.resolveCell(stepIndex, slotIndex, this._localize);
                if (
                    cell.state === "applied" ||
                    cell.state === "blocked" ||
                    cell.state === "rejected" ||
                    cell.state === "unexplained"
                ) {
                    return true;
                }
                return model.cellDeltas(stepIndex, slotIndex).length > 0;
            }),
        );
    }

    private _dayContextByDate(): Map<string, AutomationDayContextSummaryDTO> {
        const map = new Map<string, AutomationDayContextSummaryDTO>();
        for (const ctx of this._payload?.dayContexts ?? []) {
            map.set(ctx.localDate, ctx);
        }
        return map;
    }

    private _formatDay(day: string): string {
        try {
            const d = new Date(day + "T00:00:00");
            return d.toLocaleDateString(this.hass?.language, {
                weekday: "short",
                day: "numeric",
                month: "short",
            });
        } catch {
            return day;
        }
    }

    private _formatTime(slotId: string): string {
        return slotId.slice(11, 16);
    }

    static styles = css`
        :host {
            display: block; font-size: 13px;
            /* Canonical metric palette (falls back when the app-level tokens
               from the other cards are not in scope). */
            --m-surplus: var(--simple-card-source-solar, #facc15);
            --m-soc: var(--simple-card-source-battery, #22c55e);
            --m-import: var(--forecast-grid-import, #2563eb);
            --m-export: var(--forecast-grid-export, #7dd3fc);
        }
        .metric-surplus { --m: var(--m-surplus); }
        .metric-soc { --m: var(--m-soc); }
        .metric-import { --m: var(--m-import); }
        .metric-export { --m: var(--m-export); }
        .msg { padding: 16px; color: var(--secondary-text-color); }
        .msg.error { color: var(--error-color); }
        .header {
            display: flex; justify-content: space-between; align-items: center;
            gap: 8px; flex-wrap: wrap; margin-bottom: 8px;
        }
        .header-info { display: flex; gap: 10px; align-items: center; }
        .outcome { font-weight: 600; }
        .outcome.ok { color: var(--success-color, #16a34a); }
        .outcome.warn { color: var(--warning-color, #d97706); }
        .duration { color: var(--secondary-text-color); }
        .header-actions { display: flex; gap: 10px; align-items: center; }
        .filter { display: flex; gap: 4px; align-items: center; color: var(--secondary-text-color); }
        .run-now {
            background: var(--primary-color); color: var(--text-primary-color, #fff);
            border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer;
        }
        .run-now:disabled { opacity: 0.6; cursor: default; }
        .matrix-scroll { overflow-x: auto; }
        table.matrix { border-collapse: collapse; width: 100%; }
        .matrix th, .matrix td {
            border: 1px solid var(--divider-color, #e0e0e0);
            padding: 2px 6px; text-align: center; white-space: nowrap;
        }
        .slot-col { position: sticky; left: 0; background: var(--card-background-color, #fff); text-align: right; }
        .rail-cell, .rail-col { color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .step-col { min-width: 96px; }
        .step-name { font-weight: 600; }
        .step-meta { display: flex; gap: 4px; justify-content: center; align-items: center; }
        .step-meta .kind { color: var(--secondary-text-color); font-size: 11px; }
        .step-col.skipped, .step-col.failed { opacity: 0.6; }
        .day-header td {
            text-align: left; background: var(--secondary-background-color, #f5f5f5);
            font-weight: 600; position: sticky; left: 0;
        }
        .classification { color: var(--secondary-text-color); font-weight: 400; }
        .now-row { background: color-mix(in srgb, var(--primary-color) 8%, transparent); }
        .now-marker { color: var(--primary-color); margin-right: 2px; }
        .legend {
            display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center;
            margin: 2px 0 8px; font-size: 11px; color: var(--secondary-text-color);
        }
        .legend-label { font-weight: 600; }
        .legend-item { display: inline-flex; gap: 4px; align-items: center; }
        .legend-swatch {
            width: 9px; height: 9px; border-radius: 2px; background: var(--m, #888);
        }
        .legend-unit { color: var(--disabled-text-color, #999); }
        .cell { cursor: pointer; padding: 2px 4px; }
        .cell .glyph { display: inline-block; min-width: 1em; }
        .deltas {
            display: flex; flex-direction: column; gap: 1px;
            align-items: stretch; position: relative;
        }
        .chip {
            display: inline-flex; gap: 3px; align-items: baseline;
            justify-content: flex-end;
            padding-left: 4px; border-left: 2px solid var(--m, #888);
            color: var(--m, inherit); font-variant-numeric: tabular-nums;
            font-size: 11px; line-height: 1.35; white-space: nowrap;
        }
        .chip .arrow { color: var(--secondary-text-color); opacity: 0.7; }
        .chip .v:last-child { font-weight: 700; }
        .glyph.corner {
            position: absolute; top: -2px; right: -2px; font-size: 9px;
            min-width: 0; opacity: 0.85; pointer-events: none;
        }
        /* Inbound edge tint — the value "arriving" from the previous column. */
        .cell.metric-edge-surplus { box-shadow: inset 3px 0 0 -1px var(--m-surplus); }
        .cell.metric-edge-soc { box-shadow: inset 3px 0 0 -1px var(--m-soc); }
        .cell.metric-edge-import { box-shadow: inset 3px 0 0 -1px var(--m-import); }
        .cell.metric-edge-export { box-shadow: inset 3px 0 0 -1px var(--m-export); }
        .cell-applied { color: var(--success-color, #16a34a); font-weight: 700; }
        .cell-blocked { color: var(--warning-color, #d97706); }
        .cell-rejected { color: var(--secondary-text-color); }
        .cell-unexplained { color: var(--error-color, #dc2626); font-weight: 700; }
        .cell-out_of_scope, .cell-derived { color: var(--disabled-text-color, #bbb); }
        .cell.selected { outline: 2px solid var(--primary-color); }
        .cell.sibling { background: color-mix(in srgb, var(--primary-color) 12%, transparent); }
        .badge {
            font-size: 10px; border-radius: 4px; padding: 0 4px; color: #fff;
        }
        .badge.skipped { background: var(--warning-color, #d97706); }
        .badge.failed { background: var(--error-color, #dc2626); }
        .badge.incomplete { background: var(--warning-color, #d97706); }
        .popover-backdrop {
            position: fixed; inset: 0; background: rgba(0,0,0,0.2); z-index: 10;
        }
        .popover {
            position: fixed; z-index: 11; top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            background: var(--card-background-color, #fff);
            border: 1px solid var(--divider-color, #e0e0e0); border-radius: 10px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2); padding: 12px 14px;
            min-width: 260px; max-width: 92vw;
        }
        .popover-head { display: flex; justify-content: space-between; gap: 12px; }
        .popover-title { font-weight: 700; }
        .popover-sub { color: var(--secondary-text-color); font-size: 12px; }
        .close { background: none; border: none; cursor: pointer; font-size: 14px; }
        .reason-detail { margin: 8px 0; }
        .effects { margin: 8px 0; }
        .effects-head {
            font-size: 11px; font-weight: 600; text-transform: uppercase;
            letter-spacing: 0.04em; color: var(--secondary-text-color); margin-bottom: 4px;
        }
        .effects-none { margin: 8px 0; color: var(--secondary-text-color); font-size: 12px; }
        .effect-row {
            display: grid; grid-template-columns: auto 1fr auto; gap: 8px;
            align-items: center; padding: 2px 0;
        }
        .effect-swatch { width: 9px; height: 9px; border-radius: 2px; background: var(--m, #888); }
        .effect-name { color: var(--primary-text-color); }
        .effect-val { font-variant-numeric: tabular-nums; color: var(--m, inherit); font-weight: 600; }
        .effect-val .arrow { color: var(--secondary-text-color); opacity: 0.7; font-weight: 400; }
        .effect-unit { color: var(--disabled-text-color, #999); font-weight: 400; margin-left: 2px; }
        .pins { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; margin: 8px 0; }
        .pin { display: flex; justify-content: space-between; }
        .pin span { color: var(--secondary-text-color); }
        .write { margin-top: 8px; font-size: 12px; }
        .write code { background: var(--secondary-background-color, #f5f5f5); padding: 0 4px; border-radius: 4px; }
        .reason-code { margin-top: 8px; color: var(--disabled-text-color, #999); font-size: 11px; font-family: monospace; }
    `;
}

function fmt(value: number | null): string {
    if (value === null || value === undefined) return "—";
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function fmtMetric(value: number | null, precision: number): string {
    if (value === null || value === undefined) return "—";
    return value.toFixed(precision);
}

function fmtAction(action: Record<string, unknown> | null): string {
    if (!action) return "—";
    if (typeof action.kind === "string") return action.kind;
    if ("on" in action) return action.on ? "on" : "off";
    return JSON.stringify(action);
}

customElements.define("helman-automation-inspector", HelmanAutomationInspector);
