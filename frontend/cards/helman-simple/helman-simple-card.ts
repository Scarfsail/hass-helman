import { LitElement, css, html, svg } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant, LovelaceCard } from "../../types/ha";
import { HelmanSimpleCardConfig } from "./HelmanSimpleCardConfig";
import { getLocalizeFunction, LocalizeFunction } from "../localize/localize";
import { ValueType, TreeItemDTO, TreePayload, HelmanUiConfig, InverterDetailPayload, applyValueType } from "../helman-api";
import { HistoryEngine } from "../helman/history-engine";
import { getSharedHelmanStore } from "../helman/store";
import { getSharedDataChangedFeed } from "../helman/data-changed";
import { TreeItem } from "../helman/tree-item";
import { hydrateItem } from "../helman/tree-item-hydrator";
import type { NodeType } from "./node-detail/node-detail-types";
import {
    buildNodeDetailParams,
    type NodeDetailContext,
} from "./node-detail/node-detail-params-builder";
import "./node-detail-dialog";
import { inverterCellEntityIds } from "./inverter-cell";
import "../shared/schedule/dialogs/scheduling-day-editor-host";
import {
    OPEN_SCHEDULE_EDITOR_EVENT,
    type OpenScheduleEditorDetail,
    type SchedulingDayEditorHost,
} from "../shared/schedule/dialogs/scheduling-day-editor-host";
import "./simple-card-solar";
import "./simple-card-battery";
import "./simple-card-grid";
import "./simple-card-house";
import { computeDominantSourceColorCached } from "../color-utils";
import { getFlowColor, getFlowGlow } from "./flow-colors";
import { DEFAULT_SOLAR_MAX_W, IDLE_W, liveFlows, type LiveFlows } from "./live-flows";
import { readingNumber } from "./node-detail/node-detail-readings";
import { powerUnitFactor, readPowerW } from "../shared/power-reading";
import { WATCHED_ENTITIES_EVENT, type WatchedEntitiesDetail } from "../shared/hass-change";

// ──────────────────────────────── Internal model ──────────────────────────────

interface EnergyEntityMap {
    solarPowerEntityId:   string | null;
    solarValueType:       ValueType;
    gridPowerEntityId:    string | null;
    gridValueType:        ValueType;
    batteryPowerEntityId: string | null;
    /**
     * Whether the battery sensor reads backwards from the house convention.
     *
     * Not a ValueType, because this card needs battery power *signed* —
     * `battCharge`/`battDischarge` read its sign — where `applyValueType`
     * returns an unsigned magnitude. The battery source node is `negative`
     * upright and `positive` when `power_polarity` inverts it, which is what
     * this reads off.
     */
    batteryInverted:      boolean;
    batterySocEntityId:   string | null;
    batteryMinSocEntityId:string | null;
    housePowerEntityId:   string | null;
    houseValueType:       ValueType;
    solarMaxPower:        number;
    gridMaxPower:         number;
    batteryMaxPower:      number;
}

interface EnergyValues {
    solarPower:   number;
    /** `solarPower`, `null` without a reading rather than 0. */
    solarPowerReading: number | null;
    gridPower:    number;
    /**
     * The grid meter signed import-positive, export-negative. `gridPower` keeps
     * only the source side (a `positive` grid node clamps export to zero) and
     * the card derives export from the balance; the grid detail reports the meter.
     */
    gridPowerSigned: number | null;
    batteryPower: number;
    /** The battery meter, positive charging; `null` without a reading, never 0. */
    batteryPowerReading: number | null;
    batterySoc:   number;
    batteryMinSoc:number;
    housePower:   number;
    /** Whether the house meter has a reading; `housePower` is 0 without one. */
    houseReadable: boolean;
}

const EMPTY_ENERGY: EnergyValues = {
    solarPower: 0, solarPowerReading: null, gridPower: 0, gridPowerSigned: null, batteryPower: 0, batteryPowerReading: null,
    batterySoc: 0, batteryMinSoc: 10,
    housePower: 0, houseReadable: false,
};

// ──────────────────────────────────── Card ────────────────────────────────────

@customElement("helman-simple-card")
export class HelmanSimpleCard extends LitElement implements LovelaceCard {

    // 1. Static HA configuration methods
    public static async getStubConfig(_hass: HomeAssistant): Promise<Partial<HelmanSimpleCardConfig>> {
        return { type: "custom:helman-simple-card" };
    }

    public static getConfigForm() {
        return {
            schema: [
                {
                    name: "width",
                    selector: { number: { min: 100, max: 800, step: 10, mode: "box", unit_of_measurement: "px" } },
                },
                {
                    name: "height",
                    selector: { number: { min: 100, max: 800, step: 10, mode: "box", unit_of_measurement: "px" } },
                },
                {
                    name: "transparent_background",
                    selector: { boolean: {} },
                },
            ],
        };
    }

