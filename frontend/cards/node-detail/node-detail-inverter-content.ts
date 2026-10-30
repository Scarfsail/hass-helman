import { formatPower } from "../shared/format";
import { css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import type {
    InverterDetailPayload,
    InverterModesSectionPayload,
    InverterRuntimeDTO,
    InverterTemperatureSectionPayload,
    ScheduleActionKind,
} from "../helman-api";
import { helmanColorVars } from "../color-vars";
import { commandedModeKind } from "../helman-api";

import type { ModeSegment } from "../shared/mode-strip";
import { inverterGlyph } from "../shared/node-glyphs";
import { getScheduleActionTone, scheduleActionToneStyles, type ScheduleActionTone } from "../shared/schedule/action-tones";
import { getScheduleReasonLabel } from "../shared/schedule/model/schedule-labels";
import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import "../shared/day-line-chart";
import type { DayLineSeries } from "../shared/day-line-chart";
import { IDLE_W, NodeDetailContentBase } from "./node-detail-base";
import { staleToday } from "./section-resource";
import {
    currentRun,
    effectiveAction,
    inverterModeLabel,
    inverterRuns,
    renderCurrentSlot,
    runtimeFor,
    runtimeText,
} from "./node-detail-schedule";
import { powerUnitFactor } from "../shared/power-reading";
import { nodeDetailPictureStyles, nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { InverterDetailParams } from "./node-detail-types";
import { LaneOwnershipController } from "./lane-ownership";
import { DialogHistoryController } from "../shared/dialog-history-controller";
import type { ControlOverrideDialog } from "./control-override-dialog";
import { boldTemplate } from "./detail-section";
import { historyRow, historySummary, renderShowMore, sectionNotReady, subTitle } from "./node-detail-history";
import "./detail-headline";
import "./help-tip";
import "./control-override-dialog";

const PHASES = [1, 2, 3] as const;

/** A link whose readings succeed at least this often, %, with no register quarantined, is healthy. */
const LINK_HEALTHY_PCT = 99;

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
 * The Overview opens on the mode headline (what the mode does as caption),
 * then the plan → command → inverter chain and the output tile.
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
 * Schedule section's strip, and again when the observed mode changes or they
 * go stale; today's temperature on opening too, for the History header.
 */
export { inverterModeLabel };

@customElement("node-detail-inverter-content")
export class NodeDetailInverterContent extends NodeDetailContentBase<InverterDetailPayload> {
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
            grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr) 20px minmax(0, 1fr);
            align-items: stretch;
        }
        .box {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 0;
            padding: 10px;
            border-radius: 10px;
            background: var(--secondary-background-color);
        }
        .box.mismatch {
            outline: 1px solid var(--error-color, #db4437);
            background: color-mix(in srgb, var(--error-color, #db4437) 12%, transparent);
        }
        .box-label {
            font-size: 12px;
            line-height: 1.45;
            color: var(--secondary-text-color);
        }
        .box-value {
            font-size: 13px;
            line-height: 1.2;
            overflow-wrap: anywhere;
            color: var(--schedule-action-tone-color);
        }
        .box.mismatch .box-value {
            color: var(--error-color, #db4437);
        }
        .box-detail {
            font-size: 0.75rem;
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
            color: var(--success-color, #43a047);
        }
        .link svg {
            width: 18px;
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
        .inverter-icon.active { animation: inverter-glow 2s ease-in-out infinite; }
        [data-verdict] { margin: 0; color: var(--warning-color, #c27c0e); }
        [data-verdict][data-agrees] { color: var(--success-color, #43a047); }
        [data-output] ~ .meter { height: 8px; margin: 0; --meter-accent: var(--primary-text-color); }
        @keyframes inverter-glow {
            50% { filter: drop-shadow(0 0 8px var(--helman-neutral)); }
        }
        @media (prefers-reduced-motion: reduce) { .inverter-icon.active { animation: none; } }
    `];

    protected readonly _node = "inverter" as const;

    @property({ attribute: false }) public params!: InverterDetailParams;
    @state() private _overrideOpen = false;
    private readonly _lanes = new LaneOwnershipController(this, () => this.hass);
    private readonly _history = new DialogHistoryController(this, "__helmanInverterOverrideId", {
        onBack: () => {
            const dialog = this.renderRoot.querySelector<ControlOverrideDialog>("control-override-dialog");
            if (dialog === null) return false;
            queueMicrotask(() => dialog.requestClose());
            return true;
        },
        close: () => { this._overrideOpen = false; },
    });
    private _openOverride(): void {
        this._overrideOpen = true;
        this._history.push();
    }
    private _onOverrideClosed = (): void => {
        this._history.closed();
        this._overrideOpen = false;
    };

    /** The inverter's plan. */
    private readonly _plan = this._useSchedule(inverterRuns);
    /** Today's temperature, for the History header's range: read on opening and kept current. */
    private readonly _temperature = this._section<InverterTemperatureSectionPayload>("temperature", {
        fetch: () => this._readSection("temperature"),
        shown: () => this._offers("temperature"),
    });
    /** The observed mode today's modes were read under; a new one re-reads them. */
    private _modesObserved: ScheduleActionKind | null = null;
    /** Today's observed modes, for the strip, while the overview offers them. */
    private readonly _modes = this._section<InverterModesSectionPayload>("modes", {
        fetch: () => this._readSection("modes"),
        shown: () => this._offers("modes"),
        staleness: (payload, requestedAt) => staleToday(payload, requestedAt, this.hass)
            || (this._overview.status === "ready" && this._overview.payload.agreement.observedOption !== this._modesObserved),
        onRequest: () => {
            this._modesObserved = this._overview.status === "ready" ? this._overview.payload.agreement.observedOption : null;
        },
    });
    /** The states the backend compared: a change in any of them re-reads the comparison. */
    protected _signatureEntities(payload: InverterDetailPayload) {
        // Every register the observed mode is read from, not only the command's.
        return [payload.mode?.entityId, ...payload.agreement.observedFrom, payload.entities.run_mode];
    }

    protected _watchedEntities(payload: InverterDetailPayload) {
        return [
            payload.mode?.entityId,
            ...Object.values(payload.entities),
            ...payload.agreement.registers.map((register) => register.entityId),
        ];
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    protected _renderOverview(overview: InverterDetailPayload) {
        const mode = overview.agreement.observedOption;
        const ac = this._acPower(overview);
        const rated = this._watts(overview, "rated_power");
        const pct = ac !== null && rated !== null && rated > 0 ? Math.round(Math.abs(ac) / rated * 100) : null;
        const controllable = this._lanes.roster?.find((item) => item.id === INVERTER_CONTROLLABLE_ID);
        return html`
            <div class="content" data-overview>
                ${this._renderException(overview)}
                <helman-detail-headline .value=${mode ? this._modeLabel(mode) : "—"}
                    .entityId=${overview.mode?.entityId ?? null}
                    .caption=${mode && mode !== "empty" ? [this.localize("node_detail.shared.mode_now"), this.localize(`node_detail.shared.mode_does.${mode}`)] : [this.localize("node_detail.shared.mode_now")]}>
                    <span slot="icon" class=${`inverter-icon ${ac !== null && Math.abs(ac) > IDLE_W ? "active" : ""}`}>${inverterGlyph()}</span>
                </helman-detail-headline>
                <div class="section-title">${this.localize("node_detail.shared.inverter_chain")}
                    <helman-help-tip .explanation=${this.localize("node_detail.shared.inverter_chain_help")}></helman-help-tip></div>
                ${this._renderChain(overview)}
                <div class="tile">
                    <div class="row" data-output><span class="label">${this.localize("node_detail.shared.output_now")}</span>
                        <span>${ac === null ? "—" : formatPower(Math.abs(ac)).display}${pct !== null && rated !== null ? html` <span class="label">· ${pct} % ${this.localize("node_detail.shared.of_rating")} ${formatPower(rated).display}</span>` : nothing}</span></div>
                    ${pct !== null ? html`<span class="meter"><span class="meter-fill" style=${`width:${Math.min(100, pct)}%`}></span></span>` : nothing}
                    <div class="row"><span class="label">${this.localize("node_detail.shared.temperature")}</span><span>${this._reading(overview, "inverter_temperature") ?? "—"}</span></div>
                </div>
                <button type="button" class="outline-button" ?disabled=${!controllable?.supportsAuthoring} @click=${this._openOverride}>${this.localize("node_detail.shared.override_mode")}</button>
                ${this._overrideOpen && controllable ? html`<control-override-dialog .hass=${this.hass} .localize=${this.localize}
                    .controllable=${controllable} .normalized=${this._lanes.normalized}
                    .executionEnabled=${this._lanes.snapshot.schedule?.executionEnabled ?? false} .open=${true}
                    @closed=${this._onOverrideClosed}></control-override-dialog>` : nothing}
            </div>
        `;
    }

    /** A fault or off-grid operation the hardware reports, else a reported mismatch. */
    private _renderException(overview: InverterDetailPayload) {
        const condition = overview.condition;
        if (condition) return this._exceptionBanner(fillTemplate(this._t(`exception.${condition.kind}`), { state: condition.runMode }));
        return overview.agreement.status === "mismatch" ? this._exceptionBanner(this._t("exception.mismatch")) : nothing;
    }

    // Chain -------------------------------------------------------------------

    /**
     * Plan → command → inverter, always three boxes, each bordered in its
     * mode's tone. With execution off the plan's link to the command is
     * broken. A confirmed mismatch turns the inverter's box red and puts the
     * mismatch exception under the chain. The chain opens *why*.
     */
    private _renderChain(overview: InverterDetailPayload) {
        const notApplied = this._plan.schedule !== null && !this._plan.schedule.executionEnabled;
        const [plan, command, inverter] = this._chainBoxes(overview);
        const mismatch = overview.agreement.status === "mismatch";
        const current = this._plan.runs.find((run) => run.startMs <= Date.now() && (run.endMs === null || Date.now() < run.endMs));
        const runtime = runtimeFor<InverterRuntimeDTO>(this._plan.schedule, INVERTER_CONTROLLABLE_ID, Date.now());
        // A target reached resolves to holding the battery there: that is the plan, carried out.
        const resolved = runtime?.reason === "target_soc_reached" ? runtime.executedAction?.kind : undefined;
        const planned = current ? resolved ?? effectiveAction(current.action).kind : null;
        const commanded = this._commandedKind(overview);
        const planMismatch = planned !== null && commanded !== null && planned !== commanded;
        const reason = notApplied ? this._t("why.execution_off_short")
            : planMismatch ? this._t("chain.plan_mismatch")
                : runtime?.outcome === "failed" ? this._t("chain.executor_failed")
                    : mismatch ? this._t("exception.mismatch") : null;
        return html`
            <div class="picture chain" data-chain>
                <span class="chain-row">
                    ${this._renderBox(plan)}
                    ${this._renderLink(notApplied)}
                    ${this._renderBox(command)}
                    ${this._renderLink(false)}
                    ${this._renderBox(inverter)}
                </span>
            </div>
            <p data-verdict ?data-agrees=${!reason && planned !== null && commanded !== null && overview.agreement.status === "match"}>${reason ? fillTemplate(this.localize("node_detail.shared.inverter_not_applied"), { why: reason })
                : planned !== null && commanded !== null && overview.agreement.status === "match"
                    ? this.localize("node_detail.shared.inverter_agrees") : this._t("chain.unknown")}</p>
        `;
    }

    private _chainBoxes(overview: InverterDetailPayload): [ChainBox, ChainBox, ChainBox] {
        const run = currentRun(this._plan.runs, Date.now());
        const runtime = runtimeFor<InverterRuntimeDTO>(this._plan.schedule, INVERTER_CONTROLLABLE_ID, Date.now());
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
                run && runtime?.reason === "target_soc_reached" ? getScheduleReasonLabel(runtime.reason, this.localize) : null,
                this._plan.schedule ? this._t(this._plan.schedule.executionEnabled ? "why.execution_on_short" : "why.execution_off_short") : null,
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
            <span class="link ${broken ? "broken" : ""}" data-link=${broken ? "broken" : "applied"} title=${broken ? this._t("chain.not_applied") : nothing}>
                <svg viewBox="0 0 26 12" aria-hidden="true">
                    ${broken
                        ? svg`<path d="M1 6 H8 M15 6 H20 M17 2 L22 6 L17 10 M9 10 L12 2 M12 10 L15 2"></path>`
                        : svg`<path d="M1 6 H20 M17 2 L22 6 L17 10"></path>`}
                </svg>
            </span>
        `;
    }

    // Lane history -----------------------------------------------------------

    protected updated(changed: Map<string, unknown>): void {
        super.updated(changed);
        if (this._overview.status !== "ready") return;
        const overview = this._overview.payload;
        const failed = this._modes.state?.status === "error";
        const note = failed ? this._t("strip.history_failed")
            : !overview.sections.includes("modes") ? this._t("strip.no_history")
            : this._modes.payload?.modes === null ? this._t("strip.no_registers")
            : null;
        this._reportLaneHistory({ segments: this._historySegments(overview), note, retry: failed ? { label: this._t("retry"), load: () => this._modes.load() } : null });
    }

    /**
     * Today's recorded modes for the Schedule strip, a stretch the registers
     * held no mode in left as a gap; the one still held runs on while the
     * registers still show it.
     */
    private _historySegments(overview: InverterDetailPayload): ModeSegment[] {
        return (this._modes.payload?.modes ?? []).flatMap((stretch) => stretch.kind === null ? [] : [{
            start: Date.parse(stretch.start),
            end: stretch.open && overview.agreement.observedOption === stretch.kind ? Infinity : Date.parse(stretch.end),
            tone: getScheduleActionTone(stretch.kind),
            label: this._modeLabel(stretch.kind),
        }]);
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

    // History & statistics -----------------------------------------------------

    /** Today's temperature range and chart, how reliably the link reads, and the limits in force. */
    protected _renderHistory(overview: InverterDetailPayload) {
        const stats = this._temperature.payload?.temperature ?? null;
        const range = stats && stats.min !== null && stats.max !== null ? this._temperatureRange(stats.min, stats.max, stats.unit) : null;
        const summary = historySummary(this._temperature, this.localize, range ? boldTemplate(this._h("inverter_summary"), { range }) : null);
        return this._historySection(summary, () => html`
            ${subTitle(this._h("today"))}
            <div class="rows">${historyRow(this.localize("node_detail.shared.temperature"), range ?? "—", "temperature")}</div>
            ${this._renderTemperatureChart()}
            ${this._renderLinkRate(overview)}
            ${subTitle(this._h("limits"))}
            <div class="rows">${this._renderLimits(overview)}</div>
        `);
    }

    private _temperatureRange(min: number, max: number, unit: string | null): string {
        return `${Math.round(min)}–${Math.round(max)}${unit ? ` ${unit}` : ""}`;
    }

    private _renderTemperatureChart() {
        const notReady = sectionNotReady(this._temperature, this.localize);
        if (notReady) return notReady;
        const stats = this._temperature.payload?.temperature;
        if (!stats || stats.points.length === 0) return nothing;
        const format = (value: number) => value.toFixed(1) + (stats.unit ? " " + stats.unit : "");
        const series: DayLineSeries[] = [{
            key: "temperature",
            label: this.localize("node_detail.shared.temperature"),
            color: "var(--accent-color, #ff9800)",
            points: stats.points.map((point) => ({ t: Date.parse(point.start), v: point.mean, min: point.min, max: point.max })),
        }];
        return html`
            <helman-day-line-chart
                data-temperature-chart
                .series=${series}
                .start=${Date.parse(this._temperature.payload!.period.start)}
                .end=${Date.parse(this._temperature.payload!.period.end)}
                .bucketMs=${stats.bucketMinutes * 60_000}
                .now=${Date.now()}
                .nowLabel=${this.localize("node_detail.shared.now")}
                .timeZone=${this._timeZone}
                .locale=${this._locale}
                .formatValue=${format}
            ></helman-day-line-chart>
            ${renderShowMore([stats.entityId], this.localize)}
        `;
    }

    /** The share of readings that succeeded, and whether that makes the link healthy. */
    private _renderLinkRate(overview: InverterDetailPayload) {
        const rate = this._number(overview, "link_success_rate");
        if (rate === null) return nothing;
        const quarantined = this._number(overview, "link_quarantined_registers");
        const healthy = rate >= LINK_HEALTHY_PCT && !(quarantined !== null && quarantined > 0);
        return html`<div class="rows">${historyRow(this._h("link"), html`${Math.floor(rate * 10) / 10} % <span class="label">· ${this._h(healthy ? "link_healthy" : "link_unreliable")}</span>`, "link")}</div>`;
    }

    /** The export cap, the solar input limit and the battery's SoC range the inverter holds. */
    private _renderLimits(overview: InverterDetailPayload) {
        const exportLimit = this._watts(overview, "export_limit") ?? overview.maxAllowedExportPower;
        const pvLimit = this._watts(overview, "pv_power_limit");
        const rated = this._watts(overview, "rated_power");
        const limited = pvLimit !== null && (rated === null || pvLimit < rated);
        const soc = this._socRange(overview);
        return html`
            ${historyRow(this._h("export_limit"), exportLimit === null ? "—" : fillTemplate(this._h("up_to"), { power: formatPower(exportLimit).display }), "export-limit")}
            ${historyRow(this._h("solar_input"), limited ? fillTemplate(this._h("limited_to"), { power: formatPower(pvLimit!).display }) : this._h("not_limited"), "solar-input")}
            ${historyRow(this._h("battery_between"), soc ?? "—", "soc-range")}
        `;
    }

    // Technical details ---------------------------------------------------------

    /** The registers against the last command, what the executor did, the inverter's configuration and its link. */
    protected _renderTechnical(overview: InverterDetailPayload) {
        const now = Date.now();
        const runtime = runtimeFor<InverterRuntimeDTO>(this._plan.schedule, INVERTER_CONTROLLABLE_ID, now);
        const commanded = this._commandedKind(overview);
        const registers = overview.agreement.registers;
        const t = (key: string) => this.localize(`node_detail.shared.technical.${key}`);
        return html`
            ${registers.length ? html`
                ${subTitle(this._t("why.registers"))}
                <table data-registers>
                    <thead><tr><th>${this._t("why.register")}</th><th>${this._t("why.expected")}</th><th>${this._t("why.actual")}</th><th></th></tr></thead>
                    <tbody>${registers.map((register) => html`<tr>
                        <td>${this._name(register.entityId)}</td>
                        <td>${String(register.expected)}</td>
                        <td>${register.actual ?? this._t("unavailable")}</td>
                        <td>${this._t(register.matches === true ? "why.match_yes" : register.matches === false ? "why.match_no" : "why.match_unknown")}</td>
                    </tr>`)}</tbody>
                </table>
            ` : nothing}
            <div class="rows">
                ${renderCurrentSlot(currentRun(this._plan.runs, now), runtime, this.localize, (label, value) => this._row(label, value))}
                ${this._row(t("executor"), runtime ? runtimeText(runtime, this.localize) : t("no_runtime"), "executor")}
                ${this._row(this._t("why.last_command"), [commanded ? this._modeLabel(commanded) : this._commandedRaw(overview) ?? this._t("unavailable"),
                    overview.agreement.reason !== "no_profile" ? this._agreementText(overview) : null].filter(Boolean).join(" · "), "last-command")}
            </div>
            ${subTitle(t("configuration"))}
            <div class="rows">
                ${this._optionalRow(overview, "use_mode", "why.use_mode")}
                ${this._optionalRow(overview, "manual_mode", "why.manual_mode")}
                ${this._optionalRow(overview, "remote_control", "why.remote_control")}
                ${this._optionalRow(overview, "remote_control_mode", "why.remote_control_mode")}
                ${this._optionalRow(overview, "link_success_rate", "trust.link_rate")}
                ${this._optionalRow(overview, "link_quarantined_registers", "trust.quarantined")}
            </div>
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

    private _modeLabel(kind: ScheduleActionKind): string {
        return inverterModeLabel(this.localize, kind);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-inverter-content": NodeDetailInverterContent;
    }
}
