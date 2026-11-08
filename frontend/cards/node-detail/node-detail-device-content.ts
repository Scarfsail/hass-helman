import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { fillTemplate } from "../localize/localize";
import type { TreeItem } from "../shared/data/tree-item";
import { formatKwh, formatPower } from "../shared/format";
import { readPowerW } from "../shared/power-reading";
import { dispatchWatchedEntities } from "../shared/hass-change";
import type { DeviceDetailParams } from "./node-detail-types";
import { deviceControllableIds, deviceDirectControls, deviceEntities, powerEntity } from "./node-detail-utils";
import { estimatedConsumerMix } from "./live-flows";
import { isSwitchOn } from "../shared/config/devices";
import { SectionResource, timeZone } from "./section-resource";
import type { ApplianceProjectionsPayload, ApplianceRuntimeDTO, DeviceStats, NodeHistoryPayload } from "../helman-api";
import { readTodayKWh } from "../shared/devices/device-energy";
import { consumerHistoryFallback, consumerHistorySummary, deviceStatsSection, nodeHistorySection, nodeHistoryStyles, renderNodeHistory } from "./node-history";
import { defaultPeriod, type HistoryPeriod } from "./history-period-picker";
import { todayKey } from "../shared/time/day-key";
import { ScheduleController } from "./schedule-controller";
import { runtimeText, runtimeFor } from "./node-detail-schedule";
import { historyRow, historySummary, renderHistorySection, renderTechnicalSection, sectionNotReady } from "./node-detail-history";
import { getSharedHelmanStore } from "../shared/data/store";
import { DataChangedController } from "../shared/data/data-changed";
import { SLOT_MS } from "../shared/time/slot-time";
import { helmanColorVars } from "../color-vars";
import {
    deviceForecastSummary, forecastChartContext, forecastWhen, powerHistorySection, projectedRuns, projectedSlots, renderDevicePowerChart, renderForecastSection,
    type ForecastChartContext, type ProjectedSlot,
} from "./node-detail-forecast";
import type { DayLinePoint } from "../shared/day-line-chart";
import { modeStripWindow } from "../shared/mode-strip";
import "./detail-headline";
import "./flow-gauge";
import "./switch-tile";
import "./cover-control";
import "./who-decides";
import { subdeviceEntities } from "./subdevice-list";
import { openMoreInfo, renderEntityList } from "./node-detail-readings";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";

