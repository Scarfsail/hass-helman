import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { LocalizeFunction } from "../../localize/localize";
import type { TreeItem } from "../../helman/tree-item";
import type { DeviceDetailParams } from "./node-detail-types";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { formatPower } from "../../power-format";
import "../../appliance-switch-badge";
import type { HomeAssistantLike } from "../../shared/config/types";
import { fetchDeviceStats, type DeviceStats, type DeviceStatsSpread } from "../../helman-api";
import type { HelmanDeviceEditDialog } from "../../shared/devices/helman-device-edit-dialog";
import "../../shared/devices/helman-device-edit-dialog";
import {
    deviceEnergyFigure,
    deviceEnergyLabel,
    deviceEnergyMeasures,
    deviceEnergySourceLabel,
    deviceEnergyStyles,
    formatDeviceEnergyWatts,
    renderDeviceEnergyValue,
} from "../../shared/devices/device-energy";

type HistoryGraphCard = HTMLElement & { hass?: HomeAssistant };

/** A tile's figure: `undefined` while it loads, `null` when HA had no answer. */
type Reading = number | null | undefined;

/**
 * The device's power sensor, if it has one. An inspector box with no power
 * sensor falls back to its energy meter, which is a cumulative total, not watts.
 */
function powerEntity(item: TreeItem): string | undefined {
    return item.powerSensorId && item.powerSensorId !== item.energyEntityId ? item.powerSensorId : undefined;
}

/**
 * One config device at a glance: its live power and switch, the energy its own
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

    @state() private _today: Reading;
    @state() private _lastHour: Reading;
    /** The learned usage record: `undefined` while it loads, `null` when there is none. */
    @state() private _stats: DeviceStats | null | undefined;
    @state() private _chart?: HistoryGraphCard;
    /** The device's config form is open over this detail. */
    @state() private _editing = false;

    /**
     * Back pressed while the detail is open. With the edit dialog on top, only
     * that closes, through its own discard check; returns whether it was.
     */
    public handleBack(): boolean {
        if (!this._editing) return false;
        this.renderRoot.querySelector<HelmanDeviceEditDialog>("helman-device-edit-dialog")?.requestClose();
        return true;
    }

    /** The device the figures and chart were loaded for; the host rebuilds params every render. */
    private _loadedItem?: TreeItem;

    protected willUpdate(changed: PropertyValues<this>): void {
        super.willUpdate(changed);
        const item = this.params?.item;
        if (item && item !== this._loadedItem && this.hass) {
            this._loadedItem = item;
            this._today = undefined;
            this._lastHour = undefined;
            this._stats = undefined;
            this._chart = undefined;
            void this._loadEnergy(item);
            void this._loadStats(item);
            void this._loadChart(item);
        }
        if (this._chart && changed.has("hass")) this._chart.hass = this.hass;
    }

    render() {
        const item = this.params.item;
        return html`
            <div class="content">
                <div class="header">
                    ${item.icon ? html`<ha-icon .icon=${item.icon}></ha-icon>` : nothing}
                    <div class="power">${this._livePower(item)}</div>
                    ${item.switchEntityId ? html`
                        <helman-appliance-switch-badge
                            .hass=${this.hass}
                            .entityId=${item.switchEntityId}
                            @show-more-info=${this._showMoreInfo}
                        ></helman-appliance-switch-badge>
                    ` : nothing}
                    ${item.deviceKey && this.hass.user?.is_admin === true ? html`
                        <ha-button class="edit" @click=${() => { this._editing = true; }}>
                            ${this.localize("node_detail.device.edit.button")}
                        </ha-button>
                    ` : nothing}
                </div>
                ${item.energyEntityId ? html`
                    <div class="tiles">
                        ${this._tile("today", this._today, item.energyEntityId)}
                        ${this._tile("last_hour", this._lastHour, item.energyEntityId)}
                    </div>
                ` : nothing}
                ${this._renderStats()}
                ${this._chart ?? nothing}
            </div>
            ${this._renderEditDialog(item)}
        `;
    }

    /**
     * The device's own config form, stacked over this detail. Mounted per
     * request, so each open loads the stored config afresh; closing it comes
     * back here.
     */
    private _renderEditDialog(item: TreeItem) {
        if (!this._editing || !item.deviceKey) return nothing;
        return html`
            <helman-device-edit-dialog
                .hass=${this.hass as unknown as HomeAssistantLike}
                .localize=${this.localize}
                .open=${true}
                .deviceKey=${item.deviceKey}
                .keyIsMeter=${item.deviceKeyIsMeter === true}
                @closed=${() => { this._editing = false; }}
            ></helman-device-edit-dialog>
        `;
    }

    private _livePower(item: TreeItem): string {
        const raw = parseFloat(this.hass.states?.[powerEntity(item) ?? ""]?.state ?? "");
        return Number.isFinite(raw) ? formatPower(raw).display : "—";
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
        const stats = this._stats;
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
                ? this.localize("node_detail.device.stats.title").replace("{days}", String(day.days))
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

    private async _loadStats(item: TreeItem): Promise<void> {
        // The solar inspector's deviceKey is a controllable id; the backend
        // resolves a metered device's id to its meter.
        const deviceKey = item.deviceKey;
        if (!deviceKey) return;
        let stats: DeviceStats | null;
        try {
            stats = await fetchDeviceStats(this.hass as unknown as HomeAssistantLike, deviceKey);
        } catch {
            stats = null;
        }
        // Swapped to another device while this was in flight.
        if (this._loadedItem !== item) return;
        this._stats = stats;
    }

    private async _loadEnergy(item: TreeItem): Promise<void> {
        const meter = item.energyEntityId;
        if (!meter) return;
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
        // Swapped to another device while this was in flight.
        if (this._loadedItem !== item) return;
        this._today = today;
        this._lastHour = lastHour;
    }

    private async _loadChart(item: TreeItem): Promise<void> {
        const entities = [powerEntity(item), item.switchEntityId].filter(Boolean);
        const loadCardHelpers = (window as any).loadCardHelpers;
        if (entities.length === 0 || typeof loadCardHelpers !== "function") return;
        const helpers = await loadCardHelpers();
        if (this._loadedItem !== item) return;
        const chart = helpers.createCardElement({
            type: "history-graph",
            hours_to_show: 24,
            entities,
        }) as HistoryGraphCard;
        chart.hass = this.hass;
        this._chart = chart;
    }

    /** HA's own more-info request, as the device rows turn it. */
    private _showMoreInfo(event: CustomEvent<{ entityId: string }>): void {
        this.dispatchEvent(new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId: event.detail.entityId },
        }));
    }
}
