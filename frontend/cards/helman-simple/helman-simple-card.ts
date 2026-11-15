import { LitElement, PropertyValues, css, html, nothing, svg } from "lit-element";
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
import { FLOW_SURGE_LENGTH_CSS, alignToBeat, flowBeam, flowBeatStyles, flowGlow, flowHalo, flowHot, flowLandsAt, flowRatio, flowSurgeLength, flowSurgeStops, flowSurges, type FlowBeam } from "../shared/flow-style";
import { dominantFlowColor, getFlowColor, type FlowSource } from "./flow-colors";
import { IDLE_W, liveFlows } from "../node-detail/live-flows";

/** Every flow on this card leaves its source on the beat's origin. */
const LEAVES_AT = 0;

/** One flow the card draws: its power against its source's maximum. */
interface Edge {
    power: number;
    r: number;
    color: string;
    /** The vertical connectors are short edges; the horizontals and diagonals are long. */
    short: boolean;
}

/** One edge as drawn: whether it carries power, its beam and whether it is short. */
interface DrawnEdge {
    active: boolean;
    beam: FlowBeam;
    short: boolean;
}

/** The diagonal overlay's viewBox: the energy grid at its default size, px. */
const OVERLAY_W = 200;
const OVERLAY_H = 168;

/** A node's halo, while it has a flow: its ratio, its colour and the beat it peaks on. */
interface Halo {
    r: number;
    color: string;
    phase: number;
}

/**
 * A node's halo from its flows: it emits in its own colour as its surges
 * leave, or receives in `sourceColor` (its strongest flow's colour without
 * one) as its strongest flow's surges land; no flow, no halo.
 */
