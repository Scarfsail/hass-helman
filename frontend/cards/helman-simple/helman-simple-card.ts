import { LitElement, PropertyValues, css, html, nothing, svg } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
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
import { FLOW_SURGE_LENGTH, flowBeam, flowBeatStyles, flowFadeShare, flowGlow, flowHalo, flowRatio, flowSurges, flowTrailStops, syncFlowRates, type FlowBeam, type FlowBeamLengths } from "../shared/flow-style";
import { dominantFlowColor, getFlowColor, type FlowSource } from "./flow-colors";
import { IDLE_W, liveFlows } from "../node-detail/live-flows";

/** One flow the card draws: its power against its source's maximum. */
interface Edge {
    power: number;
    r: number;
    color: string;
}

/** One edge as drawn: whether it carries power, its ratio and its beam. */
interface DrawnEdge {
    active: boolean;
    r: number;
    beam: FlowBeam;
}

/** The diagonal overlay's viewBox: the energy grid at its default size, px. */
const OVERLAY_W = 200;
const OVERLAY_H = 168;

/** A beam's coordinate as a CSS length: a percentage as it is, a bare number in px. */
/** The vertical connectors' row, px: their length on screen until it is measured. */
const CONNECTOR_ROW_H = 28;

/** A node's halo, while it has a flow: its ratio and its colour. */
interface Halo {
    r: number;
    color: string;
}

/**
 * A node's halo from its flows: it emits in its own colour, or receives in
 * `sourceColor` (its strongest flow's colour without one); no flow, no halo.
 */
