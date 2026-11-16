import { formatPower } from "../shared/format";
import { LitElement, css, html, svg, unsafeCSS } from "lit-element";
import { customElement, property } from "lit/decorators.js";

import { helmanColorVars } from "../color-vars";
import { WIRE_SWEEP_MS } from "../shared/flow-style";
import { simpleCardSharedStyles } from "./simple-card-shared-styles";

/** The pylon's three wires: their path, and their top and bottom ends, in its view box. */
const WIRES = [
    { d: "M17,29 Q14,46 13,58", top: [17, 29], bottom: [13, 58] },
    { d: "M40,24 Q40,44 40,58", top: [40, 24], bottom: [40, 58] },
    { d: "M63,29 Q66,46 67,58", top: [63, 29], bottom: [67, 58] },
] as const;

@customElement("simple-card-grid")
export class SimpleCardGrid extends LitElement {
    // Static styles
    static styles = [helmanColorVars, simpleCardSharedStyles, css`
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
        .pole.import { fill: var(--simple-card-source-grid); filter: drop-shadow(0 0 6px color-mix(in srgb, var(--simple-card-source-grid) 60%, transparent)); }
        .pole.export { fill: var(--helman-grid-export); filter: drop-shadow(0 0 6px color-mix(in srgb, var(--helman-grid-export) 60%, transparent)); }

        .wire { stroke: var(--simple-card-neutral-stroke-soft); stroke-width: 1.5; fill: none; transition: stroke 0.6s; }
        /* wire color when active is set dynamically via sourceColor prop */

        /*
         * A dot runs down its wire, from its top end to its bottom one on import and back on
         * export, fading in and out at the ends. Only its transform and opacity animate, so the
         * compositor runs it without a style recalc, a layout or a paint on the main thread.
         */
        .dot {
            animation: wire-dot ${unsafeCSS(WIRE_SWEEP_MS)}ms linear infinite;
        }
        .dot-import { fill: var(--simple-card-grid-accent); }
        /* export dot color is set dynamically via sourceColor prop */
        @keyframes wire-dot {
            0%   { transform: translate(var(--from-x), var(--from-y)); opacity: 0; }
            10%  { opacity: 1; }
            90%  { opacity: 1; }
            100% { transform: translate(var(--to-x), var(--to-y)); opacity: 0; }
        }

        .power-label.import { color: var(--simple-card-source-grid); }
        .power-label.export { color: var(--helman-grid-export); }
    `];

    // Private properties
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
        const { value, unit } = formatPower(this.power);
        const wireColor = isActive ? (importing ? 'var(--helman-grid)' : this.sourceColor ?? 'var(--helman-grid)') : undefined;
        const wireGlow = wireColor ? `color-mix(in srgb, ${wireColor} 60%, transparent)` : undefined;
        const svgSize = this.compact ? 40 : 50;

        return html`
            <div class="svg-wrapper" style="${this.compact ? 'width:40px;height:40px;' : ''}">
                <svg viewBox="-15 -8 110 110" width="${svgSize}" height="${svgSize}" xmlns="http://www.w3.org/2000/svg">
                    ${this._renderPylon(stateClass, wireColor, wireGlow)}
                    ${isActive ? this._renderFlowDots(importing, wireColor!) : ''}
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
            ${WIRES.map((wire) => svg`<path class="wire" style="${wireStyle}" d="${wire.d}"/>`)}
        `;
    }

    /**
     * One dot per wire, a quarter of a sweep apart, each running straight between its wire's
     * ends: the wires bow by at most a unit of the 110-unit view box, so a straight run stays on them.
     */
    private _renderFlowDots(importing: boolean, dotColor: string) {
        const dotClass = importing ? 'dot-import' : 'dot-export';
        const fill = importing ? '' : `fill: ${dotColor}; `;
        return WIRES.map(({ top, bottom }, index) => {
            const [from, to] = importing ? [top, bottom] : [bottom, top];
            return svg`<circle class="dot ${dotClass}" r="3"
                style="${fill}--from-x: ${from[0]}px; --from-y: ${from[1]}px; --to-x: ${to[0]}px; --to-y: ${to[1]}px; animation-delay: -${index * WIRE_SWEEP_MS / 4}ms"/>`;
        });
    }
}