function nodeHalo(r: number, ownColor: string, outgoing: Edge[], incoming: Edge[], sourceColor?: string): Halo | null {
    if (outgoing.some((edge) => edge.power > 0)) {
        return { r, color: ownColor, phase: LEAVES_AT };
    }
    const strongest = incoming.filter((edge) => edge.power > 0).sort((a, b) => b.power - a.power)[0];
    return strongest
        ? { r, color: sourceColor ?? strongest.color, phase: flowLandsAt(LEAVES_AT, strongest.r, strongest.short) }
        : null;
}

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
    static styles = [helmanColorVars, flowBeatStyles, css`
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
            position: relative;
            isolation: isolate;
        }
        /* The halo, behind the node and centred on its 50 px illustration. */
        .halo-level {
            position: absolute;
            top: 2px;
            left: 50%;
            width: 50px;
            height: 50px;
            transform: translateX(-50%);
            z-index: -1;
            pointer-events: none;
        }
        .halo {
            position: absolute;
            border-radius: 50%;
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
        .flow-bloom, .flow-beam, .flow-core {
            fill: none;
            stroke-linecap: round;
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
        this.toggleAttribute("light-theme", hass.themes?.darkMode === false);
        this._host.setHass(hass);
    }

    private get _hass(): HomeAssistant | undefined { return this._host.hass; }
    private get _localize() { return this._host.localize; }

    // 8. HA-specific methods
    getCardSize() { return 4; }

    setConfig(config: HelmanSimpleCardConfig) {
        this._config = { ...config };
    }

    protected updated(changed: PropertyValues): void {
        super.updated(changed);
        alignToBeat(this.renderRoot);
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

        const edgeList = [
            { key: "solarToGrid", from: "solar", max: energy.solarMaxPower, short: false },
            { key: "solarToHouse", from: "solar", max: energy.solarMaxPower, short: true },
            { key: "solarToBattery", from: "solar", max: energy.solarMaxPower, short: false },
            { key: "gridToBattery", from: "grid", max: energy.gridMaxPower, short: true },
            { key: "gridToHouse", from: "grid", max: energy.gridMaxPower, short: false },
            { key: "batteryToHouse", from: "battery", max: energy.batteryMaxPower, short: false },
            { key: "batteryToGrid", from: "battery", max: energy.batteryMaxPower, short: true },
        ] as const;
        // An absent node has no maximum: its edge is drawn at the lowest ratio.
        const edges = Object.fromEntries(edgeList.map(({ key, from, max, short }) => [key, {
            power: flows[key], r: flowRatio(flows[key], max), color: getFlowColor(from as FlowSource), short,
        }])) as Record<typeof edgeList[number]["key"], Edge>;
        const edge = (key: keyof typeof edges): DrawnEdge => ({ active: edges[key].power > 0, beam: flowBeam(edges[key].r, edges[key].color), short: edges[key].short });

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

        // Each node's ratio from its own total power; the house's against the largest maximum.
        const houseMax = Math.max(0, ...[energy.solarMaxPower, energy.gridMaxPower, energy.batteryMaxPower].filter((max): max is number => max !== null));
        const halos = {
            solar: nodeHalo(flowRatio(solarPower, energy.solarMaxPower), solarFlowColor,
                [edges.solarToGrid, edges.solarToHouse, edges.solarToBattery], []),
            grid: nodeHalo(flowRatio(Math.abs(effectiveGridPower), energy.gridMaxPower), gridFlowColor,
                [edges.gridToBattery, edges.gridToHouse], [edges.solarToGrid, edges.batteryToGrid], gridSourceColor),
            house: nodeHalo(flowRatio(housePower, houseMax), "var(--helman-house)",
                [], [edges.solarToHouse, edges.gridToHouse, edges.batteryToHouse], houseSourceColor),
            battery: nodeHalo(flowRatio(Math.abs(batteryPower), energy.batteryMaxPower), batteryFlowColor,
                [edges.batteryToHouse, edges.batteryToGrid], [edges.solarToBattery, edges.gridToBattery], battSourceColor),
        };

        return html`
            <ha-card class=${this._config?.transparent_background ? "transparent" : ""}>
                <div class="card-content">
                    <div class="energy-grid" style=${gridStyle}>

                        <!-- ── Row 1: Solar  ─── connector ─── Grid ── -->
                        <div class="node-cell" @click=${() => this._openNode("solar")}>
                            ${this._halo(halos.solar)}
                            <simple-card-solar .power=${solarPower}></simple-card-solar>
                        </div>
                        <div class="connector-h">
                            ${edge("solarToGrid").active ? this._flowH("solar-grid", solarFlowColor, false, edge("solarToGrid"), 22.5, 33) : ""}
                        </div>
                        <div class="node-cell" @click=${() => this._openNode("grid")}>
                            ${this._halo(halos.grid)}
                            <simple-card-grid .power=${effectiveGridPower} .sourceColor=${gridSourceColor}></simple-card-grid>
                        </div>

                        <!-- ── Row 2: vertical connectors ── -->
                        <div class="connector-v">
                            ${edge("solarToHouse").active ? this._flowV("solar-house", solarFlowColor, false, edge("solarToHouse")) : ""}
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
                            ${edge("gridToBattery").active ? this._flowV("grid-battery", gridFlowColor, false, edge("gridToBattery")) : ""}
                            ${edge("batteryToGrid").active ? this._flowV("battery-grid", batteryFlowColor, true, edge("batteryToGrid")) : ""}
                        </div>

                        <!-- ── Row 3: House ─── connector ─── Battery ── -->
                        <div class="node-cell" @click=${() => this._openNode("house")}>
                            ${this._halo(halos.house)}
                            <simple-card-house .power=${housePower} .sourceColor=${houseSourceColor}></simple-card-house>
                        </div>
                        <div class="connector-h"></div>
                        <div class="node-cell" @click=${() => this._openNode("battery")}>
                            ${this._halo(halos.battery)}
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

    /** A node's halo: the level and size on a static wrapper, only the opacity on the beat. */
    private _halo(halo: Halo | null) {
        if (!halo) return nothing;
        const glow = flowGlow(halo.r, halo.phase);
        const { extent, background } = flowHalo(halo.color, glow.size);
        return html`
            <div class="halo-level" style="opacity: ${glow.level}">
                <div class="halo" data-beat="glow" data-tier=${glow.tier}
                    style="inset: -${extent}px; background: ${background}; --beat-delay: ${glow.delay}"></div>
            </div>`;
    }

    private _renderFlowOverlay(solarToBatt: DrawnEdge, gridToHouse: DrawnEdge, battToHouse: DrawnEdge) {
        if (!solarToBatt.active && !gridToHouse.active && !battToHouse.active) return "";
        // SVG overlays the full energy-grid (viewBox 0 0 200 168).
        // Column centers: House=45, Grid/Battery=155. Row centers: top≈35, bottom≈133.
        // vector-effect="non-scaling-stroke" keeps stroke-width in screen pixels,
        // matching the same scale used by the straight connector flows.
        return html`
            <svg class="diagonal-overlay" viewBox="0 0 ${OVERLAY_W} ${OVERLAY_H}"
                 preserveAspectRatio="none"
                 xmlns="http://www.w3.org/2000/svg">
                ${solarToBatt.active ? this._flowLine("solar-battery", getFlowColor("solar"), solarToBatt, "62", "48", "138", "120", true) : ""}
                ${gridToHouse.active ? this._flowLine("grid-house", getFlowColor("grid"), gridToHouse, "138", "48", "62", "120", true) : ""}
                ${battToHouse.active ? this._flowLine("battery-house", getFlowColor("battery"), battToHouse, "130", "133", "70", "133", true) : ""}
            </svg>`;
    }

    private _flowH(key: string, color: string, reverse: boolean, flow: DrawnEdge, leftOverhang = 0, rightOverhang = 0) {
        // connectorW matches the 20px CSS grid connector column so absolute SVG
        // coordinates (no viewBox) map 1:1 to pixels, letting us reach actual
        // picture borders on both sides via overflow:visible.
        const connectorW = 20;
        const x1 = reverse ? connectorW + rightOverhang : -leftOverhang;
        const x2 = reverse ? -leftOverhang : connectorW + rightOverhang;
        return html`
            <svg width="100%" height="100%" style="display:block; overflow:visible">
                ${this._flowLine(key, color, flow, String(x1), "50%", String(x2), "50%")}
            </svg>`;
    }

    private _flowV(key: string, color: string, reverse: boolean, flow: DrawnEdge) {
        const y1 = reverse ? "100%" : "0%";
        const y2 = reverse ? "0%" : "100%";
        return html`
            <svg width="100%" height="100%" style="display:block; overflow:visible">
                ${this._flowLine(key, color, flow, "50%", y1, "50%", y2)}
            </svg>`;
    }

    /**
     * A beam from its first endpoint to its second: its bloom, the body in
     * the flow's colour, a hot core along it, and the tier's surges, clipped
     * to the beam's ends by a mask of its own shape. The bloom is a blurred
     * copy of the body under it (a shadow's blur radius is twice the blur's
     * deviation) rather than a shadow of the body, so the body's opacity does
     * not dim it.
     *
     * Only the surges animate, and only their transform. vector-effect is
     * kept off them: a non-scaling stroke takes the animation off the
     * compositor, to a style recalc and a paint every frame. On the overlay,
     * whose viewBox stretches with the card's configured size, a surge is
     * drawn in px instead: unscaled by the overlay's scale and turned to the
     * beam's on-screen angle.
     */
    private _flowLine(key: string, color: string, { beam, short }: DrawnEdge, x1: string, y1: string, x2: string, y2: string, nonScaling = false) {
        const gradientId = `${this._flowId}-${key}-gradient`;
        const maskId = `${this._flowId}-${key}-mask`;
        const vectorEffect = nonScaling ? "non-scaling-stroke" : "none";
        const { reach, surges } = flowSurges(beam.tier, short, LEAVES_AT);
        const travel = (start: string, end: string) =>
            `${(parseFloat(end) - parseFloat(start)) * reach}${start.endsWith("%") ? "%" : "px"}`;
        // A vertical connector's length is its cell's height, a percentage of
        // it; every other beam is drawn in units its length can be taken in.
        const vertical = x1 === x2;
        const dx = parseFloat(x2) - parseFloat(x1);
        const dy = vertical ? 0 : parseFloat(y2) - parseFloat(y1);
        const halfThickness = beam.surgeThickness / 2;
        const [scaleX, scaleY] = nonScaling
            ? [(this._config?.width ?? OVERLAY_W) / OVERLAY_W, (this._config?.height ?? OVERLAY_H) / OVERLAY_H]
            : [1, 1];
        const halfLength = flowSurgeLength(Math.hypot(dx * scaleX, dy * scaleY)) / 2;
        const blob = vertical
            ? svg`<ellipse cx=${x1} cy=${y1} rx=${halfThickness} style="ry: calc(${FLOW_SURGE_LENGTH_CSS} / 2)" fill="url(#${gradientId})"/>`
            : nonScaling
                ? svg`<ellipse rx=${halfLength} ry=${halfThickness} fill="url(#${gradientId})"
                        transform="translate(${x1} ${y1}) scale(${1 / scaleX} ${1 / scaleY}) rotate(${Math.atan2(dy * scaleY, dx * scaleX) * 180 / Math.PI})"/>`
                : svg`<ellipse cx=${x1} cy=${y1} rx=${halfLength} ry=${halfThickness} fill="url(#${gradientId})"/>`;
        return svg`
            <defs>
                <radialGradient id=${gradientId}>
                    ${flowSurgeStops(color).map(([offset, stop]) => svg`<stop offset=${offset} style="stop-color: ${offset === 1 ? color : stop}; stop-opacity: ${offset === 1 ? 0 : 1}"/>`)}
                </radialGradient>
                <mask id=${maskId} maskUnits="userSpaceOnUse" x="-1000" y="-1000" width="2000" height="2000">
                    <line x1=${x1} y1=${y1} x2=${x2} y2=${y2}
                          stroke="white" stroke-width=${beam.surgeThickness} stroke-linecap="round"
                          vector-effect=${vectorEffect}/>
                </mask>
            </defs>
            <line class="flow-bloom" x1=${x1} y1=${y1} x2=${x2} y2=${y2}
                  stroke-width=${beam.width}
                  vector-effect=${vectorEffect}
                  style="stroke: ${beam.bloomColor}; filter: blur(${beam.bloomBlur / 2}px)"/>
            <line class="flow-beam" data-flow=${key} x1=${x1} y1=${y1} x2=${x2} y2=${y2}
                  stroke=${color} stroke-width=${beam.width}
                  vector-effect=${vectorEffect}
                  style="opacity: ${beam.bodyOpacity}"/>
            <line class="flow-core" x1=${x1} y1=${y1} x2=${x2} y2=${y2}
                  stroke-width=${beam.coreWidth}
                  vector-effect=${vectorEffect}
                  style="stroke: ${flowHot(color)}; opacity: ${beam.bodyOpacity}"/>
            <g mask="url(#${maskId})" opacity=${beam.surgeOpacity}>
                ${surges.map((surge) => svg`
                    <g class="flow-surge" data-beat="surge" data-tier=${beam.tier} ?data-short=${short}
                       style="--surge-x: ${travel(x1, x2)}; --surge-y: ${travel(y1, y2)}; --surge-rest: ${surge.rest}; --beat-delay: ${surge.delay}">
                        ${blob}
                    </g>`)}
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
