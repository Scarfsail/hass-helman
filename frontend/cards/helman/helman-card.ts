import { LitElement, css, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant, LovelaceCard, LovelaceCardEditor } from "../../types/ha";
import { TreeItem } from "../shared/data/tree-item";
import "./tree-item-row";
import "./tree-item-list";
import { HelmanCardConfig, HelmanUiConfig } from "./HelmanCardConfig";
import { InverterDetailPayload } from "../helman-api";
import { EnergyCardHost } from "../shared/energy-card-host";
import type { LocalizeFunction } from "../localize/localize";
import "../node-detail/node-detail-dialog";
import "../helman-simple/inverter-cell";
import "./power-flow-arrows";
import "./tree-item-info";
import "./house-devices-section";
import "../shared/schedule/dialogs/scheduling-day-editor-host";
import "./helman-card-editor";

const EMPTY_ARRAY: readonly TreeItem[] = Object.freeze([]);

@customElement("helman-card")
export class HelmanCard extends LitElement implements LovelaceCard {
    // 1. Static HA configuration methods
    public static async getStubConfig(_hass: HomeAssistant): Promise<Partial<HelmanCardConfig>> {
        return { type: `custom:helman-card` };
    }

    public static getConfigElement(): LovelaceCardEditor {
        return document.createElement("helman-card-editor") as unknown as LovelaceCardEditor;
    }

    // 2. Static styles
    static get styles() {
        return css`
            .card-content {
                padding-right: 10px;
                padding-left: 10px;
                display: flex;
                flex-direction: column;
            }
        `;
    }

    // 3. Private properties & Host controller
    private config!: HelmanCardConfig;
    private readonly _host = new EnergyCardHost(this, {
        whichNodesToWalk: (tree) => tree,
    });
    private _cachedTree?: TreeItem[];

    @state() private _computedNodes?: {
        sourcesNode: TreeItem | undefined;
        sourcesChildren: readonly TreeItem[];
        consumerNode: TreeItem | undefined;
        consumersChildren: readonly TreeItem[];
        houseNode: TreeItem | undefined;
        houseArrowDevices: (TreeItem | undefined)[];
        houseDevices: readonly TreeItem[];
    };

    // 7. HA-specific setters & getters
    public set hass(hass: HomeAssistant) {
        this._host.setHass(hass);
    }

    private get _hass(): HomeAssistant | undefined { return this._host.hass; }
    private get _deviceTree(): TreeItem[] { return this._host.deviceTree; }
    private get _historyRevision(): number { return this._host.historyRevision; }
    private get _uiConfig(): HelmanUiConfig | undefined { return this._host.uiConfig ?? undefined; }
    private get _inverter(): InverterDetailPayload | null { return this._host.inverter; }
    private get _localize(): LocalizeFunction | undefined { return this._host.localize; }

    // 8. HA-specific methods
    getCardSize() {
        return this.config?.card_size ?? 1;
    }

    async setConfig(config: HelmanCardConfig) {
        this.config = { ...config };
    }

    willUpdate(changedProperties: Map<string, any>): void {
        super.willUpdate(changedProperties);
        const deviceTree = this._host.deviceTree;
        if (deviceTree !== this._cachedTree) {
            this._cachedTree = deviceTree;
            const sourcesNode = deviceTree.find((device) => device.id === "sources");
            const sourcesChildren = sourcesNode?.children ?? EMPTY_ARRAY;
            const consumerNode = deviceTree.find((device) => device.id === "consumers");
            const consumersChildren = consumerNode?.children ?? EMPTY_ARRAY;
            const houseNode = consumersChildren.find((device) => device.id === "house");
            const houseDevices = houseNode?.children ?? EMPTY_ARRAY;
            const houseArrowDevices = [houseNode, undefined, undefined];
            this._computedNodes = { sourcesNode, sourcesChildren, consumerNode, consumersChildren, houseNode, houseArrowDevices, houseDevices };
        }
    }

