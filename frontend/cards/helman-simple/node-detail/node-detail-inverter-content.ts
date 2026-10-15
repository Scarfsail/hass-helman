import { css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../../localize/localize";
import type {
    InverterDetailPayload,
    InverterModesSectionPayload,
    InverterTemperatureSectionPayload,
    ScheduleActionKind,
    SchedulePayload,
    TodayFlowsDTO,
} from "../../helman-api";
import type { HelmanSolarInspectorCardConfig } from "../../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { helmanColorVars } from "../../color-vars";
import { getSharedHelmanStore } from "../../helman/store";
import { commandedModeKind } from "../../helman-api";
import { formatPower } from "../../power-format";
import { formatGridEnergy } from "../../shared/forecast-value-format";
import "../../shared/mode-strip";
import { modeStripWindow, type ModeChange, type ModeSegment } from "../../shared/mode-strip";
import { inverterGlyph } from "../../shared/node-glyphs";
import { getScheduleActionTone, scheduleActionToneStyles, type ScheduleActionTone } from "../../shared/schedule/action-tones";
import { getSharedScheduleOwner } from "../../shared/schedule/schedule-owner";
import "../../shared/day-line-chart";
import type { DayLineSeries } from "../../shared/day-line-chart";
import { NodeDetailContentBase, TODAY_REFRESH_MS, type NodeFlow, type SectionState } from "./node-detail-base";
import {
    currentRun,
    currentRuntime,
    dayKey,
    effectiveAction,
    nextChange,
    renderCurrentSlot,
    runtimeText,
    scheduleRuns,
    todayAndTomorrow,
    type ScheduleRun,
} from "./node-detail-schedule";
import { powerUnitFactor } from "../../shared/power-reading";
import { nodeDetailPictureStyles, nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { InverterDetailParams } from "./node-detail-types";

type QuestionId = "why" | "next" | "limits" | "operating" | "trust";

const PHASES = [1, 2, 3] as const;

/**
 * The inspector under "What will it do next?": the battery SoC plan with the
 * schedule strip, on the dialog's surface. Prices, money and the month/year
 * views answer other questions, so they are hidden; the bias diagnostics stay
 * off. Mirrors the Training tab's embed configs in
 * `config-editor/solar-inspector-embed.ts`. The battery detail's plan answer
 * shows the same view.
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

/** One box of the plan → command → inverter chain. */
interface ChainBox {
    key: "plan" | "command" | "inverter";
    value: string;
    detail: string | null;
    tone: ScheduleActionTone;
    /** A confirmed disagreement: the only state the chain promotes. */
    mismatch?: boolean;
}

/**
 * The inverter detail: what Helman commanded, what the hardware shows, and
 * what comes next.
 *
 * It opens on a status pill, then two pictures: the plan → command →
 * inverter chain, which absorbs *why*, and the mode strip from midnight to
 * noon tomorrow, which absorbs *next*. The Now/Today flow around the
 * inverter follows, then the *Limits*, *Operating* and *Trust* tiles; one
 * answer is open at a time, full width under the tiles.
 *
 * Four facts are kept apart throughout: the schedule's intent (this slot's
 * action), the last command (Helman's mode control), the executor's outcome
 * (the schedule runtime) and the observed configuration (the vendor's mode
 * registers, compared by the backend). None of them is presented as another,
 * and only a confirmed disagreement is promoted.
 *
 * Readings are read live from `hass`; the backend overview supplies the entity
 * ids and the comparison, and is re-read when a compared register changes.
 * Today's observed modes (the `modes` section) are read on opening for the
 * strip, and again when the observed mode changes or they go stale; today's
 * temperature only while its question is open.
 */
@customElement("node-detail-inverter-content")
export class NodeDetailInverterContent extends NodeDetailContentBase<InverterDetailPayload, QuestionId> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, nodeDetailPictureStyles, scheduleActionToneStyles, css`
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
        .chain-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 30px minmax(0, 1fr) 30px minmax(0, 1fr);
            align-items: stretch;
            margin-top: 4px;
        }
        .box {
            display: flex;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
            padding: 6px 8px;
            border-radius: 8px;
            border: 2px solid var(--schedule-action-tone-border);
            background: var(--schedule-action-tone-bg);
        }
        .box.mismatch {
            border-color: var(--error-color, #db4437);
            background: color-mix(in srgb, var(--error-color, #db4437) 12%, transparent);
        }
        .box-label {
            font-size: 0.68rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: var(--secondary-text-color);
        }
        .box-value {
            font-weight: 700;
            font-size: 0.88rem;
            line-height: 1.2;
            overflow-wrap: anywhere;
            color: var(--schedule-action-tone-color);
        }
        .box.mismatch .box-value {
            color: var(--error-color, #db4437);
        }
        .box-detail {
            font-size: 0.72rem;
            line-height: 1.2;
            color: var(--secondary-text-color);
            overflow-wrap: anywhere;
        }
        .link {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 2px;
            color: var(--secondary-text-color);
            font-size: 0.6rem;
            line-height: 1.1;
            text-align: center;
            overflow-wrap: anywhere;
        }
        .link svg {
            width: 26px;
            height: 12px;
            stroke: currentColor;
            stroke-width: 1.6;
            fill: none;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        .link.broken {
            color: var(--warning-color, #c27c0e);
        }
        .soc-range .meter-fill {
            --meter-accent: var(--helman-battery);
        }
        .load .meter-fill {
            --meter-accent: var(--helman-neutral);
        }
    `];

    protected readonly _node = "inverter" as const;

    @property({ attribute: false }) public params!: InverterDetailParams;

    @state() private _schedule: SchedulePayload | null = null;
    @state() private _temperature: SectionState<InverterTemperatureSectionPayload> | null = null;
    /** Today's observed modes, read on opening for the strip. */
    @state() private _modes: SectionState<InverterModesSectionPayload> | null = null;

    private _temperatureRequest = 0;
    private _modesRequest = 0;
    private _modesRequestedAt = 0;
    /** The observed mode today's modes were read under; a new one re-reads them. */
    private _modesObserved: ScheduleActionKind | null = null;
    /** A data change was announced: the overview it reloads re-reads today's modes. */
    private _modesChanged = false;
    private _unsubscribeSchedule?: () => void;
    /** `_runs()` for the update in progress; several answers read it per render. */
    private _runsCache?: ScheduleRun[];

    willUpdate(changed: Map<string, unknown>): void {
        this._runsCache = undefined;
        super.willUpdate(changed);
        // Today's modes are "today so far": re-read on a new day, and otherwise
        // at most every few minutes, only while the page is visible.
        if (this._modes?.status === "ready" && !document.hidden
            && (!this._isToday(this._modes.payload.period.start) || Date.now() - this._modesRequestedAt > TODAY_REFRESH_MS)) {
            void this._loadModes();
        }
    }

    protected _start(): void {
        this._unsubscribeSchedule = getSharedScheduleOwner(this.hass).subscribe((snapshot) => {
            this._schedule = snapshot.schedule;
        });
        super._start();
    }

    protected _stop(): void {
        this._unsubscribeSchedule?.();
        this._unsubscribeSchedule = undefined;
        this._temperatureRequest += 1;
        this._modesRequest += 1;
        // A dropped load would otherwise stay "loading" after a reconnect.
        if (this._modes?.status === "loading") this._modes = null;
    }

    protected _onDataChanged(): void {
        // A config change (another client) can re-map what the overview reads.
        super._onDataChanged();
        if (this._open === "operating" && this._temperature !== null) void this._loadTemperature();
        this._modesChanged = true;
    }

    /**
     * Today's modes, a recorder read, are read with the first overview, and
     * again when an overview brings a new observed mode or follows a data
     * change; `willUpdate` keeps them current otherwise.
     */
    protected _overviewLoaded(payload: InverterDetailPayload): void {
        const changed = this._modesChanged;
        this._modesChanged = false;
        if (!payload.sections.includes("modes")) {
            // No longer offered (a config change): nothing to show or refresh.
            this._modesRequest += 1;
            this._modes = null;
            return;
        }
        if (changed || this._modes === null || payload.agreement.observedOption !== this._modesObserved) void this._loadModes();
    }

    /** The states the backend compared: a change in any of them re-reads the comparison. */
    protected _overviewSignature(payload: InverterDetailPayload): string {
        // Every register the observed mode is read from, not only the command's.
        const ids = [payload.mode?.entityId, ...payload.agreement.observedFrom, payload.entities.run_mode];
        return ids.map((id) => (id ? this.hass.states[id]?.state ?? "" : "")).join("|");
    }

    protected _watchedEntities(payload: InverterDetailPayload) {
        return [
            payload.mode?.entityId,
            ...Object.values(payload.entities),
            ...payload.agreement.registers.map((register) => register.entityId),
        ];
    }

    // ── Data ────────────────────────────────────────────────────────────────

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

    /** Today's observed modes; a refresh keeps the day's strip on screen. */
    private async _loadModes(): Promise<void> {
        const request = ++this._modesRequest;
        // A refresh keeps today's strip; yesterday's gives way, so a failure shows.
        if (this._modes?.status !== "ready" || !this._isToday(this._modes.payload.period.start)) {
            this._modes = { status: "loading" };
        }
        this._modesRequestedAt = Date.now();
        this._modesObserved = this._overview.status === "ready" ? this._overview.payload.agreement.observedOption : null;
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<InverterModesSectionPayload>({ node: "inverter", section: "modes" }, { fresh: true });
            if (request !== this._modesRequest) return;
            this._modes = { status: "ready", payload };
        } catch (error) {
            if (request !== this._modesRequest) return;
            console.error("node-detail-inverter: failed to load today's modes", error);
            if (this._modes?.status !== "ready") this._modes = { status: "error" };
        }
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    protected _setOpen(id: QuestionId | null): void {
        super._setOpen(id);
        // A closed answer's history request is obsolete; it is re-read on reopen.
        this._temperatureRequest += 1;
        this._temperature = null;
        if (id === "operating" && this._overview.status === "ready" && this._overview.payload.sections.includes("temperature")) {
            void this._loadTemperature();
        }
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
        return html`
            <div class="content">
                ${this._renderSummary(overview)}
                ${this._renderChain(overview)}
                ${this._renderStrip(overview)}
                ${this._renderInverterFlow(overview)}
                <div class="tiles">
                    ${this._renderLimitsTile(overview)}
                    ${this._renderOperatingTile(overview)}
                    ${overview.profile ? this._renderTrustTile(overview) : nothing}
                </div>
                ${this._renderOpen(overview)}
            </div>
        `;
    }

    /** The open question's answer and evidence, full width under the tiles. */
    private _renderOpen(overview: InverterDetailPayload) {
        switch (this._open) {
            case "why":
                return this._question("why", this._whyPreview(), () => this._renderWhy(overview), () => this._renderWhyEvidence(overview), "evidence");
            case "next":
                return this._question("next", this._nextPreview(), () => this._renderNext(), () => this._renderNextEvidence(), "evidence");
            case "limits":
                return this._question("limits", this._limitsPreview(overview), () => this._renderLimits(overview), () => this._renderLimitsEvidence(overview), "technical");
            case "operating":
                return this._question("operating", this._operatingPreview(overview), () => this._renderOperating(overview), () => this._renderOperatingEvidence(overview), "technical");
            case "trust":
                return overview.profile ? this._question("trust", this._trustPreview(overview), () => this._renderTrust(overview), () => this._renderTrustEvidence(overview), "technical") : nothing;
            default:
                return nothing;
        }
    }

    /** The last command in its mode's tone, and at most one reported condition. */
    private _renderSummary(overview: InverterDetailPayload) {
        const commanded = this._commandedKind(overview);
        const raw = this._commandedRaw(overview);
        const status = commanded || raw
            ? fillTemplate(this._t("status.commanded"), { mode: commanded ? this._modeLabel(commanded) : raw! })
            : this._t("status.no_command");
        const tone: ScheduleActionTone = commanded ? getScheduleActionTone(commanded) : "neutral";
        return html`
            <div class="summary" data-overview>
                <p class="status pill action-tone-${tone}" data-tone=${tone}>${status}</p>
                ${this._renderCondition(overview)}
            </div>
        `;
    }

    /** A fault or off-grid operation the hardware reports, leading to the operating answer. */
    private _renderCondition(overview: InverterDetailPayload) {
        const condition = overview.condition;
        if (!condition) return nothing;
        return html`
            <div class="exception" role="status" data-exception>
                <span>${fillTemplate(this._t(`exception.${condition.kind}`), { state: condition.runMode })}</span>
                <button class="link-button" @click=${() => this._setOpen("operating")}>${this._t("exception.details")}</button>
            </div>
        `;
    }

    // Chain -------------------------------------------------------------------

    /**
     * Plan → command → inverter, always three boxes, each bordered in its
     * mode's tone. With execution off the plan's link to the command is
     * broken. A confirmed mismatch turns the inverter's box red and puts the
     * mismatch exception under the chain. The chain opens *why*.
     */
    private _renderChain(overview: InverterDetailPayload) {
        const notApplied = this._schedule !== null && !this._schedule.executionEnabled;
        const [plan, command, inverter] = this._chainBoxes(overview);
        const mismatch = overview.agreement.status === "mismatch";
        return html`
            <button class="picture chain" data-chain title=${this._t("q.why")} aria-expanded=${this._open === "why" ? "true" : "false"}
                @click=${() => this._setOpen(this._open === "why" ? null : "why")}>
                <span class="picture-scope">${this._nowScopeLabel()}</span>
                <span class="chain-row">
                    ${this._renderBox(plan)}
                    ${this._renderLink(notApplied)}
                    ${this._renderBox(command)}
                    ${this._renderLink(false)}
                    ${this._renderBox(inverter)}
                </span>
            </button>
            ${mismatch ? html`
                <div class="exception" role="status" data-exception>
                    <span>${this._t("exception.mismatch")}</span>
                    <button class="link-button" @click=${() => this._setOpen("why")}>${this._t("exception.details")}</button>
                </div>
            ` : nothing}
        `;
    }

    private _chainBoxes(overview: InverterDetailPayload): [ChainBox, ChainBox, ChainBox] {
        const run = this._currentRun();
        const runtime = this._currentRuntime();
        const commanded = this._commandedKind(overview);
        const agreement = overview.agreement;
        const observed = agreement.observedOption;
        // What the executor applies, as the strip and the next change read it:
        // a candidate whose condition is not met is normal, and said so.
        const planned = run ? effectiveAction(run.action) : null;
        const plan: ChainBox = {
            key: "plan",
            value: planned ? this._actionLabel(planned) : this._t("why.nothing_scheduled"),
            detail: [
                run?.action.conditionMet === false ? fillTemplate(this._t("chain.candidate"), { action: this._actionLabel(run.action) }) : null,
                this._schedule ? this._t(this._schedule.executionEnabled ? "why.execution_on_short" : "why.execution_off_short") : null,
            ].filter(Boolean).join(" · ") || null,
            tone: planned ? getScheduleActionTone(planned.kind) : "neutral",
        };
        const command: ChainBox = {
            key: "command",
            value: commanded ? this._modeLabel(commanded) : this._commandedRaw(overview) ?? this._t("unavailable"),
            detail: runtime
                ? fillTemplate(this._t("chain.executor"), { outcome: this._t(`runtime.outcome.${runtime.outcome}`) })
                : this._t("chain.no_runtime"),
            tone: commanded ? getScheduleActionTone(commanded) : "neutral",
        };
        const inverter: ChainBox = {
            key: "inverter",
            value: observed ? this._modeLabel(observed) : agreement.status === "mismatch" ? this._t("chain.other_mode") : "–",
            detail: this._t(agreement.status === "match" ? "chain.match"
                : agreement.status === "mismatch" ? "chain.mismatch"
                : agreement.reason === "no_profile" ? "chain.not_read"
                : agreement.reason === "no_command" || agreement.reason === "not_bound" ? `agreement.${agreement.reason}`
                : "chain.unknown"),
            tone: observed ? getScheduleActionTone(observed) : "neutral",
            mismatch: agreement.status === "mismatch",
        };
        return [plan, command, inverter];
    }

    private _renderBox(box: ChainBox) {
        return html`
            <span class="box action-tone-${box.tone} ${box.mismatch ? "mismatch" : ""}" data-box=${box.key} data-tone=${box.tone}
                data-state=${box.mismatch ? "mismatch" : nothing}>
                <span class="box-label">${this._t(`chain.${box.key}`)}</span>
                <span class="box-value">${box.value}</span>
                ${box.detail ? html`<span class="box-detail">${box.detail}</span>` : nothing}
            </span>
        `;
    }

    /** An arrow; broken, and said so, where the plan is not applied. */
    private _renderLink(broken: boolean) {
        return html`
            <span class="link ${broken ? "broken" : ""}" data-link=${broken ? "broken" : "applied"}>
                <svg viewBox="0 0 26 12" aria-hidden="true">
                    ${broken
                        ? svg`<path d="M1 6 H8 M15 6 H20 M17 2 L22 6 L17 10 M9 10 L12 2 M12 10 L15 2"></path>`
                        : svg`<path d="M1 6 H20 M17 2 L22 6 L17 10"></path>`}
                </svg>
                ${broken ? html`<span>${this._t("chain.not_applied")}</span>` : nothing}
            </span>
        `;
    }

    // Strip -------------------------------------------------------------------

    /**
     * Today's observed modes, solid, and the plan's from now to noon
     * tomorrow, hatched, with the next change flagged in its tone. The strip
     * opens *next*.
     */
    private _renderStrip(overview: InverterDetailPayload) {
        const now = Date.now();
        const { start, end } = modeStripWindow(now, this._timeZone);
        const change = this._nextChange();
        const next: ModeChange | null = change ? {
            at: change.startMs,
            tone: getScheduleActionTone(change.action.kind),
            label: this._time(change.startMs) + " · " + this._actionLabel(change.action),
        } : null;
        return html`
            <button class="picture strip" data-strip title=${this._t("q.next")} aria-expanded=${this._open === "next" ? "true" : "false"}
                @click=${() => this._setOpen(this._open === "next" ? null : "next")}>
                <span class="picture-scope">${this._t("strip.scope")}</span>
                <helman-mode-strip
                    .start=${start}
                    .end=${end}
                    .now=${now}
                    .segments=${this._stripSegments(overview, now)}
                    .next=${next}
                    .timeZone=${this._timeZone}
                    .locale=${this._locale}
                ></helman-mode-strip>
            </button>
            ${this._modes?.status === "error" ? html`
                <p class="note" data-strip-failed>${this._t("strip.history_failed")}
                    <button class="link-button" @click=${() => this._loadModes()}>${this._t("retry")}</button>
                </p>
            ` : nothing}
            ${!overview.sections.includes("modes") ? html`<p class="note" data-strip-no-history>${this._t("strip.no_history")}</p>`
                : this._modes?.status === "ready" && this._modes.payload.modes === null ? html`<p class="note" data-strip-no-registers>${this._t("strip.no_registers")}</p>`
                : nothing}
        `;
    }

    /**
     * The recorded stretches, a stretch the registers held no mode in left
     * as a gap, and the plan's runs from now: what the executor applies, in
     * its tone, or neutral while execution is off.
     */
    private _stripSegments(overview: InverterDetailPayload, now: number): ModeSegment[] {
        const segments: ModeSegment[] = [];
        const modes = this._modes?.status === "ready" ? this._modes.payload.modes : null;
        for (const stretch of modes ?? []) {
            if (stretch.kind === null) continue;
            // Still held: drawn to now while the registers still show it.
            const open = stretch.open && overview.agreement.observedOption === stretch.kind;
            segments.push({
                start: Date.parse(stretch.start),
                end: open ? now : Date.parse(stretch.end),
                tone: getScheduleActionTone(stretch.kind),
                label: this._modeLabel(stretch.kind),
            });
        }
        const executing = this._schedule?.executionEnabled === true;
        for (const run of this._runs()) {
            const action = effectiveAction(run.action);
            segments.push({
                start: Math.max(run.startMs, now),
                end: run.endMs ?? Infinity,
                tone: executing ? getScheduleActionTone(action.kind) : "neutral",
                label: this._actionLabel(action) + (executing ? "" : " – " + this._t("chain.not_applied")),
            });
        }
        return segments;
    }

    // Flow --------------------------------------------------------------------

    /**
     * Solar, battery and grid in; house, battery and export out, around the
     * inverter with its AC power now. Live from the card on Now, today's kWh
     * from the `flows` section on Today. The flow opens *operating*.
     */
    private _renderInverterFlow(overview: InverterDetailPayload) {
        const flow = this._flowScope === "now" ? this._nowFlow(overview) : this._todayFlow();
        return this._renderFlow(flow, this.params.flowScaleW, "operating", html`<span slot="centre">${inverterGlyph()}</span>`);
    }

    /** The card's live split, W; unknown without the solar, battery or house reading, never 0. */
    private _nowFlow(overview: InverterDetailPayload): NodeFlow {
        const flows = this.params.flows;
        const power = (value: number | null) => value === null ? "–" : formatPower(value).display;
        const sum = (...keys: Array<keyof NonNullable<typeof flows>>) => flows ? keys.reduce((total, key) => total + flows[key], 0) : null;
        const inputs = [
            this._flowItem("solar", sum("solarToHouse", "solarToBattery", "solarToGrid"), power),
            this._flowItem("battery", sum("batteryToHouse", "batteryToGrid"), power),
            this._flowItem("grid", sum("gridToHouse", "gridToBattery"), power),
        ];
        const outputs = [
            this._flowItem("house", sum("solarToHouse", "batteryToHouse", "gridToHouse"), power),
            this._flowItem("battery", sum("solarToBattery", "gridToBattery"), power),
            this._exportItem(sum("solarToGrid", "batteryToGrid"), power),
        ];
        const ac = this._acPower(overview);
        return {
            scopeLabel: this._nowScopeLabel(),
            inputs,
            outputs,
            ...this._flowTotals(inputs, outputs, power),
            notes: [],
            centreValue: ac === null ? null : fillTemplate(this._t("operating.ac_short"), { value: power(ac) }),
            active: this._isActive(ac),
        };
    }

    /**
     * Today's kWh from the `flows` section, the same edges as Now. Energy
     * whose source or destination is not known is said in the footnotes and
     * added to its side's total, never forced into a ribbon.
     */
    private _todayFlow(): NodeFlow {
        const flows = this._todayFlows?.status === "ready" ? this._todayFlows.payload.flows : null;
        const energy = (value: number | null) => value === null ? "–" : formatGridEnergy(value);
        const sum = (...keys: Array<keyof TodayFlowsDTO>) => {
            const values = keys.map((key) => flows?.[key] ?? null);
            return values.some((value) => value === null) ? null : values.reduce((total, value) => total! + value!, 0);
        };
        const inputs = [
            this._flowItem("solar", sum("solarToHouse", "solarToBattery", "solarToGrid"), energy),
            this._flowItem("battery", sum("batteryToHouse", "batteryToGrid"), energy),
            this._flowItem("grid", sum("gridToHouse", "gridToBattery"), energy),
        ];
        const outputs = [
            this._flowItem("house", sum("solarToHouse", "batteryToHouse", "gridToHouse"), energy),
            this._flowItem("battery", sum("solarToBattery", "gridToBattery"), energy),
            this._exportItem(sum("solarToGrid", "batteryToGrid"), energy),
        ];
        const status = this._todayFlowsNote();
        const notes: string[] = status ? [status] : [];
        const unresolvedSolar = flows?.solarUnresolved ?? 0;
        const unknownCharge = flows?.unknownToBattery ?? 0;
        const unknownHouse = flows?.unknownToHouse ?? 0;
        if (unresolvedSolar > 0) notes.push(fillTemplate(this.localize("node_detail.solar.flow.unresolved"), { kwh: formatGridEnergy(unresolvedSolar) }));
        if (unknownCharge > 0) notes.push(fillTemplate(this.localize("node_detail.battery.flow.unknown_charge"), { kwh: formatGridEnergy(unknownCharge) }));
        if (unknownHouse > 0) notes.push(fillTemplate(this._t("flow.unknown_house"), { kwh: formatGridEnergy(unknownHouse) }));
        const { sumOut, ...totals } = this._flowTotals(inputs, outputs, energy, unresolvedSolar, unknownCharge + unknownHouse);
        return {
            scopeLabel: this._todayScopeLabel(),
            inputs,
            outputs,
            ...totals,
            notes,
            centreValue: energy(sumOut),
            active: false,
        };
    }

    /** What goes out to the grid: an export, in the grid's colour. */
    private _exportItem(value: number | null, format: (value: number | null) => string) {
        return { ...this._flowItem("grid", value, format), label: this._t("flow.export") };
    }

    // Tiles -------------------------------------------------------------------

    /** The export cap the inverter holds, and the battery's SoC range as a bar. */
    private _renderLimitsTile(overview: InverterDetailPayload) {
        const exportLimit = this._watts(overview, "export_limit") ?? overview.maxAllowedExportPower;
        const low = this._number(overview, "battery_min_soc");
        const high = this._number(overview, "battery_max_soc");
        const soc = this._socRange(overview);
        if (exportLimit === null && soc === null) return this._tile("limits", "–", this._t("limits.none"));
        const detail = [
            exportLimit !== null ? this._t("tile.export_cap") : null,
            soc ? fillTemplate(this._t("limits.soc_short"), { range: soc }) : null,
        ].filter(Boolean).join(" · ");
        const bar = low !== null && high !== null && low >= 0 && high <= 100 && high >= low ? html`
            <span class="meter soc-range" data-soc-range data-min=${low} data-max=${high}>
                <span class="meter-fill" style="margin-left: ${low}%; width: ${high - low}%"></span>
            </span>
        ` : nothing;
        return this._tile("limits", exportLimit !== null ? "≤ " + formatPower(exportLimit).display : "–", detail, bar);
    }

    /** The temperature, and the AC load as a share of the inverter's rating, without thresholds. */
    private _renderOperatingTile(overview: InverterDetailPayload) {
        const ac = this._acPower(overview);
        const rated = this._watts(overview, "rated_power");
        const share = ac !== null && rated !== null && rated > 0 ? Math.abs(ac) / rated : null;
        const detail = ac === null ? null
            : share === null ? fillTemplate(this._t("operating.ac_short"), { value: formatPower(ac).display })
            : fillTemplate(this._t("tile.ac_share"), { value: formatPower(ac).display, share: this._share(share) });
        const bar = share !== null ? html`
            <span class="meter load" data-load-meter><span class="meter-fill" style="width: ${Math.min(100, share * 100).toFixed(1)}%"></span></span>
        ` : nothing;
        return this._tile("operating", this._reading(overview, "inverter_temperature") ?? "–", detail, bar);
    }

    /** The link's success rate and the quarantined registers, as the integration reports them. */
    private _renderTrustTile(overview: InverterDetailPayload) {
        const rate = this._reading(overview, "link_success_rate");
        const quarantined = this._number(overview, "link_quarantined_registers");
        if (rate === null && quarantined === null) return this._tile("trust", "–", this._t("trust.unavailable"));
        return this._tile(
            "trust",
            rate ?? "–",
            quarantined !== null ? fillTemplate(this._t("trust.quarantined_short"), { count: String(quarantined) }) : null,
        );
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
            ${this._row(this._t("why.executor"), runtime ? runtimeText(runtime, this.localize) : this._t("why.no_runtime"), "executor")}
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
            <div class="plan" data-plan>${this._inspector("next", INVERTER_PLAN_INSPECTOR_CONFIG)}</div>
        `;
    }

    private _renderNextEvidence() {
        return renderCurrentSlot(this._currentRun(), this._currentRuntime(), this.localize, (label, value) => this._row(label, value));
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
            exportLimit !== null ? this._row(this._t("limits.export_limit"), formatPower(exportLimit).display, "export-limit", this._t("limits.scope_inverter"), overview.entities.export_limit) : nothing,
            overview.maxAllowedExportPower !== null ? this._row(this._t("limits.export_cap"), formatPower(overview.maxAllowedExportPower).display, "export-cap", this._t("limits.scope_helman")) : nothing,
            pvLimit !== null ? this._row(this._t("limits.pv_limit"), formatPower(pvLimit).display, "pv-limit", this._t("limits.scope_remote"), overview.entities.pv_power_limit) : nothing,
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
            ${rate !== null ? this._row(this._t("trust.link_rate"), rate, "link-rate", undefined, overview.entities.link_success_rate) : nothing}
            ${quarantined !== null ? this._row(this._t("trust.quarantined"), String(quarantined), "quarantined", undefined, overview.entities.link_quarantined_registers) : nothing}
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

    /** The phases' AC power summed, W, only when every phase reads in a power unit. */
    private _acPower(overview: InverterDetailPayload): number | null {
        const values = PHASES.map((phase) => this._watts(overview, "ac_power_l" + phase));
        return values.every((value): value is number => value !== null)
            ? values.reduce((sum, value) => sum + value, 0)
            : null;
    }

    /** A power reading in W, signed; `null` when missing or in a unit that is not power. */
    private _watts(overview: InverterDetailPayload, key: string): number | null {
        const value = this._number(overview, key);
        const factor = powerUnitFactor(this.hass, overview.entities[key]);
        return value === null || factor === null ? null : value * factor;
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

    // ── Schedule ────────────────────────────────────────────────────────────

    /** The inverter's actions from the current slot on, merged into runs. */
    /** The slot in progress and the next change are read off the clock. */
    protected *_clockBoundaries(): Iterable<number> {
        for (const run of this._runs()) {
            yield run.startMs;
            if (run.endMs !== null) yield run.endMs;
        }
    }

    private _runs(): ScheduleRun[] {
        return this._runsCache ??= scheduleRuns(this._schedule, Date.now());
    }

    private _currentRun(): ScheduleRun | null {
        return currentRun(this._runs(), Date.now());
    }

    private _currentRuntime() {
        return currentRuntime(this._schedule, Date.now());
    }

    private _nextChange(): ScheduleRun | null {
        return nextChange(this._runs(), Date.now(), this._timeZone);
    }

    /** Today's and tomorrow's runs, empty stretches left out. */
    private _upcomingRuns(): ScheduleRun[] {
        const [today, tomorrow] = todayAndTomorrow(Date.now(), this._timeZone);
        return this._runs().filter((run) => {
            const day = this._dayKey(run.startMs);
            return run.action.kind !== "empty" && (day === today || day === tomorrow);
        });
    }

    // ── Formatting ──────────────────────────────────────────────────────────

    private _range(run: ScheduleRun): string {
        return run.endMs === null ? this._time(run.startMs) + "+" : this._time(run.startMs) + "–" + this._time(run.endMs);
    }

    private _dayKey(ms: number): string | null {
        return dayKey(ms, this._timeZone);
    }

    private _modeLabel(kind: ScheduleActionKind): string {
        return this._t(`mode_short.${kind}`);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-inverter-content": NodeDetailInverterContent;
    }
}
