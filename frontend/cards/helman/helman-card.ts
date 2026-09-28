import { LitElement, css, html } from "lit-element"
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import { TreeItem } from "./tree-item";
import type { BatteryNodeConfig } from "./energy-node-config";
import "./tree-item-row";
import "./tree-item-list";
import { HelmanCardConfig, HelmanUiConfig } from "./HelmanCardConfig";
import { TreeItemDTO, TreePayload } from "../helman-api";
import { hydrateItem } from "./tree-item-hydrator";
import { HistoryEngine } from "./history-engine";
import { getSharedHelmanStore } from "./store";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import {
    buildNodeDetailParams,
    type NodeDetailContext,
} from "../node-detail/node-detail-params-builder";
import type { NodeDetailParams, NodeType } from "../node-detail/node-detail-types";
import "../helman-simple/node-detail-dialog";
import "./power-flow-arrows"
import "./tree-item-info"
import "./house-devices-section"
import "../shared/schedule/dialogs/scheduling-day-editor-host"
import {
    OPEN_SCHEDULE_EDITOR_EVENT,
    type OpenScheduleEditorDetail,
    type SchedulingDayEditorHost,
} from "../shared/schedule/dialogs/scheduling-day-editor-host";
import { WATCHED_ENTITIES_EVENT, type WatchedEntitiesDetail } from "../shared/hass-change";
import "./helman-card-editor"
import type { LovelaceCardEditor } from "../../hass-frontend/src/panels/lovelace/types";

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

    // 3. Private properties
    private config!: HelmanCardConfig;
    private _historyEngine?: HistoryEngine;
    /**
     * Bumped on every disconnect and on every load that replaces another. A load
     * that resolves after its generation was superseded commits nothing: the card
     * may already be detached, and installing a `HistoryEngine` on it would start
     * an interval nothing ever stops (#232).
     */
    private _loadGeneration = 0;
    private _localize?: LocalizeFunction;
    private _sourceNodes: TreeItem[] = [];
    private _watchedEntityIds: Set<string> = new Set();
    /** Entity ids the schedule editor host resolved, folded into the filter. */
    private _scheduleWatchedIds: Set<string> = new Set();
    private _latestHass?: HomeAssistant;

    // 5. State properties
    @state() private _hass?: HomeAssistant;
    @state() private _deviceTree: TreeItem[] = [];
    /** What the node detail dialog shows: a top-level node by type, or one device. */
    @state() private _dialogRequest: NodeType | TreeItem | null = null;
    /**
     * Bumped once per history tick. `HistoryEngine` mutates the item histories in
     * place, so nothing a child is handed changes identity when a bucket rolls —
     * same items, same arrays, and on an idle house the same power values too.
     * Without a signal of its own the containers' dirty checks saw nothing and the
     * bars below them froze until an unrelated HA state change happened to shake
     * the tree (#227). A counter is the whole signal: it moves exactly when the
     * histories moved, and never otherwise.
     */
    @state() private _historyRevision = 0;
    @state() private _uiConfig?: HelmanUiConfig;
    @state() private _computedNodes?: {
        sourcesNode: TreeItem | undefined;
        sourcesChildren: readonly TreeItem[];
        consumerNode: TreeItem | undefined;
        consumersChildren: readonly TreeItem[];
        houseNode: TreeItem | undefined;
        houseArrowDevices: (TreeItem | undefined)[];
        houseDevices: readonly TreeItem[];
    };

    // 7. HA-specific setters
    /**
     * The worked example of "a new `hass` is not a change signal" — see
     * `frontend/cards/README.md`, "Card rendering discipline".
     */
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
        // On the card itself rather than on `ha-card`: the node detail dialog is
        // rendered beside it and draws the very same house rows, badges and
        // device names and all, so a listener inside the card body would hear
        // nothing from there.
        this.addEventListener(OPEN_SCHEDULE_EDITOR_EVENT, this._handleOpenScheduleEditor);
        this.addEventListener(WATCHED_ENTITIES_EVENT, this._handleWatchedEntities);
        this.addEventListener("show-node-detail", this._handleShowNodeDetail);
        this.addEventListener("show-device-detail", this._handleShowDeviceDetail);
        if (this._latestHass) {
            await this._loadBackendData();
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this.removeEventListener(OPEN_SCHEDULE_EDITOR_EVENT, this._handleOpenScheduleEditor);
        this.removeEventListener(WATCHED_ENTITIES_EVENT, this._handleWatchedEntities);
        this.removeEventListener("show-node-detail", this._handleShowNodeDetail);
        this.removeEventListener("show-device-detail", this._handleShowDeviceDetail);
        this._loadGeneration += 1;
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
            // The house arrow row draws one arrow in three columns; built here so
            // the row is not handed a fresh array on every render.
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
        const dialogParams = this._dialogRequest !== null
            ? this._buildDialogParams(this._dialogRequest)
            : null;

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
                    <power-flow-arrows .devices=${sourcesChildren} .historyRevision=${this._historyRevision} .maxPower=${this.config?.max_power}></power-flow-arrows>

                    <helman-tree-item-list
                        .hass=${this._hass!}
                        .devices=${consumerNode ? [consumerNode] : []}
                        .historyBuckets=${historyBuckets}
                        .historyBucketDuration=${historyBucketDuration}
                        .historyRevision=${this._historyRevision}
                        .devices_full_width=${true}
                    ></helman-tree-item-list>
                    <power-flow-arrows .devices=${consumersChildren} .historyRevision=${this._historyRevision} .maxPower=${this.config?.max_power}></power-flow-arrows>

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
                    <power-flow-arrows .devices=${houseArrowDevices} .historyRevision=${this._historyRevision} .maxPower=${this.config?.max_power}></power-flow-arrows>
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

    // 12. Private helper methods
    // A request while the dialog is open (a device name inside the house
    // detail) swaps its content in place, with no second history entry.
    private _handleShowNodeDetail = (event: Event): void => {
        event.stopPropagation();
        this._dialogRequest = (event as CustomEvent<{ nodeType: NodeType }>).detail.nodeType;
    };

    private _handleShowDeviceDetail = (event: Event): void => {
        event.stopPropagation();
        this._dialogRequest = (event as CustomEvent<{ item: TreeItem }>).detail.item;
    };

    private _closeNodeDetail(): void {
        this._dialogRequest = null;
    }

    /**
     * A badge asked for the day editor; open it on the controllable it named.
     *
     * The card has no day of its own, so the host is left to open on today —
     * which is the only day a badge is ever talking about, since it reports the
     * slot running right now.
     */
    private _handleOpenScheduleEditor = (event: Event): void => {
        event.stopPropagation();
        const detail = (event as CustomEvent<OpenScheduleEditorDetail>).detail;
        const host = this.shadowRoot?.querySelector<SchedulingDayEditorHost>(
            "scheduling-day-editor-host",
        );
        host?.openFor(detail.target);
    };

    /**
     * The editor host resolves controllable entities the device tree knows
     * nothing about — switches, climates, the EV charger's mode selects — and
     * the card filters `hass` down to what it watches. Without folding these in,
     * the editor opened from a badge would read stale states on a quiet house.
     */
    private _handleWatchedEntities = (event: Event): void => {
        const detail = (event as CustomEvent<WatchedEntitiesDetail>).detail;
        const next = new Set(detail.entityIds);
        if (next.size === this._scheduleWatchedIds.size
            && [...next].every((id) => this._scheduleWatchedIds.has(id))) {
            return;
        }

        this._scheduleWatchedIds = next;
        this._rebuildWatchedEntityIds();
    };

    private _buildDialogParams(request: NodeType | TreeItem): NodeDetailParams {
        return typeof request === "string"
            ? buildNodeDetailParams(this._buildNodeDetailContext(), request)
            : { nodeType: "device", item: request };
    }

    private _buildNodeDetailContext(): NodeDetailContext {
        const { sourcesNode, sourcesChildren, consumerNode, consumersChildren, houseNode, houseDevices } = this._computedNodes!;
        const solarNode = sourcesChildren.find((device) => device.sourceType === "solar") ?? null;
        const gridProducerNode = sourcesChildren.find((device) => device.sourceType === "grid") ?? null;
        const gridConsumerNode = consumersChildren.find((device) => device.sourceType === "grid") ?? null;
        const batteryProducerNode = sourcesChildren.find((device) => device.sourceType === "battery") ?? null;
        const batteryConsumerNode = consumersChildren.find((device) => device.sourceType === "battery") ?? null;
        const batteryConfig = (batteryProducerNode?.nodeConfig ?? batteryConsumerNode?.nodeConfig) as BatteryNodeConfig | undefined;
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
            historyRevision: this._historyRevision,
            uiConfig: this._uiConfig,
        };
    }

    private async _loadBackendData(): Promise<void> {
        const generation = ++this._loadGeneration;
        // Superseded by a later load, or the card is gone. Either way this
        // response belongs to nobody: commit none of it.
        const obsolete = () => generation !== this._loadGeneration || !this.isConnected;
        this._historyEngine?.stop();
        try {
            const store = getSharedHelmanStore(this._latestHass!);
            const treePayload = await store.getDeviceTree();
            if (obsolete()) return;
            this._uiConfig = treePayload.uiConfig;
            this._deviceTree = this._hydrateTreeItems(treePayload);
            this._sourceNodes = this._collectSourceNodes(this._deviceTree);
            this._rebuildWatchedEntityIds();

            const history = await store.getHistory();
            if (obsolete()) return;
            const histBuckets = this._uiConfig.history_buckets;
            const engine = new HistoryEngine(
                () => this._latestHass,
                histBuckets,
                () => { this._historyRevision++; },
            );
            engine.applyHistory(history, HistoryEngine.walkTree(this._deviceTree), this._sourceNodes);
            this._historyEngine = engine;
            this.requestUpdate();

            engine.start(
                this._uiConfig.history_bucket_duration,
                () => this._deviceTree,
                () => this._sourceNodes,
            );
            engine.advanceBuckets(this._deviceTree, this._sourceNodes);
        } catch (error) {
            // Logged even for an obsolete load: the guard is there to keep stale data
            // out of the card, not to hide a backend failure that raced a detach.
            console.error('Helman: failed to load backend data', error);
        }
    }

    private _hydrateItem(dto: TreeItemDTO): TreeItem {
        return hydrateItem(dto, this._uiConfig?.history_buckets ?? 60, this._localize!);
    }

    private _hydrateTreeItems(payload: TreePayload): TreeItem[] {
        const { sources, consumers, consumptionTotalSensorId, productionTotalSensorId, uiConfig } = payload;
        const historyBuckets = uiConfig.history_buckets;
        const roots: TreeItem[] = [];

        // Build id→sourceType map from source DTOs so consumer counterparts (battery, grid)
        // can inherit the same sourceType even when the backend doesn't set it on the consumer side.
        const sourceTypeByDeviceId = new Map<string, string>();
        for (const dto of sources) {
            if (dto.sourceType) sourceTypeByDeviceId.set(dto.id, dto.sourceType);
        }

        if (sources.length > 0) {
            const sourcesNode = new TreeItem("sources", this._localize!('card.sources_title'), null, null, historyBuckets);
            sourcesNode.childrenCollapsed = false;
            sourcesNode.icon = 'mdi:lightning-bolt-outline';
            sourcesNode.powerSensorId = productionTotalSensorId;
            sourcesNode.children = sources.map(dto => this._hydrateItem(dto));
            roots.push(sourcesNode);
        }

        if (consumers.length > 0) {
            const consumersNode = new TreeItem("consumers", this._localize!('card.consumers_title'), null, null, historyBuckets);
            consumersNode.hideChildren = true;
            consumersNode.hideChildrenIndicator = true;
            consumersNode.icon = 'mdi:lightning-bolt-outline';
            consumersNode.powerSensorId = consumptionTotalSensorId;
            consumersNode.children = consumers.map(dto => this._hydrateItem(dto));
            // Propagate sourceType to consumer nodes. Source counterparts (battery/grid) inherit
            // from the sourceTypeByDeviceId map; house is identified by its well-known id.
            const propagateSourceType = (items: TreeItem[]) => {
                for (const item of items) {
                    if (!item.sourceType) {
                        item.sourceType = sourceTypeByDeviceId.get(item.id)
                            ?? (item.id === 'house' ? 'house' : null);
                    }
                    propagateSourceType(item.children);
                }
            };
            propagateSourceType(consumersNode.children);
            roots.push(consumersNode);
        }

        return roots;
    }

    private _rebuildWatchedEntityIds(): void {
        const ids = new Set<string>();
        const visit = (items: TreeItem[]) => {
            for (const item of items) {
                if (item.powerSensorId) ids.add(item.powerSensorId);
                if (item.ratioSensorId) ids.add(item.ratioSensorId);
                visit(item.children);
            }
        };
        visit(this._deviceTree);

        // Also watch battery SOC/remaining-energy entities so the dialog
        // reflects live values even when no power/ratio entity changed.
        const { sourcesChildren, consumersChildren } = this._computedNodes ?? {};
        const batteryProducerNode = sourcesChildren?.find((n) => n.sourceType === "battery");
        const batteryConsumerNode = consumersChildren?.find((n) => n.sourceType === "battery");
        const batteryConfig = (batteryProducerNode?.nodeConfig ?? batteryConsumerNode?.nodeConfig) as import("./energy-node-config").BatteryNodeConfig | undefined;
        if (batteryConfig?.entities.capacity) ids.add(batteryConfig.entities.capacity);
        if (batteryConfig?.entities.remaining_energy) ids.add(batteryConfig.entities.remaining_energy);

        for (const id of this._scheduleWatchedIds) {
            ids.add(id);
        }

        this._watchedEntityIds = ids;
    }

    private _collectSourceNodes(items: TreeItem[]): TreeItem[] {
        const sourceNodes: TreeItem[] = [];
        const collect = (itemList: TreeItem[]) => {
            for (const item of itemList) {
                if (item.isSource) sourceNodes.push(item);
                if (item.children) collect(item.children);
            }
        };
        collect(items);
        return sourceNodes;
    }

}

// Register the custom card in Home Assistant
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: 'helman-card',
    name: 'House Electricity Manager Card',
    description: 'A custom card for Home Assistant to control energy nodes. It allows users to see power consumption, control devices, and manage power settings.',
    preview: true,
});