    // 2. Static styles
    static styles = css`
        :host { display: block; }
        ha-card { overflow: hidden; }
        ha-card.transparent {
            background: transparent;
            box-shadow: none;
            border: none;
        }
        .card-content {
            padding: 8px;
            max-width: 850px;
            margin: 0 auto;
            box-sizing: border-box;
        }

        /* 3×3 CSS grid: node | connector | node */
        .energy-grid {
            display: grid;
            grid-template-columns: 1fr 20px 1fr;
            grid-template-rows: auto 28px auto;
            align-items: center;
            justify-items: center;
            margin: 0 auto;
            width: 200px;
            position: relative;
        }
        .node-cell {
            width: 100%;
            display: flex;
            justify-content: center;
            padding: 2px 0;
            cursor: pointer;
        }
        .connector-h,
        .connector-v {
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .connector-h { width: 100%; height: 12px; flex-direction: row; }
        .connector-v { width: 20px; height: 100%; flex-direction: column; align-self: stretch; justify-content: center; }

        /* SVG flow overlay (all flows use this) */
        .diagonal-overlay {
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            pointer-events: none;
            overflow: visible;
        }
        @keyframes flow-diagonal {
            0%   { stroke-dashoffset: 0; }
            100% { stroke-dashoffset: -18; }
        }

        /* The inverter sits where the flows cross: drawn over them, kept small. */
        .center-cell {
            position: relative;
            width: 100%;
            height: 100%;
        }
        helman-inverter-cell {
            position: absolute;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
            z-index: 2;
        }

        .loading {
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 40px;
            color: var(--secondary-text-color);
            font-size: 0.9rem;
        }
    `;

    // 3. Private properties
    private _config!: HelmanSimpleCardConfig;
    private _entityMap: EnergyEntityMap | null = null;
    private _localize?: LocalizeFunction;
    private _localizeLanguage?: string;
    private _unsubscribeDataChanged?: () => void;
    private _latestHass?: HomeAssistant;
    private _watchedEntityIds: Set<string> = new Set();
    private _scheduleWatchedIds: Set<string> = new Set();
    /** The readings the open node detail announced it reads live. */
    private _detailEntityIds: string[] = [];
    private _solarDTO:           TreeItemDTO | null = null;
    private _gridDTO:            TreeItemDTO | null = null;
    private _batteryDTO:         TreeItemDTO | null = null;
    private _houseDTO:           TreeItemDTO | null = null;
    private _batteryConsumerDTO: TreeItemDTO | null = null;
    private _gridConsumerDTO:    TreeItemDTO | null = null;
    private _solarNode:          TreeItem | null = null;
    private _gridProducerNode:   TreeItem | null = null;
    private _batteryProducerNode: TreeItem | null = null;
    private _batteryConsumerNode: TreeItem | null = null;
    private _gridConsumerNode:   TreeItem | null = null;
    private _houseNode:          TreeItem | null = null;
    private _productionNode:     TreeItem | null = null;
    private _consumptionNode:    TreeItem | null = null;
    private _historyEngine?: HistoryEngine;
    /**
     * Bumped on every disconnect and on every load that replaces another. A load
     * that resolves after its generation was superseded commits nothing: the card
     * may already be detached, and installing a `HistoryEngine` on it would start
     * an interval nothing ever stops (#232).
     */
    private _loadGeneration = 0;
    private _uiConfig?: HelmanUiConfig;
    private _flowColors?: { solar: string; grid: string; battery: string };
    private _flowGlows?:  { solar: string; grid: string; battery: string };

    // 5. State properties
    /**
     * Bumped once per history tick, exactly as `helman-card._historyRevision` is.
     * The simple card draws no bars itself, but its node-detail panels draw the
     * card's rows off the buffers `HistoryEngine` mutates in place, and a bare
     * `requestUpdate()` is not a signal those rows can dirty-check against.
     */
    @state() private _historyRevision = 0;
    @state() private _hass?: HomeAssistant;
    @state() private _energy: EnergyValues = EMPTY_ENERGY;
    @state() private _loading = true;
    /** What the node detail dialog shows: a top-level node by type, or one device. */
    @state() private _dialogRequest: NodeType | TreeItem | null = null;
    /** The inverter overview behind the centre cell; `null` until loaded, or when it failed. */
    @state() private _inverter: InverterDetailPayload | null = null;

