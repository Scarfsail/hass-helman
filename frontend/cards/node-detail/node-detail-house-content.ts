import { formatKwh, formatPower } from "../shared/format";
import { pad2, SLOT_MS } from "../shared/time/slot-time";
import { phaseSign } from "../shared/power-reading";
import { css, html, nothing, unsafeCSS } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import {
    type DevicePhase,
    type HouseDetailPayload,
    type HouseLoadDTO,
    type HousePatternSectionPayload,
    type HouseTodaySectionPayload,
    type HouseRankingSectionPayload,
    type ScheduleApplianceActionDTO,
} from "../helman-api";
import type { HelmanSolarInspectorCardConfig } from "../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { currencyFromPriceUnit } from "../helman-solar-inspector/money-model";
import { BATT_COLOR, GRID_COLOR, HOUSE_COLOR, NEUTRAL_LIGHT_COLOR, SOLAR_COLOR } from "../color-utils";
import { helmanColorVars } from "../color-vars";
import type { TreeItem } from "../shared/data/tree-item";

import type { FlowItem } from "../shared/node-flow";
import { houseGlyph, type HouseShare } from "../shared/node-glyphs";
import { scheduleActionToneStyles, type ScheduleActionTone } from "../shared/schedule/action-tones";
import { getScheduleApplianceActionPresentation } from "../shared/schedule/model/schedule-appliance-action-presentation";
import {
    INVERTER_CONTROLLABLE_ID,
    isScheduleApplianceActionEnabled,
    isScheduleClimateApplianceAction,
    isScheduleEvChargerAction,
} from "../shared/schedule/schedule-types";
import { todayKey } from "../shared/time/day-key";
import "../helman-device-reports/device-report-ranking";
import { IDLE_W, NodeDetailContentBase, type NodeFlow } from "./node-detail-base";
import { readingNumber } from "./node-detail-readings";
import { powerUnitFactor, readPowerW } from "../shared/power-reading";
import { dayKey, laneRuns, todayAndTomorrow, withinTodayTomorrow } from "./node-detail-schedule";
import { nodeDetailPictureStyles, nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { HouseDetailParams } from "./node-detail-types";
import { NODE_DETAIL_REQUEST_EVENT } from "./node-detail-types";
import "../helman-simple/simple-card-house";
import "./detail-headline";
import "./flow-gauge";

type QuestionId = "sources" | "consumers" | "next" | "pattern" | "phases";

/** The consumers the flow draws by name; the rest is "everything else". */
const TOP_CONSUMERS = 3;

/** The house's sources, in the order every split and row shows them. */
const SOURCES = [
    ["solar", SOLAR_COLOR],
    ["battery", BATT_COLOR],
    ["grid", GRID_COLOR],
] as const;

const PHASES = ["L1", "L2", "L3"] as const;

/**
 * The inspector under "What will use energy next?": the house forecast against
 * what the house measured, with the plan's strip; prices, money and the
 * aggregate views belong to other answers.
 */
export const HOUSE_FORECAST_INSPECTOR_CONFIG: HelmanSolarInspectorCardConfig = {
    type: "custom:helman-solar-inspector-card",
    transparent_background: true,
    hide_price_strip: true,
    hide_money_strip: true,
    hide_aggregate_views: true,
    show_bias_ratio: false,
    daylight_only_default: false,
    chart_series: ["houseForecast", "houseActual"],
};

/** One load of the house tree, counted once, as the phase estimate sees it. */
export interface PhaseLoad {
    item?: TreeItem;
    label: string;
    /** A metered parent's own share: its remainder. */
    own: boolean;
    /** Its own phase, or the single phase of the device it sits under. */
    phase: DevicePhase | null;
    /** The device whose phase it is on, when not its own. */
    inheritedFrom: string | null;
    /** W now; `null` without a reading. */
    watts: number | null;
}

export interface PhaseEstimate {
    loads: PhaseLoad[];
    /** Estimated W per phase from the mapped loads, a three-phase load in thirds. */
    perPhase: Record<(typeof PHASES)[number], number>;
    mappedW: number;
    /** Loads without a phase, and the house's own unmeasured remainder. */
    unassignedW: number;
    /** The house's own remainder, W: what no device meter explains. */
    houseRemainderW: number | null;
    /** Whether any load is on a phase at all. */
    anyMapped: boolean;
}

/**
 * Each phase's load, estimated from the devices the user mapped to phases.
 *
 * Every load is counted once, the way the card's tree accounts for it: a
 * device with children is its children plus its own remainder, never its
 * meter beside them. A load's own phase counts only where it is the user's
 * choice, as in `phaseAssignableDevices`: at the top level or behind a
 * three-phase device. Anywhere else it is on its parent's phase, a stale own
 * one notwithstanding. Behind a three-phase device a load without its own
 * phase could be on any, so it stays unassigned. A three-phase load splits in thirds, an
 * estimate rather than a measured balance. A load without a reading is
 * unknown, never 0 W, and is in no total.
 */
export function estimatePhaseLoads(house: TreeItem | null, read: (entityId: string | null) => number | null): PhaseEstimate {
    const loads: PhaseLoad[] = [];
    let houseRemainderW: number | null = null;

    // `phaseFrom` is the device whose own phase the parent's is, so a load
    // inheriting through a device without one names where the phase is set.
    const walk = (item: TreeItem, parentPhase: DevicePhase | null, phaseFrom: string | null, assignable: boolean): void => {
        const own = assignable ? item.phase ?? null : null;
        const inherited = own === null && parentPhase !== null && parentPhase !== "3ph";
        const phase = own ?? (inherited ? parentPhase : null);
        const inheritedFrom = inherited ? phaseFrom : null;
        const add = (watts: number | null, isOwn: boolean) =>
            loads.push({ item, label: item.name, own: isOwn, phase, inheritedFrom, watts });
        if (!item.children.length) {
            add(read(item.powerSensorId), false);
            return;
        }
        const remainder = item.children.find((child) => child.isUnmeasured);
        for (const child of item.children) if (!child.isUnmeasured) walk(child, phase, inherited ? phaseFrom : item.name, own === "3ph");
        // Without a power sensor the parent has no remainder: its own share is unknown.
        add(remainder ? read(remainder.powerSensorId) : null, true);
    };

    for (const child of house?.children ?? []) {
        if (child.isUnmeasured) houseRemainderW = read(child.powerSensorId);
        else walk(child, null, null, true);
    }

    const perPhase = { L1: 0, L2: 0, L3: 0 };
    let mappedW = 0;
    let unassignedW = houseRemainderW ?? 0;
    for (const load of loads) {
        if (load.watts === null) continue;
        if (load.phase === null) unassignedW += load.watts;
        else if (load.phase === "3ph") for (const phase of PHASES) perPhase[phase] += load.watts / 3;
        else perPhase[load.phase] += load.watts;
        if (load.phase !== null) mappedW += load.watts;
    }
    return { loads, perPhase, mappedW, unassignedW, houseRemainderW, anyMapped: loads.some((load) => load.phase !== null) };
}

/** An appliance's planned run: consecutive slots with the same running action. */
interface PlannedRun {
    id: string;
    name: string;
    startMs: number;
    endMs: number | null;
    /** Placed by an optimizer whose condition is not met: the executor will not run it. */
    candidate: boolean;
    setBy: string | null;
    action: ScheduleApplianceActionDTO;
}

/**
 * The house detail: what powered the house today, what used the energy, what
 * will use it next, whether today is unusual and how the load spreads over the
 * phases. The card's device tree is not repeated: the card stays the route to
 * individual devices.
 *
 * The Overview opens on the power headline (the house filled with its main
 * source's colour), then the gauge of where the power comes from and the
 * biggest users now, each with its kW and share, the rest folded into
 * everything else.
 *
 * Live readings come from `hass` and the live split from the card; Now's
 * consumers are the card's house tree, each load counted once. The backend
 * overview supplies the entity ids. Today's report figures are requested with
 * the overview: they are the Today flow (sources, top consumers, the paid
 * estimate) and the today tile. The weekday comparison and the overnight
 * minimum are requested only while their question is open, and the forecast
 * embed and today's full ranking only behind their answers. Nothing here is
 * a diagnosis: a low overnight load is an observation, an unusual day a
 * comparison, and a phase's gap to its assigned devices a hint, measured
 * against an estimate from the user's own wiring map.
 */
@customElement("node-detail-house-content")
export class NodeDetailHouseContent extends NodeDetailContentBase<HouseDetailPayload, QuestionId> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, nodeDetailPictureStyles, scheduleActionToneStyles, css`
        .phase-meters {
            display: flex;
            flex-direction: column;
            gap: 2px;
            margin-top: 2px;
        }
        .phase-meters .meter {
            margin-top: 0;
        }
        .swatch {
            display: inline-block;
            width: 10px;
            height: 10px;
            margin-right: 6px;
            vertical-align: baseline;
            border-radius: 2px;
        }
        .split {
            display: flex;
            height: 12px;
            border-radius: 6px;
            overflow: hidden;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
        }
        .split > span {
            height: 100%;
        }
        .mix {
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 0.85rem;
            color: var(--secondary-text-color);
        }
        .bars {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .bar-row {
            display: grid;
            grid-template-columns: minmax(64px, auto) 1fr;
            gap: 2px 8px;
            align-items: center;
            font-size: 0.9rem;
        }
        .bar-label {
            font-weight: 600;
        }
        .bar-track {
            position: relative;
            height: 10px;
            border-radius: 5px;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
            overflow: hidden;
        }
        .bar-fill {
            height: 100%;
            border-radius: 5px;
            background: ${unsafeCSS(HOUSE_COLOR)};
        }
        .bar-text {
            grid-column: 2;
            font-size: 0.82rem;
        }
        .heatmap {
            display: grid;
            grid-template-columns: 28px repeat(24, minmax(0, 1fr));
            gap: 1px;
            font-size: 0.7rem;
        }
        .heatmap .cell {
            height: 14px;
            border-radius: 2px;
        }
        .heatmap .day {
            color: var(--secondary-text-color);
            line-height: 14px;
        }
        .heatmap .hour {
            color: var(--secondary-text-color);
            text-align: center;
        }
        .tag {
            font-size: 0.75rem;
            color: var(--secondary-text-color);
        }
        .phase {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .phase-devices > summary {
            cursor: pointer;
            font-size: 0.82rem;
            color: var(--secondary-text-color);
        }
        .user-list { display: flex; flex-direction: column; gap: 4px; }
        .user-row {
            box-sizing: border-box;
            display: flex;
            align-items: center;
            gap: 12px;
            width: 100%;
            min-height: 44px;
            padding: 0 12px;
            border: 0;
            border-radius: 8px;
            color: var(--primary-text-color);
            font: inherit;
            font-size: 14px;
            text-align: start;
            background: linear-gradient(to right,
                color-mix(in srgb, var(--helman-house) 35%, var(--secondary-background-color)) var(--share),
                var(--secondary-background-color) var(--share));
        }
        button.user-row { cursor: pointer; }
        button.user-row:hover { filter: brightness(1.08); }
        button.user-row:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .user-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .user-row.muted .user-name { color: var(--secondary-text-color); }
        .user-amount { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .user-amount .percent { color: var(--secondary-text-color); }
        .user-chevron { flex: none; width: 16px; --mdc-icon-size: 16px; color: var(--secondary-text-color); }
        .show-less { align-self: flex-start; }
    `];

    protected readonly _node = "house" as const;

    @property({ attribute: false }) public params!: HouseDetailParams;
    @state() private _allUsers = false;

    /**
     * The appliances' planned runs from now through tomorrow: consecutive
     * slots in which the plan has the appliance running with the same
     * settings; any change of them starts a new run. A candidate, whose
     * condition is not met, is kept and marked: the executor does not run it.
     */
    private readonly _plan = this._useSchedule((schedule, now): PlannedRun[] => {
        const ids = new Set(schedule.slots.flatMap((slot) => Object.keys(slot.controllables)));
        ids.delete(INVERTER_CONTROLLABLE_ID);
        const names = this._applianceNames();
        const runs = [...ids].flatMap((id) => laneRuns(schedule, id, now, { byAuthor: true })
            .filter((run) => isScheduleApplianceActionEnabled(run.action as ScheduleApplianceActionDTO) === true)
            .map((run) => ({
            ...run,
            action: run.action as ScheduleApplianceActionDTO,
            id,
            name: names.get(id) ?? id,
            candidate: run.action.conditionMet === false,
            setBy: run.action.setBy ?? null,
        })));
        return withinTodayTomorrow(runs, now, this._timeZone).sort((a, b) => a.startMs - b.startMs);
    });
    /** Today's report figures, shown on the overview and drawn by Today. */
    private readonly _today = this._section<HouseTodaySectionPayload>("today", {
        fetch: () => this._readSection("today"),
        shown: () => this._offers("today"),
    });
    /** The pattern answer's history, while it is open. */
    private readonly _pattern = this._section<HousePatternSectionPayload>("pattern", {
        fetch: () => this._readSection("pattern"),
        shown: () => this._open === "pattern" && this._offers("pattern"),
    });
    /** Today's full ranking, while the consumers answer's evidence is open; `null` when the reports cannot build it. */
    private readonly _ranking = this._section<HouseRankingSectionPayload>("ranking", {
        fetch: () => this._readSection("ranking"),
        shown: () => this._open === "consumers" && this._evidenceOpen,
    });

    /** The overview's entities, and every load the phase estimate reads. */
    protected *_watchedEntities(payload: HouseDetailPayload): Iterable<string | null | undefined> {
        yield* Object.values(payload.entities);
        const walk = function* (items: TreeItem[]): Iterable<string | null> {
            for (const item of items) {
                yield item.powerSensorId;
                yield* walk(item.children);
            }
        };
        yield* walk(this.params.houseNode?.children ?? []);
    }

    /** The rest of today's forecast moves at each slot boundary; the next planned load at each run, which the base follows. */
    protected *_clockBoundaries(): Iterable<number> {
        yield Math.ceil(Date.now() / SLOT_MS) * SLOT_MS;
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    protected _setOpen(id: QuestionId | null): void {
        super._setOpen(id);
        // An opened forecast answer shows the forecast as it is now.
        if (id === "next") void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
        const phases = this._phaseEstimate();
        const power = this._powerNow();
        const flows = this.params.flows;
        const loads = phases.loads.filter((load) => load.watts !== null && load.watts > 0).sort((a, b) => b.watts! - a.watts!);
        const visible = this._allUsers ? loads : loads.slice(0, TOP_CONSUMERS);
        const hasUnmeasured = phases.houseRemainderW !== null || power !== null;
        const unmeasuredW = phases.houseRemainderW ?? (power === null ? 0 : Math.max(0, power - loads.reduce((sum, load) => sum + (load.watts ?? 0), 0)));
        const otherW = loads.slice(TOP_CONSUMERS).reduce((sum, load) => sum + (load.watts ?? 0), unmeasuredW);
        const otherCount = Math.max(0, loads.length - TOP_CONSUMERS) + (hasUnmeasured ? 1 : 0);
        return html`
            <div class="content" data-overview>
                ${this._renderException(overview)}
                <helman-detail-headline .value=${power === null ? "—" : formatPower(power).display}
                    .entityId=${overview.entities.power ?? null} .caption=${[this.localize("node_detail.shared.house_used")] }>
                    <simple-card-house slot="icon" .compact=${true} .power=${power ?? 0}
                        .sourceColor=${this._houseSourceColor()}></simple-card-house>
                </helman-detail-headline>
                <helman-flow-gauge direction="from" .localize=${this.localize}
                    .items=${flows && power !== null && power > IDLE_W ? [
                        { node: "solar", powerW: flows.solarToHouse },
                        { node: "battery", powerW: flows.batteryToHouse },
                        { node: "grid", powerW: flows.gridToHouse },
                    ] : []}></helman-flow-gauge>
                <div class="section-title">${this.localize("node_detail.shared.house_biggest")}</div>
                <div class="user-list">
                    ${visible.map((load) => this._userRow(load, power))}
                    ${this._allUsers && hasUnmeasured ? this._userRow({ label: this.localize("node_detail.shared.not_measured"), own: false, phase: null, inheritedFrom: null, watts: unmeasuredW }, power, false) : nothing}
                    ${otherCount > 0 && !this._allUsers ? this._userRow({ label: fillTemplate(this.localize("node_detail.shared.everything_else"), { count: otherCount }), own: false, phase: null, inheritedFrom: null, watts: otherW }, power, true, () => { this._allUsers = true; }, true) : nothing}
                </div>
                ${otherCount > 0 && this._allUsers ? html`<button type="button" class="link-button show-less" @click=${() => { this._allUsers = false; }}>${this.localize("node_detail.shared.show_less")}</button>` : nothing}
            </div>
        `;
    }

    private _houseSourceColor(): string | undefined {
        const flow = this.params.flows;
        if (!flow) return undefined;
        const parts = [["solar", flow.solarToHouse], ["battery", flow.batteryToHouse], ["grid", flow.gridToHouse]] as const;
        const source = parts.reduce((best, item) => item[1] > best[1] ? item : best, parts[0]);
        return `var(--helman-${source[0]})`;
    }

    private _userRow(load: PhaseLoad, house: number | null, clickable = true, onClick?: () => void, expanded = false) {
        const pct = house && load.watts ? Math.round(load.watts / house * 100) : 0;
        const item = clickable ? load.item ?? null : null;
        const inner = html`<span class="user-name">${load.label}</span><span class="user-amount">${formatPower(load.watts ?? 0).display} <span class="percent">${pct} %</span></span>${item || onClick
            ? html`<ha-icon class="user-chevron" icon=${expanded ? "mdi:chevron-down" : "mdi:chevron-right"}></ha-icon>` : html`<span class="user-chevron"></span>`}`;
        const style = `--share: ${Math.max(0, Math.min(100, pct))}%`;
        // Everything else and Not measured are no device: their names read muted.
        const rowClass = clickable && !onClick ? "user-row" : "user-row muted";
        return item || onClick ? html`<button type="button" class=${rowClass} style=${style}
            @click=${onClick ?? (() => this.dispatchEvent(new CustomEvent(NODE_DETAIL_REQUEST_EVENT, { detail: { target: item }, bubbles: true, composed: true })))}>${inner}</button>`
            : html`<div class=${rowClass} style=${style}>${inner}</div>`;
    }


    /** The open question's answer and evidence, full width under the tiles. */
    protected _renderOpen(overview: HouseDetailPayload, phases: PhaseEstimate) {
        switch (this._open) {
            case "sources":
                return this._question("sources", this._sourcesPreview(), () => this._renderSources(), () => this._renderSourcesEvidence(), "evidence");
            case "consumers":
                return this._question("consumers", this._consumersPreview(), () => this._renderConsumers(), () => this._renderConsumersEvidence(), "evidence");
            case "next":
                return this._question("next", this._nextPreview(), () => this._renderNext(), () => this._renderNextEvidence(), "evidence");
            case "pattern":
                return this._question("pattern", this._patternPreview(), () => this._renderPattern(), () => this._renderPatternEvidence(), "evidence");
            case "phases":
                return this._question("phases", this._phasesPreview(overview, phases), () => this._renderPhases(overview, phases), () => this._renderPhasesEvidence(overview), "evidence");
            default:
                return nothing;
        }
    }

    /** An off-grid or fault run mode the inverter reports. */
    private _renderException(overview: HouseDetailPayload) {
        return overview.condition ? this._exceptionBanner(fillTemplate(this._t(`exception.${overview.condition.kind}`), { state: overview.condition.runMode })) : nothing;
    }

    // Flow --------------------------------------------------------------------

    /**
     * The sources in and the consumers out around the house, which is filled
     * with the sources' mix: live on Now, from the card's split and its house
     * tree; today's kWh on Today, from the `today` section the overview
     * already reads. The sources open what powered the house, the consumers
     * what used the most.
     */
    protected _renderHouseFlow(phases: PhaseEstimate) {
        const now = this._flowScope === "now";
        const { flow, shares } = now ? this._nowFlow(phases) : this._todayFlow();
        return this._renderFlow(flow, this.params.flowScaleW, "sources", html`<span slot="centre">${houseGlyph(shares)}</span>`, "consumers");
    }

    /**
     * The card's live split in, W, and out the three largest loads of the
     * house tree, each counted once as the phase estimate counts it, and what
     * they leave of the house reading. Unknown without the split or the house
     * reading, never 0; a load without a reading is in neither.
     */
    private _nowFlow(phases: PhaseEstimate): { flow: NodeFlow; shares: HouseShare[] | null } {
        const power = this._fmt("now");
        const inputs = this._edgeItems(this.params.flows, [["solar", "solarToHouse"], ["battery", "batteryToHouse"], ["grid", "gridToHouse"]], power);
        const loads = phases.loads
            .filter((load) => load.watts !== null && load.watts > 0)
            .sort((a, b) => b.watts! - a.watts!)
            .slice(0, TOP_CONSUMERS)
            .map((load) => ({ label: this._phaseLoadName(load), value: load.watts! }));
        const house = this._powerNow();
        const top = loads.reduce((sum, load) => sum + load.value, 0);
        const outputs = this._consumerItems(loads, house === null ? null : Math.max(0, house - top), power);
        return {
            flow: this._flowShell("now", inputs, outputs, {
                centre: () => power(house),
                active: this._isActive(house),
            }),
            shares: this._shares(inputs.map((item) => ({ id: item.id, value: item.value, color: item.color }))),
        };
    }

    /**
     * Today's kWh from the `today` section: the house's sources in, its top
     * consumers and everything else out. Energy of no known source is a
     * footnote and part of what went in, never a source; the paid cost is a
     * footnote, an estimate.
     */
    private _todayFlow(): { flow: NodeFlow; shares: HouseShare[] | null } {
        const today = this._today.payload;
        const house = today?.house ?? null;
        const energy = this._fmt("today");
        const inputs = SOURCES.map(([key]) => this._flowItem(key, house ? house.sources[key] : null, energy));
        const top = (today?.consumers?.top ?? []).slice(0, TOP_CONSUMERS).map((load) => ({ label: this._loadName(load), value: load.kwh }));
        const named = top.reduce((sum, load) => sum + load.value, 0);
        const outputs = this._consumerItems(top, house ? Math.max(0, house.kwh - named) : null, energy);
        const notes: string[] = [];
        const status = this._todayFlowStatus();
        if (status) notes.push(status);
        if (house) {
            if (house.sources.unattributed > 0) notes.push(fillTemplate(this._t("flow.unattributed"), { kwh: energy(house.sources.unattributed) }));
            if (house.money.paid !== null) notes.push(fillTemplate(this._t("flow.paid"), { value: this._money(house.money.paid, today!.priceUnit) }));
        }
        return {
            flow: this._flowShell("today", inputs, outputs, {
                // Used: every source and the unattributed rest.
                centre: (sumIn) => energy(sumIn),
                notes,
                unresolvedIn: house?.sources.unattributed ?? 0,
            }),
            shares: this._shares([
                ...inputs.map((item) => ({ id: item.id, value: item.value, color: item.color })),
                { id: "unattributed", value: house?.sources.unattributed ?? null, color: "var(--helman-neutral-light)" },
            ]),
        };
    }

    /** The named consumers and everything else, each in the house's colour. */
    private _consumerItems(loads: Array<{ label: string; value: number }>, rest: number | null, format: (value: number | null) => string): FlowItem[] {
        const color = "var(--helman-house)";
        return [
            ...loads.map((load, index) => ({ id: `consumer-${index + 1}`, label: load.label, value: load.value, display: format(load.value), color })),
            { id: "rest", label: this._t("flow.rest"), value: rest, display: format(rest), color },
        ];
    }

    /** Each source's share of their sum, for the house's fill; `null` without a known, non-zero mix. */
    private _shares(parts: Array<{ id: string; value: number | null; color: string }>): HouseShare[] | null {
        if (parts.some((part) => part.value === null)) return null;
        const total = parts.reduce((sum, part) => sum + Math.max(0, part.value!), 0);
        if (total <= 0) return null;
        return parts.map((part) => ({ id: part.id, share: Math.max(0, part.value!) / total, color: part.color }));
    }

    /** Why Today has nothing to draw: loading, failed or unavailable; `null` once it has the house's figures. */
    private _todayFlowStatus(): string | null {
        const today = this._today.state;
        if (today === null || today.status === "loading") return this._t("today.loading");
        if (today.status === "error") return this._t("today.failed");
        if (!today.payload.house) {
            return this._t(["no_house_node", "no_house_meter"].includes(today.payload.unavailable ?? "")
                ? `today.unavailable_${today.payload.unavailable}` : "today.unavailable_not_loaded");
        }
        return null;
    }

    /** Today is the `today` section, read with the overview and kept current. */
    protected _todayResource() {
        return this._today;
    }

    // Tiles -------------------------------------------------------------------

    /** The next planned appliance run, or the one running now, in its action's tone. */
    protected _renderNextTile() {
        const run = this._plan.runs[0];
        if (!run) return this._tile("next", this._t("tile.no_runs"), null, nothing, "neutral");
        const running = run.startMs <= Date.now();
        const detail = [run.name, run.candidate ? this._t("next.candidate") : null].filter(Boolean).join(" · ");
        return running
            ? this._tile("next", fillTemplate(this._t("tile.until"), { time: run.endMs === null ? "…" : this._time(run.endMs) }), detail, nothing, this._runTone(run))
            : this._tile("next", this._time(run.startMs), detail, nothing, this._runTone(run));
    }

    /** A run's tone as the scheduler paints its appliance's action; a candidate, which does not run, is neutral. */
    private _runTone(run: PlannedRun): ScheduleActionTone {
        if (run.candidate) return "neutral";
        const action = run.action;
        const kind = isScheduleEvChargerAction(action) ? "ev_charger" : isScheduleClimateApplianceAction(action) ? "climate" : "generic";
        return getScheduleApplianceActionPresentation({ appliance: { kind, icon: "" }, action, localize: this.localize }).tone;
    }

    /** Today's energy so far, with today against the usual once the comparison is read. */
    protected _renderPatternTile() {
        const house = this._today.payload?.house;
        return this._tile("pattern", house ? (formatKwh(Math.abs(house.kwh)) + " kWh") : "–", this._patternPreview() ?? this._t("tile.today_so_far"));
    }

    /**
     * The most loaded phase, measured, or estimated from the wiring map while
     * the measured sensors are unavailable, and the three phases as bars in
     * the shared phase colours.
     */
    protected _renderPhasesTile(overview: HouseDetailPayload, estimate: PhaseEstimate) {
        const measured = this._measuredPhases(overview);
        if (!measured && !estimate.anyMapped) return this._tile("phases", "–", this._t("phases.none_mapped_short"));
        const bars = measured ?? estimate.perPhase;
        const scale = Math.max(IDLE_W, ...PHASES.map((phase) => bars[phase]));
        const highest = PHASES.reduce((a, b) => (bars[b] > bars[a] ? b : a));
        const graphic = html`
            <span class="phase-meters" data-phase-meters>
                ${PHASES.map((phase, index) => html`
                    <span class="meter" data-phase-bar=${phase} style="--meter-accent: var(--helman-phase-l${index + 1})">
                        <span class="meter-fill" style="width: ${Math.max(0, Math.min(100, bars[phase] / scale * 100)).toFixed(1)}%"></span>
                    </span>
                `)}
            </span>
        `;
        return this._tile("phases", `${highest} ${formatPower(bars[highest]).display}`,
            this._t(measured ? "tile.phase_highest" : "tile.phase_highest_estimated"), graphic);
    }

    /** Why today's report figures are not shown, or `null` once they are. */
    private _todayNotReady() {
        const today = this._today.state;
        if (today === null || today.status === "loading") return html`<p class="note" data-today-loading>${this._t("today.loading")}</p>`;
        if (today.status === "error") {
            return html`
                <p class="note">${this._t("today.failed")}</p>
                <button class="link-button" @click=${() => this._today.load()}>${this._t("retry")}</button>
            `;
        }
        if (!today.payload.house) {
            const reason = ["no_house_node", "no_house_meter"].includes(today.payload.unavailable ?? "")
                ? `today.unavailable_${today.payload.unavailable}`
                : "today.unavailable_not_loaded";
            return html`<p class="note" data-today-unavailable>${this._t(reason)}</p>`;
        }
        return null;
    }

    // Sources -----------------------------------------------------------------

    private _sourcesPreview(): string | null {
        const house = this._today.payload?.house;
        if (!house || house.kwh <= 0) return null;
        return SOURCES.map(([key]) => fillTemplate(this._t(`mix.${key}`), { share: this._share(house.sources[key] / house.kwh) })).join(" · ");
    }

    private _renderSources() {
        const notReady = this._todayNotReady();
        if (notReady) return notReady;
        const today = this._today.payload!;
        const house = today.house!;
        const period = this._row(this._t("period_label"), this._periodText(today), "period");
        if (house.kwh <= 0) return html`${period}<p class="note" data-no-usage>${this._t("sources.none")}</p>`;
        const parts: Array<[string, number, string]> = [
            ...SOURCES.map(([key, color]) => [key, house.sources[key], color] as [string, number, string]),
            ["unattributed", house.sources.unattributed, NEUTRAL_LIGHT_COLOR],
        ];
        const independence = today.independence;
        const self = today.selfConsumption;
        return html`
            ${period}
            ${this._row(this._t("sources.used"), (formatKwh(Math.abs(house.kwh)) + " kWh"), "used")}
            <div class="split" aria-hidden="true">
                ${parts.filter(([, kwh]) => kwh > 0).map(([key, kwh, color]) => html`<span data-split=${key} style="width: ${Math.min(100, kwh / house.kwh * 100)}%; background: ${color}"></span>`)}
            </div>
            ${parts.map(([key, kwh, color]) => key === "unattributed" && kwh <= 0 ? nothing : html`
                <div class="row" data-row=${key}>
                    <span class="label"><span class="swatch" style="background: ${color}"></span>${this._t(`sources.${key}`)}</span>
                    <span class="value">${fillTemplate(this._t("share_value"), { kwh: (formatKwh(Math.abs(kwh)) + " kWh"), share: this._share(kwh / house.kwh) })}</span>
                </div>
            `)}
            ${this._row(this._t("sources.independence"), independence
                ? fillTemplate(this._t(independence.unknownShare > 0 ? "sources.independence_unknown" : "sources.independence_value"), {
                    share: this._share(independence.share),
                    unknown: this._share(independence.unknownShare),
                })
                : this._t("unknown"), "independence", this._t("sources.independence_scope"))}
            ${this._row(this._t("sources.self_consumption"), self?.share != null
                ? this._share(self.share)
                : this._t(`sources.self_${self?.reason ?? "no_solar_meter"}`), "self-consumption", this._t("sources.self_scope"))}
            <p class="note">${this._t("sources.explain")}</p>
        `;
    }

    private _renderSourcesEvidence() {
        const today = this._today.payload;
        const house = today?.house;
        if (!today || !house) return html`<p class="note">${this._t("sources.no_evidence")}</p>`;
        const money = house.money;
        const destinations = today.selfConsumption?.destinations ?? null;
        return html`
            <div class="section-title">${this._t("sources.valuation")}</div>
            ${this._row(this._t("sources.paid"), money.paid === null ? this._t("unknown") : this._money(money.paid, today.priceUnit), "paid", this._t("sources.paid_scope"))}
            ${this._row(this._t("sources.priced"), fillTemplate(this._t("sources.priced_value"), {
                kwh: (formatKwh(Math.abs(money.paidPricedKwh)) + " kWh"),
                share: house.kwh > 0 ? this._share(money.paidPricedKwh / house.kwh) : "–",
            }), "priced")}
            ${this._row(this._t("sources.forgone"), money.forgone === null ? this._t("unknown") : this._money(money.forgone, today.priceUnit), "forgone", this._t("sources.forgone_scope"))}
            <div class="section-title">${this._t("sources.unresolved_title")}</div>
            ${this._row(this._t("sources.unattributed"), (formatKwh(Math.abs(house.sources.unattributed)) + " kWh"), "unresolved")}
            ${house.ambiguousKwh > 0 ? this._row(this._t("sources.ambiguous"), (formatKwh(Math.abs(house.ambiguousKwh)) + " kWh"), "ambiguous", this._t("sources.ambiguous_scope")) : nothing}
            ${house.mismatchKwh > 0 ? this._row(this._t("sources.mismatch"), (formatKwh(Math.abs(house.mismatchKwh)) + " kWh"), "mismatch") : nothing}
            ${destinations ? html`
                ${this._row(this._t("sources.matched_solar"), (formatKwh(Math.abs(destinations.attributedKwh)) + " kWh"), "matched-solar")}
                ${this._row(this._t("sources.solar_used"), (formatKwh(Math.abs(destinations.houseKwh + destinations.batteryKwh)) + " kWh"), "solar-used")}
                ${destinations.unattributedKwh > 0 ? this._row(this._t("sources.solar_unmatched"), (formatKwh(Math.abs(destinations.unattributedKwh)) + " kWh"), "solar-unmatched") : nothing}
            ` : nothing}
            ${!today.complete ? html`<p class="note" data-incomplete>${this._t("incomplete")}</p>` : nothing}
            <p class="note">${this._t("sources.evidence_note")}</p>
        `;
    }

    // Consumers ---------------------------------------------------------------

    private _consumersPreview(): string | null {
        const consumers = this._today.payload?.consumers;
        const top = consumers?.top[0];
        if (!top) return null;
        return fillTemplate(this._t("consumers.top_short"), { name: this._loadName(top), kwh: (formatKwh(Math.abs(top.kwh)) + " kWh") });
    }

    private _renderConsumers() {
        const notReady = this._todayNotReady();
        if (notReady) return notReady;
        const today = this._today.payload!;
        const consumers = today.consumers;
        const period = this._row(this._t("period_label"), this._periodText(today), "period");
        if (!consumers || !consumers.top.length) return html`${period}<p class="note" data-no-consumers>${this._t("consumers.none")}</p>`;
        return html`
            ${period}
            ${consumers.top.map((load, index) => this._row(
                this._loadName(load),
                this._loadValue(load, today.priceUnit),
                `top-${index + 1}`,
            ))}
            ${consumers.others.count > 0 ? this._row(
                fillTemplate(this._t("consumers.others"), { count: String(consumers.others.count) }),
                (formatKwh(Math.abs(consumers.others.kwh)) + " kWh"),
                "others",
            ) : nothing}
            ${consumers.unmeasuredKwh !== null ? this._row(this._t("consumers.unmeasured"), (formatKwh(Math.abs(consumers.unmeasuredKwh)) + " kWh"), "unmeasured", this._t("consumers.unmeasured_scope")) : nothing}
            <p class="note">${this._t("consumers.explain")}</p>
        `;
    }

    private _loadName(load: HouseLoadDTO): string {
        const name = load.label || load.id;
        const named = load.ownOf ? fillTemplate(this._t("consumers.own"), { name }) : name;
        return load.estimated ? "≈ " + named : named;
    }

    /** kWh first; the attributed paid cost beside it, an estimate. */
    private _loadValue(load: HouseLoadDTO, currency: string | null): string {
        const kwh = (formatKwh(Math.abs(load.kwh)) + " kWh");
        return load.money.paid === null
            ? kwh
            : fillTemplate(this._t("consumers.value_paid"), { kwh, paid: this._money(load.money.paid, currency) });
    }

    private _renderConsumersEvidence() {
        const today = this._today.payload;
        const consumers = today?.consumers;
        return html`
            ${consumers?.top.length ? html`
                <div class="section-title">${this._t("consumers.money_title")}</div>
                ${consumers.top.map((load, index) => this._row(
                    this._loadName(load),
                    fillTemplate(this._t("consumers.money_value"), {
                        priced: load.kwh > 0 ? this._share(load.money.paidPricedKwh / load.kwh) : "–",
                        forgone: load.money.forgone === null ? this._t("unknown") : this._money(load.money.forgone, today!.priceUnit),
                    }),
                    `money-${index + 1}`,
                ))}
                <p class="note">${this._t("consumers.money_note")}</p>
                ${consumers.overallocatedKwh > 0 ? this._row(this._t("consumers.overallocated"), (formatKwh(Math.abs(consumers.overallocatedKwh)) + " kWh"), "overallocated", this._t("consumers.overallocated_scope")) : nothing}
            ` : nothing}
            <div class="section-title">${this._t("consumers.ranking_title")}</div>
            ${this._renderRanking()}
        `;
    }

    /** The device reports' own ranking of today: the full list, as the reports card shows it. */
    private _renderRanking() {
        const ranking = this._ranking.state;
        if (ranking === null || ranking.status === "loading") return html`<p class="note">${this._t("consumers.ranking_loading")}</p>`;
        if (ranking.status === "error") {
            return html`
                <p class="note">${this._t("consumers.ranking_failed")}</p>
                <button class="link-button" @click=${() => this._ranking.load()}>${this._t("retry")}</button>
            `;
        }
        if (!ranking.payload?.report) return html`<p class="note">${this._t("today.unavailable_not_loaded")}</p>`;
        const today = todayKey(this._timeZone);
        return html`
            <helman-device-report-ranking
                data-ranking
                .payload=${ranking.payload.report}
                .query=${{ start_date: today, end_date: today }}
                .localize=${this.localize}
            ></helman-device-report-ranking>
        `;
    }

    // Next --------------------------------------------------------------------

    private _nextPreview(): string | null {
        const rest = this._restOfDayKwh();
        const run = this._plan.runs[0];
        const parts: string[] = [];
        if (rest !== null) parts.push(fillTemplate(this._t("next.rest_short"), { kwh: (formatKwh(Math.abs(rest)) + " kWh") }));
        if (run) parts.push(fillTemplate(this._t("next.run_short"), { name: run.name, time: this._time(run.startMs) }));
        if (parts.length) return parts.join(" · ");
        return this._forecastFailed ? this.localize("node_detail.forecast_failed") : null;
    }

    private _renderNext() {
        const rest = this._restOfDayKwh();
        const runs = this._plan.runs;
        const executionOff = this._plan.schedule?.executionEnabled === false;
        return html`
            ${rest !== null
                ? this._row(this._t("next.rest"), (formatKwh(Math.abs(rest)) + " kWh"), "rest", this._t("next.rest_scope"))
                : this._forecastFailed ? this._renderForecastFailed() : html`<p class="note" data-no-forecast>${this._forecastMissing()}</p>`}
            <div class="section-title">${this._t("next.planned_title")}</div>
            ${runs.length ? runs.map((run, index) => html`
                <div class="row" data-row=${`run-${index + 1}`} data-candidate=${run.candidate ? "true" : "false"}>
                    <span class="label">${run.name}${run.candidate ? html`<br><span class="tag">${this._t("next.candidate")}</span>` : nothing}</span>
                    <span class="value">${this._runTime(run)}</span>
                </div>
            `) : html`<p class="note" data-no-runs>${this._t("next.no_runs")}</p>`}
            ${executionOff ? html`<p class="note" data-execution-off>${this._t("next.execution_off")}</p>` : nothing}
            <p class="note">${this._t("next.explain")}</p>
            <div class="plan" data-forecast-inspector>${this._inspector("next", HOUSE_FORECAST_INSPECTOR_CONFIG)}</div>
        `;
    }

    private _renderNextEvidence() {
        const forecast = this._forecast?.house_consumption;
        const slot = forecast?.currentSlot;
        const runs = this._plan.runs;
        return html`
            <div class="section-title">${this._t("next.forecast_title")}</div>
            ${forecast ? html`
                ${this._row(this._t("next.forecast_status"), this._t(`next.status_${forecast.status}`), "forecast-status")}
                ${this._row(this._t("next.history"), fillTemplate(this._t("next.history_value"), {
                    days: String(forecast.historyDaysAvailable),
                    window: String(forecast.trainingWindowDays),
                }), "history")}
                ${slot ? this._row(this._t("next.slot"), fillTemplate(this._t("next.slot_value"), {
                    kwh: (formatKwh(Math.abs(slot.nonDeferrable.value)) + " kWh"),
                    lower: (formatKwh(Math.abs(slot.nonDeferrable.lower)) + " kWh"),
                    upper: (formatKwh(Math.abs(slot.nonDeferrable.upper)) + " kWh"),
                }), "slot") : nothing}
            ` : html`<p class="note">${this._forecastMissing()}</p>`}
            <p class="note">${this._t("next.forecast_note")}</p>
            ${runs.length ? html`
                <div class="section-title">${this._t("next.plan_title")}</div>
                ${runs.map((run, index) => this._row(
                    run.name,
                    [
                        this._runTime(run),
                        run.setBy ? this.localize(`node_detail.inverter.next.set_by_${run.setBy}`) : null,
                        this.localize(`node_detail.inverter.next.${run.candidate ? "condition_not_met" : "condition_met"}`),
                    ].filter(Boolean).join(" · "),
                    `plan-${index + 1}`,
                ))}
            ` : nothing}
            <p class="note">${this._t("next.plan_note")}</p>
        `;
    }

    private _runTime(run: PlannedRun): string {
        const range = fillTemplate(this._t("period_range"), { start: this._time(run.startMs), end: run.endMs === null ? "…" : this._time(run.endMs) });
        const [, tomorrow] = todayAndTomorrow(Date.now(), this._timeZone);
        return dayKey(run.startMs, this._timeZone) === tomorrow ? fillTemplate(this._t("next.tomorrow"), { range }) : range;
    }

    /**
     * Today's house forecast from now to midnight: the adjusted base load
     * (scheduled appliance runs included), the slot in progress by its
     * remaining part. The deferrable band is never added. `null` without a
     * forecast with data.
     */
    private _restOfDayKwh(): number | null {
        const forecast = this._forecast?.house_consumption;
        if (!forecast || forecast.status !== "available") return null;
        const now = Date.now();
        const today = dayKey(now, this._timeZone);
        let kwh = 0;
        for (const slot of [forecast.currentSlot, ...forecast.series]) {
            if (!slot) continue;
            const start = Date.parse(slot.timestamp);
            const end = start + SLOT_MS;
            if (!Number.isFinite(start) || end <= now || dayKey(start, this._timeZone) !== today) continue;
            kwh += Math.max(0, slot.nonDeferrable.value) * Math.min(1, (end - Math.max(start, now)) / SLOT_MS);
        }
        return kwh;
    }

    /** Controllable id → the device's name, from the card's house tree. */
    private _applianceNames(): Map<string, string> {
        const names = new Map<string, string>();
        const walk = (items: TreeItem[]) => {
            for (const item of items) {
                for (const id of item.controllableIds ?? []) names.set(id, item.name);
                walk(item.children);
            }
        };
        walk(this.params.houseNode?.children ?? []);
        return names;
    }

    private _forecastMissing(): string {
        if (this._forecast === null) return this._t("forecast_loading");
        return this._t(this._forecast.house_consumption.status === "not_configured" ? "forecast_not_configured" : "forecast_unavailable");
    }

    // Pattern -----------------------------------------------------------------

    private _patternPreview(): string | null {
        const comparison = this._pattern.payload?.comparison;
        if (!comparison || comparison.ratio === null) return null;
        return fillTemplate(this._t("pattern.short"), {
            change: this._signedShare(comparison.ratio - 1),
            weekday: this._weekday(Date.parse(comparison.until)),
            time: this._time(Date.parse(comparison.until)),
        });
    }

    private _renderPattern() {
        const overview = this._overview.status === "ready" ? this._overview.payload : null;
        if (!overview?.sections.includes("pattern")) return html`<p class="note" data-pattern-unavailable>${this._t("pattern.no_meters")}</p>`;
        const section = this._pattern.state;
        if (section === null || section.status === "loading") return html`<p class="note" data-pattern-loading>${this._t("loading_history")}</p>`;
        if (section.status === "error") {
            return html`
                <p class="note">${this._t("history_failed")}</p>
                <button class="link-button" @click=${() => this._pattern.load()}>${this._t("retry")}</button>
            `;
        }
        const payload = section.payload;
        return html`
            <div class="section-title">${this._t("pattern.comparison_title")}</div>
            ${this._renderComparison(payload.comparison)}
            <div class="section-title">${this._t("pattern.overnight_title")}</div>
            ${this._renderOvernight(payload.overnight)}
        `;
    }

    private _renderComparison(comparison: HousePatternSectionPayload["comparison"]) {
        if (comparison.unavailable) return html`<p class="note" data-comparison-unavailable>${this._t(`pattern.${comparison.unavailable}`)}</p>`;
        const until = Date.parse(comparison.until);
        const values = { weekday: this._weekday(until), time: this._time(until) };
        if (comparison.todayKwh === null) return html`<p class="note" data-no-today>${this._t("pattern.no_today")}</p>`;
        const partial = comparison.comparedHours < comparison.elapsedHours;
        const scale = Math.max(comparison.todayKwh, comparison.averageKwh ?? 0, 0.001);
        return html`
            <div class="bars" data-comparison>
                ${this._bar(fillTemplate(this._t("pattern.today"), values), comparison.todayKwh, scale, "today")}
                ${comparison.averageKwh !== null ? this._bar(fillTemplate(this._t("pattern.usual"), values), comparison.averageKwh, scale, "usual") : nothing}
            </div>
            ${partial ? html`<p class="note" data-partial-today>${fillTemplate(this._t("pattern.partial_today"), {
                compared: String(comparison.comparedHours),
                elapsed: String(comparison.elapsedHours),
            })}</p>` : nothing}
            ${comparison.averageKwh === null
                ? html`<p class="note" data-no-comparison>${fillTemplate(this._t("pattern.no_earlier"), values)}</p>`
                : html`
                    ${this._row(this._t("pattern.difference"), comparison.ratio === null ? this._t("unknown") : this._signedShare(comparison.ratio - 1), "difference")}
                    ${this._row(this._t("pattern.samples"), fillTemplate(this._t("pattern.samples_value"), {
                        used: String(comparison.used),
                        total: String(comparison.days.length),
                        weekday: values.weekday,
                    }), "samples")}
                `}
            <p class="note">${fillTemplate(this._t("pattern.comparison_explain"), values)}</p>
        `;
    }

    private _bar(label: string, kwh: number, scale: number, key: string) {
        return html`
            <div class="bar-row" data-bar=${key}>
                <span class="bar-label">${label}</span>
                <div class="bar-track"><div class="bar-fill" style="width: ${Math.min(100, Math.max(0, kwh) / scale * 100)}%"></div></div>
                <span class="bar-text">${(formatKwh(Math.abs(kwh)) + " kWh")}</span>
            </div>
        `;
    }

    private _renderOvernight(overnight: HousePatternSectionPayload["overnight"]) {
        const window = fillTemplate(this._t("period_range"), {
            start: this._time(Date.parse(overnight.start)),
            end: overnight.complete ? this._time(Date.parse(overnight.end)) : this._t("pattern.now"),
        });
        if (overnight.unavailable) return html`<p class="note" data-overnight-unavailable>${this._t(`pattern.overnight_${overnight.unavailable}`)}</p>`;
        const minimum = overnight.minimum;
        return html`
            ${this._row(this._t("pattern.overnight"), minimum
                ? fillTemplate(this._t("pattern.overnight_value"), { power: formatPower(Math.max(0, minimum.watts)).display, time: this._time(Date.parse(minimum.at)) })
                : this._t("pattern.overnight_none"), "overnight", fillTemplate(this._t(overnight.complete ? "pattern.overnight_scope" : "pattern.overnight_partial"), { window }))}
            <p class="note">${this._t("pattern.overnight_explain")}</p>
        `;
    }

    private _renderPatternEvidence() {
        const payload = this._pattern.payload;
        if (!payload) return html`<p class="note">${this._t("loading_history")}</p>`;
        const comparison = payload.comparison;
        const until = Date.parse(comparison.until);
        return html`
            ${comparison.days.length ? html`
                <div class="section-title">${this._t("pattern.days_title")}</div>
                ${comparison.days.map((day) => this._row(
                    this._date(day.date),
                    day.kwh === null
                        ? fillTemplate(this._t("pattern.day_incomplete"), { known: String(day.knownHours), compared: String(comparison.comparedHours) })
                        : (formatKwh(Math.abs(day.kwh)) + " kWh"),
                    `day-${day.date}`,
                ))}
                <p class="note">${fillTemplate(this._t("pattern.days_note"), { time: this._time(until) })}</p>
            ` : nothing}
            ${this._row(this._t("pattern.overnight_coverage"), this._share(payload.overnight.coverage), "overnight-coverage")}
            <div class="section-title">${this._t("pattern.profile_title")}</div>
            ${this._renderProfile(payload.profile)}
        `;
    }

    /** The learned weekday/hour profile: an expectation, Monday first, with its extremes in text. */
    private _renderProfile(profile: HousePatternSectionPayload["profile"]) {
        if (!profile) return html`<p class="note" data-no-profile>${this._t("pattern.no_profile")}</p>`;
        const values = profile.kwh.flat();
        const max = Math.max(...values, 0.001);
        let peak = { day: 0, hour: 0, kwh: -Infinity };
        let low = { day: 0, hour: 0, kwh: Infinity };
        profile.kwh.forEach((row, day) => row.forEach((kwh, hour) => {
            if (kwh > peak.kwh) peak = { day, hour, kwh };
            if (kwh < low.kwh) low = { day, hour, kwh };
        }));
        const dayNames = this._weekdayNames();
        const cell = (day: number, hour: number) => fillTemplate(this._t("pattern.cell"), {
            day: dayNames[day],
            hour: pad2(hour),
            kwh: (formatKwh(Math.abs(profile.kwh[day][hour])) + " kWh"),
        });
        return html`
            <div class="heatmap" data-heatmap role="img" aria-label=${fillTemplate(this._t("pattern.heatmap_summary"), {
                peak: cell(peak.day, peak.hour),
                low: cell(low.day, low.hour),
            })}>
                <span></span>
                ${Array.from({ length: 24 }, (_, hour) => html`<span class="hour">${hour % 6 === 0 ? hour : ""}</span>`)}
                ${profile.kwh.map((row, day) => html`
                    <span class="day">${dayNames[day]}</span>
                    ${row.map((kwh, hour) => html`<span class="cell" title=${cell(day, hour)} style="background: color-mix(in srgb, ${HOUSE_COLOR} ${Math.round(10 + Math.max(0, kwh) / max * 90)}%, transparent)"></span>`)}
                `)}
            </div>
            ${this._row(this._t("pattern.profile_peak"), cell(peak.day, peak.hour), "profile-peak")}
            ${this._row(this._t("pattern.profile_low"), cell(low.day, low.hour), "profile-low")}
            ${this._row(this._t("pattern.profile_history"), fillTemplate(this._t("pattern.profile_history_value"), { days: String(profile.historyDays) }), "profile-history")}
            <p class="note" data-profile-label>${this._t("pattern.profile_note")}</p>
        `;
    }

    // Phases ------------------------------------------------------------------

    private _phaseEstimate(): PhaseEstimate {
        return estimatePhaseLoads(this.params.houseNode, (entityId) => {
            const watts = this._watts(entityId);
            return watts === null ? null : Math.max(0, watts);
        });
    }

    /** A power reading in W through its unit, `null` without one. */
    private _watts(entityId: string | null | undefined): number | null {
        const value = readingNumber(this.hass, entityId);
        const factor = powerUnitFactor(this.hass, entityId);
        return value === null || factor === null ? null : value * factor;
    }

    /** Helman's measured house load per phase, W; `null` unless every phase reads. */
    private _measuredPhases(overview: HouseDetailPayload): PhaseEstimate["perPhase"] | null {
        const [L1, L2, L3] = PHASES.map((_, i) => this._watts(overview.entities[`phase_power_l${i + 1}`]));
        return L1 === null || L2 === null || L3 === null ? null : { L1, L2, L3 };
    }

    private _phasesPreview(overview: HouseDetailPayload, estimate: PhaseEstimate): string {
        const measured = this._measuredPhases(overview);
        if (measured) return PHASES.map((phase) => `${phase} ${formatPower(measured[phase]).display}`).join(" · ");
        if (!estimate.anyMapped) return this._t("phases.none_mapped_short");
        return PHASES.map((phase) => `${phase} ${formatPower(estimate.perPhase[phase]).display}`).join(" · ") + " " + this._t("phases.estimated_tag");
    }

    /**
     * Measured load per phase against what the mapped devices explain, or,
     * while the measured sensors are unavailable, the wiring estimate alone.
     * Each phase lists its devices, and the "No phase" group the rest.
     */
    private _renderPhases(overview: HouseDetailPayload, estimate: PhaseEstimate) {
        const offGrid = overview.condition?.kind === "off_grid";
        const measured = this._measuredPhases(overview);
        if (!measured && !estimate.anyMapped) {
            return html`
                ${offGrid ? this._renderEps(overview) : nothing}
                <p class="note" data-none-mapped>${this._t("phases.none_mapped")}</p>
            `;
        }
        const power = this._powerNow();
        const unknown = estimate.loads.filter((load) => load.phase !== null && load.watts === null);
        const bars = measured ?? estimate.perPhase;
        const scale = Math.max(IDLE_W, ...PHASES.map((phase) => bars[phase]));
        return html`
            ${offGrid ? this._renderEps(overview) : nothing}
            <div class="section-title">${this._t(measured ? "phases.measured_title" : "phases.estimate_title")}</div>
            <div class="bars" data-phase-measured=${measured ? "" : nothing} data-phase-estimate=${measured ? nothing : ""}>
                ${PHASES.map((phase) => html`
                    <div class="phase" data-phase=${phase}>
                        <div class="bar-row">
                            <span class="bar-label">${phase}</span>
                            <div class="bar-track"><div class="bar-fill" style="width: ${Math.max(0, Math.min(100, bars[phase] / scale * 100))}%"></div></div>
                            <span class="bar-text">${measured
                                ? this._phaseComparison(measured[phase], estimate.perPhase[phase])
                                : "≈ " + formatPower(estimate.perPhase[phase]).display}</span>
                        </div>
                        ${this._renderPhaseDevices(phase, estimate)}
                    </div>
                `)}
                ${this._renderPhaseDevices(null, estimate)}
            </div>
            ${this._row(this._t("phases.unassigned"), formatPower(estimate.unassignedW).display, "unassigned", this._t("phases.unassigned_scope"))}
            ${this._row(this._t("phases.coverage"), power !== null && power > IDLE_W
                ? fillTemplate(this._t("phases.coverage_value"), { share: this._share(Math.min(1, estimate.mappedW / power)), power: formatPower(estimate.mappedW).display })
                : formatPower(estimate.mappedW).display, "coverage")}
            ${unknown.length ? html`<p class="note" data-unknown-loads>${fillTemplate(this._t("phases.unknown_loads"), {
                names: unknown.map((load) => this._phaseLoadName(load)).join(", "),
            })}</p>` : nothing}
            ${measured && !estimate.anyMapped ? html`<p class="note" data-none-mapped>${this._t("phases.none_mapped")}</p>` : nothing}
            <p class="note">${this._t(measured ? "phases.measured_explain" : "phases.explain")}</p>
        `;
    }

    /**
     * A phase's measured W, its assigned W and the difference. Within
     * `IDLE_W` of the assignment nothing is unexplained; further below it,
     * more is assigned than measured, most likely a device on another phase.
     */
    private _phaseComparison(measuredW: number, assignedW: number) {
        const difference = measuredW - assignedW;
        return html`
            <span data-measured>${formatPower(measuredW).display}</span>
            · <span data-assigned>${fillTemplate(this._t("phases.assigned_value"), { power: formatPower(assignedW).display })}</span>
            · <span data-difference>${difference < -IDLE_W
                ? fillTemplate(this._t("phases.over_assigned_value"), { power: formatPower(-difference).display })
                : fillTemplate(this._t("phases.unexplained_value"), { power: formatPower(Math.max(0, difference)).display })}</span>
        `;
    }

    /**
     * The loads on `phase`, a three-phase load at its third on each, or with
     * `null` the loads without a phase and the house's own remainder.
     */
    private _renderPhaseDevices(phase: (typeof PHASES)[number] | null, estimate: PhaseEstimate) {
        const rows = estimate.loads
            .filter((load) => phase === null ? load.phase === null : load.phase === phase || load.phase === "3ph")
            .map((load) => ({
                name: this._phaseLoadName(load),
                threePhase: load.phase === "3ph",
                via: load.inheritedFrom,
                watts: load.watts === null ? null : load.phase === "3ph" ? load.watts / 3 : load.watts,
            }));
        if (phase === null) {
            if (estimate.houseRemainderW !== null) rows.push({ name: this._t("phases.house_remainder"), threePhase: false, via: null, watts: estimate.houseRemainderW });
            if (!rows.length) return nothing;
        }
        return html`
            <details class="phase-devices" data-phase-devices=${phase ?? "none"}>
                <summary>${phase === null
                    ? fillTemplate(this._t("phases.devices_no_phase"), { count: String(rows.length) })
                    : fillTemplate(this._t("phases.devices_on"), { phase, count: String(rows.length) })}</summary>
                ${rows.length ? html`
                    <table>
                        <tbody>
                            ${rows.map((row) => html`
                                <tr>
                                    <td>${row.name}${row.threePhase ? html` <span class="tag" data-three-phase>${this._t("phases.three_phase_tag")}</span>` : nothing}${row.via
                                        ? html` <span class="tag" data-via>${fillTemplate(this._t("phases.via"), { name: row.via })}</span>`
                                        : nothing}</td>
                                    <td>${row.watts === null ? this._t("phases.no_reading") : formatPower(row.watts).display}</td>
                                </tr>
                            `)}
                        </tbody>
                    </table>
                ` : html`<p class="note">${this._t("phases.devices_empty")}</p>`}
            </details>
        `;
    }

    /**
     * Off-grid, the inverter's EPS output per phase: measured by the inverter,
     * shown apart from the wiring estimate and never mixed into it, with the
     * battery's time-to-empty at its recent discharge.
     */
    private _renderEps(overview: HouseDetailPayload) {
        const rows = [1, 2, 3].map((phase) => {
            const value = this._reading(overview, `eps_power_l${phase}`);
            return value === null ? nothing : this._row(`L${phase}`, value, `eps-l${phase}`, undefined, overview.entities[`eps_power_l${phase}`]);
        });
        const minutes = readingNumber(this.hass, overview.entities.time_to_empty);
        return html`
            <div class="section-title">${this._t("phases.eps_title")}</div>
            ${rows.every((row) => row === nothing) ? html`<p class="note">${this._t("phases.eps_unavailable")}</p>` : rows}
            ${this._row(this._t("phases.runtime"), minutes === null || minutes <= 0
                ? this._t("phases.runtime_none")
                : fillTemplate(this._t("phases.runtime_value"), { duration: this._duration(minutes) }), "runtime", this._t("phases.runtime_scope"))}
        `;
    }

    /** The measured phases' formula inputs per phase, the formula in words, and the estimate's assumptions. */
    private _renderPhasesEvidence(overview: HouseDetailPayload) {
        const hasInputs = [1, 2, 3].some((phase) => `ac_power_l${phase}` in overview.entities);
        // The meter shown import-positive, whichever way the profile reads it.
        const meterSign = phaseSign(overview.phasePowerPolarity);
        const cell = (watts: number | null, sign = 1) => watts === null ? "–" : Math.round(watts * sign) + " W";
        return html`
            ${hasInputs ? html`
                <table data-phase-inputs>
                    <thead><tr>
                        <th>${this._t("phases.input_phase")}</th><th>${this._t("phases.input_inverter")}</th>
                        <th>${this._t("phases.input_meter")}</th><th>${this._t("phases.input_eps")}</th>
                    </tr></thead>
                    <tbody>
                        ${[1, 2, 3].map((phase) => html`
                            <tr data-phase-input=${"L" + phase}>
                                <td>L${phase}</td>
                                <td>${cell(this._watts(overview.entities[`ac_power_l${phase}`]))}</td>
                                <td>${cell(this._watts(overview.entities[`grid_power_l${phase}`]), meterSign)}</td>
                                <td>${cell(this._watts(overview.entities[`eps_power_l${phase}`]))}</td>
                            </tr>
                        `)}
                    </tbody>
                </table>
                <p class="note" data-formula>${this._t("phases.formula")}</p>
            ` : html`<p class="note">${this._t("phases.inputs_none")}</p>`}
            <p class="note">${this._t("phases.assumptions")}</p>
        `;
    }

    private _phaseLoadName(load: PhaseLoad): string {
        return load.own ? fillTemplate(this._t("consumers.own"), { name: load.label }) : load.label;
    }

    // ── Readings and formatting ─────────────────────────────────────────────

    /** The card passes its live house reading in W, preserving its polarity. */
    private _powerNow(): number | null {
        const entityId = this._overview.status === "ready" ? this._overview.payload.entities.power : null;
        return readPowerW(this.hass, entityId) === null ? null : this.params.power;
    }

    private _periodText(payload: { period: { start: string }; asOf: string }): string {
        return fillTemplate(this._t("period"), { start: this._time(Date.parse(payload.period.start)), end: this._time(Date.parse(payload.asOf)) });
    }

    private _money(value: number, currency: string | null): string {
        return "≈ " + this._formatMoney(value, currencyFromPriceUnit(currency));
    }

    private _signedShare(share: number): string {
        const rounded = Math.round(share * 100);
        return (rounded > 0 ? "+" : rounded < 0 ? "−" : "±") + Math.abs(rounded) + " %";
    }

    private _weekday(ms: number): string {
        return new Intl.DateTimeFormat(this._locale, { weekday: "long", timeZone: this._timeZone }).format(ms);
    }

    /** Short weekday names, Monday first. 2024-01-01 was a Monday. */
    private _weekdayNames(): string[] {
        const format = new Intl.DateTimeFormat(this._locale, { weekday: "short", timeZone: "UTC" });
        return Array.from({ length: 7 }, (_, day) => format.format(Date.UTC(2024, 0, 1 + day, 12)));
    }

    /** A `YYYY-MM-DD` key as a date, formatted in UTC where noon of the key is that date. */
    private _date(key: string): string {
        return new Intl.DateTimeFormat(this._locale, { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(Date.parse(`${key}T12:00:00Z`));
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-house-content": NodeDetailHouseContent;
    }
}
