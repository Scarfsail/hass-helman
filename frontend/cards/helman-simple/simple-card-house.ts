import { LitElement, css, html, svg } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { formatPower } from "../power-format";
import { withAlpha } from "../color-utils";
import { SIMPLE_CARD_COLORS } from "./simple-card-colors";
import { simpleCardSharedStyles } from "./simple-card-shared-styles";

const { neutral, state: colorState } = SIMPLE_CARD_COLORS;

type HouseView = {
    svgSize: number;
    wrapperStyle: string;
    windowColorStyle: string;
    bodyStyle: string;
    roofStyle: string;
    doorStyle: string;
    crossColor: string;
    knobColor: string;
    activeClass: string;
    powerLabelClass: string;
    showPowerLabel: boolean;
    formattedValue: string | number;
    formattedUnit: string;
};

@customElement("simple-card-house")
export class SimpleCardHouse extends LitElement {
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
        svg { overflow: visible; }

        .house-body {
            fill: var(--simple-card-surface-mid);
            stroke: var(--simple-card-neutral-stroke);
            stroke-width: 2;
            transition: fill 0.6s, stroke 0.6s;
        }
        .house-body.active {
            fill: var(--simple-card-surface-light);
            stroke: var(--simple-card-warm-color);
            animation: house-glow 2.4s ease-in-out infinite;
        }
        @keyframes house-glow {
            0%, 100% { filter: drop-shadow(0 0 4px var(--simple-card-warm-color-44)); }
            50%       { filter: drop-shadow(0 0 14px var(--simple-card-warm-color-99)) drop-shadow(0 0 24px var(--simple-card-warm-color-44)); }
        }
        .roof {
            fill: var(--simple-card-neutral-stroke-soft);
            stroke: var(--simple-card-neutral-stroke);
            stroke-width: 2;
            stroke-linejoin: round;
            transition: fill 0.6s, stroke 0.6s;
        }
        .roof.active {
            fill: var(--simple-card-surface-lightest);
            stroke: var(--simple-card-warm-color);
        }
        .door {
            fill: var(--simple-card-surface-dark);
            stroke: var(--simple-card-neutral-stroke);
            stroke-width: 1.5;
        }
        .door.active {
            fill: var(--simple-card-surface-dark-soft);
            stroke: var(--simple-card-warm-color-88);
        }
        .window {
            fill: var(--simple-card-surface-dark);
            stroke: var(--simple-card-neutral-stroke-soft);
            stroke-width: 1;
            transition: fill 0.6s, filter 0.6s;
        }
        .window.active {
            fill: var(--window-color, var(--simple-card-warm-soft-color));
            animation: window-glow 2.4s ease-in-out infinite;
        }
        @keyframes window-glow {
            0%, 100% { filter: drop-shadow(0 0 4px var(--window-color, var(--simple-card-warm-soft-color))); opacity: 0.85; }
            50%       { filter: drop-shadow(0 0 10px var(--window-color, var(--simple-card-warm-soft-color))); opacity: 1; }
        }
        .chimney {
            fill: var(--simple-card-neutral-stroke-soft);
            stroke: var(--simple-card-neutral-stroke);
            stroke-width: 1.5;
        }

        .power-label.active { color: var(--simple-card-surface-lightest); }
    `];

    // Public properties
    @property({ type: Number }) public power = 0;
    /** Blended source color based on power ratios from solar/grid/battery. */
    @property({ type: String }) public sourceColor?: string;
    /** When true: renders SVG at 40px and suppresses the power label (for use as an icon). */
    @property({ type: Boolean }) public compact = false;

    // State properties
    @state() private _view?: HouseView;

    // Lifecycle methods
    willUpdate(changedProperties: Map<string, unknown>): void {
        if (!changedProperties.has('power')
            && !changedProperties.has('sourceColor')
            && !changedProperties.has('compact')
            && this._view !== undefined) {
            return;
        }

        const active = this.power > 50;
        const borderColor = (active && this.sourceColor) ? this.sourceColor : undefined;
        const { value, unit } = formatPower(this.power);

        const bodyStyle = (active && borderColor)
            ? `stroke: ${borderColor}; filter: drop-shadow(0 0 8px ${withAlpha(borderColor, '44')})`
            : '';
        const roofStyle = (active && borderColor) ? `stroke: ${borderColor}` : '';
        const doorStyle = (active && borderColor) ? `stroke: ${withAlpha(borderColor, '88')}` : '';
        const crossColor = active ? (borderColor ? withAlpha(borderColor, '66') : withAlpha(colorState.warm, '66')) : neutral.surfaceMid;
        const knobColor  = active ? (borderColor ? withAlpha(borderColor, '88') : withAlpha(colorState.warm, '88')) : neutral.strokeSoft;

        this._view = {
            svgSize: this.compact ? 40 : 50,
            wrapperStyle: this.compact ? 'width:40px;height:40px;' : '',
            windowColorStyle: borderColor ? `--window-color: ${borderColor}` : '',
            bodyStyle,
            roofStyle,
            doorStyle,
            crossColor,
            knobColor,
            activeClass: active ? 'active' : '',
            powerLabelClass: active ? 'active' : '',
            showPowerLabel: !this.compact,
            formattedValue: value,
            formattedUnit: unit,
        };
    }

    // Render method
    render() {
        if (!this._view) return html``;
        const v = this._view;
        return html`
            <div class="svg-wrapper" style="${v.wrapperStyle}">
                <svg viewBox="-15 -14 110 110" width="${v.svgSize}" height="${v.svgSize}" xmlns="http://www.w3.org/2000/svg"
                     style="${v.windowColorStyle}">
                    ${this._renderHouse(v)}
                </svg>
            </div>
            ${v.showPowerLabel ? html`
            <div class="power-label ${v.powerLabelClass}">
                ${v.formattedValue} <span class="unit">${v.formattedUnit}</span>
            </div>` : ''}
        `;
    }

    // Private helper methods
    private _renderHouse(v: HouseView) {
        return svg`
            <!-- Chimney -->
            <rect class="chimney" x="52" y="15" width="7" height="16" rx="1.5"/>

            <!-- Roof -->
            <polygon class="roof ${v.activeClass}" style="${v.roofStyle}" points="40,6 73,36 7,36"/>

            <!-- House body -->
            <rect class="house-body ${v.activeClass}" style="${v.bodyStyle}" x="13" y="35" width="54" height="41" rx="2"/>

            <!-- Left window -->
            <rect class="window ${v.activeClass}" x="19" y="42" width="15" height="13" rx="2"/>
            <line stroke="${v.crossColor}" stroke-width="1"
                  x1="26" y1="42" x2="26" y2="55"/>
            <line stroke="${v.crossColor}" stroke-width="1"
                  x1="19" y1="48" x2="34" y2="48"/>

            <!-- Right window -->
            <rect class="window ${v.activeClass}" x="46" y="42" width="15" height="13" rx="2"/>
            <line stroke="${v.crossColor}" stroke-width="1"
                  x1="53" y1="42" x2="53" y2="55"/>
            <line stroke="${v.crossColor}" stroke-width="1"
                  x1="46" y1="48" x2="61" y2="48"/>

            <!-- Door -->
            <rect class="door ${v.activeClass}" style="${v.doorStyle}" x="32" y="54" width="16" height="22" rx="2"/>
            <!-- Door knob -->
            <circle fill="${v.knobColor}" cx="45" cy="65" r="1.5"/>
        `;
    }
}