@customElement("node-detail-device-content")
export class NodeDetailDeviceContent extends LitElement {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, nodeHistoryStyles, css`
        .icon { width: 64px; height: 64px; display: grid; place-items: center; }
        .icon ha-icon { --mdc-icon-size: 42px; }
        .climate-control { align-self: flex-start; border: 0; padding: 0; background: none; color: var(--primary-color); font: inherit; cursor: pointer; }
        .climate-control:hover { text-decoration: underline; }
    `];
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: DeviceDetailParams;
    private readonly _energy = new SectionResource<number | null>(this, "energy", {
        fetch: () => readTodayKWh(this.hass, this.params.item.energyEntityId!),
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
    private readonly _stats = new SectionResource<DeviceStats | null>(this, "stats", deviceStatsSection(this));
    /**
     * The picked period every consumer shows, read on opening: the History
     * header needs its paid rate while the section is collapsed.
     */
    private readonly _period = new SectionResource<NodeHistoryPayload>(this, "period", nodeHistorySection(this, () => this._houseNode(), () => this._historyPeriod));
    /** The power entity's mean power per slot since midnight, for the Forecast chart, while that is open. */
    private readonly _powerHistory = new SectionResource<DayLinePoint[]>(this, "power-history",
        powerHistorySection(this, () => powerEntity(this.params.item), () => this._forecastOpen));
    /** The plan, for the executor's outcome in Technical details, followed once that is open. */
    private readonly _plan = new ScheduleController(this, () => []);
    private _planStarted = false;
    /** The period History shows, the last 30 days on opening. */
    @state() private _historyPeriod!: HistoryPeriod;
    @state() private _forecastOpen = false;
    @state() private _historyOpen = false;
    @state() private _technicalOpen = false;
    @state() private _estimatesOpen = false;
    private _loadedItem?: TreeItem;

    constructor() {
        super();
        new DataChangedController(this, () => this.hass, {}, () => this._projection.reload());
    }
    protected willUpdate(): void {
        this._plan.reset();
        const item = this.params?.item;
        if (!item || !this.hass) return;
        const sections = [this._energy, this._projection, this._stats, this._period, this._powerHistory];
        if (item !== this._loadedItem) {
            this._loadedItem = item;
            this._historyPeriod = defaultPeriod(todayKey(timeZone(this.hass)));
            for (const section of sections) section.drop();
            this._forecastOpen = this._historyOpen = this._technicalOpen = this._estimatesOpen = false;
        }
        for (const section of sections) section.sync();
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
        if (changed.has("params")) dispatchWatchedEntities(this, "node-detail", [...deviceEntities(this.params.item), ...subdeviceEntities(this.params.item)]);
    }
    render() {
        const item = this.params.item;
        const direct = deviceDirectControls(item);
        const coverId = direct?.coverEntityId ?? null;
        const controlId = direct?.switchEntityId ?? direct?.climateEntityId ?? null;
        const coverState = coverId ? this.hass.states[coverId]?.state : null;
        const switchState = controlId ? this.hass.states[controlId]?.state : null;
        const powerId = powerEntity(item);
        const power = readPowerW(this.hass, powerId);
        const ids = deviceControllableIds(item);
        const stateLabel = coverId
            ? (coverState ? (this.localize(`node_detail.cover.state_${coverState}`) || coverState) : "—")
            : isSwitchOn(switchState ?? undefined) ? this.localize("node_detail.shared.device_state_on")
            : switchState === "off" ? this.localize("node_detail.shared.device_state_off") : switchState ?? "—";
        const today = this._energy.payload;
        const caption = [stateLabel];
        if (today !== undefined && today !== null) caption.push(fillTemplate(this.localize("node_detail.shared.device_today"), { kwh: today.toFixed(2) }));
        return html`<div class="overview"><div class="content" data-overview>
            <helman-detail-headline .value=${power === null ? "—" : formatPower(power).display} .entityId=${powerId ?? null} .caption=${caption}>
                ${controlId ? html`<helman-switch-tile slot="icon" .hass=${this.hass} .localize=${this.localize}
                    .entityId=${controlId} .kind=${direct?.switchEntityId ? "switch" : "climate"}
                    .fallbackIcon=${item.icon || (direct?.climateEntityId ? "mdi:air-conditioner" : "mdi:power-plug")}></helman-switch-tile>`
                    : html`<span slot="icon" class="icon"><ha-icon .icon=${item.icon || (coverId ? "mdi:window-shutter" : "mdi:power-plug")}></ha-icon></span>`}
            </helman-detail-headline>
            ${coverId ? html`<helman-cover-control .hass=${this.hass} .localize=${this.localize} .entityId=${coverId}></helman-cover-control>` : nothing}
            ${direct?.switchEntityId && direct.climateEntityId ? html`<button class="climate-control" type="button"
                @click=${() => openMoreInfo(this, direct.climateEntityId!)}>${this.localize("node_detail.shared.climate_controls")}</button>` : nothing}
            <helman-flow-gauge of="house" direction="from" .items=${estimatedConsumerMix(this.params.flows, power)} .estimated=${true} .localize=${this.localize}></helman-flow-gauge>
            ${ids.length ? html`<helman-who-decides .hass=${this.hass} .localize=${this.localize} .controllableId=${ids[0]}></helman-who-decides>` : nothing}
            <helman-subdevice-list .hass=${this.hass} .localize=${this.localize} .parent=${item} .powerW=${power}></helman-subdevice-list>
        </div></div>
        <slot name="schedule"></slot>
        ${this._renderForecast(ids)}
        ${this._renderHistory()}
        ${renderTechnicalSection(this.hass, this.localize, this._technicalOpen, (open) => { this._technicalOpen = open; }, () => this._renderTechnical(ids))}`;
    }

    /** The power sensor and the switch, whose history the Forecast chart's Show more opens. */
    private _chartEntities(): string[] {
        const item = this.params.item;
        const direct = deviceDirectControls(item);
        return [
            powerEntity(item),
            direct?.switchEntityId ?? item.switchEntityId,
            direct?.coverEntityId,
        ].filter((id): id is string => !!id);
    }

    /** Whether the device is a consumer, a node of the house subtree, which has a last 30 days. */
    private _houseNode(): boolean {
        return !this.params.item.isSource;
    }

    /**
     * Its picked period, with what it learned is typical. None for a device
     * with neither: its period once the dataset answers it has no history,
     * its stats once they answer it has no record.
     */
    private _renderHistory() {
        const item = this.params.item;
        const noPeriod = !this._houseNode() || this._period.payload?.unavailable !== undefined;
        // A device key without a learned record has no stats; one still read or failed says so.
        const noStats = !item.deviceKey || (this._stats.state?.status === "ready" && !this._stats.payload);
        if (noStats && noPeriod) return nothing;
        const summary = consumerHistorySummary(this._stats.payload, this._period, this.localize)
            ?? (item.deviceKey
                ? historySummary(this._period.state?.status === "loading" ? this._period : this._stats, this.localize, null)
                : consumerHistoryFallback(this._period, this.localize, this.hass));
        return renderHistorySection(this.localize, summary, this._historyOpen, (open) => { this._historyOpen = open; }, () => html`
            ${renderNodeHistory(this._period, this._stats.payload, this.localize, {
                hass: this.hass, period: this._historyPeriod, onPeriodChange: (period) => { this._historyPeriod = period; },
                estimatesOpen: this._estimatesOpen, toggleEstimates: () => { this._estimatesOpen = !this._estimatesOpen; },
            })}
            ${noPeriod && !noStats ? sectionNotReady(this._stats, this.localize) ?? nothing : nothing}
        `);
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
     * Its power today and what the plan's runs are projected to use until
     * tomorrow noon: the summary, a chart of the actual and planned power and
     * one row per run. None for a device with neither a plan nor a power entity.
     */
    private _renderForecast(ids: readonly string[]) {
        const projection = this._projection.state;
        const context = forecastChartContext(this.hass, this.localize);
        if (projection?.status === "error") {
            // The recorded power does not depend on the plan: it stays, beside the failure and its retry.
            return renderForecastSection(this.localize, this.localize("node_detail.forecast_failed"), this._forecastOpen, (open) => { this._forecastOpen = open; }, () => html`
                ${powerEntity(this.params.item) ? renderDevicePowerChart(context, this._powerHistory.payload ?? [], [], this._chartEntities()) : nothing}
                <button class="link-button" @click=${() => this._projection.load()}>${this.localize("node_detail.shared.forecast.retry")}</button>`);
        }
        const slots = projectedSlots(this._projection.payload, ids, context.now, modeStripWindow(context.now, context.timeZone).end);
        if (!slots.length && !powerEntity(this.params.item)) return nothing;
        return renderForecastSection(this.localize, deviceForecastSummary(slots, projection?.status === "ready", this.localize),
            this._forecastOpen, (open) => { this._forecastOpen = open; }, () => this._renderForecastBody(slots, context));
    }

    private _renderForecastBody(slots: ProjectedSlot[], context: ForecastChartContext) {
        return html`
            ${renderDevicePowerChart(context, powerEntity(this.params.item) ? this._powerHistory.payload ?? [] : null, slots, this._chartEntities())}
            <div class="rows">
                ${projectedRuns(slots).map((run) => html`<div class="row" data-run><span class="label">${forecastWhen(run.startMs, context, run.endMs)}</span>
                    <span class="value">≈ ${formatKwh(run.kwh)} kWh</span></div>`)}
            </div>
        `;
    }

}
