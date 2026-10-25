import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { HomeAssistant } from "../../types/ha";
import { TreeItem } from "./data/tree-item";
import { hydrateItem } from "./data/tree-item-hydrator";
import { HistoryEngine } from "./data/history-engine";
import { getSharedHelmanStore } from "./data/store";
import { DataChangedController } from "./data/data-changed";
import type { HelmanUiConfig, InverterDetailPayload, TreePayload } from "../helman-api";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import {
    hassContextChanged,
    watchedEntityChanged,
    WATCHED_ENTITIES_EVENT,
    type WatchedEntitiesDetail,
} from "./hass-change";
import { inverterCellEntityIds } from "../helman-simple/inverter-cell";
import {
    OPEN_SCHEDULE_EDITOR_EVENT,
    type OpenScheduleEditorDetail,
    type SchedulingDayEditorHost,
} from "./schedule/dialogs/scheduling-day-editor-host";
import {
    NODE_DETAIL_REQUEST_EVENT,
    type NodeDetailParams,
    type NodeDetailRequestDetail,
    type NodeDetailSection,
    type NodeDetailSectionRequest,
    type NodeDetailTarget,
    type NodeType,
} from "../node-detail/node-detail-types";
import { buildNodeDetailContext, buildNodeDetailParams } from "../node-detail/node-detail-params-builder";
import {
    readEnergyReadings,
    resolveEnergyNodes,
    type EnergyNodes,
    type EnergyReadings,
} from "../node-detail/node-detail-readings";

export type WhichNodesToWalk = (tree: TreeItem[], energyNodes: EnergyNodes) => Iterable<TreeItem>;

export interface EnergyCardHostOptions {
    whichNodesToWalk: WhichNodesToWalk;
}

export class EnergyCardHost implements ReactiveController {
    public readonly host: ReactiveControllerHost & HTMLElement;
    private readonly _options: EnergyCardHostOptions;

    private _latestHass?: HomeAssistant;
    private _hass?: HomeAssistant;
    private _deviceTree: TreeItem[] = [];
    private _sourceNodes: TreeItem[] = [];
    private _energyNodes: EnergyNodes = {};
    private _readings: EnergyReadings | null = null;
    private _uiConfig: HelmanUiConfig | null = null;
    private _historyEngine?: HistoryEngine;
    private _historyRevision = 0;
    private _watchedEntityIds: ReadonlySet<string> = new Set();
    private _watchSources: Map<string, Set<string>> = new Map();
    private _localize?: LocalizeFunction;
    private _localizeLanguage?: string;
    private _dialogRequest: NodeDetailTarget | null = null;
    /** The tab the open detail was asked for: a new object per request, kept across a tree refresh. */
    private _dialogSectionRequest?: NodeDetailSectionRequest;
    private _loadGeneration = 0;
    private _inverterGeneration = 0;

    constructor(host: ReactiveControllerHost & HTMLElement, options: EnergyCardHostOptions) {
        this.host = host;
        this._options = options;
        this.host.addController(this);
        new DataChangedController(
            this.host,
            () => this._latestHass,
            { kinds: ["config"] },
            () => void this.loadBackendData(true),
        );
    }

    public hostConnected(): void {
        this.host.addEventListener(OPEN_SCHEDULE_EDITOR_EVENT, this._handleOpenScheduleEditor);
        this.host.addEventListener(WATCHED_ENTITIES_EVENT, this._handleWatchedEntities);
        this.host.addEventListener("show-node-detail", this._handleShowNodeDetail);
        this.host.addEventListener("show-device-detail", this._handleShowDeviceDetail);
        this.host.addEventListener(NODE_DETAIL_REQUEST_EVENT, this._handleNodeDetailRequest);

        if (this._latestHass) {
            void this.loadBackendData();
        }
    }

    public hostDisconnected(): void {
        this.host.removeEventListener(OPEN_SCHEDULE_EDITOR_EVENT, this._handleOpenScheduleEditor);
        this.host.removeEventListener(WATCHED_ENTITIES_EVENT, this._handleWatchedEntities);
        this.host.removeEventListener("show-node-detail", this._handleShowNodeDetail);
        this.host.removeEventListener("show-device-detail", this._handleShowDeviceDetail);
        this.host.removeEventListener(NODE_DETAIL_REQUEST_EVENT, this._handleNodeDetailRequest);

        this._loadGeneration += 1;
        this._inverterGeneration += 1;
        this._historyEngine?.stop();
    }