function nodeHalo(r: number, ownColor: string, outgoing: Edge[], incoming: Edge[], sourceColor?: string): Halo | null {
    if (outgoing.some((edge) => edge.power > 0)) {
        return { r, color: ownColor };
    }
    const strongest = incoming.filter((edge) => edge.power > 0).sort((a, b) => b.power - a.power)[0];
    return strongest ? { r, color: sourceColor ?? strongest.color } : null;
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
            grid-template-rows: auto ${CONNECTOR_ROW_H}px auto;
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
        .flow-bloom, .flow-beam {
            fill: none;
            stroke-linecap: butt;
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
    /** Each beam's length on screen, px, as `syncFlowRates` measured it: what its surges are drawn from. */
    @state() private _beamLengths: FlowBeamLengths = {};
    /** The diagonal overlay's scale on screen, across and down, read with the beam lengths: what its surges are unscaled by. */
    private _overlayScale: [number, number] = [1, 1];
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
        syncFlowRates(this.renderRoot, (lengths) => {
            const ctm = this.renderRoot.querySelector<SVGSVGElement>(".diagonal-overlay")?.getScreenCTM();
            this._overlayScale = ctm ? [ctm.a, ctm.d] : [1, 1];
            this._beamLengths = lengths;
        });
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
            { key: "solarToGrid", from: "solar" },
            { key: "solarToHouse", from: "solar" },
            { key: "solarToBattery", from: "solar" },
            { key: "gridToBattery", from: "grid" },
            { key: "gridToHouse", from: "grid" },
            { key: "batteryToHouse", from: "battery" },
            { key: "batteryToGrid", from: "battery" },
        ] as const;
        // Every edge and halo is drawn against the one shared scale, so equal watts look equal.
        const scale = energy.flowScaleW;
        const edges = Object.fromEntries(edgeList.map(({ key, from }) => [key, {
            power: flows[key], r: flowRatio(flows[key], scale), color: getFlowColor(from as FlowSource),
        }])) as Record<typeof edgeList[number]["key"], Edge>;
        const edge = (key: keyof typeof edges): DrawnEdge => ({ active: edges[key].power > 0, r: edges[key].r, beam: flowBeam(edges[key].r, edges[key].color) });

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

        // Each node's ratio from its own total power.
        const halos = {
            solar: nodeHalo(flowRatio(solarPower, scale), solarFlowColor,
                [edges.solarToGrid, edges.solarToHouse, edges.solarToBattery], []),
            grid: nodeHalo(flowRatio(Math.abs(effectiveGridPower), scale), gridFlowColor,
                [edges.gridToBattery, edges.gridToHouse], [edges.solarToGrid, edges.batteryToGrid], gridSourceColor),
            house: nodeHalo(flowRatio(housePower, scale), "var(--helman-house)",
                [], [edges.solarToHouse, edges.gridToHouse, edges.batteryToHouse], houseSourceColor),
            battery: nodeHalo(flowRatio(Math.abs(batteryPower), scale), batteryFlowColor,
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
        if (h !== undefined) parts.push(`height: ${h}px`, `grid-template-rows: 1fr ${CONNECTOR_ROW_H}px 1fr`);
        return parts.join("; ");
    }

    /** A node's halo: the level and size on a static wrapper, only the opacity animated, at its own rate. */
    private _halo(halo: Halo | null) {
        if (!halo) return nothing;
        const glow = flowGlow(halo.r);
        const { extent, background } = flowHalo(halo.color, glow.size);
        return html`
            <div class="halo-level" style="opacity: ${glow.level}">
                <div class="halo" data-beat="glow" data-rate=${glow.rate}
                    style="inset: -${extent}px; background: ${background}"></div>
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
     * the flow's colour, and its surges, all under one mask that fades them
     * out into the nodes over `flowFadeShare` of the beam at each end. The
     * bloom is a blurred copy of the body under it (a shadow's blur radius is
     * twice the blur's deviation) rather than a shadow of the body, so the
     * body's opacity does not dim it. The mask reaches three deviations
     * either side, scaled as the overlay is, since the blur is in its units.
     * The static bloom and body and the animated surges are two groups under
     * that mask, so a surge's frame never repaints the blur.
     *
     * Only the surges animate, and only their transform. vector-effect is
     * kept off them: a non-scaling stroke takes the animation off the
     * compositor, to a style recalc and a paint every frame. On the overlay,
     * whose viewBox stretches with the card, a surge is drawn in px instead:
     * unscaled by the overlay's scale on screen, read with the beam lengths,
     * and turned to the beam's on-screen angle.
     *
     * The surges come from the beam's length on screen, as `syncFlowRates`
     * measured it (`data-flow-beam`): how many, their rate, and on every beam
     * but a vertical one, which takes its length as a CSS percentage, where
     * a surge's centre starts. So does the fade, which until then takes the
     * beam's length in its own units, scaled as the overlay is, or a vertical
     * connector's row.
     */
    private _flowLine(key: string, color: string, { r, beam }: DrawnEdge, x1: string, y1: string, x2: string, y2: string, nonScaling = false) {
        const gradientId = `${this._flowId}-${key}-gradient`;
        const fadeId = `${this._flowId}-${key}-fade`;
        const maskId = `${this._flowId}-${key}-mask`;
        const vectorEffect = nonScaling ? "non-scaling-stroke" : "none";
        const length = this._beamLengths[key];
        const { count, rate, surges } = flowSurges(r, length);
        // A vertical connector's length is its cell's height, a percentage of
        // it; every other beam is drawn in units its length can be taken in.
        const vertical = x1 === x2;
        const dx = parseFloat(x2) - parseFloat(x1);
        const dy = vertical ? 0 : parseFloat(y2) - parseFloat(y1);
        const [scaleX, scaleY] = nonScaling ? this._overlayScale : [1, 1];
        const fade = flowFadeShare(length ?? (vertical ? CONNECTOR_ROW_H : Math.hypot(dx * scaleX, dy * scaleY)));
        const half = FLOW_SURGE_LENGTH / 2;
        // The share of the beam a surge's centre starts back from its start.
        const share = length ? half / length : 0;
        const towards = Math.sign(parseFloat(y2) - parseFloat(y1));
        // The beam's vector, and where a surge's centre starts: half its length back from the beam's start.
        const surgeVector = vertical
            ? `--surge-x: 0px; --surge-y: ${parseFloat(y2) - parseFloat(y1)}%; --surge-start-x: 0px; --surge-start-y: ${-towards * half}px`
            : `--surge-x: ${dx}px; --surge-y: ${dy}px; --surge-start-x: ${-dx * share}px; --surge-start-y: ${-dy * share}px`;
        // A surge runs along its own x from its tail to its head, turned to the beam on the overlay; on a
        // straight connector it lies along the connector, which may run either way, and its gradient with it.
        const across = beam.surgeWidth;
        const [ux, uy] = nonScaling ? [1, 0] : vertical ? [0, towards] : [Math.sign(dx), 0];
        const pulse = nonScaling
            ? svg`<rect x=${-half} y=${-across / 2} width=${FLOW_SURGE_LENGTH} height=${across} rx=${across / 2} fill="url(#${gradientId})"
                    transform="translate(${x1} ${y1}) scale(${1 / scaleX} ${1 / scaleY}) rotate(${Math.atan2(dy * scaleY, dx * scaleX) * 180 / Math.PI})"/>`
            : svg`<rect x=${x1} y=${y1} width=${vertical ? across : FLOW_SURGE_LENGTH} height=${vertical ? FLOW_SURGE_LENGTH : across} rx=${across / 2} fill="url(#${gradientId})"
                    transform="translate(${vertical ? -across / 2 : -half} ${vertical ? -half : -across / 2})"/>`;
        // Keyed by their count: a new count starts the edge's surges afresh, together, so they stay evenly spread.
        return svg`
            <defs>
                <linearGradient id=${gradientId} x1=${(1 - ux) / 2} y1=${(1 - uy) / 2} x2=${(1 + ux) / 2} y2=${(1 + uy) / 2}>
                    ${flowTrailStops(color, beam).map(([offset, stop, strength]) => svg`<stop offset=${offset} style="stop-color: ${stop}; stop-opacity: ${strength}"/>`)}
                </linearGradient>
                <linearGradient id=${fadeId} gradientUnits="userSpaceOnUse" x1=${x1} y1=${y1} x2=${x2} y2=${y2}>
                    ${[[0, 0], [fade, 1], [1 - fade, 1], [1, 0]].map(([offset, opacity]) => svg`<stop offset=${offset} stop-color="white" stop-opacity=${opacity}/>`)}
                </linearGradient>
                <mask id=${maskId} maskUnits="userSpaceOnUse" x="-1000" y="-1000" width="2000" height="2000">
                    <line x1=${x1} y1=${y1} x2=${x2} y2=${y2}
                          stroke="url(#${fadeId})" stroke-width=${beam.width + 3 * beam.bloomBlur * Math.max(scaleX, scaleY)} stroke-linecap="butt"
                          vector-effect=${vectorEffect}/>
                </mask>
            </defs>
            <g mask="url(#${maskId})">
                <line class="flow-bloom" x1=${x1} y1=${y1} x2=${x2} y2=${y2}
                      stroke-width=${beam.width}
                      vector-effect=${vectorEffect}
                      style="stroke: ${beam.bloomColor}; filter: blur(${beam.bloomBlur / 2}px)"/>
                <line class="flow-beam" data-flow-beam=${key} data-flow=${key} x1=${x1} y1=${y1} x2=${x2} y2=${y2}
                      stroke=${color} stroke-width=${beam.width}
                      vector-effect=${vectorEffect}
                      style="opacity: ${beam.bodyOpacity}"/>
            </g>
            <g mask="url(#${maskId})" opacity=${beam.surgeOpacity}>
                ${keyed(count, surges.map((surge) => svg`
                    <g class="flow-surge" data-beat="surge" data-rate=${rate}
                       style="${surgeVector}; --surge-rest: ${surge.rest}; animation-delay: ${surge.delay}">
                        ${pulse}
                    </g>`))}
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
