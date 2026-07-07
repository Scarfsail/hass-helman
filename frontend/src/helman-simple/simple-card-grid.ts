import { LitElement, css, html, svg } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { formatPower } from "../power-format";
import { getGridInternalFlowColors } from "./flow-colors";
import { simpleCardSharedStyles } from "./simple-card-shared-styles";

@customElement("simple-card-grid")
export class SimpleCardGrid extends LitElement {
    // Static styles
    static styles = [simpleCardSharedStyles, css`
        :host {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            width: fit-content;
        }
        .svg-wrapper {
            width: 50px;
            height: 50px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        svg { overflow: hidden; }

        .pole { fill: var(--simple-card-neutral-stroke); transition: fill 0.6s; }
        .pole.import, .pole.export { fill: var(--simple-card-source-grid); filter: drop-shadow(0 0 6px var(--simple-card-source-grid-99)); }

        .wire { stroke: var(--simple-card-neutral-stroke-soft); stroke-width: 1.5; fill: none; transition: stroke 0.6s; }
        /* wire color when active is set dynamically via sourceColor prop */

        .dot-import {
            fill: var(--simple-card-grid-accent);
            animation: flow-in 1.6s linear infinite;
        }
        /* export dot color is set dynamically via sourceColor prop */
        .dot-export {
            animation: flow-out 1.6s linear infinite;
        }

        /* Import: dots move from right to center (toward house) */
        @keyframes flow-in {
            0%   { offset-distance: 0%;   opacity: 0; }
            10%  { opacity: 1; }
            90%  { opacity: 1; }
            100% { offset-distance: 100%; opacity: 0; }
        }
        /* Export: dots move from center outward */
        @keyframes flow-out {
            0%   { offset-distance: 100%; opacity: 0; }
            10%  { opacity: 1; }
            90%  { opacity: 1; }
            100% { offset-distance: 0%;   opacity: 0; }
        }

        .power-label.import, .power-label.export { color: var(--simple-card-source-grid); }
    `];

    // Private properties
    private readonly _uid = Math.random().toString(36).slice(2);
    private get _wlId() { return `wl-${this._uid}`; }
    private get _wcId() { return `wc-${this._uid}`; }
    private get _wrId() { return `wr-${this._uid}`; }

    // Public properties
    /** Positive = importing from grid, negative = exporting to grid */
    @property({ type: Number }) public power = 0;
    /** When exporting: color of the energy source supplying the export (e.g. solar yellow). */
    @property({ type: String }) public sourceColor?: string;
    /** When true: renders SVG at 40px and suppresses the power label (for use as an icon). */
    @property({ type: Boolean }) public compact = false;

    // Render method
    render() {
        const importing = this.power > 50;
        const exporting = this.power < -50;
        const isActive = importing || exporting;
        const stateClass = importing ? 'import' : exporting ? 'export' : '';
        const absPower = Math.abs(this.power);
        const { value, unit } = formatPower(absPower);
        const flowColors = getGridInternalFlowColors(importing, this.sourceColor);
        const wireColor = isActive ? flowColors.base : undefined;
        const wireGlow = isActive ? flowColors.glow : undefined;
        const svgSize = this.compact ? 40 : 50;

        return html`
            <div class="svg-wrapper" style="${this.compact ? 'width:40px;height:40px;' : ''}">
                <svg viewBox="-15 -8 110 110" width="${svgSize}" height="${svgSize}" xmlns="http://www.w3.org/2000/svg">
                    ${this._renderPylon(stateClass, wireColor, wireGlow)}
                    ${isActive ? this._renderFlowDots(importing, flowColors.accent) : ''}
                </svg>
            </div>
            ${this.compact ? '' : html`
            <div class="power-label ${stateClass}">
                ${value} <span class="unit">${unit}</span>
            </div>`}
        `;
    }

    // Private helper methods
    private _renderPylon(stateClass: string, wireColor?: string, wireGlow?: string) {
        const wireStyle = wireColor && wireGlow ? `stroke: ${wireColor}; filter: drop-shadow(0 0 4px ${wireGlow})` : '';
        return svg`
            <!-- Base -->
            <rect class="pole ${stateClass}" x="32" y="68" width="16" height="9" rx="2"/>
            <!-- Vertical post -->
            <rect class="pole ${stateClass}" x="38" y="20" width="4" height="50" rx="1.5"/>
            <!-- Cross arm top -->
            <rect class="pole ${stateClass}" x="14" y="23" width="52" height="5" rx="2"/>
            <!-- Diagonal supports -->
            <polygon class="pole ${stateClass}" points="40,40 16,28 19,27"/>
            <polygon class="pole ${stateClass}" points="40,40 62,28 65,27"/>
            <!-- Crossarm insulators -->
            <circle class="pole ${stateClass}" cx="17" cy="26" r="3"/>
            <circle class="pole ${stateClass}" cx="40" cy="21" r="3"/>
            <circle class="pole ${stateClass}" cx="63" cy="26" r="3"/>
            <!-- Wires -->
            <path class="wire" style="${wireStyle}" d="M17,29 Q14,46 13,58"/>
            <path class="wire" style="${wireStyle}" d="M40,24 Q40,44 40,58"/>
            <path class="wire" style="${wireStyle}" d="M63,29 Q66,46 67,58"/>
        `;
    }

    private _renderFlowDots(importing: boolean, dotColor: string) {
        const dotClass = importing ? 'dot-import' : 'dot-export';
        const dotStyle = importing ? '' : `fill: ${dotColor}`;
        return svg`
            <circle class="dot ${dotClass}" style="${dotStyle}" r="3">
                <animateMotion dur="1.6s" repeatCount="indefinite" begin="0s"
                    keyPoints="${importing ? '0;1' : '1;0'}" keyTimes="0;1" calcMode="linear">
                    <mpath href="#${this._wlId}"/>
                </animateMotion>
            </circle>
            <circle class="dot ${dotClass}" style="${dotStyle}" r="3">
                <animateMotion dur="1.6s" repeatCount="indefinite" begin="0.4s"
                    keyPoints="${importing ? '0;1' : '1;0'}" keyTimes="0;1" calcMode="linear">
                    <mpath href="#${this._wcId}"/>
                </animateMotion>
            </circle>
            <circle class="dot ${dotClass}" style="${dotStyle}" r="3">
                <animateMotion dur="1.6s" repeatCount="indefinite" begin="0.8s"
                    keyPoints="${importing ? '0;1' : '1;0'}" keyTimes="0;1" calcMode="linear">
                    <mpath href="#${this._wrId}"/>
                </animateMotion>
            </circle>
            <defs>
                <path id="${this._wlId}" d="M17,29 Q14,46 13,58"/>
                <path id="${this._wcId}" d="M40,24 Q40,44 40,58"/>
                <path id="${this._wrId}" d="M63,29 Q66,46 67,58"/>
            </defs>
        `;
    }
}
