import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { fillTemplate } from "../localize/localize";
import type { TreeItem } from "../shared/data/tree-item";
import { formatKwh, formatMinutes, formatPower } from "../shared/format";
import { convertToKWh, isSupportedEnergyUnit } from "../helman/energy-unit-converter";
import { readPowerW } from "../shared/power-reading";
import { dispatchWatchedEntities } from "../shared/hass-change";
import type { DeviceDetailParams } from "./node-detail-types";
import { deviceControllableIds, deviceDirectControls, deviceEntities } from "./node-detail-utils";
import { estimatedConsumerMix } from "./live-flows";
import { SectionResource } from "./section-resource";
import type { ApplianceProjectionsPayload, ApplianceRuntimeDTO, DeviceStats, DeviceStatsSpread } from "../helman-api";
import { callHelman } from "../shared/data/helman-commands";
import { deviceEnergyMeasures } from "../shared/devices/device-energy";
import { ScheduleController } from "./schedule-controller";
import { runtimeText, runtimeFor } from "./node-detail-schedule";
import {
    HistoryGraphResource, historyRow, historySummary, renderHistorySection, renderTechnicalSection, sectionNotReady, statTile, subTitle,
} from "./node-detail-history";
import { getSharedHelmanStore } from "../shared/data/store";
import { DataChangedController } from "../shared/data/data-changed";
import { SLOT_MS } from "../shared/time/slot-time";
import { boldTemplate } from "./detail-section";
import { helmanColorVars } from "../color-vars";
import {
    forecastChartContext, forecastWhen, projectedRuns, projectedSlots, remainingShare, renderForecastChart, renderForecastSection, slotKw,
    type ForecastChartContext, type ProjectedSlot,
} from "./node-detail-forecast";
import { modeStripWindow } from "../shared/mode-strip";
import "./detail-headline";
import "./flow-gauge";
import "./switch-tile";
import "./who-decides";
import { openMoreInfo, renderEntityList } from "./node-detail-readings";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";

function powerEntity(item: TreeItem): string | undefined {
    return item.powerSensorId && item.powerSensorId !== item.energyEntityId ? item.powerSensorId : undefined;
}