    // Getters
    public get latestHass(): HomeAssistant | undefined { return this._latestHass; }
    public get hass(): HomeAssistant | undefined { return this._hass; }
    public get deviceTree(): TreeItem[] { return this._deviceTree; }
    public get sourceNodes(): TreeItem[] { return this._sourceNodes; }
    public get energyNodes(): EnergyNodes { return this._energyNodes; }
    public get readings(): EnergyReadings | null { return this._readings; }
    public get uiConfig(): HelmanUiConfig | null { return this._uiConfig; }
    public get inverter(): InverterDetailPayload | null { return this._energyNodes.inverter ?? null; }
    public get historyEngine(): HistoryEngine | undefined { return this._historyEngine; }
    public get historyRevision(): number { return this._historyRevision; }
    public get watchedEntityIds(): ReadonlySet<string> { return this._watchedEntityIds; }
    public get localize(): LocalizeFunction | undefined { return this._localize; }
    public get dialogRequest(): NodeDetailTarget | null { return this._dialogRequest; }
    /** Whether a load has succeeded; a later refresh keeps the card on what it has. */
    public get loaded(): boolean { return this._historyEngine !== undefined; }

    /** Built from the stored readings; reading state here would assign it during render. */
    public get dialogParams(): NodeDetailParams | null {
        if (this._dialogRequest === null || this._readings === null || this._uiConfig === null) return null;
        const context = buildNodeDetailContext(this._readings, {
            houseNode: this._energyNodes.houseNode,
            gridPowerEntityId: this._energyNodes.gridProducerNode?.powerSensorId ?? this._energyNodes.gridConsumerNode?.powerSensorId ?? null,
            historyBuckets: this._uiConfig.history_buckets,
            historyBucketDuration: this._uiConfig.history_bucket_duration,
        });
        return buildNodeDetailParams(context, this._dialogRequest, this._dialogSectionRequest);
    }

    public setHass(hass: HomeAssistant): void {
        const previous = this._latestHass;
        this._latestHass = hass;

        const language = hass.locale?.language ?? hass.language;
        const languageChanged = language !== this._localizeLanguage;
        if (languageChanged || !this._localize) {
            this._localizeLanguage = language;
            this._localize = getLocalizeFunction({ ...hass, language });
            if (languageChanged && this._deviceTree.length > 0) {
                for (const root of this._deviceTree) {
                    if (root.id === "sources") root.name = this._localize("card.sources_title");
                    if (root.id === "consumers") root.name = this._localize("card.consumers_title");
                }
                for (const item of HistoryEngine.walkTree(this._deviceTree)) {
                    if (item.isUnmeasured) item.name = this._localize("house_section.unmeasured");
                }
                this._deviceTree = [...this._deviceTree];
            }
        }

        // The first hass on a connected card loads it; after that only a
        // reconnect or a config event does, never a hass push.
        if (!previous && this.host.isConnected) {
            void this.loadBackendData();
        }

        if (!previous || languageChanged || this._watchedEntityIds.size === 0) {
            this._hass = hass;
            this._updateReadings();
            this.host.requestUpdate();
            return;
        }

        if (hassContextChanged(previous, hass) || watchedEntityChanged(previous, hass, this._watchedEntityIds)) {
            this._hass = hass;
            this._updateReadings();
            this.host.requestUpdate();
        }
    }

    /**
     * Show a node's detail: on its Overview, or on the tab asked for. An open
     * detail swaps its target in place; asking for the same node again still
     * selects the tab asked for.
     */
    public openNode(request: NodeDetailTarget, section?: NodeDetailSection): void {
        this._dialogSectionRequest = section ? { section } : undefined;
        // The same node again keeps the readings its open detail announced.
        if (request !== this._dialogRequest) {
            this._dialogRequest = request;
            this._forgetNodeDetailSources();
            this._rebuildWatchedEntityIds();
        }
        this._adoptLatestHass();
        this.host.requestUpdate();
    }

    public closeDialog(): void {
        this._dialogRequest = null;
        this._forgetNodeDetailSources();
        this._rebuildWatchedEntityIds();
        this._adoptLatestHass();
        this.host.requestUpdate();
    }

