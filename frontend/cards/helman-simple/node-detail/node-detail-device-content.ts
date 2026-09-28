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
import type { HelmanDeviceEditDialog } from "../../shared/devices/helman-device-edit-dialog";
import "../../shared/devices/helman-device-edit-dialog";

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
 * meter counted today and in the last hour, and HA's history graph of both.
 *
 * Always "now", wherever it is opened from. The energy figures are fetched when
 * the dialog opens on a device, not on every `hass` tick.
 */
@customElement("node-detail-device-content")
export class NodeDetailDeviceContent extends LitElement {

    static styles = [nodeDetailSharedStyles, css`
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
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: DeviceDetailParams;

    @state() private _today: Reading;
    @state() private _lastHour: Reading;
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
            this._chart = undefined;
            void this._loadEnergy(item);
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
