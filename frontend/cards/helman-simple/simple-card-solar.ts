import { LitElement, css, html, svg } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { formatPower } from "../power-format";
import { simpleCardSharedStyles } from "./simple-card-shared-styles";

@customElement("simple-card-solar")
export class SimpleCardSolar extends LitElement {
    // Static styles
    static styles = [simpleCardSharedStyles, css`
        :host {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 3px;
            width: fit-content;
        }
        .svg-wrapper {
            width: 50px;
            height: 50px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        svg {
            overflow: visible;
        }
        .rays {
            transform-origin: 40px 40px;
        }
        .rays.active {
            animation: sun-rotate 12s linear infinite;
        }
        @keyframes sun-rotate {
            to { transform: rotate(360deg); }
        }
        .core {
            fill: var(--simple-card-surface-light);
            transition: fill 0.6s, filter 0.6s;
        }
        .core.active {
            fill: var(--simple-card-source-solar);
            filter: drop-shadow(0 0 10px var(--simple-card-solar-glow-color)) drop-shadow(0 0 20px var(--simple-card-source-solar-99));
        }
        .ray {
            fill: var(--simple-card-neutral-stroke);
            opacity: 0.6;
            transition: fill 0.6s;
        }
        .ray.active {
            fill: var(--simple-card-warm-soft-color);
            opacity: 0.9;
        }
        .power-label.active {
            color: var(--simple-card-source-solar);
        }
    `];

    // Public properties
    @property({ type: Number }) public power = 0;
    /** When true: renders SVG at 40px and suppresses the power label (for use as an icon). */
    @property({ type: Boolean }) public compact = false;

    // Render method
    render() {
        const active = this.power > 50;
        const { value, unit } = formatPower(this.power);
        const svgSize = this.compact ? 40 : 45;

        return html`
            <div class="svg-wrapper" style="${this.compact ? 'width:40px;height:40px;' : ''}">
                <svg viewBox="0 0 80 80" width="${svgSize}" height="${svgSize}" xmlns="http://www.w3.org/2000/svg">
                    <g class="rays ${active ? 'active' : ''}">
                        ${[0, 45, 90, 135, 180, 225, 270, 315].map(angle => svg`
                            <rect
                                class="ray ${active ? 'active' : ''}"
                                x="38" y="3"
                                width="4" height="14" rx="2"
                                transform="rotate(${angle} 40 40)"
                            />
                        `)}
                    </g>
                    <circle class="core ${active ? 'active' : ''}" cx="40" cy="40" r="17"/>
                </svg>
            </div>
            ${this.compact ? '' : html`
            <div class="power-label ${active ? 'active' : ''}">
                ${value} <span class="unit">${unit}</span>
            </div>`}
        `;
    }
}