    public async loadBackendData(freshTree = false, retryInitial = true): Promise<boolean> {
        const generation = ++this._loadGeneration;
        const obsolete = () => generation !== this._loadGeneration || !this.host.isConnected;
        try {
            const store = getSharedHelmanStore(this._latestHass!);
            const treePayload = await store.getDeviceTree({ fresh: freshTree });
            if (obsolete()) return false;
            const history = await store.getHistory({ fresh: freshTree });
            if (obsolete()) return false;

            if (!this._localize && this._latestHass) {
                this._localize = getLocalizeFunction(this._latestHass);
            }

            const deviceTree = this._hydrateTreeItems(treePayload);
            const sourceNodes = this._collectSourceNodes(deviceTree);
            const engine = new HistoryEngine(
                () => this._latestHass,
                treePayload.uiConfig.history_buckets,
                () => {
                    this._historyRevision++;
                    this.host.requestUpdate();
                },
            );
            engine.applyHistory(history, HistoryEngine.walkTree(deviceTree), sourceNodes);

            this._historyEngine?.stop();
            this._uiConfig = treePayload.uiConfig;
            this._deviceTree = deviceTree;
            this._sourceNodes = sourceNodes;
            this._energyNodes = { ...resolveEnergyNodes(deviceTree), inverter: this._energyNodes.inverter };

            if (this._dialogRequest instanceof TreeItem) {
                const old = this._dialogRequest;
                this._dialogRequest = HistoryEngine.walkTree(this._deviceTree)
                    .find((item) => item.id === old.id && item.isSource === old.isSource) ?? null;
                this._watchSources.delete("node-detail");
            }

            this._historyEngine = engine;
            this._adoptLatestHass();
            this._rebuildWatchedEntityIds();

            engine.start(
                this._uiConfig.history_bucket_duration,
                () => this._deviceTree,
                () => this._sourceNodes,
            );
            engine.advanceBuckets(this._deviceTree, this._sourceNodes);

            const inverterGeneration = ++this._inverterGeneration;
            void this._loadInverter(
                () => inverterGeneration !== this._inverterGeneration || !this.host.isConnected,
                freshTree,
            );

            this.host.requestUpdate();
            return true;
        } catch (error) {
            console.error("Helman: failed to load backend data", error);
            if (!obsolete() && freshTree && retryInitial && !this._historyEngine) {
                void this.loadBackendData(true, false);
            }
            return false;
        }
    }

    private async _loadInverter(obsolete: () => boolean, fresh: boolean): Promise<void> {
        try {
            const payload = await getSharedHelmanStore(this._latestHass!)
                .getNodeDetail<InverterDetailPayload>({ node: "inverter" }, { fresh });
            if (obsolete()) return;
            this._energyNodes = { ...this._energyNodes, inverter: payload };
            this._rebuildWatchedEntityIds();
            this._adoptLatestHass();
            this.host.requestUpdate();
        } catch (err) {
            if (!obsolete()) console.error("Helman: failed to load the inverter overview", err);
        }
    }

    /** Drop what the open detail announced: its readings and every Control tab block's. */
    private _forgetNodeDetailSources(): void {
        for (const source of [...this._watchSources.keys()]) {
            if (source === "node-detail" || source.startsWith("node-detail:")) this._watchSources.delete(source);
        }
    }

    private _rebuildWatchedEntityIds(): void {
        const ids = new Set<string>();

        const nodesToWalk = this._options.whichNodesToWalk(this._deviceTree, this._energyNodes);
        const visit = (items: Iterable<TreeItem>) => {
            for (const item of items) {
                if (item.powerSensorId) ids.add(item.powerSensorId);
                if (item.ratioSensorId) ids.add(item.ratioSensorId);
                if (item.children) visit(item.children);
            }
        };
        visit(nodesToWalk);

        const batteryNode = this._energyNodes.batteryProducerNode ?? this._energyNodes.batteryConsumerNode;
        for (const id of [batteryNode?.socEntityId, batteryNode?.minSocEntityId, batteryNode?.remainingEnergyEntityId]) {
            if (id) ids.add(id);
        }

        for (const id of inverterCellEntityIds(this.inverter)) ids.add(id);

        for (const sourceSet of this._watchSources.values()) {
            for (const id of sourceSet) ids.add(id);
        }

        this._watchedEntityIds = ids;
    }

