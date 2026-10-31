import { formatKwh, formatPower } from "../shared/format";
import { SLOT_MS } from "../shared/time/slot-time";
import { css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import {
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
import { readPowerW } from "../shared/power-reading";
import { dayKey, laneRuns, withinTodayTomorrow } from "./node-detail-schedule";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { HouseDetailParams } from "./node-detail-types";
import "../helman-simple/simple-card-house";
import "./detail-headline";
import "./flow-gauge";
import { subdeviceEntities } from "./subdevice-list";
import { boldTemplate } from "./detail-section";
import { forecastWhen, projectedKwh, projectedSlots, remainingShare, renderForecastChart } from "./node-detail-forecast";
import { historyRow, historySummary, kwhText, sectionNotReady, subTitle } from "./node-detail-history";
import { modeStripWindow } from "../shared/mode-strip";
import type { ApplianceProjectionsPayload } from "../helman-api";
import { getSharedHelmanStore } from "../shared/data/store";

/** The consumers the History lists by name; the rest is "everything else". */
const TOP_CONSUMERS = 3;

/** A planned appliance run on the Forecast chart. */
const RUN_COLOR = "color-mix(in srgb, var(--helman-house) 60%, var(--primary-text-color))";

/** Today against the usual within this share reads "about as usual". */
const AS_USUAL = 0.05;

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
 * house's subdevices, each with its kW and share, the rest folded into
 * everything else. The card's house tree is the route to each device.
 *
 * Live readings come from `hass` and the live split from the card; the
 * subdevices are the house tree's direct children. The backend
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
    `];

    protected readonly _node = "house" as const;

    @property({ attribute: false }) public params!: HouseDetailParams;

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

    /** The overview's entities, and every subdevice the list reads. */
    protected *_watchedEntities(payload: HouseDetailPayload): Iterable<string | null | undefined> {
        yield* Object.values(payload.entities);
        yield* subdeviceEntities(this.params.houseNode);
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
        const power = this._powerNow();
        const flows = this.params.flows;
        return html`
            <div class="content" data-overview>
                ${this._renderException(overview)}
                <helman-detail-headline .value=${power === null ? "—" : formatPower(power).display}
                    .entityId=${overview.entities.power ?? null} .caption=${[this.localize("node_detail.shared.house_used")] }>
                    <simple-card-house slot="icon" .compact=${true} .power=${power ?? 0}
                        .sourceColor=${this._houseSourceColor()}></simple-card-house>
                </helman-detail-headline>
                <helman-flow-gauge of="house" direction="from" .localize=${this.localize}
                    .items=${flows && power !== null && power > IDLE_W ? [
                        { node: "solar", powerW: flows.solarToHouse },
                        { node: "battery", powerW: flows.batteryToHouse },
                        { node: "grid", powerW: flows.gridToHouse },
                    ] : []}></helman-flow-gauge>
                <helman-subdevice-list .hass=${this.hass} .localize=${this.localize} .parent=${this.params.houseNode} .powerW=${power}></helman-subdevice-list>
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
        const comparison = new Map((forecast.forecastHistory ?? []).map((slot) => [Date.parse(slot.timestamp), slot.value]));
        for (const slot of slots) comparison.set(slot.start, slot.kwh);
        const predicted = [...comparison].sort(([a], [b]) => a - b)
            .map(([start, kwh]) => ({ t: start + SLOT_MS / 2, v: kw(kwh) }));
        const actual = forecast.actualHistory.flatMap((slot) => {
            const total = slot.total?.value ?? (slot.nonDeferrable && slot.deferrableConsumers
                ? slot.nonDeferrable.value + [...new Map(slot.deferrableConsumers.map((consumer) => [consumer.entityId, consumer.value])).values()].reduce((sum, value) => sum + value, 0)
                : undefined);
            return total === undefined ? [] : [{ t: Date.parse(slot.timestamp) + SLOT_MS / 2, v: kw(total) }];
        });
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
                        points: predicted },
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