@customElement("node-detail-device-content")
export class NodeDetailDeviceContent extends LitElement {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        .icon { width: 64px; height: 64px; display: grid; place-items: center; }
        .icon ha-icon { --mdc-icon-size: 42px; }
        .climate-control { align-self: flex-start; border: 0; padding: 0; background: none; color: var(--primary-color); font: inherit; cursor: pointer; }
        .climate-control:hover { text-decoration: underline; }
    `];
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: DeviceDetailParams;
    private readonly _energy = new SectionResource<number | null>(this, "energy", {
        fetch: () => this._readToday(this.params.item.energyEntityId!),
        shown: () => !!this.params.item.energyEntityId,
        staleness: () => false,
    });
    /**
     * The plan's projected energy, for the Forecast section's summary, read on
     * opening. A projection from an earlier slot counts energy already used:
     * re-read once per slot, and on every announced change of the plan.
     */
    private readonly _projection = new SectionResource<ApplianceProjectionsPayload>(this, "projection", {
        fetch: () => getSharedHelmanStore(this.hass).getApplianceProjections(),
        shown: () => deviceControllableIds(this.params.item).length > 0,
        staleness: (_payload, requestedAt) => requestedAt < Math.floor(Date.now() / SLOT_MS) * SLOT_MS,
        keepOnError: false,
    });
    /** The learned usage record, for the History header: read on opening; `null` when there is none. */
    private readonly _stats = new SectionResource<DeviceStats | null>(this, "stats", {
        // The backend resolves a metered device's id to its meter.
        fetch: () => callHelman(this.hass, "helman/get_device_stats", { device_key: this.params.item.deviceKey! }),
        shown: () => !!this.params.item.deviceKey,
        staleness: () => false,
    });
    /** HA's history graph of the device's power and switch, once History & statistics is open. */
    private readonly _chart = new HistoryGraphResource(this, () => this._chartEntities(), () => this._historyOpen);
    /** The plan, for the executor's outcome in Technical details, followed once that is open. */
    private readonly _plan = new ScheduleController(this, () => []);
    private _planStarted = false;
    @state() private _forecastOpen = false;
    @state() private _historyOpen = false;
    @state() private _technicalOpen = false;
    private _loadedItem?: TreeItem;

    constructor() {
        super();
        new DataChangedController(this, () => this.hass, {}, () => this._projection.reload());
    }
    protected willUpdate(): void {
        this._plan.reset();
        const item = this.params?.item;
        if (!item || !this.hass) return;
        const sections = [this._energy, this._projection, this._stats];
        if (item !== this._loadedItem) {
            this._loadedItem = item;
            for (const section of [...sections, this._chart]) section.drop();
            this._forecastOpen = this._historyOpen = this._technicalOpen = false;
        }
        for (const section of sections) section.sync();
        this._chart.follow(this.hass);
        if (this._technicalOpen && !this._planStarted) {
            this._planStarted = true;
            this._plan.start(this.hass);
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._plan.stop();
        this._planStarted = false;
    }
    protected updated(changed: PropertyValues<this>): void {
        if (changed.has("params")) dispatchWatchedEntities(this, "node-detail", deviceEntities(this.params.item));
    }
    render() {
        const item = this.params.item;
        const direct = deviceDirectControls(item);
        const controlId = direct?.switchEntityId ?? direct?.climateEntityId ?? null;
        const state = controlId ? this.hass.states[controlId]?.state : null;
        const powerId = powerEntity(item);
        const power = readPowerW(this.hass, powerId);
        const ids = deviceControllableIds(item);
        const stateLabel = state === "on" ? this.localize("node_detail.shared.device_state_on")
            : state === "off" ? this.localize("node_detail.shared.device_state_off") : state ?? "—";
        const today = this._energy.payload;
        const caption = [stateLabel];
        if (today !== undefined && today !== null) caption.push(fillTemplate(this.localize("node_detail.shared.device_today"), { kwh: today.toFixed(2) }));
        return html`<div class="overview"><div class="content" data-overview>
            <helman-detail-headline .value=${power === null ? "—" : formatPower(power).display} .entityId=${powerId ?? null} .caption=${caption}>
                ${controlId ? html`<helman-switch-tile slot="icon" .hass=${this.hass} .localize=${this.localize}
                    .entityId=${controlId} .kind=${direct?.switchEntityId ? "switch" : "climate"}
                    .fallbackIcon=${item.icon || (direct?.climateEntityId ? "mdi:air-conditioner" : "mdi:power-plug")}></helman-switch-tile>`
                    : html`<span slot="icon" class="icon"><ha-icon .icon=${item.icon || "mdi:power-plug"}></ha-icon></span>`}
            </helman-detail-headline>
            ${direct?.switchEntityId && direct.climateEntityId ? html`<button class="climate-control" type="button"
                @click=${() => openMoreInfo(this, direct.climateEntityId!)}>${this.localize("node_detail.shared.climate_controls")}</button>` : nothing}
            <helman-flow-gauge direction="from" .items=${estimatedConsumerMix(this.params.flows, power)} .estimated=${true} .localize=${this.localize}></helman-flow-gauge>
            ${ids.length ? html`<helman-who-decides .hass=${this.hass} .localize=${this.localize} .controllableId=${ids[0]}></helman-who-decides>` : nothing}
        </div></div>
        <slot name="schedule"></slot>
        ${this._renderForecast(ids)}
        ${this._renderHistory()}
        ${renderTechnicalSection(this.hass, this.localize, this._technicalOpen, (open) => { this._technicalOpen = open; }, () => this._renderTechnical(ids))}`;
    }

    /** The power sensor and the switch, which HA's history graph draws. */
    private _chartEntities(): string[] {
        const item = this.params.item;
        return [powerEntity(item), deviceDirectControls(item)?.switchEntityId ?? item.switchEntityId].filter((id): id is string => !!id);
    }

    /**
     * Its power and switch over the last 24 hours, and what it typically
     * uses, as learned over its window. None for a device with neither.
     */
    private _renderHistory() {
        if (!this._chart.available() && !this.params.item.deviceKey) return nothing;
        const stats = this._stats.payload;
        const measures = deviceEnergyMeasures(stats ?? undefined);
        const whileOn = measures.on ?? measures.running;
        const h = (key: string) => this.localize(`node_detail.shared.history.${key}`);
        const summary = historySummary(this._stats, this.localize, whileOn !== undefined ? boldTemplate(h("device_summary"), { kw: formatPower(whileOn).display }) : null);
        return renderHistorySection(this.localize, summary, this._historyOpen, (open) => { this._historyOpen = open; }, () => html`
            ${this._chart.render(this.localize)}
            ${this.params.item.deviceKey ? this._renderTypical() : nothing}
        `);
    }

    /** A typical day, how often and how long it runs, and its average while on: 2×2 tiles. */
    private _renderTypical() {
        const notReady = sectionNotReady(this._stats, this.localize);
        if (notReady) return notReady;
        const stats = this._stats.payload;
        const h = (key: string) => this.localize(`node_detail.shared.history.${key}`);
        if (!stats) return html`<p class="note" data-no-stats>${h("device_no_stats")}</p>`;
        const range = (spread: Pick<DeviceStatsSpread, "min" | "max">, digits: number) => `${spread.min.toFixed(digits)}–${spread.max.toFixed(digits)}`;
        const day = stats.daily_kwh;
        const measures = deviceEnergyMeasures(stats);
        const whileOn = measures.on ?? measures.running;
        const run = stats.run_minutes && stats.run_kwh ? { minutes: stats.run_minutes.median, kwh: stats.run_kwh.median } : null;
        return html`
            ${subTitle(day ? fillTemplate(h("device_typical"), { days: day.days }) : h("device_typical_undated"))}
            <div class="stat-tiles two" data-typical>
                ${day ? statTile(`${formatKwh(day.median)} kWh`, fillTemplate(h("device_day"), { range: range(day, 1) }), "day") : nothing}
                ${typeof stats.runs_per_day === "number" ? statTile(fillTemplate(h("device_runs"), { n: Math.round(stats.runs_per_day * 10) / 10 }), stats.daily_runs ? fillTemplate(h("device_runs_range"), { range: range(stats.daily_runs, 0) }) : h("device_runs_caption"), "runs") : nothing}
                ${run ? statTile(formatMinutes(run.minutes), fillTemplate(h("device_run"), { kwh: formatKwh(run.kwh) }), "run") : nothing}
                ${whileOn !== undefined ? statTile(formatPower(whileOn).display, h("device_while_on"), "while-on") : nothing}
            </div>
        `;
    }

    /** The executor's outcome for each of its lanes in the slot in progress, and the entities it is read and switched through. */
    private _renderTechnical(ids: readonly string[]) {
        const item = this.params.item;
        const t = (key: string) => this.localize(`node_detail.shared.technical.${key}`);
        const now = Date.now();
        return html`
            ${ids.length ? html`
                <div class="rows">
                    ${ids.map((id) => {
                        const runtime = runtimeFor<ApplianceRuntimeDTO>(this._plan.schedule, id, now);
                        return historyRow(ids.length > 1 ? `${t("executor")} · ${id}` : t("executor"), runtime ? runtimeText(runtime, this.localize) : t("no_runtime"), `runtime-${id}`);
                    })}
                </div>
            ` : nothing}
            ${renderEntityList(this.hass, this.localize, this, deviceEntities(item))}
        `;
    }

    /**
     * What the plan's runs are projected to use until tomorrow noon: the
     * summary, a chart of the planned power and one row per run. None for a
     * device without projected energy.
     */
    private _renderForecast(ids: readonly string[]) {
        const projection = this._projection.state;
        if (projection?.status === "error") {
            return renderForecastSection(this.localize, this.localize("node_detail.forecast_failed"), this._forecastOpen, (open) => { this._forecastOpen = open; },
                () => html`<button class="link-button" @click=${() => this._projection.load()}>${this.localize("node_detail.shared.forecast.retry")}</button>`);
        }
        const context = forecastChartContext(this.hass, this.localize);
        const slots = projectedSlots(this._projection.payload, ids, context.now, modeStripWindow(context.now, context.timeZone).end);
        if (!slots.length) return nothing;
        const total = slots.reduce((sum, slot) => sum + slot.kwh, 0);
        return renderForecastSection(this.localize,
            boldTemplate(this.localize("node_detail.shared.forecast.device_summary"), { kwh: `≈ ${formatKwh(total)} kWh` }),
            this._forecastOpen, (open) => { this._forecastOpen = open; }, () => this._renderForecastBody(slots, context));
    }

    private _renderForecastBody(slots: ProjectedSlot[], context: ForecastChartContext) {
        const first = Math.floor(context.now / SLOT_MS) * SLOT_MS;
        const end = modeStripWindow(context.now, context.timeZone).end;
        const bySlot = new Map(slots.map((slot) => [slot.startMs, slot.kwh]));
        const points = [];
        // Off between the runs is planned too: zero, not a gap.
        // The slots hold only what is still ahead of the slot in progress.
        const power = (startMs: number, kwh: number) => {
            const share = remainingShare(startMs, context.now);
            return share > 0 ? slotKw(kwh / share) : 0;
        };
        for (let t = first; t < end; t += SLOT_MS) points.push({ t, v: power(t, bySlot.get(t) ?? 0) });
        const kw = Math.max(...slots.map((slot) => power(slot.startMs, slot.kwh)));
        const runs = projectedRuns(slots);
        return html`
            ${renderForecastChart(context, {
                title: this.localize("node_detail.shared.forecast.device_chart"),
                help: fillTemplate(this.localize("node_detail.shared.forecast.device_help"), { kw: formatPower(kw * 1000).display }),
                series: [{ key: "planned", label: this.localize("node_detail.shared.forecast.planned"), color: "var(--helman-house)", points, dashed: true }],
                step: true,
                formatValue: (value) => formatPower(value * 1000).display,
            })}
            <div class="rows">
                ${runs.map((run) => html`<div class="row" data-run><span class="label">${forecastWhen(run.startMs, context, run.endMs)}</span>
                    <span class="value">≈ ${formatKwh(run.kwh)} kWh</span></div>`)}
            </div>
        `;
    }

    private async _readToday(meter: string): Promise<number | null> {
        try {
            const result = await this.hass.callWS<{ change?: number | null }>({
                type: "recorder/statistic_during_period", statistic_id: meter, types: ["change"], calendar: { period: "day" },
            });
            const unit = this.hass.states[meter]?.attributes.unit_of_measurement as string | undefined;
            return typeof result?.change === "number" && unit && isSupportedEnergyUnit(unit)
                ? convertToKWh(result.change, unit) : null;
        } catch { return null; }
    }
}
