import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { fillTemplate } from "../localize/localize";
import type { TreeItem } from "../shared/data/tree-item";
import { formatPower } from "../shared/format";
import { convertToKWh, isSupportedEnergyUnit } from "../helman/energy-unit-converter";
import { readPowerW } from "../shared/power-reading";
import { dispatchWatchedEntities } from "../shared/hass-change";
import type { DeviceDetailParams } from "./node-detail-types";
import { deviceControllableIds, deviceDirectControls } from "./node-detail-utils";
import { estimatedConsumerMix } from "./live-flows";
import { SectionResource } from "./section-resource";
import type { ApplianceProjectionsPayload } from "../helman-api";
import { getSharedHelmanStore } from "../shared/data/store";
import { DataChangedController } from "../shared/data/data-changed";
import { SLOT_MS } from "../shared/time/slot-time";
import { formatKwh } from "../shared/format";
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
import { openMoreInfo } from "./node-detail-readings";
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
    @state() private _forecastOpen = false;
    private _loadedItem?: TreeItem;

    constructor() {
        super();
        new DataChangedController(this, () => this.hass, {}, () => this._projection.reload());
    }
    protected willUpdate(_changed: PropertyValues<this>): void {
        const item = this.params?.item;
        if (!item || !this.hass) return;
        if (item !== this._loadedItem) { this._loadedItem = item; this._energy.drop(); this._projection.drop(); this._forecastOpen = false; }
        this._energy.sync();
        this._projection.sync();
    }
    protected updated(changed: PropertyValues<this>): void {
        if (changed.has("params")) dispatchWatchedEntities(this, "node-detail:device-climate", [deviceDirectControls(this.params.item)?.climateEntityId]);
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
        ${this._renderForecast(ids)}`;
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
