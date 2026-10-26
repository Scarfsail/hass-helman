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
import type { HelmanSolarInspectorCardConfig } from "../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { helmanColorVars } from "../color-vars";
import { commandedModeKind } from "../helman-api";

import "../shared/mode-strip";
import { modeStripWindow, type ModeChange, type ModeSegment } from "../shared/mode-strip";
import { inverterGlyph } from "../shared/node-glyphs";
import { getScheduleActionTone, scheduleActionToneStyles, type ScheduleActionTone } from "../shared/schedule/action-tones";
import { getScheduleReasonLabel } from "../shared/schedule/model/schedule-labels";
import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import "../shared/day-line-chart";
import type { DayLineSeries } from "../shared/day-line-chart";
import { IDLE_W, NodeDetailContentBase, type NodeFlow } from "./node-detail-base";
import { staleToday } from "./section-resource";
import {
    currentRun,
    dayKey,
    effectiveAction,
    inverterRuns,
    nextChange,
    renderCurrentSlot,
    runtimeFor,
    runtimeText,
    todayAndTomorrow,
    type ScheduleRun,
} from "./node-detail-schedule";
import { powerUnitFactor } from "../shared/power-reading";
import { nodeDetailPictureStyles, nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { InverterDetailParams } from "./node-detail-types";
import { LaneOwnershipController } from "./lane-ownership";
import { DialogHistoryController } from "../shared/dialog-history-controller";
import type { ControlOverrideDialog } from "./control-override-dialog";
import "./detail-headline";
import "./help-tip";
import "./control-override-dialog";
import type { LiveFlows } from "./live-flows";

type QuestionId = "why" | "next" | "limits" | "operating" | "trust";

const PHASES = [1, 2, 3] as const;

/** A flow between two nodes, live and today. */
type FlowEdge = Exclude<keyof LiveFlows, "gridPower">;

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
    /**
     * Today's temperature, while the operating answer is open; read on
     * opening and re-read on a data change only. A refresh follows a data
     * change: what was shown may be out of date, so a failure replaces it.
     */
    private readonly _temperature = this._section<InverterTemperatureSectionPayload>("temperature", {
        fetch: () => this._readSection("temperature"),
        shown: () => this._open === "operating" && this._offers("temperature"),
        staleness: () => false,
        keepOnError: false,
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

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
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

    /** The open question's answer and evidence, full width under the tiles. */
    protected _renderOpen(overview: InverterDetailPayload) {
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

    // Strip -------------------------------------------------------------------

    /**
     * Today's observed modes, solid, and the plan's from now to noon
     * tomorrow, hatched, with the next change flagged in its tone. The strip
     * opens *next*.
     */
    protected _renderStrip(overview: InverterDetailPayload) {
        const now = Date.now();
        const { start, end } = modeStripWindow(now, this._timeZone);
        const change = nextChange(this._plan.runs, Date.now(), this._timeZone);
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
            ${this._modes.state?.status === "error" ? html`
                <p class="note" data-strip-failed>${this._t("strip.history_failed")}
                    <button class="link-button" @click=${() => this._modes.load()}>${this._t("retry")}</button>
                </p>
            ` : nothing}
            ${!overview.sections.includes("modes") ? html`<p class="note" data-strip-no-history>${this._t("strip.no_history")}</p>`
                : this._modes.payload?.modes === null ? html`<p class="note" data-strip-no-registers>${this._t("strip.no_registers")}</p>`
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
        const modes = this._modes.payload?.modes ?? null;
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
        const executing = this._plan.schedule?.executionEnabled === true;
        for (const run of this._plan.runs) {
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
    protected _renderInverterFlow(overview: InverterDetailPayload) {
        const flow = this._flowScope === "now" ? this._nowFlow(overview) : this._todayFlow();
        return this._renderFlow(flow, this.params.flowScaleW, "operating", html`<span slot="centre">${inverterGlyph()}</span>`);
    }

    /** The card's live split, W; unknown without the solar, battery or house reading, never 0. */
    private _nowFlow(overview: InverterDetailPayload): NodeFlow {
        const power = this._fmt("now");
        const { inputs, outputs } = this._sides(this.params.flows, power);
        const ac = this._acPower(overview);
        return this._flowShell("now", inputs, outputs, {
            centre: () => ac === null ? null : fillTemplate(this._t("operating.ac_short"), { value: power(ac) }),
            active: this._isActive(ac),
        });
    }

    /**
     * Today's kWh from the `flows` section, the same edges as Now. Energy
     * whose source or destination is not known is said in the footnotes and
     * added to its side's total, never forced into a ribbon.
     */
    private _todayFlow(): NodeFlow {
        const flows = this._flows.payload?.flows ?? null;
        const energy = this._fmt("today");
        const { inputs, outputs } = this._sides(flows, energy);
        const status = this._todayFlowsNote();
        const notes: string[] = status ? [status] : [];
        const unresolvedSolar = flows?.solarUnresolved ?? 0;
        const unknownCharge = flows?.unknownToBattery ?? 0;
        const unknownHouse = flows?.unknownToHouse ?? 0;
        if (unresolvedSolar > 0) notes.push(fillTemplate(this.localize("node_detail.solar.flow.unresolved"), { kwh: energy(unresolvedSolar) }));
        if (unknownCharge > 0) notes.push(fillTemplate(this.localize("node_detail.battery.flow.unknown_charge"), { kwh: energy(unknownCharge) }));
        if (unknownHouse > 0) notes.push(fillTemplate(this._t("flow.unknown_house"), { kwh: energy(unknownHouse) }));
        return this._flowShell("today", inputs, outputs, {
            centre: (_sumIn, sumOut) => energy(sumOut),
            notes,
            unresolvedIn: unresolvedSolar,
            unresolvedOut: unknownCharge + unknownHouse,
        });
    }

    /** Solar, battery and grid in; house, battery and export out: each the sum of its edges. */
    private _sides(flows: Partial<Record<FlowEdge, number | null>> | null, format: (value: number | null) => string) {
        const sum = (...keys: FlowEdge[]) => this._sumEdges(flows, keys);
        return {
            inputs: [
                this._flowItem("solar", sum("solarToHouse", "solarToBattery", "solarToGrid"), format),
                this._flowItem("battery", sum("batteryToHouse", "batteryToGrid"), format),
                this._flowItem("grid", sum("gridToHouse", "gridToBattery"), format),
            ],
            outputs: [
                this._flowItem("house", sum("solarToHouse", "batteryToHouse", "gridToHouse"), format),
                this._flowItem("battery", sum("solarToBattery", "gridToBattery"), format),
                this._exportItem(sum("solarToGrid", "batteryToGrid"), format),
            ],
        };
    }

    /** What goes out to the grid: an export, in the grid's colour. */
    private _exportItem(value: number | null, format: (value: number | null) => string) {
        return { ...this._flowItem("grid", value, format), label: this._t("flow.export") };
    }

    // Tiles -------------------------------------------------------------------

    /** The export cap the inverter holds, and the battery's SoC range as a bar. */
    protected _renderLimitsTile(overview: InverterDetailPayload) {
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
    protected _renderOperatingTile(overview: InverterDetailPayload) {
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
    protected _renderTrustTile(overview: InverterDetailPayload) {
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
        const run = currentRun(this._plan.runs, Date.now());
        const parts = [run ? this._actionLabel(run.action) : this._t("why.nothing_scheduled")];
        if (this._plan.schedule) parts.push(this._t(this._plan.schedule.executionEnabled ? "why.execution_on_short" : "why.execution_off_short"));
        return parts.join(" · ");
    }

    private _renderWhy(overview: InverterDetailPayload) {
        const run = currentRun(this._plan.runs, Date.now());
        const runtime = runtimeFor<InverterRuntimeDTO>(this._plan.schedule, INVERTER_CONTROLLABLE_ID, Date.now());
        const commanded = this._commandedKind(overview);
        return html`
            ${this._row(this._t("why.scheduled_now"), run
                ? this._scheduledText(run)
                : this._t("why.nothing_scheduled"), "scheduled")}
            ${this._plan.schedule ? this._row(this._t("why.execution"), this._t(this._plan.schedule.executionEnabled ? "why.execution_on" : "why.execution_off"), "execution") : nothing}
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
        const next = nextChange(this._plan.runs, Date.now(), this._timeZone);
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
        return renderCurrentSlot(currentRun(this._plan.runs, Date.now()), runtimeFor<InverterRuntimeDTO>(this._plan.schedule, INVERTER_CONTROLLABLE_ID, Date.now()), this.localize, (label, value) => this._row(label, value));
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
        const section = this._temperature.state;
        const title = html`<div class="section-title">${this._t("operating.temperature_today")}</div>`;
        if (section === null || section.status === "loading") {
            return html`${title}<p class="note" data-temperature-loading>${this._t("operating.loading_history")}</p>`;
        }
        if (section.status === "error") {
            return html`
                ${title}
                <p class="note">${this._t("operating.history_failed")}</p>
                <button class="link-button" @click=${() => this._temperature.load()}>${this._t("retry")}</button>
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

    /** Today's and tomorrow's runs, empty stretches left out. */
    private _upcomingRuns(): ScheduleRun[] {
        const [today, tomorrow] = todayAndTomorrow(Date.now(), this._timeZone);
        return this._plan.runs.filter((run) => {
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