    // 10. Render method
    render() {
        if (!this._hass || this._deviceTree.length === 0 || !this._computedNodes || !this._uiConfig) {
            return html``;
        }
        const { sourcesNode, sourcesChildren, consumerNode, consumersChildren, houseNode, houseArrowDevices, houseDevices } = this._computedNodes;
        const historyBuckets = this._uiConfig.history_buckets;
        const historyBucketDuration = this._uiConfig.history_bucket_duration;
        const dialogParams = this._host.dialogParams;

        return html`
            <ha-card>
                <div class="card-content">
                    <helman-tree-item-list
                        .hass=${this._hass!}
                        .devices=${sourcesChildren}
                        .historyBuckets=${historyBuckets}
                        .historyBucketDuration=${historyBucketDuration}
                        .historyRevision=${this._historyRevision}
                        .currentParentPower=${sourcesNode!.powerValue}
                        .parentPowerHistory=${sourcesNode!.powerHistory}
                        .openNodeDetailOnIcon=${true}
                    ></helman-tree-item-list>
                    <power-flow-arrows .devices=${sourcesChildren} .sources=${sourcesChildren} .historyRevision=${this._historyRevision} .maxPower=${this.config?.max_power}></power-flow-arrows>

                    <helman-tree-item-list
                        .hass=${this._hass!}
                        .devices=${consumerNode ? [consumerNode] : []}
                        .historyBuckets=${historyBuckets}
                        .historyBucketDuration=${historyBucketDuration}
                        .historyRevision=${this._historyRevision}
                        .devices_full_width=${true}
                        .centreContent=${html`
                            <helman-inverter-cell
                                .hass=${this._hass}
                                .localize=${this._localize}
                                .inverter=${this._inverter}
                            ></helman-inverter-cell>
                        `}
                    ></helman-tree-item-list>
                    <power-flow-arrows .devices=${consumersChildren} .sources=${sourcesChildren} .historyRevision=${this._historyRevision} .maxPower=${this.config?.max_power}></power-flow-arrows>

                    <helman-tree-item-list
                        .hass=${this._hass!}
                        .devices=${consumersChildren}
                        .historyBuckets=${historyBuckets}
                        .historyBucketDuration=${historyBucketDuration}
                        .historyRevision=${this._historyRevision}
                        .currentParentPower=${consumerNode!.powerValue}
                        .parentPowerHistory=${consumerNode!.powerHistory}
                        .openNodeDetailOnIcon=${true}
                    ></helman-tree-item-list>
                    <power-flow-arrows .devices=${houseArrowDevices} .sources=${sourcesChildren} .historyRevision=${this._historyRevision} .maxPower=${this.config?.max_power}></power-flow-arrows>
                    <helman-house-devices-section
                        .hass=${this._hass!}
                        .devices=${houseDevices}
                        .historyBuckets=${historyBuckets}
                        .historyBucketDuration=${historyBucketDuration}
                        .historyRevision=${this._historyRevision}
                        .currentParentPower=${houseNode!.powerValue}
                        .parentPowerHistory=${houseNode!.powerHistory}
                        .devices_full_width=${true}
                        .sortChildrenByPower=${true}
                        .initial_show_only_top_children=${this.config?.collapsed_consumers_count ?? 3}
                        .uiConfig=${this._uiConfig}
                    ></helman-house-devices-section>
                </div>
            </ha-card>
            <scheduling-day-editor-host
                .hass=${this._hass}
                .timeZone=${this._hass.config?.time_zone || "UTC"}
            ></scheduling-day-editor-host>
            ${dialogParams ? html`
                <node-detail-dialog
                    .hass=${this._hass}
                    .localize=${this._localize!}
                    .open=${true}
                    .params=${dialogParams}
                    @closed=${this._closeNodeDetail}
                ></node-detail-dialog>
            ` : ""}
        `;
    }

    private _closeNodeDetail = (): void => {
        this._host.closeDialog();
    };
}

// Register the custom card in Home Assistant
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: 'helman-card',
    name: 'House Electricity Manager Card',
    description: 'A custom card for Home Assistant to control energy nodes. It allows users to see power consumption, control devices, and manage power settings.',
    preview: true,
});
