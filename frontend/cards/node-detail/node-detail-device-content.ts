import { formatPower } from "../shared/format";
import { callHelman } from "../shared/data/helman-commands";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import type { TreeItem } from "../shared/data/tree-item";
import type { DeviceDetailParams } from "./node-detail-types";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { readPowerW } from "../shared/power-reading";
import { openMoreInfo } from "./node-detail-readings";
import { SectionResource } from "./section-resource";

import { type DeviceStats, type DeviceStatsSpread } from "../helman-api";
import "./device-direct-control";
import { deviceControllableIds, deviceDirectControls } from "./node-detail-utils";
import {
    deviceEnergyFigure,
    deviceEnergyLabel,
    deviceEnergyMeasures,
    deviceEnergySourceLabel,
    deviceEnergyStyles,
    formatDeviceEnergyWatts,
    renderDeviceEnergyValue,
} from "../shared/devices/device-energy";

type HistoryGraphCard = HTMLElement & { hass?: HomeAssistant };

/** A tile's figure: `undefined` while it loads, `null` when HA had no answer. */
type Reading = number | null | undefined;

/** What the device's own meter counted today and in the last hour; `null` where HA had no answer. */
type MeterEnergy = { today: number | null; lastHour: number | null };

/**
 * The device's power sensor, if it has one. An inspector box with no power
 * sensor falls back to its energy meter, which is a cumulative total, not watts.
 */
function powerEntity(item: TreeItem): string | undefined {
    return item.powerSensorId && item.powerSensorId !== item.energyEntityId ? item.powerSensorId : undefined;
}

/**
 * One config device at a glance: its live power, the energy its own
 * meter counted today and in the last hour, what it typically uses as learned
 * over its learning window, and HA's history graph of both.
 *
 * Always "now", wherever it is opened from. The energy figures are fetched when
 * the dialog opens on a device, not on every `hass` tick.
 */
@customElement("node-detail-device-content")
export class NodeDetailDeviceContent extends LitElement {

