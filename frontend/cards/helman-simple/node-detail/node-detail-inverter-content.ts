import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import { fillTemplate, type LocalizeFunction } from "../../localize/localize";
import type {
    InverterDetailPayload,
    InverterRuntimeDTO,
    InverterTemperatureSectionPayload,
    ScheduleActionDTO,
    ScheduleActionKind,
    SchedulePayload,
} from "../../helman-api";
import type { HelmanSolarInspectorCardConfig } from "../../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { getSharedDataChangedFeed } from "../../helman/data-changed";
import { getSharedHelmanStore } from "../../helman/store";
import { commandedModeKind } from "../../helman-api";
import { formatPower } from "../../power-format";
import { getSharedScheduleOwner } from "../../shared/schedule/schedule-owner";
import {
    formatScheduleTime,
    addDaysToDayKey,
    getScheduleDayKey,
    resolveScheduleSlotBoundaries,
} from "../../shared/schedule/model/schedule-time";
import { getScheduleActionLabel, getScheduleReasonLabel } from "../../shared/schedule/model/schedule-labels";
import { INVERTER_CONTROLLABLE_ID } from "../../shared/schedule/schedule-types";
import {
    EVIDENCE_TOGGLE_EVENT,
    QUESTION_TOGGLE_EVENT,
    type QuestionToggleDetail,
} from "../../shared/node-question";
import "../../shared/node-question";
import "../../shared/day-line-chart";
import type { DayLineSeries } from "../../shared/day-line-chart";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { announceWatchedEntities, readingNumber, readingText } from "./node-detail-readings";
import type { InverterDetailParams } from "./node-detail-types";

type QuestionId = "why" | "next" | "limits" | "operating" | "trust";

const PHASES = [1, 2, 3] as const;

/**
 * The inspector under "What will it do next?": the battery SoC plan with the
 * schedule strip, on the dialog's surface. Prices, money and the month/year
 * views answer other questions, so they are hidden; the bias diagnostics stay
 * off. Mirrors the Training tab's embed configs in
 * `config-editor/solar-inspector-embed.ts`.
 */
export const INVERTER_PLAN_INSPECTOR_CONFIG: HelmanSolarInspectorCardConfig = {
    type: "custom:helman-solar-inspector-card",
    transparent_background: true,
    hide_price_strip: true,
    hide_money_strip: true,
    hide_aggregate_views: true,
    show_bias_ratio: false,
    daylight_only_default: false,
    chart_series: ["batterySocForecast", "batterySocActual"],
};

type InspectorCardElement = HTMLElement & {
    setConfig(config: HelmanSolarInspectorCardConfig): void;
    hass: unknown;
};

interface ScheduleRun {
    startMs: number;
    endMs: number | null;
    action: ScheduleActionDTO;
}

type SectionState<T> =
    | { status: "loading" }
    | { status: "ready"; payload: T }
    | { status: "error" };

/**
 * The inverter detail: what Helman commanded, what the hardware shows, and
 * what comes next, as an overview and five questions.
 *
 * Four facts are kept apart throughout: the schedule's intent (this slot's
 * action), the last command (Helman's mode control), the executor's outcome
 * (the schedule runtime) and the observed configuration (the vendor's mode
 * registers, compared by the backend). None of them is presented as another.
 *
 * Readings are read live from `hass`; the backend overview supplies the entity
 * ids and the comparison, and is re-read when a compared register changes.
 * History (today's temperature) is requested only while its question is open.
 */
