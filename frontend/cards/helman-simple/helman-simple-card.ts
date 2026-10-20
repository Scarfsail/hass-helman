import { LitElement, css, html, svg } from "lit-element";
import { customElement } from "lit/decorators.js";
import type { HomeAssistant, LovelaceCard } from "../../types/ha";
import { HelmanSimpleCardConfig } from "./HelmanSimpleCardConfig";
import { TreeItem } from "../shared/data/tree-item";
import { EnergyCardHost } from "../shared/energy-card-host";
import type { NodeType } from "../node-detail/node-detail-types";
import "../node-detail/node-detail-dialog";
import "./inverter-cell";
import "../shared/schedule/dialogs/scheduling-day-editor-host";
import "./simple-card-solar";
import "./simple-card-battery";
import "./simple-card-grid";
import "./simple-card-house";
import { computeDominantSourceColorCached } from "../color-utils";
import { getFlowColor, getFlowGlow } from "./flow-colors";
import { IDLE_W, liveFlows } from "../node-detail/live-flows";

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

    // 3. Private properties & Host controller
    private _config?: HelmanSimpleCardConfig;
    private readonly _host = new EnergyCardHost(this, {
        whichNodesToWalk: (_tree, energyNodes) => [
            energyNodes.solarNode,
            energyNodes.gridProducerNode,
            energyNodes.batteryProducerNode,
            energyNodes.batteryConsumerNode,
            energyNodes.gridConsumerNode,
            energyNodes.houseNode,
        ].filter((n): n is TreeItem => n != null),
    });

    private _flowColors?: { solar: string; grid: string; battery: string };
    private _flowGlows?:  { solar: string; grid: string; battery: string };

    // Setters & Getters delegating to host
    public set hass(hass: HomeAssistant) {
        this._host.setHass(hass);
    }

    private get _hass(): HomeAssistant | undefined { return this._host.hass; }
    private get _localize() { return this._host.localize; }

    // 8. HA-specific methods
    getCardSize() { return 4; }

    setConfig(config: HelmanSimpleCardConfig) {
        this._config = { ...config };
    }

    willUpdate(changedProperties: Map<string | symbol, unknown>) {
        super.willUpdate(changedProperties);
        if (!this._flowColors || changedProperties.has('_config')) {
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
        const energy = this._host.readings;
        if (!this._host.loaded || !energy) {
            return html`<ha-card class=${this._config?.transparent_background ? "transparent" : ""}><div class="loading">${this._localize?.('card.loading') ?? 'Loading energy data…'}</div></ha-card>`;
        }

        const { solarPower, housePower, batteryPower,
                batterySoc, batteryMinSoc } = energy;

        // One activation threshold for every flow, as the details read it.
        const battCharge    = batteryPower > IDLE_W;
        const flows = liveFlows(energy);
        const effectiveGridPower = flows.gridPower;

        // Stroke width scales linearly from 1.5 to 12 px based on the power ratio; minimum ensures visibility.
        const edgeList = [
            { key: "solarToGrid", max: energy.solarMaxPower },
            { key: "solarToHouse", max: energy.solarMaxPower },
            { key: "solarToBattery", max: energy.solarMaxPower },
            { key: "gridToBattery", max: energy.gridMaxPower },
            { key: "gridToHouse", max: energy.gridMaxPower },
            { key: "batteryToHouse", max: energy.batteryMaxPower },
            { key: "batteryToGrid", max: energy.batteryMaxPower },
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
        const { gridConsumerNode, houseNode } = this._host.energyNodes;
        const gridSourceColor  = gridConsumerNode    ? computeDominantSourceColorCached(gridConsumerNode)    : undefined;
        const houseSourceColor = houseNode           ? computeDominantSourceColorCached(houseNode)           : undefined;

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
                                .inverter=${this._host.inverter}
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
                                .minSoc=${batteryMinSoc || 10}
                                .sourceColor=${battSourceColor}
                            ></simple-card-battery>
                        </div>

                        ${this._renderFlowOverlay(edge("solarToBattery"), edge("gridToHouse"), edge("batteryToHouse"))}

                    </div>
                </div>
            </ha-card>
            ${this._host.dialogRequest !== null ? html`
                <node-detail-dialog
                    .hass=${this._hass!}
                    .localize=${this._localize!}
                    .open=${true}
                    .params=${this._host.dialogParams}
                    @closed=${() => this._closeNodeDetail()}
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
        this._host.openNode(node);
    }

    private _closeNodeDetail(): void {
        this._host.closeDialog();
    }

    private _buildGridStyle(): string {
        const w = this._config?.width;
        const h = this._config?.height;
        const parts: string[] = [];
        if (w !== undefined) parts.push(`width: ${w}px`);
        if (h !== undefined) parts.push(`height: ${h}px`, `grid-template-rows: 1fr 28px 1fr`);
        return parts.join("; ");
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
}

// Card registration
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: "helman-simple-card",
    name: "Helman Simple Energy Card",
    description: "Compact animated visualization of solar, battery, grid and house power.",
    preview: true,
});