    static styles = [nodeDetailSharedStyles, deviceEnergyStyles, css`
        .header {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .header ha-icon {
            color: var(--secondary-text-color);
        }
        .power {
            flex-grow: 1;
            font-size: 1.4rem;
            font-weight: 600;
        }
        button.power {
            border: 0;
            background: none;
            color: inherit;
            font: inherit;
            text-align: left;
            padding: 0;
            cursor: pointer;
        }
        .tiles {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .tile {
            flex: 1 1 120px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 8px 12px;
            border-radius: 8px;
            background: var(--secondary-background-color);
        }
        .tile .range {
            color: var(--secondary-text-color);
            font-size: 0.8rem;
        }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: DeviceDetailParams;

    /** The energy the device's own meter counted. */
    private readonly _energy = new SectionResource<MeterEnergy>(this, "energy", {
        fetch: () => this._readEnergy(this.params.item.energyEntityId!),
        shown: () => !!this.params.item.energyEntityId,
        staleness: () => false,
    });
    /** The learned usage record; `null` when there is none. */
    private readonly _stats = new SectionResource<DeviceStats | null>(this, "stats", {
        // The solar inspector's deviceKey is a controllable id; the backend
        // resolves a metered device's id to its meter.
        fetch: () => callHelman(this.hass, "helman/get_device_stats", { device_key: this.params.item.deviceKey! }),
        shown: () => !!this.params.item.deviceKey,
        staleness: () => false,
    });
    /** HA's history graph of the device's power and switch. */
    private readonly _chart = new SectionResource<HistoryGraphCard>(this, "chart", {
        fetch: () => this._createChart(this._chartEntities(this.params.item)),
        shown: () => this._chartEntities(this.params.item).length > 0 && typeof (window as any).loadCardHelpers === "function",
        staleness: () => false,
    });
    /** Every figure of the device, read once per device opened. */
    private readonly _sections = [this._energy, this._stats, this._chart];
    /** The device the figures and chart were read for; the host rebuilds params every render. */
    private _loadedItem?: TreeItem;

    protected willUpdate(changed: PropertyValues<this>): void {
        super.willUpdate(changed);
        const item = this.params?.item;
        if (!item || !this.hass) return;
        // Another device: nothing shown is its.
        if (item !== this._loadedItem) {
            this._loadedItem = item;
            for (const section of this._sections) section.drop();
        }
        for (const section of this._sections) section.sync();
        const chart = this._chart.payload;
        if (chart && changed.has("hass")) chart.hass = this.hass;
    }

    render() {
        const item = this.params.item;
        const direct = deviceDirectControls(item);
        const powerId = powerEntity(item);
        const header = html`<div class="header">
            ${powerId
                ? html`<button class="power" data-power-entity=${powerId} @click=${() => openMoreInfo(this, powerId)}>${this._livePower(item)}</button>`
                : html`<div class="power">${this._livePower(item)}</div>`}
        </div>`;
        return html`
            <div class="content">
                ${direct ? html`
                    <helman-device-direct-control
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .switchEntityId=${direct.switchEntityId}
                        .climateEntityId=${direct.climateEntityId}
                        .scheduled=${deviceControllableIds(item).length > 0}
                    >${header}</helman-device-direct-control>
                ` : header}
                ${item.energyEntityId ? html`
                    <div class="tiles">
                        ${this._tile("today", this._energy.payload?.today, item.energyEntityId)}
                        ${this._tile("last_hour", this._energy.payload?.lastHour, item.energyEntityId)}
                    </div>
                ` : nothing}
                ${this._renderStats()}
                ${this._chart.payload ?? nothing}
            </div>
        `;
    }

    private _livePower(item: TreeItem): string {
        const power = readPowerW(this.hass, powerEntity(item));
        return power === null ? "—" : formatPower(power).display;
    }

    private _tile(key: "today" | "last_hour", value: Reading, meter: string) {
        const unit = this.hass.states?.[meter]?.attributes.unit_of_measurement ?? "";
        return html`
            <div class="tile ${key}">
                <span class="label">${this.localize(`node_detail.device.${key}`)}</span>
                <span class="value">${typeof value === "number" ? `${value.toFixed(2)} ${unit}`.trim() : "—"}</span>
            </div>
        `;
    }

    /**
     * The learned-usage row: its headline figure, a typical day, and -- when
     * the record has them -- how often and how long the device runs, and the
     * other of its two power figures.
     * The headline is chosen by schedulability, as everywhere else: a
     * schedulable device's average while switched on, any other device's
     * power while active. The tree lists controllable ids only for
     * schedulable devices.
     * A meterless child has no meter tiles above, so this stands on its own.
     * Titled by the days the record covers: the device's lookback, or less
     * where the recorder has purged older history.
     */
    private _renderStats() {
        const stats = this._stats.payload;
        if (!stats) return nothing;
        const day = stats.daily_kwh;
        const run = stats.run_minutes && stats.run_kwh
            ? { minutes: stats.run_minutes, kwh: stats.run_kwh }
            : undefined;
        const energy = { record: stats, schedulable: (this.params.item.controllableIds?.length ?? 0) > 0 };
        const text = (key: string) => this.localize(`device_energy.${key}`);
        const other = energy.schedulable ? "running" : "on";
        const otherWatts = deviceEnergyMeasures(stats)[other];
        const tiles = [
            deviceEnergyFigure(stats, energy.schedulable) ? html`
                <div class="tile energy">
                    <span class="label">${deviceEnergyLabel(text, energy)}</span>
                    <span class="value">${renderDeviceEnergyValue(text, energy)}</span>
                </div>
            ` : nothing,
            day ? this._statTile(
                "typical_day",
                `${day.median.toFixed(2)} kWh`,
                `${this._range(day, 2)} kWh · ${this.localize("node_detail.device.stats.mean")} ${day.mean.toFixed(2)} kWh`,
            ) : nothing,
            typeof stats.runs_per_day === "number"
                ? this._statTile("runs_per_day", stats.runs_per_day.toFixed(1))
                : nothing,
            run ? this._statTile(
                "typical_run",
                `${Math.round(run.minutes.median)} min · ${run.kwh.median.toFixed(2)} kWh`,
                `${this._range(run.minutes, 0)} min · ${this._range(run.kwh, 2)} kWh`,
            ) : nothing,
            otherWatts !== undefined ? html`
                <div class="tile ${other}">
                    <span class="label">${deviceEnergySourceLabel(text, other)}</span>
                    <span class="value">${formatDeviceEnergyWatts(otherWatts)}</span>
                </div>
            ` : nothing,
        ];
        if (tiles.every((tile) => tile === nothing)) return nothing;
        return html`
            <div class="section-title">${day
                ? this.localize("node_detail.device.stats.title", { days: day.days })
                : this.localize("node_detail.device.stats.title_undated")}</div>
            <div class="tiles stats">${tiles}</div>
        `;
    }

    private _range(spread: DeviceStatsSpread, digits: number): string {
        return `${spread.min.toFixed(digits)}–${spread.max.toFixed(digits)}`;
    }

    private _statTile(key: string, value: string, range?: string) {
        return html`
            <div class="tile ${key}">
                <span class="label">${this.localize(`node_detail.device.stats.${key}`)}</span>
                <span class="value">${value}</span>
                ${range ? html`<span class="range">${range}</span>` : nothing}
            </div>
        `;
    }

    private async _readEnergy(meter: string): Promise<MeterEnergy> {
        const change = async (period: Record<string, unknown>): Promise<number | null> => {
            try {
                const result = await this.hass.callWS<{ change?: number | null }>({
                    type: "recorder/statistic_during_period",
                    statistic_id: meter,
                    types: ["change"],
                    ...period,
                });
                return typeof result?.change === "number" ? result.change : null;
            } catch {
                return null;
            }
        };
        const [today, lastHour] = await Promise.all([
            change({ calendar: { period: "day" } }),
            change({ rolling_window: { duration: { hours: 1 } } }),
        ]);
        return { today, lastHour };
    }

    private _chartEntities(item: TreeItem): string[] {
        return [powerEntity(item), item.switchEntityId].filter((id): id is string => !!id);
    }

    private async _createChart(entities: string[]): Promise<HistoryGraphCard> {
        const helpers = await (window as any).loadCardHelpers();
        const chart = helpers.createCardElement({
            type: "history-graph",
            hours_to_show: 24,
            entities,
        }) as HistoryGraphCard;
        chart.hass = this.hass;
        return chart;
    }
}