@customElement("node-detail-inverter-content")
export class NodeDetailInverterContent extends LitElement {
    static styles = [nodeDetailSharedStyles, css`
        .content {
            gap: 8px;
        }
        .summary {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding-bottom: 8px;
        }
        .status {
            margin: 0;
            font-size: 0.95rem;
        }
        .figures {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
            gap: 8px;
        }
        .figure {
            display: flex;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
        }
        .figure-label {
            font-size: 0.75rem;
            color: var(--secondary-text-color);
        }
        .figure-value {
            font-size: 1.05rem;
            font-weight: 600;
            overflow-wrap: anywhere;
        }
        .next {
            margin: 0;
            font-size: 0.9rem;
            color: var(--secondary-text-color);
        }
        .exception {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 4px 8px;
            padding: 8px 10px;
            border-radius: 8px;
            border-left: 3px solid var(--warning-color, #ffa600);
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
            font-size: 0.9rem;
        }
        .link-button {
            font: inherit;
            background: none;
            border: none;
            padding: 4px 0;
            color: var(--primary-color);
            font-weight: 600;
            cursor: pointer;
            min-height: 32px;
        }
        .rows {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .row {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            gap: 12px;
            font-size: 0.9rem;
        }
        .row .label {
            flex: 1 1 auto;
            min-width: 0;
        }
        .row .value {
            text-align: right;
            overflow-wrap: anywhere;
            min-width: 0;
            max-width: 60%;
        }
        .note {
            margin: 0;
            font-size: 0.82rem;
            color: var(--secondary-text-color);
        }
        .runs {
            list-style: none;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 0.9rem;
        }
        .runs li {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .run-time {
            min-width: 92px;
            color: var(--secondary-text-color);
            font-variant-numeric: tabular-nums;
        }
        .muted {
            color: var(--secondary-text-color);
            font-style: italic;
        }
        .day-label {
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--secondary-text-color);
            margin-top: 4px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.82rem;
            font-variant-numeric: tabular-nums;
        }
        th, td {
            padding: 3px 4px;
            text-align: right;
            overflow-wrap: anywhere;
        }
        th:first-child, td:first-child {
            text-align: left;
        }
        th {
            color: var(--secondary-text-color);
            font-weight: 600;
        }
        .plan {
            margin: 0 -8px;
        }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: InverterDetailParams;

    @state() private _overview: SectionState<InverterDetailPayload> = { status: "loading" };
    @state() private _schedule: SchedulePayload | null = null;
    @state() private _open: QuestionId | null = null;
    @state() private _evidenceOpen = false;
    @state() private _temperature: SectionState<InverterTemperatureSectionPayload> | null = null;

    private _overviewRequest = 0;
    private _temperatureRequest = 0;
    /** The compared registers' states the current overview was computed from. */
    private _comparedStates = "";
    private _unsubscribeSchedule?: () => void;
    private _unsubscribeDataChanged?: () => void;
    /** `_runs()` for the update in progress; several answers read it per render. */
    private _runsCache?: ScheduleRun[];
    private _planCard?: InspectorCardElement;

    connectedCallback(): void {
        super.connectedCallback();
        this.addEventListener(QUESTION_TOGGLE_EVENT, this._onQuestionToggle as EventListener);
        this.addEventListener(EVIDENCE_TOGGLE_EVENT, this._onEvidenceToggle as EventListener);
        if (this.hass) this._start();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this.removeEventListener(QUESTION_TOGGLE_EVENT, this._onQuestionToggle as EventListener);
        this.removeEventListener(EVIDENCE_TOGGLE_EVENT, this._onEvidenceToggle as EventListener);
        this._unsubscribeSchedule?.();
        this._unsubscribeSchedule = undefined;
        this._unsubscribeDataChanged?.();
        this._unsubscribeDataChanged = undefined;
        // Whatever is still in flight answers nobody.
        this._overviewRequest += 1;
        this._temperatureRequest += 1;
    }

    willUpdate(changed: Map<string, unknown>): void {
        this._runsCache = undefined;
        if (changed.has("hass") && this.hass) {
            if (!this._unsubscribeSchedule) this._start();
            else if (this._overview.status === "ready" && this._comparedSignature(this._overview.payload) !== this._comparedStates) {
                void this._loadOverview();
            }
            if (this._planCard) this._planCard.hass = this.hass;
        }
    }

    private _start(): void {
        this._unsubscribeSchedule = getSharedScheduleOwner(this.hass).subscribe((snapshot) => {
            this._schedule = snapshot.schedule;
        });
        // A config change (another client) can re-map what the overview reads.
        this._unsubscribeDataChanged = getSharedDataChangedFeed(this.hass).subscribe(() => {
            void this._loadOverview(true);
            if (this._open === "operating" && this._temperature !== null) void this._loadTemperature();
        });
        void this._loadOverview();
    }

    // ── Data ────────────────────────────────────────────────────────────────

    /** `fresh`: never join a request sent before a change was announced. */
    private async _loadOverview(fresh = false): Promise<void> {
        const request = ++this._overviewRequest;
        const previous = this._overview.status === "ready" ? this._overview.payload : undefined;
        // A refresh compares the states as they are now, when it is sent: a
        // change while it is in flight re-reads, a failure does not.
        if (previous) this._comparedStates = this._comparedSignature(previous);
        else this._overview = { status: "loading" };
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<InverterDetailPayload>({ node: "inverter" }, { fresh: fresh || previous !== undefined });
            if (request !== this._overviewRequest) return;
            if (!previous) this._comparedStates = this._comparedSignature(payload);
            this._overview = { status: "ready", payload };
            announceWatchedEntities(this, [
                payload.mode?.entityId,
                ...Object.values(payload.entities),
                ...payload.agreement.registers.map((register) => register.entityId),
            ]);
        } catch (error) {
            if (request !== this._overviewRequest) return;
            console.error("node-detail-inverter: failed to load the overview", error);
            // A refresh that fails keeps what was shown, with its own as-of.
            if (this._overview.status !== "ready") this._overview = { status: "error" };
        }
    }

    private async _loadTemperature(): Promise<void> {
        const request = ++this._temperatureRequest;
        this._temperature = { status: "loading" };
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<InverterTemperatureSectionPayload>({ node: "inverter", section: "temperature" }, { fresh: true });
            if (request !== this._temperatureRequest) return;
            this._temperature = { status: "ready", payload };
        } catch (error) {
            if (request !== this._temperatureRequest) return;
            console.error("node-detail-inverter: failed to load today's temperature", error);
            this._temperature = { status: "error" };
        }
    }

    /** The states the backend compared: a change in any of them re-reads the comparison. */
    private _comparedSignature(payload: InverterDetailPayload): string {
        const ids = [payload.mode?.entityId, ...payload.agreement.registers.map((register) => register.entityId), payload.entities.run_mode];
        return ids.map((id) => (id ? this.hass.states[id]?.state ?? "" : "")).join("|");
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    private _onQuestionToggle = (event: CustomEvent<QuestionToggleDetail>): void => {
        event.stopPropagation();
        const id = event.detail.id as QuestionId;
        const header = event.composedPath()[0] as HTMLElement | undefined;
        this._setOpen(this._open === id ? null : id);
        // Opening one closes the one above it, which would move this header
        // out from under the pointer: keep it where it is in view.
        void this.updateComplete.then(() => header?.scrollIntoView?.({ block: "nearest" }));
    };

    private _onEvidenceToggle = (event: CustomEvent<QuestionToggleDetail>): void => {
        event.stopPropagation();
        this._evidenceOpen = !this._evidenceOpen;
    };

    private _setOpen(id: QuestionId | null): void {
        this._open = id;
        this._evidenceOpen = false;
        // A closed answer's history request is obsolete; it is re-read on reopen.
        this._temperatureRequest += 1;
        this._temperature = null;
        if (id === "operating" && this._overview.status === "ready" && this._overview.payload.sections.includes("temperature")) {
            void this._loadTemperature();
        }
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        if (this._overview.status === "loading") {
            return html`<div class="content"><p class="note">${this._t("loading")}</p></div>`;
        }
        if (this._overview.status === "error") {
            return html`
                <div class="content">
                    <p class="note">${this._t("load_failed")}</p>
                    <button class="link-button" @click=${() => this._loadOverview()}>${this._t("retry")}</button>
                </div>
            `;
        }
        const overview = this._overview.payload;
        return html`
            <div class="content">
                ${this._renderSummary(overview)}
                ${this._question("why", this._whyPreview(), () => this._renderWhy(overview), () => this._renderWhyEvidence(overview), "evidence")}
                ${this._question("next", this._nextPreview(), () => this._renderNext(), () => this._renderNextEvidence(), "evidence")}
                ${this._question("limits", this._limitsPreview(overview), () => this._renderLimits(overview), () => this._renderLimitsEvidence(overview), "technical")}
                ${this._question("operating", this._operatingPreview(overview), () => this._renderOperating(overview), () => this._renderOperatingEvidence(overview), "technical")}
                ${overview.profile ? this._question("trust", this._trustPreview(overview), () => this._renderTrust(overview), () => this._renderTrustEvidence(overview), "technical") : nothing}
            </div>
        `;
    }

    private _question(
        id: QuestionId,
        preview: string | null,
        answer: () => TemplateResult,
        evidence: () => TemplateResult | typeof nothing,
        evidenceKind: "evidence" | "technical",
    ) {
        const open = this._open === id;
        return html`
            <helman-node-question
                data-question=${id}
                question-id=${id}
                .question=${this._t(`q.${id}`)}
                .preview=${preview}
                ?open=${open}
                ?evidence-open=${open && this._evidenceOpen}
                .evidenceLabel=${this._t(evidenceKind)}
            >
                ${open ? html`<div slot="answer" class="rows">${answer()}</div>` : nothing}
                ${open && this._evidenceOpen ? html`<div slot="evidence" class="rows">${evidence()}</div>` : nothing}
            </helman-node-question>
        `;
    }

    private _renderSummary(overview: InverterDetailPayload) {
        const commanded = this._commandedKind(overview);
        const agreement = overview.agreement;
        const sentence = [
            commanded ? fillTemplate(this._t("status.commanded"), { mode: this._modeLabel(commanded) })
                : this._commandedRaw(overview) ? fillTemplate(this._t("status.commanded"), { mode: this._commandedRaw(overview)! })
                : this._t("status.no_command"),
            agreement.status === "match" ? this._t("status.match")
                : agreement.status === "unknown" && agreement.reason === "unavailable" ? this._t("status.unknown")
                : "",
        ].filter(Boolean).join(" ");

        const figures: Array<[string, string]> = [];
        if (commanded) figures.push([this._t("figure.commanded"), this._modeLabel(commanded)]);
        const ac = this._acPower(overview);
        if (ac !== null) figures.push([this._t("figure.ac_power"), formatPower(ac).display]);
        const temperature = this._reading(overview, "inverter_temperature");
        if (temperature !== null) figures.push([this._t("figure.temperature"), temperature]);

        const next = this._nextChange();
        return html`
            <div class="summary" data-overview>
                <p class="status">${sentence}</p>
                ${figures.length ? html`
                    <div class="figures">
                        ${figures.slice(0, 3).map(([label, value]) => html`
                            <div class="figure"><span class="figure-label">${label}</span><span class="figure-value">${value}</span></div>
                        `)}
                    </div>
                ` : nothing}
                <p class="next" data-next>${next ? fillTemplate(this._t("next_change"), { time: this._time(next.startMs), action: this._actionLabel(next.action) }) : this._t("no_change")}</p>
                ${this._renderException(overview)}
            </div>
        `;
    }

    /** At most one: a reported fault, off-grid operation, or a confirmed disagreement. */
    private _renderException(overview: InverterDetailPayload) {
        let text: string | null = null;
        let target: QuestionId = "why";
        if (overview.condition) {
            text = fillTemplate(this._t(`exception.${overview.condition.kind}`), { state: overview.condition.runMode });
            target = "operating";
        } else if (overview.agreement.status === "mismatch") {
            text = this._t("exception.mismatch");
        }
        if (text === null) return nothing;
        return html`
            <div class="exception" role="status" data-exception>
                <span>${text}</span>
                <button class="link-button" @click=${() => this._setOpen(target)}>${this._t("exception.details")}</button>
            </div>
        `;
    }

    // Why ---------------------------------------------------------------------

    private _whyPreview(): string | null {
        const run = this._currentRun();
        const parts = [run ? this._actionLabel(run.action) : this._t("why.nothing_scheduled")];
        if (this._schedule) parts.push(this._t(this._schedule.executionEnabled ? "why.execution_on_short" : "why.execution_off_short"));
        return parts.join(" · ");
    }

    private _renderWhy(overview: InverterDetailPayload) {
        const run = this._currentRun();
        const runtime = this._currentRuntime();
        const commanded = this._commandedKind(overview);
        return html`
            ${this._row(this._t("why.scheduled_now"), run
                ? this._scheduledText(run)
                : this._t("why.nothing_scheduled"), "scheduled")}
            ${this._schedule ? this._row(this._t("why.execution"), this._t(this._schedule.executionEnabled ? "why.execution_on" : "why.execution_off"), "execution") : nothing}
            ${this._row(this._t("why.executor"), runtime ? this._runtimeText(runtime) : this._t("why.no_runtime"), "executor")}
            ${this._row(this._t("why.last_command"), commanded ? this._modeLabel(commanded) : this._commandedRaw(overview) ?? this._t("unavailable"), "last-command")}
            ${overview.agreement.reason !== "no_profile" ? this._row(this._t("why.observed"), this._agreementText(overview), "agreement") : nothing}
            <p class="note">${this._t("why.explain")}</p>
        `;
    }

    private _renderWhyEvidence(overview: InverterDetailPayload) {
        const registers = overview.agreement.registers;
        return html`
            ${registers.length ? html`
                <div class="section-title">${this._t("why.registers")}</div>
                <table data-registers>
                    <thead><tr><th>${this._t("why.register")}</th><th>${this._t("why.expected")}</th><th>${this._t("why.actual")}</th><th></th></tr></thead>
                    <tbody>
                        ${registers.map((register) => html`
                            <tr>
                                <td>${this._name(register.entityId)}</td>
                                <td>${String(register.expected)}</td>
                                <td>${register.actual ?? this._t("unavailable")}</td>
                                <td>${this._t(register.matches === true ? "why.match_yes" : register.matches === false ? "why.match_no" : "why.match_unknown")}</td>
                            </tr>
                        `)}
                    </tbody>
                </table>
            ` : nothing}
            ${this._optionalRow(overview, "use_mode", "why.use_mode")}
            ${this._optionalRow(overview, "manual_mode", "why.manual_mode")}
            ${this._optionalRow(overview, "remote_control", "why.remote_control")}
            ${this._optionalRow(overview, "remote_control_mode", "why.remote_control_mode")}
            ${this._optionalRow(overview, "active_power_target", "why.active_power_target")}
            ${this._optionalRow(overview, "active_power_real", "why.active_power_real")}
            <p class="note">${this._t("why.evidence_note")}</p>
        `;
    }

    private _agreementText(overview: InverterDetailPayload): string {
        const agreement = overview.agreement;
        if (agreement.status === "match") return this._t("agreement.match");
        if (agreement.status === "mismatch") {
            return agreement.observedOption
                ? fillTemplate(this._t("agreement.mismatch_observed"), { mode: this._modeLabel(agreement.observedOption) })
                : this._t("agreement.mismatch");
        }
        return this._t(`agreement.${agreement.reason ?? "unavailable"}`);
    }

    private _scheduledText(run: ScheduleRun): string {
        const parts = [this._actionLabel(run.action)];
        if (run.endMs !== null) parts.push(fillTemplate(this._t("why.until"), { time: this._time(run.endMs) }));
        let text = parts.join(" ");
        if (run.action.conditionMet === false) text += " – " + this._t("why.candidate");
        return text;
    }

    private _runtimeText(runtime: InverterRuntimeDTO): string {
        const parts = [this._t(`runtime.action.${runtime.actionKind}`), this._t(`runtime.outcome.${runtime.outcome}`)];
        if (runtime.executedAction) parts.push(this._actionLabel(runtime.executedAction));
        const reason = getScheduleReasonLabel(runtime.reason, this.localize);
        if (reason) parts.push(reason);
        if (runtime.outcome === "failed" && runtime.message) parts.push(runtime.message);
        return parts.join(" · ");
    }

    // Next ----------------------------------------------------------------------

    private _nextPreview(): string | null {
        const next = this._nextChange();
        return next
            ? fillTemplate(this._t("next_change"), { time: this._time(next.startMs), action: this._actionLabel(next.action) })
            : this._t("no_change");
    }

    private _renderNext() {
        const runs = this._upcomingRuns();
        const today = this._dayKey(Date.now());
        let lastDay: string | null = null;
        return html`
            ${runs.length ? html`
                <ul class="runs" data-runs>
                    ${runs.map((run) => {
                        const day = this._dayKey(run.startMs);
                        const heading = day !== lastDay ? html`<li class="day-label">${this._t(day === today ? "next.today" : "next.tomorrow")}</li>` : nothing;
                        lastDay = day;
                        return html`
                            ${heading}
                            <li>
                                <span class="run-time">${this._range(run)}</span>
                                <span class=${run.action.conditionMet === false ? "muted" : ""}>
                                    ${this._actionLabel(run.action)}${run.action.conditionMet === false ? " (" + this._t("next.candidate") + ")" : ""}
                                </span>
                            </li>
                        `;
                    })}
                </ul>
            ` : html`<p class="note">${this._t("no_change")}</p>`}
            <p class="note">${this._t("next.explain")}</p>
            <div class="plan" data-plan>${this._planInspector()}</div>
        `;
    }

    private _planInspector(): HTMLElement {
        if (!this._planCard) {
            const card = document.createElement("helman-solar-inspector-card") as InspectorCardElement;
            card.setConfig(INVERTER_PLAN_INSPECTOR_CONFIG);
            this._planCard = card;
        }
        this._planCard.hass = this.hass;
        return this._planCard;
    }

    private _renderNextEvidence() {
        const run = this._currentRun();
        const runtime = this._currentRuntime();
        const action = run?.action;
        return html`
            <div class="section-title">${this._t("next.slot")}</div>
            ${this._row(this._t("next.kind"), action ? this._actionLabel(action) : this._t("why.nothing_scheduled"))}
            ${action?.targetSoc !== undefined ? this._row(this._t("next.target"), action.targetSoc + " %") : nothing}
            ${action?.setBy ? this._row(this._t("next.set_by"), this._t(`next.set_by_${action.setBy}`)) : nothing}
            ${action ? this._row(this._t("next.condition"), this._t(action.conditionMet === false ? "next.condition_not_met" : "next.condition_met")) : nothing}
            ${this._row(this._t("next.runtime_reason"), getScheduleReasonLabel(runtime?.reason, this.localize) ?? this._t("next.reason_not_provided"))}
            <p class="note">${this._t("next.optimizer_note")}</p>
        `;
    }

    // Limits --------------------------------------------------------------------

    private _limitsPreview(overview: InverterDetailPayload): string | null {
        const parts: string[] = [];
        const exportLimit = this._number(overview, "export_limit");
        if (exportLimit !== null) parts.push(fillTemplate(this._t("limits.export_short"), { value: formatPower(exportLimit).display }));
        const soc = this._socRange(overview);
        if (soc) parts.push(fillTemplate(this._t("limits.soc_short"), { range: soc }));
        return parts.length ? parts.join(" · ") : this._t("limits.none");
    }

    private _renderLimits(overview: InverterDetailPayload) {
        const exportLimit = this._number(overview, "export_limit");
        const pvLimit = this._number(overview, "pv_power_limit");
        const soc = this._socRange(overview);
        const rows = [
            exportLimit !== null ? this._row(this._t("limits.export_limit"), formatPower(exportLimit).display, "export-limit", this._t("limits.scope_inverter")) : nothing,
            overview.maxAllowedExportPower !== null ? this._row(this._t("limits.export_cap"), formatPower(overview.maxAllowedExportPower).display, "export-cap", this._t("limits.scope_helman")) : nothing,
            pvLimit !== null ? this._row(this._t("limits.pv_limit"), formatPower(pvLimit).display, "pv-limit", this._t("limits.scope_remote")) : nothing,
            this._optionalRow(overview, "battery_charge_max_current", "limits.charge_current"),
            this._optionalRow(overview, "battery_discharge_max_current", "limits.discharge_current"),
            soc ? this._row(this._t("limits.soc_range"), soc, "soc-range", this._t("limits.scope_config")) : nothing,
        ];
        return html`
            ${rows.every((row) => row === nothing) ? html`<p class="note">${this._t("limits.none")}</p>` : rows}
            <p class="note">${this._t("limits.explain")}</p>
        `;
    }

    private _renderLimitsEvidence(overview: InverterDetailPayload) {
        return html`
            ${this._optionalRow(overview, "eps_min_soc", "limits.eps_min")}
            ${this._optionalRow(overview, "eps_restart_soc", "limits.eps_restart")}
            ${this._optionalRow(overview, "main_breaker_limit", "limits.main_breaker")}
            <p class="note">${this._t("limits.evidence_note")}</p>
        `;
    }

    // Operating -----------------------------------------------------------------

    private _operatingPreview(overview: InverterDetailPayload): string | null {
        const parts: string[] = [];
        const ac = this._acPower(overview);
        if (ac !== null) parts.push(fillTemplate(this._t("operating.ac_short"), { value: formatPower(ac).display }));
        else parts.push(fillTemplate(this._t("operating.solar_short"), { value: formatPower(this.params.solarPower).display }));
        const temperature = this._reading(overview, "inverter_temperature");
        if (temperature) parts.push(temperature);
        return parts.join(" · ");
    }

    private _renderOperating(overview: InverterDetailPayload) {
        const ac = this._acPower(overview);
        const battery = this.params.batteryPower;
        const batteryMode = battery > 50 ? "charging" : battery < -50 ? "discharging" : "idle";
        return html`
            ${"ac_power_l1" in overview.entities
                ? this._row(this._t("operating.ac_total"), ac !== null ? formatPower(ac).display : this._t("unavailable"), "ac-total")
                : nothing}
            ${this._row(this._t("operating.solar"), formatPower(this.params.solarPower).display, "solar")}
            ${this._row(this._t("operating.battery"), formatPower(Math.abs(battery)).display + " · " + this._t(`operating.battery_${batteryMode}`), "battery")}
            ${"ac_power_l1" in overview.entities ? html`<p class="note">${this._t("operating.derived_note")}</p>` : nothing}
            ${overview.sections.includes("temperature") ? this._renderTemperature() : nothing}
        `;
    }

    private _renderTemperature() {
        const section = this._temperature;
        const title = html`<div class="section-title">${this._t("operating.temperature_today")}</div>`;
        if (section === null || section.status === "loading") {
            return html`${title}<p class="note" data-temperature-loading>${this._t("operating.loading_history")}</p>`;
        }
        if (section.status === "error") {
            return html`
                ${title}
                <p class="note">${this._t("operating.history_failed")}</p>
                <button class="link-button" @click=${() => this._loadTemperature()}>${this._t("retry")}</button>
            `;
        }
        const stats = section.payload.temperature;
        if (!stats || stats.points.length === 0 || stats.mean === null) {
            return html`${title}<p class="note">${this._t("operating.temperature_none")}</p>`;
        }
        const unit = stats.unit ?? "";
        const format = (value: number) => value.toFixed(1) + (unit ? " " + unit : "");
        const series: DayLineSeries[] = [{
            key: "temperature",
            label: this._t("figure.temperature"),
            color: "var(--accent-color, #ff9800)",
            points: stats.points.map((point) => ({ t: Date.parse(point.start), v: point.mean, min: point.min, max: point.max })),
        }];
        const summary = fillTemplate(this._t("operating.temperature_summary"), {
            min: format(stats.min!),
            max: format(stats.max!),
            mean: format(stats.mean),
            max_at: stats.maxAt ? this._time(Date.parse(stats.maxAt)) : "?",
            coverage: Math.round(stats.coverage * 100) + " %",
        });
        return html`
            ${title}
            <helman-day-line-chart
                data-temperature-chart
                .series=${series}
                .start=${Date.parse(section.payload.period.start)}
                .end=${Date.parse(section.payload.period.end)}
                .bucketMs=${stats.bucketMinutes * 60_000}
                .timeZone=${this._timeZone}
                .locale=${this._locale}
                .formatValue=${format}
                .summary=${summary}
            ></helman-day-line-chart>
            <p class="note">${this._t(stats.extrema === "recorded" ? "operating.extrema_recorded" : "operating.extrema_statistics")}</p>
        `;
    }

    private _renderOperatingEvidence(overview: InverterDetailPayload) {
        const hasPhases = PHASES.some((phase) => overview.entities["ac_power_l" + phase]);
        const cell = (key: string) => this._reading(overview, key) ?? "–";
        return html`
            ${hasPhases ? html`
                <table data-phases>
                    <thead><tr>
                        <th>${this._t("operating.phase")}</th><th>W</th><th>V</th><th>A</th><th>Hz</th>
                    </tr></thead>
                    <tbody>
                        ${PHASES.map((phase) => html`
                            <tr>
                                <td>L${phase}</td>
                                <td>${cell("ac_power_l" + phase)}</td>
                                <td>${cell("ac_voltage_l" + phase)}</td>
                                <td>${cell("ac_current_l" + phase)}</td>
                                <td>${cell("ac_frequency_l" + phase)}</td>
                            </tr>
                        `)}
                    </tbody>
                </table>
            ` : nothing}
            ${this._optionalRow(overview, "phase_balance", "operating.phase_balance")}
            ${this._optionalRow(overview, "inverter_temperature", "operating.temperature_now")}
            ${this._optionalRow(overview, "run_mode", "operating.run_mode")}
            ${hasPhases ? nothing : html`<p class="note">${this._t("operating.no_phases")}</p>`}
        `;
    }

    // Trust ---------------------------------------------------------------------

    private _trustPreview(overview: InverterDetailPayload): string | null {
        const rate = this._reading(overview, "link_success_rate");
        const quarantined = this._number(overview, "link_quarantined_registers");
        if (rate === null && quarantined === null) return this._t("trust.unavailable");
        const parts: string[] = [];
        if (rate !== null) parts.push(fillTemplate(this._t("trust.rate_short"), { value: rate }));
        if (quarantined !== null) parts.push(fillTemplate(this._t("trust.quarantined_short"), { count: String(quarantined) }));
        return parts.join(" · ");
    }

    private _renderTrust(overview: InverterDetailPayload) {
        const rate = this._reading(overview, "link_success_rate");
        const quarantined = this._number(overview, "link_quarantined_registers");
        return html`
            ${rate === null && quarantined === null ? html`<p class="note">${this._t("trust.unavailable")}</p>` : nothing}
            ${rate !== null ? this._row(this._t("trust.link_rate"), rate, "link-rate") : nothing}
            ${quarantined !== null ? this._row(this._t("trust.quarantined"), String(quarantined), "quarantined") : nothing}
            <p class="note">${this._t("trust.explain")}</p>
        `;
    }

    private _renderTrustEvidence(overview: InverterDetailPayload) {
        return html`
            ${this._optionalRow(overview, "firmware", "trust.firmware")}
            ${this._optionalRow(overview, "hardware_version", "trust.hardware_version")}
            ${this._optionalRow(overview, "rated_power", "trust.rated_power")}
            ${this._optionalRow(overview, "mppt_count", "trust.mppt_count")}
            ${this._optionalRow(overview, "lock_state", "trust.lock_state")}
            ${this._optionalRow(overview, "grid_mode_runtime", "trust.grid_runtime")}
            ${this._optionalRow(overview, "eps_mode_runtime", "trust.eps_runtime")}
        `;
    }

    // ── Rows and readings ───────────────────────────────────────────────────

    private _row(label: string, value: string, key?: string, scope?: string) {
        return html`
            <div class="row" data-row=${key ?? nothing}>
                <span class="label">${label}${scope ? html`<br><span class="note">${scope}</span>` : nothing}</span>
                <span class="value">${value}</span>
            </div>
        `;
    }

    /** A technical row, hidden when its reading is unavailable. */
    private _optionalRow(overview: InverterDetailPayload, key: string, labelKey: string) {
        const value = this._reading(overview, key);
        return value === null ? nothing : this._row(this._t(labelKey), value, key);
    }

    /** A reading as shown: its state and unit, `null` when missing or unavailable. */
    private _reading(overview: InverterDetailPayload, key: string): string | null {
        return readingText(this.hass, overview.entities[key], (on) => this._t(on ? "on" : "off"));
    }

    private _number(overview: InverterDetailPayload, key: string): number | null {
        return readingNumber(this.hass, overview.entities[key]);
    }

    /** The phases' AC power summed, only when every phase reads. */
    private _acPower(overview: InverterDetailPayload): number | null {
        const values = PHASES.map((phase) => this._number(overview, "ac_power_l" + phase));
        return values.every((value): value is number => value !== null)
            ? values.reduce((sum, value) => sum + value, 0)
            : null;
    }

    private _socRange(overview: InverterDetailPayload): string | null {
        const low = this._number(overview, "battery_min_soc");
        const high = this._number(overview, "battery_max_soc");
        if (low === null && high === null) return null;
        return (low ?? "?") + "–" + (high ?? "?") + " %";
    }

    private _commandedKind(overview: InverterDetailPayload): ScheduleActionKind | null {
        return commandedModeKind(overview.mode, this.hass.states);
    }

    /** The mode control's state when it maps to no action kind, as read. */
    private _commandedRaw(overview: InverterDetailPayload): string | null {
        const live = overview.mode ? this.hass.states[overview.mode.entityId]?.state : undefined;
        return live && live !== "unavailable" && live !== "unknown" ? live : null;
    }

    private _name(entityId: string): string {
        return (this.hass.states[entityId]?.attributes.friendly_name as string | undefined) ?? entityId;
    }

    // ── Schedule ────────────────────────────────────────────────────────────

    /** The inverter's actions from the current slot on, merged into runs. */
    private _runs(): ScheduleRun[] {
        return this._runsCache ??= this._computeRuns();
    }

    private _computeRuns(): ScheduleRun[] {
        const slots = this._schedule?.slots ?? [];
        if (!slots.length) return [];
        const byId = new Map(slots.map((slot) => [slot.id, slot]));
        const now = Date.now();
        const runs: ScheduleRun[] = [];
        for (const boundary of resolveScheduleSlotBoundaries(slots.map((slot) => slot.id))) {
            if (boundary.endMs !== null && boundary.endMs <= now) continue;
            const action = (byId.get(boundary.id)?.controllables[INVERTER_CONTROLLABLE_ID] as ScheduleActionDTO | undefined)
                ?? { kind: "empty" as const };
            const last = runs[runs.length - 1];
            if (last && last.endMs === boundary.startMs && sameAction(last.action, action)) {
                last.endMs = boundary.endMs;
            } else {
                runs.push({ startMs: boundary.startMs, endMs: boundary.endMs, action });
            }
        }
        return runs;
    }

    private _currentRun(): ScheduleRun | null {
        const run = this._runs()[0];
        return run && run.startMs <= Date.now() && run.action.kind !== "empty" ? run : null;
    }

    /** The executor's record, only when it is for the slot in progress. */
    private _currentRuntime(): InverterRuntimeDTO | null {
        const runtime = this._schedule?.runtime;
        if (!runtime) return null;
        const slots = resolveScheduleSlotBoundaries((this._schedule?.slots ?? []).map((slot) => slot.id));
        const now = Date.now();
        const current = slots.find((slot) => slot.startMs <= now && (slot.endMs === null || now < slot.endMs));
        if (!current || current.id !== runtime.activeSlotId) return null;
        return (runtime.controllables[INVERTER_CONTROLLABLE_ID] as InverterRuntimeDTO | undefined) ?? null;
    }

    /**
     * The first run today or tomorrow whose effective mode differs from the
     * one before it. An empty stretch counts: the executor returns the
     * inverter to its normal mode there, so it is reported as `normal`.
     */
    private _nextChange(): ScheduleRun | null {
        const now = Date.now();
        const days = this._todayAndTomorrow();
        // Before the first scheduled slot the inverter rests in normal mode.
        let previous: ScheduleActionDTO = { kind: "normal" };
        for (const run of this._runs()) {
            const action = effectiveAction(run.action);
            if (run.startMs > now && !sameAction(previous, action)) {
                return days.includes(this._dayKey(run.startMs)) ? { ...run, action } : null;
            }
            previous = action;
        }
        return null;
    }

    /** Today's and tomorrow's runs, empty stretches left out. */
    private _upcomingRuns(): ScheduleRun[] {
        const [today, tomorrow] = this._todayAndTomorrow();
        return this._runs().filter((run) => {
            const day = this._dayKey(run.startMs);
            return run.action.kind !== "empty" && (day === today || day === tomorrow);
        });
    }

    // ── Formatting ──────────────────────────────────────────────────────────

    private get _timeZone(): string {
        return this.hass.config?.time_zone || "UTC";
    }

    private get _locale(): string {
        return this.hass.locale?.language ?? this.hass.language ?? "cs";
    }

    private _time(ms: number): string {
        return formatScheduleTime(ms, this._locale, this._timeZone);
    }

    private _range(run: ScheduleRun): string {
        return run.endMs === null ? this._time(run.startMs) + "+" : this._time(run.startMs) + "–" + this._time(run.endMs);
    }

    /** Local calendar days, so a 25-hour DST day still has a tomorrow. */
    private _todayAndTomorrow(): [string | null, string | null] {
        const today = this._dayKey(Date.now());
        return [today, today === null ? null : addDaysToDayKey(today, 1)];
    }

    private _dayKey(ms: number): string | null {
        return getScheduleDayKey(new Date(ms), this._timeZone);
    }

    private _actionLabel(action: ScheduleActionDTO): string {
        return getScheduleActionLabel(action, this.localize);
    }

    private _modeLabel(kind: ScheduleActionKind): string {
        return this._t(`mode_short.${kind}`);
    }

    private _t(key: string): string {
        return this.localize(`node_detail.inverter.${key}`);
    }
}

/**
 * What the inverter does in a run: an empty stretch is its normal mode, and so
 * is a candidate whose condition is not met, which the executor strips.
 */
function effectiveAction(action: ScheduleActionDTO): ScheduleActionDTO {
    return action.kind === "empty" || action.conditionMet === false ? { kind: "normal" } : action;
}

function sameAction(left: ScheduleActionDTO, right: ScheduleActionDTO): boolean {
    return left.kind === right.kind
        && left.targetSoc === right.targetSoc
        && (left.conditionMet !== false) === (right.conditionMet !== false);
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-inverter-content": NodeDetailInverterContent;
    }
}
