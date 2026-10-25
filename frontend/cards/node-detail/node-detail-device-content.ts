import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { fillTemplate } from "../localize/localize";
import type { TreeItem } from "../shared/data/tree-item";
import { formatPower } from "../shared/format";
import { readPowerW } from "../shared/power-reading";
import type { DeviceDetailParams } from "./node-detail-types";
import { deviceControllableIds, deviceDirectControls } from "./node-detail-utils";
import { estimatedConsumerMix } from "./live-flows";
import { SectionResource } from "./section-resource";
import "./detail-headline";
import "./flow-gauge";
import "./switch-tile";
import "./who-decides";
import { ownershipText } from "./who-decides";
import { LaneOwnershipController } from "./lane-ownership";

function powerEntity(item: TreeItem): string | undefined {
    return item.powerSensorId && item.powerSensorId !== item.energyEntityId ? item.powerSensorId : undefined;
}

@customElement("node-detail-device-content")
export class NodeDetailDeviceContent extends LitElement {
    static styles = css`
        :host { display: block; }
        .status { margin: 0 0 8px; color: var(--secondary-text-color); }
        .content { display: grid; gap: 10px; }
        .icon { width: 64px; height: 64px; display: grid; place-items: center; }
        .icon ha-icon { --mdc-icon-size: 42px; }
    `;
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: DeviceDetailParams;
    private readonly _lanes = new LaneOwnershipController(this, () => this.hass);
    private readonly _energy = new SectionResource<number | null>(this, "energy", {
        fetch: () => this._readToday(this.params.item.energyEntityId!),
        shown: () => !!this.params.item.energyEntityId,
        staleness: () => false,
    });
    private _loadedItem?: TreeItem;
    protected willUpdate(_changed: PropertyValues<this>): void {
        const item = this.params?.item;
        if (!item || !this.hass) return;
        if (item !== this._loadedItem) { this._loadedItem = item; this._energy.drop(); }
        this._energy.sync();
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
        return html`<div class="content">
            <p class="status" data-overview>${stateLabel} · ${ids.length
                ? ownershipText(this._lanes.status(ids[0]), this.localize, this._lanes.locale, this._lanes.timeZone)
                : this.localize("node_detail.control.status.not_automated")}</p>
            <helman-detail-headline .value=${power === null ? "—" : formatPower(power).display} .entityId=${powerId ?? null} .caption=${caption}>
                ${controlId ? html`<helman-switch-tile slot="icon" .hass=${this.hass} .localize=${this.localize}
                    .entityId=${controlId} .kind=${direct?.switchEntityId ? "switch" : "climate"}
                    .fallbackIcon=${item.icon || (direct?.climateEntityId ? "mdi:air-conditioner" : "mdi:power-plug")}></helman-switch-tile>`
                    : html`<span slot="icon" class="icon"><ha-icon .icon=${item.icon || "mdi:power-plug"}></ha-icon></span>`}
            </helman-detail-headline>
            <helman-flow-gauge direction="from" .items=${estimatedConsumerMix(this.params.flows, power)} .estimated=${true} .localize=${this.localize}></helman-flow-gauge>
            ${ids.length ? html`<helman-who-decides .hass=${this.hass} .localize=${this.localize} .controllableId=${ids[0]}></helman-who-decides>` : nothing}
        </div>`;
    }
    private async _readToday(meter: string): Promise<number | null> {
        try {
            const result = await this.hass.callWS<{ change?: number | null }>({
                type: "recorder/statistic_during_period", statistic_id: meter, types: ["change"], calendar: { period: "day" },
            });
            return typeof result?.change === "number" ? result.change : null;
        } catch { return null; }
    }
}