    private _updateReadings(): void {
        const hass = this._hass ?? this._latestHass;
        if (!hass) return;
        this._readings = readEnergyReadings(hass, this._energyNodes);
    }

    /** Hands the latest hass down, and the readings with it. */
    private _adoptLatestHass(): void {
        if (!this._latestHass) return;
        this._hass = this._latestHass;
        this._updateReadings();
    }

    private _hydrateTreeItems(payload: TreePayload): TreeItem[] {
        const { sources, consumers, consumptionTotalSensorId, productionTotalSensorId, uiConfig } = payload;
        const historyBuckets = uiConfig.history_buckets;
        const roots: TreeItem[] = [];

        const sourceTypeByDeviceId = new Map<string, string>();
        for (const dto of sources) {
            if (dto.sourceType) sourceTypeByDeviceId.set(dto.id, dto.sourceType);
        }

        const localize = this._localize ?? ((k: string) => k);

        if (sources.length > 0) {
            const sourcesNode = new TreeItem("sources", localize("card.sources_title"), null, null, historyBuckets);
            sourcesNode.childrenCollapsed = false;
            sourcesNode.icon = "mdi:lightning-bolt-outline";
            sourcesNode.powerSensorId = productionTotalSensorId;
            sourcesNode.children = sources.map((dto) => hydrateItem(dto, historyBuckets, localize));
            roots.push(sourcesNode);
        }

        if (consumers.length > 0) {
            const consumersNode = new TreeItem("consumers", localize("card.consumers_title"), null, null, historyBuckets);
            consumersNode.hideChildren = true;
            consumersNode.hideChildrenIndicator = true;
            consumersNode.icon = "mdi:lightning-bolt-outline";
            consumersNode.powerSensorId = consumptionTotalSensorId;
            consumersNode.children = consumers.map((dto) => hydrateItem(dto, historyBuckets, localize));
            const propagateSourceType = (items: TreeItem[]) => {
                for (const item of items) {
                    if (!item.sourceType) {
                        item.sourceType = sourceTypeByDeviceId.get(item.id)
                            ?? (item.id === "house" ? "house" : null);
                    }
                    propagateSourceType(item.children);
                }
            };
            propagateSourceType(consumersNode.children);
            roots.push(consumersNode);
        }

        return roots;
    }

    private _collectSourceNodes(items: TreeItem[]): TreeItem[] {
        const sourceNodes: TreeItem[] = [];
        const collect = (itemList: TreeItem[]) => {
            for (const item of itemList) {
                if (item.isSource) sourceNodes.push(item);
                collect(item.children);
            }
        };
        collect(items);
        return sourceNodes;
    }

    private _handleWatchedEntities = (event: Event): void => {
        const detail = (event as CustomEvent<WatchedEntitiesDetail>).detail;
        if (!detail) return;
        const source = detail.source;
        const incoming = new Set((detail.entityIds ?? []).filter((id): id is string => !!id));
        const current = this._watchSources.get(source);

        if (!current && incoming.size === 0) {
            return;
        }

        if (current && incoming.size === current.size && [...incoming].every((id) => current.has(id))) {
            return;
        }

        if (incoming.size === 0) {
            this._watchSources.delete(source);
        } else {
            this._watchSources.set(source, incoming);
        }

        this._rebuildWatchedEntityIds();
        this._adoptLatestHass();
        this.host.requestUpdate();
    };

    private _handleOpenScheduleEditor = (event: Event): void => {
        event.stopPropagation();
        const detail = (event as CustomEvent<OpenScheduleEditorDetail>).detail;
        const host = this.host.shadowRoot?.querySelector<SchedulingDayEditorHost>(
            "scheduling-day-editor-host",
        );
        host?.openFor(detail.target);
    };

    private _handleShowNodeDetail = (event: Event): void => {
        event.stopPropagation();
        const nodeType = (event as CustomEvent<{ nodeType: NodeType }>).detail.nodeType;
        this.openNode(nodeType);
    };

    private _handleShowDeviceDetail = (event: Event): void => {
        event.stopPropagation();
        const item = (event as CustomEvent<{ item: TreeItem }>).detail.item;
        this.openNode(item);
    };

    private _handleNodeDetailRequest = (event: Event): void => {
        event.stopPropagation();
        const { target, section } = (event as CustomEvent<NodeDetailRequestDetail>).detail;
        this.openNode(target, section);
    };
}
