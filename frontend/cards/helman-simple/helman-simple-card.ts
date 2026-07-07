import { LitElement, css, html, svg } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import { HelmanSimpleCardConfig } from "./HelmanSimpleCardConfig";
import { getLocalizeFunction, LocalizeFunction } from "../localize/localize";
import { ValueType, DeviceNodeDTO, TreePayload, HistoryPayload, HelmanUiConfig, applyValueType } from "../helman-api";
import { HistoryEngine } from "../helman/history-engine";
import { DeviceNode } from "../helman/DeviceNode";
import { hydrateNode } from "../helman/device-node-hydrator";
import type { BatteryDeviceConfig } from "../helman/DeviceConfig";
import type { NodeType, NodeDetailParams } from "./node-detail/node-detail-types";
import {
    buildNodeDetailParams,
    type NodeDetailContext,
} from "./node-detail/node-detail-params-builder";
import "./node-detail-dialog";
import "./simple-card-solar";
import "./simple-card-battery";
import "./simple-card-grid";
import "./simple-card-house";
import { computeDominantSourceColorCached } from "../color-utils";
import { getFlowColor, getFlowGlow } from "./flow-colors";

// ──────────────────────────────── Internal model ──────────────────────────────

interface EnergyEntityMap {
    solarPowerEntityId:   string | null;
    solarValueType:       ValueType;
    gridPowerEntityId:    string | null;
    gridValueType:        ValueType;
    batteryPowerEntityId: string | null;
    batterySocEntityId:   string | null;
    batteryMinSocEntityId:string | null;
    housePowerEntityId:   string | null;
    solarMaxPower:        number;
    gridMaxPower:         number;
    batteryMaxPower:      number;
}

interface EnergyValues {
    solarPower:   number;
    gridPower:    number;
    batteryPower: number;
    batterySoc:   number;
    batteryMinSoc:number;
    housePower:   number;
}

