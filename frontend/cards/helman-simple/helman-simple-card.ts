import { LitElement, css, html, svg, unsafeCSS } from "lit-element";
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
import { helmanColorVars } from "../color-vars";
import { FLOW_BAND_LENGTH, FLOW_BAND_PEAK_OPACITY, FLOW_RIBBON_OPACITY, FLOW_SWEEP_DURATION } from "../shared/flow-style";
import { dominantFlowColor, getFlowColor } from "./flow-colors";
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
    static styles = [helmanColorVars, css`
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
        .flow-ribbon, .flow-band {
            fill: none;
            stroke-linecap: round;
        }
        .flow-ribbon { opacity: ${unsafeCSS(FLOW_RIBBON_OPACITY)}; }
        .flow-band {
            pointer-events: none;
            transform-box: view-box;
            animation: sweep-band ${unsafeCSS(FLOW_SWEEP_DURATION)} linear infinite;
        }
        @keyframes sweep-band {
            from { transform: translate(0, 0); }
            to { transform: translate(var(--travel-x), var(--travel-y)); }
        }
        @media (prefers-reduced-motion: reduce) {
            .flow-band { display: none; }
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
    `];

    // 3. Private properties & Host controller
    private readonly _flowId = `simple-flow-${Math.random().toString(36).slice(2)}`;
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
        const flows = liveFlows({ ...energy, gridPower: energy.gridPowerSigned ?? 0 });
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
            // An absent node has no maximum: its edge keeps the minimum width.
            return { active: power > 0, width: max === null ? 1.5 : Math.max(1.5, Math.min(power / max, 1) * 12) };
        };

        const solarFlowColor   = getFlowColor("solar");
        const gridFlowColor    = getFlowColor("grid");
        const batteryFlowColor = getFlowColor("battery");

        // ── Source colors for consumer components ──────────────────────────────
        // Battery charge color: derived from live power flows to avoid backend color discrepancies
        const battSourceColor  = battCharge
            ? (flows.solarToBattery >= flows.gridToBattery ? solarFlowColor : gridFlowColor)
            : undefined;
        const { gridConsumerNode, houseNode } = this._host.energyNodes;
        const gridSourceColor  = dominantFlowColor(gridConsumerNode, this._host.sourceNodes);
        const houseSourceColor = dominantFlowColor(houseNode, this._host.sourceNodes);

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
                            ${edge("solarToGrid").active ? this._flowH("solar-grid", solarFlowColor, false, edge("solarToGrid").width, 22.5, 33) : ""}
                        </div>
                        <div class="node-cell" @click=${() => this._openNode("grid")}>
                            <simple-card-grid .power=${effectiveGridPower} .sourceColor=${gridSourceColor}></simple-card-grid>
                        </div>

                        <!-- ── Row 2: vertical connectors ── -->
                        <div class="connector-v">
                            ${edge("solarToHouse").active ? this._flowV("solar-house", solarFlowColor, false, edge("solarToHouse").width) : ""}
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
                            ${edge("gridToBattery").active ? this._flowV("grid-battery", gridFlowColor, false, edge("gridToBattery").width) : ""}
                            ${edge("batteryToGrid").active ? this._flowV("battery-grid", batteryFlowColor, true, edge("batteryToGrid").width) : ""}
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
            <scheduling-day-editor-host
                .hass=${this._hass}
                .timeZone=${this._hass?.config?.time_zone || "UTC"}
            ></scheduling-day-editor-host>
            ${this._host.dialogRequest !== null ? html`
                <node-detail-dialog
                    .hass=${this._hass!}
                    .localize=${this._localize!}
                    .open=${true}
                    .params=${this._host.dialogParams}
                    @closed=${() => this._closeNodeDetail()}
                ></node-detail-dialog>
            ` : ''}
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
        // SVG overlays the full energy-grid (viewBox 0 0 200 168).
        // Column centers: House=45, Grid/Battery=155. Row centers: top≈35, bottom≈133.
        // vector-effect="non-scaling-stroke" keeps stroke-width in screen pixels,
        // matching the same scale used by the straight connector flows.
        return html`
            <svg class="diagonal-overlay" viewBox="0 0 200 168"
                 preserveAspectRatio="none"
                 xmlns="http://www.w3.org/2000/svg">
                ${solarToBatt.active ? this._flowLine("solar-battery", getFlowColor("solar"), solarToBatt.width, "62", "48", "138", "120", true) : ""}
                ${gridToHouse.active ? this._flowLine("grid-house", getFlowColor("grid"), gridToHouse.width, "138", "48", "62", "120", true) : ""}
                ${battToHouse.active ? this._flowLine("battery-house", getFlowColor("battery"), battToHouse.width, "130", "133", "70", "133", true) : ""}
            </svg>`;
    }

    private _flowH(key: string, color: string, reverse: boolean, strokeWidth: number, leftOverhang = 0, rightOverhang = 0) {
        // connectorW matches the 20px CSS grid connector column so absolute SVG
        // coordinates (no viewBox) map 1:1 to pixels, letting us reach actual
        // picture borders on both sides via overflow:visible.
        const connectorW = 20;
        const x1 = reverse ? connectorW + rightOverhang : -leftOverhang;
        const x2 = reverse ? -leftOverhang : connectorW + rightOverhang;
        return html`
            <svg width="100%" height="100%" style="display:block; overflow:visible">
                ${this._flowLine(key, color, strokeWidth, String(x1), "50%", String(x2), "50%")}
            </svg>`;
    }

    private _flowV(key: string, color: string, reverse: boolean, strokeWidth: number) {
        const y1 = reverse ? "100%" : "0%";
        const y2 = reverse ? "0%" : "100%";
        return html`
            <svg width="100%" height="100%" style="display:block; overflow:visible">
                ${this._flowLine(key, color, strokeWidth, "50%", y1, "50%", y2)}
            </svg>`;
    }

    /** A solid ribbon and a 40%-length white band sweeping from its first endpoint to its second. */
    private _flowLine(key: string, color: string, width: number, x1: string, y1: string, x2: string, y2: string, nonScaling = false) {
        const gradientId = `${this._flowId}-${key}-gradient`;
        const maskId = `${this._flowId}-${key}-mask`;
        const along = (start: string, end: string, fraction: number) =>
            `${parseFloat(start) + (parseFloat(end) - parseFloat(start)) * fraction}${start.endsWith("%") ? "%" : ""}`;
        const bandX = along(x1, x2, -FLOW_BAND_LENGTH);
        const bandY = along(y1, y2, -FLOW_BAND_LENGTH);
        const travel = (start: string, end: string) =>
            `${(parseFloat(end) - parseFloat(start)) * (1 + FLOW_BAND_LENGTH)}${start.endsWith("%") ? "%" : "px"}`;
        return svg`
            <defs>
                <linearGradient id=${gradientId} gradientUnits="userSpaceOnUse"
                        x1=${bandX} y1=${bandY} x2=${x1} y2=${y1}>
                    <stop offset="0" stop-color="white" stop-opacity="0"/>
                    <stop offset="0.5" stop-color="white" stop-opacity=${FLOW_BAND_PEAK_OPACITY}/>
                    <stop offset="1" stop-color="white" stop-opacity="0"/>
                </linearGradient>
                <mask id=${maskId} maskUnits="userSpaceOnUse" x="-1000" y="-1000" width="2000" height="2000">
                    <line x1=${x1} y1=${y1} x2=${x2} y2=${y2}
                          stroke="white" stroke-width=${width} stroke-linecap="round"
                          vector-effect=${nonScaling ? "non-scaling-stroke" : "none"}/>
                </mask>
            </defs>
            <line class="flow-ribbon" data-flow=${key} x1=${x1} y1=${y1} x2=${x2} y2=${y2}
                  stroke=${color} stroke-width=${width}
                  vector-effect=${nonScaling ? "non-scaling-stroke" : "none"}
                  style="filter: drop-shadow(0 0 3px color-mix(in srgb, ${color} 67%, transparent))"/>
            <g mask="url(#${maskId})">
                <line class="flow-band" x1=${bandX} y1=${bandY} x2=${x1} y2=${y1}
                      stroke="url(#${gradientId})" stroke-width=${width}
                      vector-effect=${nonScaling ? "non-scaling-stroke" : "none"}
                      style="--travel-x: ${travel(x1, x2)}; --travel-y: ${travel(y1, y2)}"/>
            </g>
        `;
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