    // 7. HA-specific property setter
    public set hass(hass: HomeAssistant) {
        const previous = this._latestHass;
        this._latestHass = hass;
        const language = hass.locale?.language ?? hass.language;
        const languageChanged = language !== this._localizeLanguage;
        if (languageChanged || !this._localize) {
            this._localizeLanguage = language;
            this._localize = getLocalizeFunction({ ...hass, language });
            if (languageChanged) {
                for (const item of HistoryEngine.walkTree(this._topLevelNodes())) {
                    if (item.isUnmeasured) item.name = this._localize("house_section.unmeasured");
                }
            }
        }

        if (!previous || languageChanged || this._watchedEntityIds.size === 0) {
            this._hass = hass;
            if (this._entityMap) this._energy = this._readEnergyValues(hass, this._entityMap);
            return;
        }
        for (const id of this._watchedEntityIds) {
            if (previous.states[id] !== hass.states[id]) {
                this._hass = hass;
                if (this._entityMap) this._energy = this._readEnergyValues(hass, this._entityMap);
                return;
            }
        }
    }

    // 8. HA-specific methods
    getCardSize() { return 4; }

    setConfig(config: HelmanSimpleCardConfig) {
        this._config = { ...config };
    }

    // 9. Lifecycle methods
    async connectedCallback() {
        super.connectedCallback();
        // The house detail dialog draws the same consumer boxes the power card
        // does, badges and all, and a badge is a request nobody else here would
        // answer — so this card hosts the editor too rather than leaving a
        // control that does nothing.
        this.addEventListener(OPEN_SCHEDULE_EDITOR_EVENT, this._handleOpenScheduleEditor);
        this.addEventListener(WATCHED_ENTITIES_EVENT, this._handleWatchedEntities);
        // A device name in the house detail swaps the open dialog to that device.
        this.addEventListener("show-device-detail", this._handleShowDeviceDetail);
        if (this._latestHass) {
            this._unsubscribeDataChanged = getSharedDataChangedFeed(this._latestHass).subscribe((kinds) => {
                if (kinds.has("config")) void this._loadFromBackend(true);
            });
            await this._loadFromBackend();
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this.removeEventListener(OPEN_SCHEDULE_EDITOR_EVENT, this._handleOpenScheduleEditor);
        this.removeEventListener(WATCHED_ENTITIES_EVENT, this._handleWatchedEntities);
        this.removeEventListener("show-device-detail", this._handleShowDeviceDetail);
        this._unsubscribeDataChanged?.();
        this._unsubscribeDataChanged = undefined;
        this._loadGeneration += 1;
        this._historyEngine?.stop();
    }

    willUpdate(changedProperties: Map<string | symbol, unknown>) {
        super.willUpdate(changedProperties);
        if (!this._flowColors || changedProperties.has('_uiConfig') || changedProperties.has('_config')) {
            const solar   = getFlowColor("solar");
            const grid    = getFlowColor("grid");
            const battery = getFlowColor("battery");
            this._flowColors = { solar, grid, battery };
            this._flowGlows  = {
                solar:   getFlowGlow(solar),
                grid:    getFlowGlow(grid),
                battery: getFlowGlow(battery),
            };
        }
    }

    // 10. Render method
    render() {
        if (this._loading || !this._entityMap) {
            return html`<ha-card class=${this._config?.transparent_background ? "transparent" : ""}><div class="loading">${this._localize?.('card.loading') ?? 'Loading energy data…'}</div></ha-card>`;
        }

        const { solarPower, housePower, batteryPower,
                batterySoc, batteryMinSoc } = this._energy;

        // One activation threshold for every flow, as the details read it.
        const battCharge    = batteryPower > IDLE_W;
        const flows = liveFlows(this._energy);
        const effectiveGridPower = flows.gridPower;

        const em = this._entityMap;
        // Stroke width scales linearly from 1.5 to 12 px based on the power ratio; minimum ensures visibility.
        const edgeList = [
            { key: "solarToGrid", max: em.solarMaxPower },
            { key: "solarToHouse", max: em.solarMaxPower },
            { key: "solarToBattery", max: em.solarMaxPower },
            { key: "gridToBattery", max: em.gridMaxPower },
            { key: "gridToHouse", max: em.gridMaxPower },
            { key: "batteryToHouse", max: em.batteryMaxPower },
            { key: "batteryToGrid", max: em.batteryMaxPower },
        ] as const;
        const edge = (key: typeof edgeList[number]["key"]) => {
            const power = flows[key];
            const max = edgeList.find((entry) => entry.key === key)!.max;
            return { active: power > 0, width: Math.max(1.5, Math.min(power / max, 1) * 12) };
        };

        const solarFlowColor   = this._flowColors!.solar;
        const gridFlowColor    = this._flowColors!.grid;
        const batteryFlowColor = this._flowColors!.battery;

        // ── Source colors for consumer components ──────────────────────────────
        // Battery charge color: derived from live power flows to avoid backend color discrepancies
        const battSourceColor  = battCharge
            ? (flows.solarToBattery >= flows.gridToBattery ? solarFlowColor : gridFlowColor)
            : undefined;
        const gridSourceColor  = this._gridConsumerNode    ? computeDominantSourceColorCached(this._gridConsumerNode)    : undefined;
        const houseSourceColor = this._houseNode           ? computeDominantSourceColorCached(this._houseNode)           : undefined;

        const gridStyle = this._buildGridStyle();

        return html`
            <ha-card class=${this._config?.transparent_background ? "transparent" : ""}>
                <div class="card-content">
                    <div class="energy-grid" style=${gridStyle}>

                        <!-- ── Row 1: Solar  ─── connector ─── Grid ── -->
                        <div class="node-cell" @click=${() => this._openNode("solar")}>
                            <simple-card-solar .power=${solarPower}></simple-card-solar>
                        </div>
                        <div class="connector-h">
                            ${edge("solarToGrid").active ? this._flowH(solarFlowColor, this._flowGlows!.solar, false, edge("solarToGrid").width, 22.5, 33) : ""}
                        </div>
                        <div class="node-cell" @click=${() => this._openNode("grid")}>
                            <simple-card-grid .power=${effectiveGridPower} .sourceColor=${gridSourceColor}></simple-card-grid>
                        </div>

                        <!-- ── Row 2: vertical connectors ── -->
                        <div class="connector-v">
                            ${edge("solarToHouse").active ? this._flowV(solarFlowColor, this._flowGlows!.solar, false, edge("solarToHouse").width) : ""}
                        </div>
                        <div class="center-cell">
                            <helman-inverter-cell
                                .hass=${this._hass}
                                .localize=${this._localize}
                                .inverter=${this._inverter}
                                @show-node-detail=${(event: Event) => { event.stopPropagation(); this._openNode("inverter"); }}
                            ></helman-inverter-cell>
                        </div>
                        <div class="connector-v">
                            ${edge("gridToBattery").active ? this._flowV(gridFlowColor, this._flowGlows!.grid, false, edge("gridToBattery").width) : ""}
                            ${edge("batteryToGrid").active ? this._flowV(batteryFlowColor, this._flowGlows!.battery, true, edge("batteryToGrid").width) : ""}
                        </div>

                        <!-- ── Row 3: House ─── connector ─── Battery ── -->
                        <div class="node-cell" @click=${() => this._openNode("house")}>
                            <simple-card-house .power=${housePower} .sourceColor=${houseSourceColor}></simple-card-house>
                        </div>
                        <div class="connector-h"></div>
                        <div class="node-cell" @click=${() => this._openNode("battery")}>
                            <simple-card-battery
                                .power=${batteryPower}
                                .soc=${batterySoc}
                                .minSoc=${batteryMinSoc}
                                .sourceColor=${battSourceColor}
                            ></simple-card-battery>
                        </div>

                        ${this._renderFlowOverlay(edge("solarToBattery"), edge("gridToHouse"), edge("batteryToHouse"))}

                    </div>
                </div>
            </ha-card>
            ${this._dialogRequest !== null ? html`
                <node-detail-dialog
                    .hass=${this._hass!}
                    .localize=${this._localize!}
                    .open=${true}
                    .params=${buildNodeDetailParams(this._buildNodeDetailContext(flows), this._dialogRequest)}
                    @closed=${() => { this._dialogRequest = null; this._detailEntityIds = []; this._rebuildWatchedEntityIds(); }}
                    @helman-watch-entities=${this._onDetailWatch}
                ></node-detail-dialog>
            ` : ''}
            <scheduling-day-editor-host
                .hass=${this._hass}
                .timeZone=${this._hass?.config?.time_zone || "UTC"}
            ></scheduling-day-editor-host>
        `;
    }

    // 12. Private helper methods

    private _openNode(node: NodeType): void {
        this._dialogRequest = node;
        this._detailEntityIds = [];
        this._rebuildWatchedEntityIds();
    }

    /** The open detail's own readings: watched while it is open, the latest handed down now. */
    private _onDetailWatch = (event: CustomEvent<string[]>): void => {
        event.stopPropagation();
        this._detailEntityIds = event.detail;
        this._rebuildWatchedEntityIds();
        if (this._latestHass) this._hass = this._latestHass;
    };

    /** The inverter overview, after the card has drawn: a failure only leaves the cell out. */
    private async _loadInverter(obsolete: () => boolean, fresh: boolean): Promise<void> {
        try {
            const payload = await getSharedHelmanStore(this._latestHass!)
                .getNodeDetail<InverterDetailPayload>({ node: "inverter" }, { fresh });
            if (obsolete()) return;
            this._inverter = payload;
            this._rebuildWatchedEntityIds();
            this._hass = this._latestHass;
        } catch (err) {
            if (!obsolete()) console.error("helman-simple-card: failed to load the inverter overview", err);
        }
    }

    private _handleOpenScheduleEditor = (event: Event): void => {
        event.stopPropagation();
        const detail = (event as CustomEvent<OpenScheduleEditorDetail>).detail;
        this.shadowRoot
            ?.querySelector<SchedulingDayEditorHost>("scheduling-day-editor-host")
            ?.openFor(detail.target);
    };

    private _handleWatchedEntities = (event: Event): void => {
        const next = new Set((event as CustomEvent<WatchedEntitiesDetail>).detail.entityIds);
        if (next.size === this._scheduleWatchedIds.size
            && [...next].every((id) => this._scheduleWatchedIds.has(id))) return;
        this._scheduleWatchedIds = next;
        this._rebuildWatchedEntityIds();
        if (this._latestHass) this._hass = this._latestHass;
    };

    private _rebuildWatchedEntityIds(): void {
        const ids = new Set<string>();
        if (this._entityMap) {
            for (const v of Object.values(this._entityMap)) {
                if (typeof v === 'string' && v.length > 0) ids.add(v);
            }
        }
        const addNode = (n: TreeItem | null | undefined) => {
            if (!n) return;
            if (n.powerSensorId) ids.add(n.powerSensorId);
            if (n.ratioSensorId) ids.add(n.ratioSensorId);
            for (const c of n.children) addNode(c);
        };
        addNode(this._solarNode);
        addNode(this._gridProducerNode);
        addNode(this._batteryProducerNode);
        addNode(this._batteryConsumerNode);
        addNode(this._gridConsumerNode);
        addNode(this._houseNode);
        for (const id of this._detailEntityIds) ids.add(id);
        for (const id of this._scheduleWatchedIds) ids.add(id);
        // The centre cell's mode and link cue.
        for (const id of inverterCellEntityIds(this._inverter)) ids.add(id);
        this._watchedEntityIds = ids;
    }

    private _buildGridStyle(): string {
        const w = this._config?.width;
        const h = this._config?.height;
        const parts: string[] = [];
        if (w !== undefined) parts.push(`width: ${w}px`);
        if (h !== undefined) parts.push(`height: ${h}px`, `grid-template-rows: 1fr 28px 1fr`);
        return parts.join("; ");
    }

    private async _loadFromBackend(freshTree = false, retryInitial = true): Promise<boolean> {
        const generation = ++this._loadGeneration;
        // Superseded by a later load, or the card is gone. Either way this
        // response belongs to nobody: commit none of it.
        const obsolete = () => generation !== this._loadGeneration || !this.isConnected;
        try {
            const store = getSharedHelmanStore(this._latestHass!);
            const payload = await store.getDeviceTree({ fresh: freshTree });
            if (obsolete()) return false;
            const history = await store.getHistory({ fresh: freshTree });
            if (obsolete()) return false;
            const entityMap = this._buildEntityMap(payload);
            const energy = this._readEnergyValues(this._latestHass!, entityMap);
            const histBuckets = payload.uiConfig.history_buckets;
            const solarNode           = this._solarDTO           ? this._hydrateItem(this._solarDTO,           histBuckets) : null;
            const gridProducerNode    = this._gridDTO            ? this._hydrateItem(this._gridDTO,            histBuckets) : null;
            const batteryProducerNode = this._batteryDTO         ? this._hydrateItem(this._batteryDTO,         histBuckets) : null;
            const batteryConsumerNode = this._batteryConsumerDTO ? this._hydrateItem(this._batteryConsumerDTO, histBuckets) : null;
            const gridConsumerNode    = this._gridConsumerDTO    ? this._hydrateItem(this._gridConsumerDTO,    histBuckets) : null;

            // Consumer-side DTOs don't carry sourceType — propagate from the matching source node
            if (batteryConsumerNode && !batteryConsumerNode.sourceType)
                batteryConsumerNode.sourceType = batteryProducerNode?.sourceType;
            if (gridConsumerNode && !gridConsumerNode.sourceType)
                gridConsumerNode.sourceType = gridProducerNode?.sourceType;

            const houseNode = this._houseDTO ? this._hydrateItem(this._houseDTO, histBuckets) : null;
            if (houseNode && !houseNode.sourceType) houseNode.sourceType = 'house';

            const productionNode = payload.productionTotalSensorId
                ? new TreeItem('production-total', '', payload.productionTotalSensorId, null, histBuckets)
                : null;
            if (productionNode) productionNode.isSource = true;
            const consumptionNode = payload.consumptionTotalSensorId
                ? new TreeItem('consumption-total', '', payload.consumptionTotalSensorId, null, histBuckets)
                : null;
            if (consumptionNode) consumptionNode.isSource = true;

            const sourceNodes = [solarNode, gridProducerNode, batteryProducerNode]
                .filter((node): node is TreeItem => node !== null);
            const topLevelNodes = [
                ...sourceNodes, houseNode, batteryConsumerNode, gridConsumerNode,
                productionNode, consumptionNode,
            ].filter((node): node is TreeItem => node !== null);
            const engine = new HistoryEngine(
                () => this._latestHass,
                histBuckets,
                () => { this._historyRevision++; },
            );
            engine.applyHistory(history, HistoryEngine.walkTree(topLevelNodes), sourceNodes);

            this._historyEngine?.stop();
            this._uiConfig = payload.uiConfig;
            this._entityMap = entityMap;
            this._energy = energy;
            this._solarNode = solarNode;
            this._gridProducerNode = gridProducerNode;
            this._batteryProducerNode = batteryProducerNode;
            this._batteryConsumerNode = batteryConsumerNode;
            this._gridConsumerNode = gridConsumerNode;
            this._houseNode = houseNode;
            this._productionNode = productionNode;
            this._consumptionNode = consumptionNode;

            if (this._dialogRequest instanceof TreeItem) {
                const old = this._dialogRequest;
                this._dialogRequest = HistoryEngine.walkTree(topLevelNodes)
                    .find((item) => item.id === old.id && item.isSource === old.isSource) ?? null;
                this._detailEntityIds = [];
            }
            this._historyEngine = engine;
            engine.start(
                this._uiConfig.history_bucket_duration,
                () => this._topLevelNodes(),
                () => this._sourceNodes,
            );
            engine.advanceBuckets(this._topLevelNodes(), this._sourceNodes);
            this._rebuildWatchedEntityIds();
            void this._loadInverter(obsolete, freshTree);
            return true;
        } catch (err) {
            // Logged even for an obsolete load: the guard is there to keep stale data
            // out of the card, not to hide a backend failure that raced a detach.
            console.error("helman-simple-card: failed to load backend data", err);
            // A config event can supersede the initial load before any tree is
            // installed. Give that failed refresh one new, post-event read.
            if (!obsolete() && freshTree && retryInitial && !this._historyEngine) {
                void this._loadFromBackend(true, false);
            }
            // Keep the inverter request useful for the retained card state.
            if (!obsolete() && this._historyEngine && !this._inverter) {
                void this._loadInverter(obsolete, false);
            }
            return false;
        } finally {
            if (!obsolete()) this._loading = false;
        }
    }

    private _buildEntityMap(payload: TreePayload): EnergyEntityMap {
        const solarNode   = payload.sources.find(n => n.sourceType === "solar");
        const gridNode    = payload.sources.find(n => n.sourceType === "grid");
        const batteryNode = payload.sources.find(n => n.sourceType === "battery");
        const houseNode   = this._findHouseNode(payload.consumers);

        this._solarDTO   = solarNode   ?? null;
        this._gridDTO    = gridNode    ?? null;
        this._batteryDTO = batteryNode ?? null;
        this._houseDTO   = houseNode   ?? null;

        this._batteryConsumerDTO = this._findDeviceById(payload.consumers, this._batteryDTO?.id ?? null) ?? null;
        this._gridConsumerDTO    = this._findDeviceById(payload.consumers, this._gridDTO?.id   ?? null) ?? null;

        const battCfg = batteryNode?.sourceConfig?.entities ?? {};

        return {
            solarPowerEntityId:    solarNode?.powerSensorId   ?? null,
            solarValueType:        solarNode?.valueType       ?? "default",
            gridPowerEntityId:     gridNode?.powerSensorId    ?? null,
            gridValueType:         gridNode?.valueType        ?? "default",
            batteryPowerEntityId:  batteryNode?.powerSensorId ?? null,
            batteryInverted:       batteryNode?.valueType === "positive",
            batterySocEntityId:    battCfg.capacity           ?? null,
            batteryMinSocEntityId: battCfg.min_soc            ?? null,
            housePowerEntityId:    houseNode?.powerSensorId   ?? null,
            houseValueType:        houseNode?.valueType       ?? "default",
            solarMaxPower:   Math.max(1, solarNode?.sourceConfig?.max_power   ?? DEFAULT_SOLAR_MAX_W),
            gridMaxPower:    Math.max(1, gridNode?.sourceConfig?.max_power    ?? 11500),
            batteryMaxPower: Math.max(1, batteryNode?.sourceConfig?.max_power ?? 5000),
        };
    }

    /** Recursively finds the house node (by sourceType or known id) in the consumers tree. */
    private _findHouseNode(nodes: TreeItemDTO[]): TreeItemDTO | undefined {
        for (const node of nodes) {
            if (node.sourceType === "house" || node.id === "house") return node;
            const found = this._findHouseNode(node.children);
            if (found) return found;
        }
        return undefined;
    }

    /** Recursively finds a non-source consumer node by entity id in the consumers tree. */
    private _findDeviceById(nodes: TreeItemDTO[], id: string | null): TreeItemDTO | undefined {
        if (!id) return undefined;
        for (const node of nodes) {
            if (!node.isSource && node.id === id) return node;
            const found = this._findDeviceById(node.children, id);
            if (found) return found;
        }
        return undefined;
    }

    private _buildNodeDetailContext(flows: LiveFlows): NodeDetailContext {
        const historyBuckets = this._uiConfig?.history_buckets ?? 60;
        const historyBucketDuration = this._uiConfig?.history_bucket_duration ?? 60;
        return {
            flows,
            flowScaleW: this._flowScaleW(),
            batteryPower: this._energy.batteryPower,
            batteryPowerReading: this._energy.batteryPowerReading,
            solarPowerReading: this._energy.solarPowerReading,
            gridPower: this._energy.gridPowerSigned,
            housePower: this._energy.housePower,
            houseReadable: this._energy.houseReadable,
            solarPower: this._energy.solarPower,
            houseNode: this._houseNode,
            historyBuckets,
            historyBucketDuration,
        };
    }

    /**
     * The power a detail's flow draws at full height: the inverter's AC
     * rating, else the solar node's configured maximum.
     */
    private _flowScaleW(): number {
        const entityId = this._inverter?.entities.rated_power;
        const hass = this._hass ?? this._latestHass;
        const value = hass ? readingNumber(hass, entityId) : null;
        const factor = hass ? powerUnitFactor(hass, entityId) : null;
        const rated = value === null || factor === null ? null : value * factor;
        return rated !== null && rated > 0 ? rated : this._entityMap!.solarMaxPower;
    }

    private _handleShowDeviceDetail = (event: Event): void => {
        event.stopPropagation();
        this._dialogRequest = (event as CustomEvent<{ item: TreeItem }>).detail.item;
    };

    private _readEnergyValues(hass: HomeAssistant, map: EnergyEntityMap): EnergyValues {
        const rawPower = (entityId: string | null): number => readPowerW(hass, entityId) ?? 0;

        const batterySoc = Math.max(0, Math.min(100, (readingNumber(hass, map.batterySocEntityId) ?? 0)));
        const gridReading = readPowerW(hass, map.gridPowerEntityId);
        const batteryRaw = readPowerW(hass, map.batteryPowerEntityId);
        const batteryReading = batteryRaw === null ? null : map.batteryInverted ? -batteryRaw : batteryRaw;
        const solarRaw = readPowerW(hass, map.solarPowerEntityId);
        const solarPower = applyValueType(solarRaw ?? 0, map.solarValueType);

        return {
            solarPower,
            solarPowerReading: solarRaw === null ? null : solarPower,
            gridPower:    applyValueType(rawPower(map.gridPowerEntityId),    map.gridValueType),
            gridPowerSigned: gridReading === null ? null : map.gridValueType === "negative" ? -gridReading : gridReading,
            batteryPower: map.batteryInverted
                ? -rawPower(map.batteryPowerEntityId)
                : rawPower(map.batteryPowerEntityId),
            batteryPowerReading: batteryReading,
            batterySoc,
            batteryMinSoc: readingNumber(hass, map.batteryMinSocEntityId) || 10,
            // applyValueType("default") passes the raw value through, so the
            // clamp this card has always applied stays outside it. For an
            // inverted house sensor the value is already a magnitude.
            housePower:   Math.max(0, applyValueType(rawPower(map.housePowerEntityId), map.houseValueType)),
            houseReadable: readPowerW(hass, map.housePowerEntityId) !== null,
        };
    }

    private _renderFlowOverlay(solarToBatt: { active: boolean; width: number }, gridToHouse: { active: boolean; width: number }, battToHouse: { active: boolean; width: number }) {
        if (!solarToBatt.active && !gridToHouse.active && !battToHouse.active) return "";
        const solarFlowColor   = this._flowColors!.solar;
        const gridFlowColor    = this._flowColors!.grid;
        const batteryFlowColor = this._flowColors!.battery;
        const solarFlowGlow    = this._flowGlows!.solar;
        const gridFlowGlow     = this._flowGlows!.grid;
        const batteryFlowGlow  = this._flowGlows!.battery;
        // SVG overlays the full energy-grid (viewBox 0 0 200 168).
        // Column centers: House=45, Grid/Battery=155. Row centers: top≈35, bottom≈133.
        // vector-effect="non-scaling-stroke" keeps stroke-width in screen pixels,
        // matching the same scale used by the straight connector flows.
        return html`
            <svg class="diagonal-overlay" viewBox="0 0 200 168"
                 preserveAspectRatio="none"
                 xmlns="http://www.w3.org/2000/svg">
                ${ solarToBatt.active ? svg`
                    <line x1="62" y1="48" x2="138" y2="120"
                          stroke="${solarFlowColor}"
                          stroke-width=${solarToBatt.width}
                          stroke-linecap="round"
                          stroke-dasharray="2 16"
                          vector-effect="non-scaling-stroke"
                          style="animation: flow-diagonal 1.6s linear infinite;
                                 filter: drop-shadow(0 0 3px ${solarFlowGlow})" />
                ` : ""}
                ${ gridToHouse.active ? svg`
                    <line x1="138" y1="48" x2="62" y2="120"
                          stroke="${gridFlowColor}"
                          stroke-width=${gridToHouse.width}
                          stroke-linecap="round"
                          stroke-dasharray="2 16"
                          vector-effect="non-scaling-stroke"
                          style="animation: flow-diagonal 1.6s linear infinite;
                                 filter: drop-shadow(0 0 3px ${gridFlowGlow})" />
                ` : ""}
                ${ battToHouse.active ? svg`
                    <line x1="130" y1="133" x2="70" y2="133"
                          stroke="${batteryFlowColor}"
                          stroke-width=${battToHouse.width}
                          stroke-linecap="round"
                          stroke-dasharray="2 16"
                          vector-effect="non-scaling-stroke"
                          style="animation: flow-diagonal 1.6s linear infinite;
                                 filter: drop-shadow(0 0 3px ${batteryFlowGlow})" />
                ` : ""}
            </svg>`;
    }

    private _flowH(color: string, glow: string, reverse: boolean, strokeWidth: number, leftOverhang = 0, rightOverhang = 0) {
        const sw = strokeWidth;
        // connectorW matches the 20px CSS grid connector column so absolute SVG
        // coordinates (no viewBox) map 1:1 to pixels, letting us reach actual
        // picture borders on both sides via overflow:visible.
        const connectorW = 20;
        const x1 = reverse ? connectorW + rightOverhang : -leftOverhang;
        const x2 = reverse ? -leftOverhang : connectorW + rightOverhang;
        return html`
            <svg width="100%" height="100%" style="display:block; overflow:visible">
                <line x1="${x1}" y1="50%" x2="${x2}" y2="50%"
                      stroke="${color}" stroke-width="${sw}"
                      stroke-linecap="round" stroke-dasharray="2 16"
                      style="animation: flow-diagonal 1.6s linear infinite;
                             filter: drop-shadow(0 0 3px ${glow})" />
            </svg>`;
    }

    private _flowV(color: string, glow: string, reverse: boolean, strokeWidth: number) {
        const sw = strokeWidth;
        const y1 = reverse ? "100%" : "0%";
        const y2 = reverse ? "0%" : "100%";
        return html`
            <svg width="100%" height="100%" style="display:block; overflow:visible">
                <line x1="50%" y1="${y1}" x2="50%" y2="${y2}"
                      stroke="${color}" stroke-width="${sw}"
                      stroke-linecap="round" stroke-dasharray="2 16"
                      style="animation: flow-diagonal 1.6s linear infinite;
                             filter: drop-shadow(0 0 3px ${glow})" />
            </svg>`;
    }

    private _hydrateItem(dto: TreeItemDTO, historyBuckets: number): TreeItem {
        return hydrateItem(dto, historyBuckets, this._localize!);
    }

    private get _sourceNodes(): TreeItem[] {
        return [this._solarNode, this._gridProducerNode, this._batteryProducerNode]
            .filter((n): n is TreeItem => n !== null);
    }

    private _topLevelNodes(): TreeItem[] {
        return [
            ...this._sourceNodes,
            this._houseNode,
            this._batteryConsumerNode,
            this._gridConsumerNode,
            this._productionNode,
            this._consumptionNode,
        ].filter((n): n is TreeItem => n !== null);
    }
}

// Card registration
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: "helman-simple-card",
    name: "Helman Simple Energy Card",
    description: "Compact animated visualization of solar, battery, grid and house power.",
    preview: true,
});
