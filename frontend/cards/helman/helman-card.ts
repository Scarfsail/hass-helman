import { LitElement, css, html } from "lit-element"
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import { DeviceNode } from "./DeviceNode";
import type { BatteryDeviceConfig } from "./DeviceConfig";
import "./power-device";
import "./power-devices-container";
import { HelmanCardConfig, HelmanUiConfig } from "./HelmanCardConfig";
import { DeviceNodeDTO, TreePayload, HistoryPayload } from "../helman-api";
import { hydrateNode } from "./device-node-hydrator";
import { HistoryEngine } from "./history-engine";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import {
    buildNodeDetailParams,
    type NodeDetailContext,
} from "../node-detail/node-detail-params-builder";
import type { NodeType } from "../node-detail/node-detail-types";
import "../helman-simple/node-detail-dialog";
import "./power-flow-arrows"
import "./power-device-info"
import "./power-house-devices-section"

const EMPTY_ARRAY: readonly DeviceNode[] = Object.freeze([]);

@customElement("helman-card")
export class HelmanCard extends LitElement implements LovelaceCard {
    // 1. Static HA configuration methods
    public static async getStubConfig(_hass: HomeAssistant): Promise<Partial<HelmanCardConfig>> {
        return { type: `custom:helman-card` };
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

    // 3. Private properties
    private config!: HelmanCardConfig;
    private _historyEngine?: HistoryEngine;
    private _localize?: LocalizeFunction;
    private _sourceNodes: DeviceNode[] = [];
    private _watchedEntityIds: Set<string> = new Set();
    private _latestHass?: HomeAssistant;

    // 5. State properties
    @state() private _hass?: HomeAssistant;
    @state() private _deviceTree: DeviceNode[] = [];
    @state() private _dialogNodeType: NodeType | null = null;
    @state() private _uiConfig?: HelmanUiConfig;
    @state() private _computedNodes?: {
        sourcesNode: DeviceNode | undefined;
        sourcesChildren: readonly DeviceNode[];
        consumerNode: DeviceNode | undefined;
        consumersChildren: readonly DeviceNode[];
        houseNode: DeviceNode | undefined;
        houseDevices: readonly DeviceNode[];
    };

    // 7. HA-specific setters
    public set hass(hass: HomeAssistant) {
        const previous = this._latestHass;
        this._latestHass = hass;
        if (!this._localize) this._localize = getLocalizeFunction(hass);

        if (!previous) {
            this._hass = hass;
            return;
        }
        if (this._watchedEntityIds.size === 0) {
            // Tree not yet hydrated — keep the simple behavior so initial load still works.
            this._hass = hass;
            return;
        }
        for (const id of this._watchedEntityIds) {
            if (previous.states[id] !== hass.states[id]) {
                this._hass = hass;
                return;
            }
        }
        // No watched entity changed — skip the re-render entirely.
    }

    // 8. HA-specific methods
    getCardSize() {
        return this.config?.card_size ?? 1;
    }

    async setConfig(config: HelmanCardConfig) {
        this.config = { ...config };
    }

    // 9. Lifecycle methods
    async connectedCallback() {
        super.connectedCallback();
        if (this._latestHass) {
            await this._loadBackendData();
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._historyEngine?.stop();
    }

    willUpdate(changedProperties: Map<string, any>): void {
        super.willUpdate(changedProperties);
        if (changedProperties.has('_deviceTree')) {
            const sourcesNode = this._deviceTree.find((device) => device.id === "sources");
            const sourcesChildren = sourcesNode?.children ?? EMPTY_ARRAY;
            const consumerNode = this._deviceTree.find((device) => device.id === "consumers");
            const consumersChildren = consumerNode?.children ?? EMPTY_ARRAY;
            const houseNode = consumersChildren.find((device) => device.id === "house");
            const houseDevices = houseNode?.children ?? EMPTY_ARRAY;
            this._computedNodes = { sourcesNode, sourcesChildren, consumerNode, consumersChildren, houseNode, houseDevices };
        }
    }

    // 10. Render method
    render() {
        if (!this._hass || this._deviceTree.length === 0 || !this._computedNodes || !this._uiConfig) {
            return html``;
        }
        const { sourcesNode, sourcesChildren, consumerNode, consumersChildren, houseNode, houseDevices } = this._computedNodes;
        const historyBuckets = this._uiConfig.history_buckets;
        const historyBucketDuration = this._uiConfig.history_bucket_duration;
        const dialogParams = this._dialogNodeType !== null
            ? this._buildDialogParams(this._dialogNodeType)
            : null;

        return html`
            <ha-card @show-node-detail=${this._handleShowNodeDetail}>
                <div class="card-content">
                    <power-devices-container
                        .hass=${this._hass!}
                        .devices=${sourcesChildren}
                        .historyBuckets=${historyBuckets}
                        .historyBucketDuration=${historyBucketDuration}
                        .currentParentPower=${sourcesNode!.powerValue}
                        .parentPowerHistory=${sourcesNode!.powerHistory}
                        .openNodeDetailOnIcon=${true}
                    ></power-devices-container>
                    <power-flow-arrows .devices=${[...sourcesChildren]} .maxPower=${this.config?.max_power}></power-flow-arrows>

                    <power-devices-container
                        .hass=${this._hass!}
                        .devices=${consumerNode ? [consumerNode] : []}
                        .historyBuckets=${historyBuckets}
                        .historyBucketDuration=${historyBucketDuration}
                        .devices_full_width=${true}
                    ></power-devices-container>
                    <power-flow-arrows .devices=${[...consumersChildren]} .maxPower=${this.config?.max_power}></power-flow-arrows>

                    <power-devices-container
                        .hass=${this._hass!}
                        .devices=${consumersChildren}
                        .historyBuckets=${historyBuckets}
                        .historyBucketDuration=${historyBucketDuration}
                        .currentParentPower=${consumerNode!.powerValue}
                        .parentPowerHistory=${consumerNode!.powerHistory}
                        .openNodeDetailOnIcon=${true}
                    ></power-devices-container>
                    <power-flow-arrows .devices=${[houseNode, undefined, undefined]} .maxPower=${this.config?.max_power}></power-flow-arrows>
                    <power-house-devices-section
                        .hass=${this._hass!}
                        .devices=${houseDevices}
                        .historyBuckets=${historyBuckets}
                        .historyBucketDuration=${historyBucketDuration}
                        .currentParentPower=${houseNode!.powerValue}
                        .parentPowerHistory=${houseNode!.powerHistory}
                        .devices_full_width=${true}
                        .sortChildrenByPower=${true}
                        .initial_show_only_top_children=${3}
                        .uiConfig=${this._uiConfig}
                    ></power-house-devices-section>
                </div>
            </ha-card>
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

    // 12. Private helper methods
    private _handleShowNodeDetail(event: CustomEvent<{ nodeType: NodeType }>): void {
        event.stopPropagation();
        this._dialogNodeType = event.detail.nodeType;
    }

    private _closeNodeDetail(): void {
        this._dialogNodeType = null;
    }

    private _buildDialogParams(nodeType: NodeType) {
        return buildNodeDetailParams(this._buildNodeDetailContext(), nodeType);
    }

    private _buildNodeDetailContext(): NodeDetailContext {
        const { sourcesNode, sourcesChildren, consumerNode, consumersChildren, houseNode, houseDevices } = this._computedNodes!;
        const solarNode = sourcesChildren.find((device) => device.sourceType === "solar") ?? null;
        const gridProducerNode = sourcesChildren.find((device) => device.sourceType === "grid") ?? null;
        const gridConsumerNode = consumersChildren.find((device) => device.sourceType === "grid") ?? null;
        const batteryProducerNode = sourcesChildren.find((device) => device.sourceType === "battery") ?? null;
        const batteryConsumerNode = consumersChildren.find((device) => device.sourceType === "battery") ?? null;
        const batteryConfig = (batteryProducerNode?.deviceConfig ?? batteryConsumerNode?.deviceConfig) as BatteryDeviceConfig | undefined;
        const batterySocEntityId = batteryConfig?.entities.capacity ?? null;
        const batterySocState = batterySocEntityId ? this._hass?.states[batterySocEntityId] : null;
        const rawBatterySoc = batterySocState ? parseFloat(batterySocState.state) : NaN;

        return {
            batteryPower: (batteryConsumerNode?.powerValue ?? 0) - (batteryProducerNode?.powerValue ?? 0),
            batterySoc: Number.isFinite(rawBatterySoc) ? Math.max(0, Math.min(100, rawBatterySoc)) : 0,
            batterySocEntityId,
            batteryRemainingEnergyEntityId: batteryConfig?.entities.remaining_energy ?? null,
            batteryProducerNode,
            batteryConsumerNode,
            solarNode,
            gridProducerNode,
            gridConsumerNode,
            productionNode: sourcesNode ?? null,
            consumptionNode: consumerNode ?? null,
            housePower: houseNode?.powerValue ?? 0,
            houseDevices: [...houseDevices],
            houseNode: houseNode ?? null,
            historyBuckets: this._uiConfig?.history_buckets ?? 60,
            historyBucketDuration: this._uiConfig?.history_bucket_duration ?? 60,
            uiConfig: this._uiConfig,
        };
    }

    private async _loadBackendData(): Promise<void> {
        this._historyEngine?.stop();
        try {
            const treePayload = await this._latestHass!.connection.sendMessagePromise<TreePayload>({
                type: "helman/get_device_tree",
            });
            this._uiConfig = treePayload.uiConfig;
            this._deviceTree = this._hydrateDeviceNodes(treePayload);
            this._sourceNodes = this._collectSourceNodes(this._deviceTree);
            this._rebuildWatchedEntityIds();

            const history = await this._latestHass!.connection.sendMessagePromise<HistoryPayload>({
                type: 'helman/get_history',
            });
            const histBuckets = this._uiConfig.history_buckets;
            this._historyEngine = new HistoryEngine(
                () => this._latestHass,
                histBuckets,
                () => this.requestUpdate(),
            );
            this._historyEngine.applyHistory(history, HistoryEngine.walkTree(this._deviceTree), this._sourceNodes);
            this.requestUpdate();

            this._historyEngine.start(
                this._uiConfig.history_bucket_duration,
                () => this._deviceTree,
                () => this._sourceNodes,
            );
            this._historyEngine.advanceBuckets(this._deviceTree, this._sourceNodes);
        } catch (error) {
            console.error('Helman: failed to load backend data', error);
        }
    }

    private _hydrateNode(dto: DeviceNodeDTO): DeviceNode {
        return hydrateNode(dto, this._uiConfig?.history_buckets ?? 60);
    }

    private _hydrateDeviceNodes(payload: TreePayload): DeviceNode[] {
        const { sources, consumers, consumptionTotalSensorId, productionTotalSensorId, uiConfig } = payload;
        const historyBuckets = uiConfig.history_buckets;
        const roots: DeviceNode[] = [];

        // Build id→sourceType map from source DTOs so consumer counterparts (battery, grid)
        // can inherit the same sourceType even when the backend doesn't set it on the consumer side.
        const sourceTypeByDeviceId = new Map<string, string>();
        for (const dto of sources) {
            if (dto.sourceType) sourceTypeByDeviceId.set(dto.id, dto.sourceType);
        }

        if (sources.length > 0) {
            const sourcesNode = new DeviceNode("sources", uiConfig.sources_title, null, null, historyBuckets);
            sourcesNode.childrenCollapsed = false;
            sourcesNode.icon = 'mdi:lightning-bolt-outline';
            sourcesNode.powerSensorId = productionTotalSensorId;
            sourcesNode.children = sources.map(dto => this._hydrateNode(dto));
            roots.push(sourcesNode);
        }

        if (consumers.length > 0) {
            const consumersNode = new DeviceNode("consumers", uiConfig.consumers_title, null, null, historyBuckets);
            consumersNode.hideChildren = true;
            consumersNode.hideChildrenIndicator = true;
            consumersNode.icon = 'mdi:lightning-bolt-outline';
            consumersNode.powerSensorId = consumptionTotalSensorId;
            consumersNode.children = consumers.map(dto => this._hydrateNode(dto));
            // Propagate sourceType to consumer nodes. Source counterparts (battery/grid) inherit
            // from the sourceTypeByDeviceId map; house is identified by its well-known id.
            const propagateSourceType = (nodes: DeviceNode[]) => {
                for (const node of nodes) {
                    if (!node.sourceType) {
                        node.sourceType = sourceTypeByDeviceId.get(node.id)
                            ?? (node.id === 'house' ? 'house' : null);
                    }
                    propagateSourceType(node.children);
                }
            };
            propagateSourceType(consumersNode.children);
            roots.push(consumersNode);
        }

        return roots;
    }

    private _rebuildWatchedEntityIds(): void {
        const ids = new Set<string>();
        const visit = (nodes: DeviceNode[]) => {
            for (const n of nodes) {
                if (n.powerSensorId) ids.add(n.powerSensorId);
                if (n.ratioSensorId) ids.add(n.ratioSensorId);
                visit(n.children);
            }
        };
        visit(this._deviceTree);

        // Also watch battery SOC/remaining-energy entities so the dialog
        // reflects live values even when no power/ratio entity changed.
        const { sourcesChildren, consumersChildren } = this._computedNodes ?? {};
        const batteryProducerNode = sourcesChildren?.find((n) => n.sourceType === "battery");
        const batteryConsumerNode = consumersChildren?.find((n) => n.sourceType === "battery");
        const batteryConfig = (batteryProducerNode?.deviceConfig ?? batteryConsumerNode?.deviceConfig) as import("./DeviceConfig").BatteryDeviceConfig | undefined;
        if (batteryConfig?.entities.capacity) ids.add(batteryConfig.entities.capacity);
        if (batteryConfig?.entities.remaining_energy) ids.add(batteryConfig.entities.remaining_energy);

        this._watchedEntityIds = ids;
    }

    private _collectSourceNodes(nodes: DeviceNode[]): DeviceNode[] {
        const sourceNodes: DeviceNode[] = [];
        const collect = (nodeList: DeviceNode[]) => {
            for (const node of nodeList) {
                if (node.isSource) sourceNodes.push(node);
                if (node.children) collect(node.children);
            }
        };
        collect(nodes);
        return sourceNodes;
    }

}

// Register the custom card in Home Assistant
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: 'helman-card',
    name: 'House Electricity Manager Card',
    description: 'A custom card for Home Assistant to control power devices. It allows users to see power consumption, control devices, and manage power settings.',
    preview: true,
});