const EMPTY_ENERGY: EnergyValues = {
    solarPower: 0, gridPower: 0, batteryPower: 0,
    batterySoc: 0, batteryMinSoc: 10,
    housePower: 0,
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
    private _latestHass?: HomeAssistant;
    private _watchedEntityIds: Set<string> = new Set();
    private _solarDTO:           DeviceNodeDTO | null = null;
    private _gridDTO:            DeviceNodeDTO | null = null;
    private _batteryDTO:         DeviceNodeDTO | null = null;
    private _houseDTO:           DeviceNodeDTO | null = null;
    private _batteryConsumerDTO: DeviceNodeDTO | null = null;
    private _gridConsumerDTO:    DeviceNodeDTO | null = null;
    private _solarNode:          DeviceNode | null = null;
    private _gridProducerNode:   DeviceNode | null = null;
    private _batteryProducerNode: DeviceNode | null = null;
    private _batteryConsumerNode: DeviceNode | null = null;
    private _gridConsumerNode:   DeviceNode | null = null;
    private _houseNode:          DeviceNode | null = null;
    private _productionNode:     DeviceNode | null = null;
    private _consumptionNode:    DeviceNode | null = null;
    private _historyEngine?: HistoryEngine;
    private _uiConfig?: HelmanUiConfig;
    private _flowColors?: { solar: string; grid: string; battery: string };
    private _flowGlows?:  { solar: string; grid: string; battery: string };

    // 5. State properties
    @state() private _hass?: HomeAssistant;
    @state() private _energy: EnergyValues = EMPTY_ENERGY;
    @state() private _loading = true;
    @state() private _dialogNodeType: NodeType | null = null;
    @state() private _houseDevices: DeviceNode[] = [];

    // 7. HA-specific property setter
    public set hass(hass: HomeAssistant) {
        const previous = this._latestHass;
        this._latestHass = hass;
        if (!this._localize) this._localize = getLocalizeFunction(hass);

        if (!previous || this._watchedEntityIds.size === 0) {
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
        if (this._latestHass) {
            await this._loadFromBackend();
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
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

        const { solarPower, gridPower, housePower, batteryPower,
                batterySoc, batteryMinSoc } = this._energy;

        // All activation thresholds: 50 W
        const solarActive   = solarPower > 50;
        const battCharge    = batteryPower > 50;
        const battDischarge = batteryPower < -50;

        // Infer solar→grid export from power balance (sign-convention independent)
        const solarToGrid = Math.max(0, solarPower - housePower - Math.max(0, batteryPower));
        const solarExportingToGrid = solarToGrid > 50;

        // ── Solar distribution (house load has priority over battery charging) ──
        const solarToGridPower  = solarExportingToGrid ? solarToGrid : 0;
        // Solar covers house first, then remaining excess charges battery
        const solarToHousePower = solarActive ? Math.max(0, Math.min(solarPower - solarToGridPower, housePower)) : 0;
        const solarToBattPower  = solarActive && battCharge
            ? Math.min(Math.max(0, solarPower - solarToHousePower - solarToGridPower), Math.max(0, batteryPower))
            : 0;

        // ── Battery distribution (when discharging) ────────────────────────────
        // Battery fills remaining house demand first; any excess is exported to grid
        const houseRemainingAfterSolar = Math.max(0, housePower - solarToHousePower);
        const battToHousePower = battDischarge ? Math.min(Math.abs(batteryPower), houseRemainingAfterSolar) : 0;
        const battToGridPower  = battDischarge ? Math.max(0, Math.abs(batteryPower) - battToHousePower) : 0;

        // Effective grid power: if the sensor reads ≈0 but solar or battery is clearly exporting,
        // derive the export value from the power balance (negative = exporting)
        const effectiveGridPower = (Math.abs(gridPower) < 20 && (solarExportingToGrid || battToGridPower > 50))
            ? -(solarToGridPower + battToGridPower)
            : gridPower;
        const gridImport = effectiveGridPower > 50;

        const em = this._entityMap;
        const intensity = (power: number, max: number) => Math.min(Math.abs(power) / max, 1);
        // Stroke width scales linearly from 1.5 to 12 px based on the power ratio; minimum ensures visibility.
        const thick = (i: number) => Math.max(1.5, i * 12);

        // ── Grid distribution ──────────────────────────────────────────────────
        const gridToBattPower  = battCharge ? Math.max(0, batteryPower - solarToBattPower) : 0;
        const gridToHousePower = Math.max(0, housePower - solarToHousePower - battToHousePower);

        // ── Intensities: ratio of each flow's power to its source's max power ──
        const solarToHouseI = intensity(solarToHousePower, em.solarMaxPower);
        const solarToGridI  = intensity(solarToGridPower,  em.solarMaxPower);
        const solarToBattI  = intensity(solarToBattPower,  em.solarMaxPower);
        const gridToBattI   = intensity(gridToBattPower,   em.gridMaxPower);
        const gridToHouseI  = intensity(gridToHousePower,  em.gridMaxPower);
        const battToHouseI  = intensity(battToHousePower,  em.batteryMaxPower);
        const battToGridI   = intensity(battToGridPower,   em.batteryMaxPower);

        // ── Stroke widths (px, unified scale for all flows) ────────────────────
        const solarToHouseT = thick(solarToHouseI);
        const solarToGridT  = thick(solarToGridI);
        const solarToBattT  = thick(solarToBattI);
        const gridToBattT   = thick(gridToBattI);
        const gridToHouseT  = thick(gridToHouseI);
        const battToHouseT  = thick(battToHouseI);
        const battToGridT   = thick(battToGridI);

        const solarFlowColor   = this._flowColors!.solar;
        const gridFlowColor    = this._flowColors!.grid;
        const batteryFlowColor = this._flowColors!.battery;

        // ── Source colors for consumer components ──────────────────────────────
        // Battery charge color: derived from live power flows to avoid backend color discrepancies
        const battSourceColor  = battCharge
            ? (solarToBattPower >= gridToBattPower ? solarFlowColor : gridFlowColor)
            : undefined;
        const gridSourceColor  = this._gridConsumerNode    ? computeDominantSourceColorCached(this._gridConsumerNode)    : undefined;
        const houseSourceColor = this._houseNode           ? computeDominantSourceColorCached(this._houseNode)           : undefined;

        const gridStyle = this._buildGridStyle();

        return html`
            <ha-card class=${this._config?.transparent_background ? "transparent" : ""}>
                <div class="card-content">
                    <div class="energy-grid" style=${gridStyle}>

                        <!-- ── Row 1: Solar  ─── connector ─── Grid ── -->
                        <div class="node-cell" @click=${() => this._dialogNodeType = 'solar'}>
                            <simple-card-solar .power=${solarPower}></simple-card-solar>
                        </div>
                        <div class="connector-h">
                            ${solarExportingToGrid ? this._flowH(solarFlowColor, this._flowGlows!.solar, false, solarToGridT, 22.5, 33) : ""}
                        </div>
                        <div class="node-cell" @click=${() => this._dialogNodeType = 'grid'}>
                            <simple-card-grid .power=${effectiveGridPower} .sourceColor=${gridSourceColor}></simple-card-grid>
                        </div>

                        <!-- ── Row 2: vertical connectors ── -->
                        <div class="connector-v">
                            ${solarActive ? this._flowV(solarFlowColor, this._flowGlows!.solar, false, solarToHouseT) : ""}
                        </div>
                        <div></div>
                        <div class="connector-v">
                            ${(gridImport && battCharge) ? this._flowV(gridFlowColor, this._flowGlows!.grid, false, gridToBattT) : ""}
                            ${battToGridPower > 50 ? this._flowV(batteryFlowColor, this._flowGlows!.battery, true, battToGridT) : ""}
                        </div>

                        <!-- ── Row 3: House ─── connector ─── Battery ── -->
                        <div class="node-cell" @click=${() => this._dialogNodeType = 'house'}>
                            <simple-card-house .power=${housePower} .sourceColor=${houseSourceColor}></simple-card-house>
                        </div>
                        <div class="connector-h"></div>
                        <div class="node-cell" @click=${() => this._dialogNodeType = 'battery'}>
                            <simple-card-battery
                                .power=${batteryPower}
                                .soc=${batterySoc}
                                .minSoc=${batteryMinSoc}
                                .sourceColor=${battSourceColor}
                            ></simple-card-battery>
                        </div>

                        ${this._renderFlowOverlay(solarToBattPower > 50, gridToHousePower > 50, battToHousePower > 50, solarToBattT, gridToHouseT, battToHouseT)}

                    </div>
                </div>
            </ha-card>
            ${this._dialogNodeType !== null ? html`
                <node-detail-dialog
                    .hass=${this._hass!}
                    .localize=${this._localize!}
                    .open=${true}
                    .params=${this._buildDialogParams(this._dialogNodeType)}
                    @closed=${() => { this._dialogNodeType = null; }}
                ></node-detail-dialog>
            ` : ''}
        `;
    }

    // 12. Private helper methods

    private _rebuildWatchedEntityIds(): void {
        const ids = new Set<string>();
        if (this._entityMap) {
            for (const v of Object.values(this._entityMap)) {
                if (typeof v === 'string' && v.length > 0) ids.add(v);
            }
        }
        const addNode = (n: DeviceNode | null | undefined) => {
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

    private async _loadFromBackend(): Promise<boolean> {
        this._historyEngine?.stop();
        try {
            const payload = await this._latestHass!.connection.sendMessagePromise<TreePayload>({
                type: "helman/get_device_tree",
            });
            this._uiConfig = payload.uiConfig;
            this._entityMap = this._buildEntityMap(payload);
            this._energy = this._readEnergyValues(this._latestHass!, this._entityMap);

            const histBuckets = payload.uiConfig.history_buckets;
            this._solarNode          = this._solarDTO          ? this._hydrateNode(this._solarDTO,          histBuckets) : null;
            this._gridProducerNode   = this._gridDTO            ? this._hydrateNode(this._gridDTO,            histBuckets) : null;
            this._batteryProducerNode = this._batteryDTO        ? this._hydrateNode(this._batteryDTO,        histBuckets) : null;
            this._batteryConsumerNode = this._batteryConsumerDTO ? this._hydrateNode(this._batteryConsumerDTO, histBuckets) : null;
            this._gridConsumerNode   = this._gridConsumerDTO    ? this._hydrateNode(this._gridConsumerDTO,    histBuckets) : null;

            // Consumer-side DTOs don't carry sourceType — propagate from the matching source node
            if (this._batteryConsumerNode && !this._batteryConsumerNode.sourceType)
                this._batteryConsumerNode.sourceType = this._batteryProducerNode?.sourceType;
            if (this._gridConsumerNode && !this._gridConsumerNode.sourceType)
                this._gridConsumerNode.sourceType = this._gridProducerNode?.sourceType;

            if (this._houseDTO) {
                this._houseNode = this._hydrateNode(this._houseDTO, histBuckets);
                if (!this._houseNode.sourceType) this._houseNode.sourceType = 'house';
                this._houseDevices = this._houseNode.children;
            }

            this._productionNode  = payload.productionTotalSensorId
                ? new DeviceNode('production-total', '', payload.productionTotalSensorId, null, histBuckets)
                : null;
            if (this._productionNode) this._productionNode.isSource = true;
            this._consumptionNode = payload.consumptionTotalSensorId
                ? new DeviceNode('consumption-total', '', payload.consumptionTotalSensorId, null, histBuckets)
                : null;
            if (this._consumptionNode) this._consumptionNode.isSource = true;

            const history = await this._latestHass!.connection.sendMessagePromise<HistoryPayload>({
                type: 'helman/get_history',
            });
            this._historyEngine = new HistoryEngine(
                () => this._latestHass,
                histBuckets,
                () => this.requestUpdate(),
            );
            this._historyEngine.applyHistory(history, HistoryEngine.walkTree(this._topLevelNodes()), this._sourceNodes);
            this._historyEngine.start(
                this._uiConfig.history_bucket_duration,
                () => this._topLevelNodes(),
                () => this._sourceNodes,
            );
            this._historyEngine.advanceBuckets(this._topLevelNodes(), this._sourceNodes);
            this._rebuildWatchedEntityIds();
            return true;
        } catch (err) {
            console.error("helman-simple-card: failed to load backend data", err);
            return false;
        } finally {
            this._loading = false;
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

        this._batteryConsumerDTO = this._findConsumerById(payload.consumers, this._batteryDTO?.id ?? null) ?? null;
        this._gridConsumerDTO    = this._findConsumerById(payload.consumers, this._gridDTO?.id   ?? null) ?? null;

        const battCfg = batteryNode?.sourceConfig?.entities ?? {};

        return {
            solarPowerEntityId:    solarNode?.powerSensorId   ?? null,
            solarValueType:        solarNode?.valueType       ?? "default",
            gridPowerEntityId:     gridNode?.powerSensorId    ?? null,
            gridValueType:         gridNode?.valueType        ?? "default",
            batteryPowerEntityId:  batteryNode?.powerSensorId ?? null,
            batterySocEntityId:    battCfg.capacity           ?? null,
            batteryMinSocEntityId: battCfg.min_soc            ?? null,
            housePowerEntityId:    houseNode?.powerSensorId   ?? null,
            solarMaxPower:   Math.max(1, solarNode?.sourceConfig?.max_power   ?? 5000),
            gridMaxPower:    Math.max(1, gridNode?.sourceConfig?.max_power    ?? 11500),
            batteryMaxPower: Math.max(1, batteryNode?.sourceConfig?.max_power ?? 5000),
        };
    }

    /** Recursively finds the house node (by sourceType or known id) in the consumers tree. */
    private _findHouseNode(nodes: DeviceNodeDTO[]): DeviceNodeDTO | undefined {
        for (const node of nodes) {
            if (node.sourceType === "house" || node.id === "house") return node;
            const found = this._findHouseNode(node.children);
            if (found) return found;
        }
        return undefined;
    }

    /** Recursively finds a non-source consumer node by entity id in the consumers tree. */
    private _findConsumerById(nodes: DeviceNodeDTO[], id: string | null): DeviceNodeDTO | undefined {
        if (!id) return undefined;
        for (const node of nodes) {
            if (!node.isSource && node.id === id) return node;
            const found = this._findConsumerById(node.children, id);
            if (found) return found;
        }
        return undefined;
    }

    private _buildNodeDetailContext(): NodeDetailContext {
        const historyBuckets = this._uiConfig?.history_buckets ?? 60;
        const historyBucketDuration = this._uiConfig?.history_bucket_duration ?? 60;
        const batteryConfig = (this._batteryProducerNode?.deviceConfig ?? this._batteryConsumerNode?.deviceConfig) as BatteryDeviceConfig | undefined;

        return {
            batteryPower: this._energy.batteryPower,
            batterySoc: this._energy.batterySoc,
            batterySocEntityId: this._entityMap?.batterySocEntityId ?? null,
            batteryRemainingEnergyEntityId: batteryConfig?.entities.remaining_energy ?? null,
            batteryProducerNode: this._batteryProducerNode,
            batteryConsumerNode: this._batteryConsumerNode,
            solarNode: this._solarNode,
            gridProducerNode: this._gridProducerNode,
            gridConsumerNode: this._gridConsumerNode,
            productionNode: this._productionNode,
            consumptionNode: this._consumptionNode,
            housePower: this._energy.housePower,
            houseDevices: this._houseDevices,
            houseNode: this._houseNode,
            historyBuckets,
            historyBucketDuration,
            uiConfig: this._uiConfig,
        };
    }

    private _buildDialogParams(nodeType: NodeType): NodeDetailParams {
        return buildNodeDetailParams(this._buildNodeDetailContext(), nodeType);
    }

    private _readEnergyValues(hass: HomeAssistant, map: EnergyEntityMap): EnergyValues {
        const rawPower = (entityId: string | null): number =>
            entityId ? parseFloat(hass.states[entityId]?.state ?? "0") || 0 : 0;

        const batterySoc = Math.max(0, Math.min(100, rawPower(map.batterySocEntityId)));

        return {
            solarPower:   applyValueType(rawPower(map.solarPowerEntityId),   map.solarValueType),
            gridPower:    applyValueType(rawPower(map.gridPowerEntityId),    map.gridValueType),
            batteryPower: rawPower(map.batteryPowerEntityId),
            batterySoc,
            batteryMinSoc: rawPower(map.batteryMinSocEntityId) || 10,
            housePower:         Math.max(0, rawPower(map.housePowerEntityId)),
        };
    }

    private _renderFlowOverlay(solarToBatt: boolean, gridToHouse: boolean, battToHouse: boolean, solarToBattT: number, gridToHouseT: number, battToHouseT: number) {
        if (!solarToBatt && !gridToHouse && !battToHouse) return "";
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
                ${ solarToBatt ? svg`
                    <line x1="62" y1="48" x2="138" y2="120"
                          stroke="${solarFlowColor}"
                          stroke-width=${solarToBattT}
                          stroke-linecap="round"
                          stroke-dasharray="2 16"
                          vector-effect="non-scaling-stroke"
                          style="animation: flow-diagonal 1.6s linear infinite;
                                 filter: drop-shadow(0 0 3px ${solarFlowGlow})" />
                ` : ""}
                ${ gridToHouse ? svg`
                    <line x1="138" y1="48" x2="62" y2="120"
                          stroke="${gridFlowColor}"
                          stroke-width=${gridToHouseT}
                          stroke-linecap="round"
                          stroke-dasharray="2 16"
                          vector-effect="non-scaling-stroke"
                          style="animation: flow-diagonal 1.6s linear infinite;
                                 filter: drop-shadow(0 0 3px ${gridFlowGlow})" />
                ` : ""}
                ${ battToHouse ? svg`
                    <line x1="130" y1="133" x2="70" y2="133"
                          stroke="${batteryFlowColor}"
                          stroke-width=${battToHouseT}
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

    private _hydrateNode(dto: DeviceNodeDTO, historyBuckets: number): DeviceNode {
        return hydrateNode(dto, historyBuckets);
    }

    private get _sourceNodes(): DeviceNode[] {
        return [this._solarNode, this._gridProducerNode, this._batteryProducerNode]
            .filter((n): n is DeviceNode => n !== null);
    }

    private _topLevelNodes(): DeviceNode[] {
        return [
            ...this._sourceNodes,
            this._houseNode,
            this._batteryConsumerNode,
            this._gridConsumerNode,
            this._productionNode,
            this._consumptionNode,
        ].filter((n): n is DeviceNode => n !== null);
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
