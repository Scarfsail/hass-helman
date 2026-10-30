import { formatKwh, formatPower } from "../shared/format";
import { SLOT_MS } from "../shared/time/slot-time";
import { css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import {
    type DevicePhase,
    type HouseDetailPayload,
    type HouseLoadDTO,
    type HousePatternSectionPayload,
    type HouseTodaySectionPayload,
    type ScheduleApplianceActionDTO,
} from "../helman-api";
import { helmanColorVars } from "../color-vars";
import type { TreeItem } from "../shared/data/tree-item";

import { INVERTER_CONTROLLABLE_ID, isScheduleApplianceActionEnabled } from "../shared/schedule/schedule-types";
import { getScheduleLocalTimeParts } from "../shared/schedule/model/schedule-time";
import { IDLE_W, NodeDetailContentBase } from "./node-detail-base";
import { readingNumber } from "./node-detail-readings";
import { powerUnitFactor, readPowerW } from "../shared/power-reading";
import { dayKey, laneRuns, withinTodayTomorrow } from "./node-detail-schedule";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { HouseDetailParams } from "./node-detail-types";
import { NODE_DETAIL_REQUEST_EVENT } from "./node-detail-types";
import "../helman-simple/simple-card-house";
import "./detail-headline";
import "./flow-gauge";
import { boldTemplate } from "./detail-section";
import { forecastWhen, projectedKwh, projectedSlots, remainingShare, renderForecastChart } from "./node-detail-forecast";
import { historyRow, historySummary, kwhText, sectionNotReady, subTitle } from "./node-detail-history";
import { modeStripWindow } from "../shared/mode-strip";
import type { ApplianceProjectionsPayload } from "../helman-api";
import { getSharedHelmanStore } from "../shared/data/store";

/** The consumers the Overview and the History list by name; the rest is "everything else". */
const TOP_CONSUMERS = 3;

/** A planned appliance run on the Forecast chart. */
const RUN_COLOR = "color-mix(in srgb, var(--helman-house) 60%, var(--primary-text-color))";

/** Today against the usual within this share reads "about as usual". */
const AS_USUAL = 0.05;

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
 * phase could be on any, so it stays unassigned. A load without a reading
 * is unknown, never 0 W, and is in no total.
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

    let unassignedW = houseRemainderW ?? 0;
    for (const load of loads) {
        if (load.watts === null) continue;
        if (load.phase === null) unassignedW += load.watts;
    }
    return { loads, unassignedW, houseRemainderW, anyMapped: loads.some((load) => load.phase !== null) };
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
 * The house detail.
 *
 * The Overview opens on the power headline (the house filled with its main
 * source's colour), then the gauge of where the power comes from and the
 * biggest users now, each with its kW and share, the rest folded into
 * everything else. The card's house tree is the route to each device.
 *
 * Live readings come from `hass` and the live split from the card; Now's
 * consumers are the card's house tree, each load counted once. The backend
 * overview supplies the entity ids. Today against a usual weekday (the
 * `pattern` section) is read on opening, for the History header; today's
 * report figures (the `today` section) once History & statistics or
 * Technical details is open. Nothing here is a diagnosis: a low overnight
 * load is an observation, an unusual day a comparison.
 */
@customElement("node-detail-house-content")
export class NodeDetailHouseContent extends NodeDetailContentBase<HouseDetailPayload> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        .compare { display: flex; flex-direction: column; gap: 8px; }
        .compare-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
        .compare-bar { height: 18px; border-radius: 4px; background: var(--helman-house); }
        .compare-bar.usual { background: var(--divider-color); }
        .compare-text { flex: none; white-space: nowrap; }
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
        const runs = [...ids].flatMap((id) => laneRuns(schedule, id, now)
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
    /** Today's report figures, once History & statistics or Technical details is open. */
    private readonly _today = this._section<HouseTodaySectionPayload>("today", {
        fetch: () => this._readSection("today"),
        shown: () => (this._historyOpen || this._technicalOpen) && this._offers("today"),
    });
    /** The plan's projected energy, for each planned run's figure, while the Forecast section is open. */
    private readonly _projection = this._section<ApplianceProjectionsPayload>("projection", {
        // Never shared: a projection is a function of the schedule, re-read because it changed.
        fetch: () => getSharedHelmanStore(this.hass).getApplianceProjections(),
        shown: () => this._forecastOpen,
        staleness: (_payload, requestedAt) => requestedAt < Math.floor(Date.now() / SLOT_MS) * SLOT_MS,
    });
    /** Today against a usual weekday and the overnight minimum, for the History header: read on opening. */
    private readonly _pattern = this._section<HousePatternSectionPayload>("pattern", {
        fetch: () => this._readSection("pattern"),
        shown: () => this._offers("pattern"),
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

    protected _start(): void {
        super._start();
        // The Forecast header says what is still to come today while it is closed.
        void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    protected _renderOverview(overview: HouseDetailPayload) {
        const phases = this._phaseEstimate();
        const power = this._powerNow();
        const flows = this.params.flows;
        const loads = phases.loads.filter((load) => load.watts !== null && load.watts > 0).sort((a, b) => b.watts! - a.watts!);
        const visible = this._allUsers ? loads : loads.slice(0, TOP_CONSUMERS);
        // What no meter explains is the headline less the loads, from the same
        // states: the rows then add up to the house. The backend's remainder
        // sensor is a median over several seconds and never adds up to it.
        const hasUnmeasured = power !== null;
        const unmeasuredW = power === null ? 0 : Math.max(0, power - loads.reduce((sum, load) => sum + (load.watts ?? 0), 0));
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


    // Forecast ----------------------------------------------------------------

    /** What the house will still use today, the forecast to tomorrow noon and the planned appliance runs. */
    protected _renderForecast(overview: HouseDetailPayload) {
        const pending = this._forecastPending();
        if (pending !== null) return pending;
        const rest = this._restOfDayKwh();
        if (rest === null) return nothing;
        return this._forecastSection(boldTemplate(this.localize("node_detail.shared.forecast.house_summary"), { kwh: `≈ ${formatKwh(rest)} kWh` }),
            () => this._renderForecastBody(overview, rest));
    }

    private _renderForecastBody(overview: HouseDetailPayload, rest: number) {
        const forecast = this._forecast!.house_consumption;
        const context = this._chartContext;
        const text = (key: string) => this.localize(`node_detail.shared.forecast.${key}`);
        const end = modeStripWindow(context.now, context.timeZone).end;
        const kw = (kwh: number) => Math.max(0, kwh) / (SLOT_MS / 3_600_000);
        const slots = [forecast.currentSlot, ...forecast.series].filter((slot) => slot !== undefined)
            .map((slot) => ({ start: Date.parse(slot!.timestamp), kwh: slot!.nonDeferrable.value }))
            .filter((slot) => slot.start < end);
        const actual = forecast.actualHistory.map((slot) => ({ t: Date.parse(slot.timestamp) + SLOT_MS / 2, v: kw(slot.nonDeferrable.value) }));
        // The busiest local hour of the rest of today, by its forecast energy.
        const today = dayKey(context.now, context.timeZone);
        const hours = new Map<number, number>();
        for (const slot of slots) {
            if (slot.start + SLOT_MS <= context.now || dayKey(slot.start, context.timeZone) !== today) continue;
            const hour = slot.start - (getScheduleLocalTimeParts(slot.start, context.timeZone)?.minute ?? 0) * 60_000;
            hours.set(hour, (hours.get(hour) ?? 0) + Math.max(0, slot.kwh) * remainingShare(slot.start, context.now));
        }
        const busiest = [...hours].reduce<[number, number] | null>((best, hour) => !best || hour[1] > best[1] ? hour : best, null);
        const runs = this._plan.runs.filter((run) => run.startMs < end);
        const projection = this._projection.payload;
        return html`
            ${renderForecastChart(context, {
                title: text("house_chart"),
                help: fillTemplate(text("house_help"), { n: Math.min(forecast.historyDaysAvailable, forecast.trainingWindowDays) }),
                series: [
                    { key: "actual", label: text("actual"), color: "var(--helman-house)", points: actual },
                    { key: "forecast", label: text("forecast"), color: "var(--helman-house)", dashed: true,
                        points: slots.map((slot) => ({ t: slot.start + SLOT_MS / 2, v: kw(slot.kwh) })) },
                ],
                spans: runs.map((run) => ({ start: run.startMs, end: run.endMs ?? end, color: RUN_COLOR })),
                formatValue: (value) => formatPower(value * 1000).display,
                entities: overview.entities.power ? [overview.entities.power] : [],
            })}
            ${runs.length ? html`<p class="note"><span style="color: ${RUN_COLOR}">▬</span> ${text("house_run_legend")}</p>` : nothing}
            <div class="rows">
                <div class="row" data-row="rest"><span class="label">${text("house_rest")}</span><span class="value">≈ ${formatKwh(rest)} kWh</span></div>
                ${busiest ? html`<div class="row" data-row="busiest"><span class="label">${text("house_busiest")}</span>
                    <span class="value">${fillTemplate(text("house_busiest_value"), { time: this._time(busiest[0]), kwh: `≈ ${formatKwh(busiest[1])} kWh` })}</span></div>` : nothing}
            </div>
            ${runs.length ? html`
                <div class="section-title">${text("house_runs")}</div>
                <div class="rows" data-runs>${runs.map((run) => {
                    const kwh = projection ? projectedKwh(projectedSlots(projection, [run.id], context.now, end), run.startMs, run.endMs ?? end) : 0;
                    return html`<div class="row" data-run data-candidate=${run.candidate ? "true" : "false"}>
                        <span><b>${forecastWhen(run.startMs, context, run.endMs ?? undefined)}</b> ${run.name}${run.candidate ? html` <span class="label">· ${text("candidate")}</span>` : nothing}</span>
                        <span class="value">${kwh > 0 ? `≈ ${formatKwh(kwh)} kWh` : ""}</span></div>`;
                })}</div>` : nothing}
        `;
    }

    // History & statistics -----------------------------------------------------

    /** Today against a usual weekday, how much was covered without the grid, the overnight base and today's biggest users. */
    protected _renderHistory(overview: HouseDetailPayload) {
        const comparison = this._pattern.payload?.comparison ?? null;
        const today = comparison && !comparison.unavailable ? comparison.todayKwh : null;
        const usual = comparison && !comparison.unavailable ? comparison.averageKwh : null;
        const summary = historySummary(this._pattern, this.localize, today === null ? null
            : usual === null ? boldTemplate(this._h("house_summary_today"), { kwh: kwhText(today) })
            : boldTemplate(this._h("house_summary"), { kwh: kwhText(today), usual: formatKwh(usual) }));
        return this._historySection(summary, () => html`
            ${this._restOfDayKwh() !== null ? this._forecastPointer() : nothing}
            ${overview.sections.includes("pattern") ? this._renderPattern() : nothing}
            ${this._renderToday()}
        `);
    }

    /** Today so far against the usual same weekday by the same hour, as two bars and a sentence, then the overnight base. */
    private _renderPattern() {
        const notReady = sectionNotReady(this._pattern, this.localize);
        if (notReady) return notReady;
        const { comparison, overnight } = this._pattern.payload!;
        const until = Date.parse(comparison.until);
        const today = comparison.unavailable ? null : comparison.todayKwh;
        const usual = comparison.unavailable ? null : comparison.averageKwh;
        const scale = Math.max(today ?? 0, usual ?? 0, 0.001);
        const bar = (key: string, kwh: number, text: string) => html`<div class="compare-row" data-bar=${key}>
            <span class="compare-bar ${key}" style=${`width: ${Math.max(1, kwh / scale * 75)}%`}></span><span class="compare-text">${text}</span></div>`;
        const ratio = today !== null && usual !== null && usual > 0 ? today / usual - 1 : null;
        return html`
            ${today !== null ? html`
                ${subTitle(fillTemplate(this._h("house_vs_usual"), { weekday: this._weekday(until), time: this._time(until) }))}
                <div class="compare" data-comparison>
                    ${bar("today", today, fillTemplate(this._h("house_today_bar"), { kwh: kwhText(today) }))}
                    ${usual !== null ? bar("usual", usual, fillTemplate(this._h("house_usual_bar"), { kwh: kwhText(usual) })) : nothing}
                </div>
                ${ratio !== null ? html`<p class="note" data-difference>${Math.abs(ratio) < AS_USUAL ? this._h("as_usual")
                    : fillTemplate(this._h(ratio > 0 ? "above_usual" : "below_usual"), { pct: Math.round(Math.abs(ratio) * 100) })}</p>` : nothing}
            ` : nothing}
            ${overnight.minimum ? html`<div class="rows">${historyRow(this._h("overnight"),
                html`${formatPower(Math.max(0, overnight.minimum.watts)).display} <span class="label">${this._h("always_on")}</span>`, "overnight")}</div>` : nothing}
        `;
    }

    /** How much was covered without the grid, and today's three biggest users with everything else. */
    private _renderToday() {
        if (!this._offers("today")) return nothing;
        const notReady = sectionNotReady(this._today, this.localize);
        if (notReady) return notReady;
        const today = this._today.payload!;
        const house = today.house;
        if (!house) return html`<p class="note" data-today-unavailable>${this._h("house_today_unavailable")}</p>`;
        const top = (today.consumers?.top ?? []).slice(0, TOP_CONSUMERS);
        const rest = Math.max(0, house.kwh - top.reduce((sum, load) => sum + load.kwh, 0));
        return html`
            ${today.independence ? html`<div class="rows">${historyRow(this._h("independence"), this._share(today.independence.share), "independence")}</div>` : nothing}
            ${top.length ? html`
                ${subTitle(this._h("biggest_today"))}
                <div class="rows" data-users>
                    ${top.map((load, index) => html`<div class="row" data-row=${`top-${index + 1}`}><span>${this._loadName(load)}</span><span>${kwhText(load.kwh)}</span></div>`)}
                    ${historyRow(this._h("everything_else"), html`<span class="label">${kwhText(rest)}</span>`, "rest")}
                </div>
            ` : nothing}
        `;
    }

    private _loadName(load: HouseLoadDTO): string {
        const name = load.label || load.id;
        const named = load.ownOf ? fillTemplate(this._t("consumers.own"), { name }) : name;
        return load.estimated ? "≈ " + named : named;
    }

    // Technical details ---------------------------------------------------------

    /** The forecast's status and training, this quarter-hour's usual range, and today's unmeasured energy. */
    protected _renderTechnical(_overview: HouseDetailPayload) {
        const forecast = this._forecast?.house_consumption;
        const slot = forecast?.currentSlot;
        const unmeasured = this._today.payload?.consumers?.unmeasuredKwh ?? null;
        const t = (key: string) => this.localize(`node_detail.shared.technical.${key}`);
        return html`<div class="rows">
            ${this._row(t("forecast_status"), forecast ? this._t(`next.status_${forecast.status}`) : "—", "forecast-status")}
            ${this._row(t("learned_from"), forecast ? fillTemplate(this._t("next.history_value"), {
                days: String(forecast.historyDaysAvailable), window: String(forecast.trainingWindowDays) }) : "—", "learned-from")}
            ${this._row(t("usual_range"), slot ? `${formatKwh(slot.nonDeferrable.lower)}–${kwhText(slot.nonDeferrable.upper)}` : "—", "usual-range")}
            ${this._row(t("unmeasured_today"), unmeasured === null ? "—" : kwhText(unmeasured), "unmeasured")}
        </div>`;
    }

    /** An off-grid or fault run mode the inverter reports. */
    private _renderException(overview: HouseDetailPayload) {
        return overview.condition ? this._exceptionBanner(fillTemplate(this._t(`exception.${overview.condition.kind}`), { state: overview.condition.runMode })) : nothing;
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
            kwh += Math.max(0, slot.nonDeferrable.value) * remainingShare(start, now);
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

    // ── Readings and formatting ─────────────────────────────────────────────

    /** The card passes its live house reading in W, preserving its polarity. */
    private _powerNow(): number | null {
        const entityId = this._overview.status === "ready" ? this._overview.payload.entities.power : null;
        return readPowerW(this.hass, entityId) === null ? null : this.params.power;
    }

    private _weekday(ms: number): string {
        return new Intl.DateTimeFormat(this._locale, { weekday: "long", timeZone: this._timeZone }).format(ms);
    }

}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-house-content": NodeDetailHouseContent;
    }
}
