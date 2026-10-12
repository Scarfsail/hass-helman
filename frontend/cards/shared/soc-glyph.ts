import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { helmanColorVars } from "../color-vars";

/** Which way the stored energy is moving. */
export type SocDirection = "charge" | "discharge" | "idle";

/** The glyph's geometry, px: an upright body with a cap, labels on the right. */
const BODY_X = 1;
const BODY_Y = 7;
const BODY_W = 60;
const BODY_H = 124;
/** The fill area inside the body's stroke. */
const INNER_X = BODY_X + 3;
const INNER_Y = BODY_Y + 3;
const INNER_W = BODY_W - 6;
const INNER_H = BODY_H - 6;
const LABEL_X = BODY_X + BODY_W + 5;
const WIDTH = 108;
const HEIGHT = BODY_Y + BODY_H + 1;
/** The text block (percentage over usable energy) needs this much fill to sit inside it. */
const TEXT_IN_FILL = 32;
/** The empty part holds the room label only when it is at least this tall. */
const ROOM_IN_GAP = 16;
/** Marker labels closer than this are pushed apart. */
const LABEL_GAP = 12;

/**
 * An upright battery whose fill is the state of charge, the shared picture of
 * stored energy: the battery detail's flow centre, and the car's in the EV
 * charger detail.
 *
 * The percentage and the usable energy sit inside; the range outside min and
 * max is hatched, with dashed markers labelled on the right. The room to max
 * shows in the empty part, and joins the max label when the empty part is too
 * thin to hold it. Chevrons move up while charging and down while
 * discharging, and are still at idle; `prefers-reduced-motion` stops them.
 * `hide-min` drops the min marker, for a car that has a charge limit but no
 * floor. A missing SoC draws an empty body, never a zero fill.
 */
@customElement("helman-soc-glyph")
export class HelmanSocGlyph extends LitElement {
    static styles = [helmanColorVars, css`
        :host {
            display: inline-block;
            line-height: 0;
        }
        svg {
            overflow: visible;
        }
        .body {
            fill: var(--card-background-color, #fff);
            stroke: var(--secondary-text-color, #727272);
            stroke-width: 2;
        }
        .cap {
            fill: var(--secondary-text-color, #727272);
        }
        .fill {
            fill: var(--helman-battery);
            fill-opacity: 0.55;
        }
        .hatch-line {
            stroke: var(--secondary-text-color, #727272);
            stroke-opacity: 0.45;
            stroke-width: 1.2;
        }
        .marker {
            stroke: var(--primary-text-color, #212121);
            stroke-width: 1.2;
            stroke-dasharray: 3 2;
        }
        text {
            fill: var(--primary-text-color, #212121);
            font-family: inherit;
        }
        .soc {
            font-size: 14px;
            font-weight: 700;
        }
        .inside {
            font-size: 9.5px;
        }
        .marker-label {
            font-size: 9.5px;
            fill: var(--secondary-text-color, #727272);
        }
        .chevron {
            fill: none;
            stroke: var(--primary-text-color, #212121);
            stroke-width: 1.6;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        .chevrons.idle .chevron {
            stroke: var(--secondary-text-color, #727272);
        }
        .chevrons.charge {
            animation: rise 1.4s linear infinite;
        }
        .chevrons.discharge {
            animation: fall 1.4s linear infinite;
        }
        @keyframes rise {
            from { transform: translateY(4px); opacity: 0.2; }
            50% { opacity: 1; }
            to { transform: translateY(-4px); opacity: 0.2; }
        }
        @keyframes fall {
            from { transform: translateY(-4px); opacity: 0.2; }
            50% { opacity: 1; }
            to { transform: translateY(4px); opacity: 0.2; }
        }
        @media (prefers-reduced-motion: reduce) {
            .chevrons.charge,
            .chevrons.discharge {
                animation: none;
            }
        }
    `];

    /** The state of charge, %; `null` without a reading. */
    @property({ type: Number }) public soc: number | null = null;
    @property({ type: Number }) public min: number | null = null;
    @property({ type: Number }) public max: number | null = null;
    /** The usable energy above min, as shown inside; omitted when unknown. */
    @property({ attribute: false }) public usableLabel: string | null = null;
    /** The room below max, as shown in the empty part; omitted when unknown. */
    @property({ attribute: false }) public roomLabel: string | null = null;
    /** The marker labels; the bare percentage when not given. */
    @property({ attribute: false }) public minLabel: string | null = null;
    @property({ attribute: false }) public maxLabel: string | null = null;
    @property() public direction: SocDirection = "idle";
    @property({ type: Boolean, attribute: "hide-min" }) public hideMin = false;

    render() {
        const soc = this.soc === null ? null : clampPct(this.soc);
        const min = this.hideMin || this.min === null ? null : clampPct(this.min);
        const max = this.max === null ? null : clampPct(this.max);
        const bottom = INNER_Y + INNER_H;
        const fillTop = soc === null ? bottom : yOf(soc);
        const fillHeight = bottom - fillTop;

        // The percentage and usable energy inside the fill when it is tall
        // enough, else just above it.
        const textInFill = fillHeight >= TEXT_IN_FILL;
        const textCentre = Math.min(bottom - 16, Math.max(INNER_Y + 16,
            textInFill ? (fillTop + bottom) / 2 : fillTop - 18));
        const textTop = textCentre - 14;

        // The room label sits in the empty part below max when the text
        // block is not there and the part is tall enough; otherwise it joins
        // the max label.
        const maxY = max === null ? INNER_Y : yOf(max);
        const gapCentre = (maxY + fillTop) / 2;
        const roomInGap = this.roomLabel !== null && soc !== null && fillTop - maxY >= ROOM_IN_GAP
            && (textInFill || Math.abs(gapCentre - textCentre) > 22);

        let maxLabelY = max === null ? null : yOf(max);
        let minLabelY = min === null ? null : yOf(min);
        if (maxLabelY !== null && minLabelY !== null && minLabelY - maxLabelY < LABEL_GAP) {
            const middle = (maxLabelY + minLabelY) / 2;
            maxLabelY = middle - LABEL_GAP / 2;
            minLabelY = middle + LABEL_GAP / 2;
        }

        const label = [
            soc === null ? null : Math.round(soc) + " %",
            this.usableLabel,
            this.roomLabel,
        ].filter(Boolean).join(", ");

        return html`
            <svg width=${WIDTH} height=${HEIGHT} viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label=${label || nothing}>
                <defs>
                    <clipPath id="inner">
                        <rect x=${INNER_X} y=${INNER_Y} width=${INNER_W} height=${INNER_H} rx="5"></rect>
                    </clipPath>
                    <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                        <line class="hatch-line" x1="0" y1="0" x2="0" y2="6"></line>
                    </pattern>
                </defs>
                <rect class="cap" x=${BODY_X + BODY_W / 2 - 9} y="1" width="18" height=${BODY_Y - 1} rx="2"></rect>
                <rect class="body" x=${BODY_X} y=${BODY_Y} width=${BODY_W} height=${BODY_H} rx="8"></rect>
                <g clip-path="url(#inner)">
                    ${soc !== null ? svg`<rect class="fill" data-fill x=${INNER_X} y=${fillTop} width=${INNER_W} height=${fillHeight}></rect>` : nothing}
                    ${max !== null && max < 100 ? svg`<rect data-hatch="max" fill="url(#hatch)" x=${INNER_X} y=${INNER_Y} width=${INNER_W} height=${yOf(max) - INNER_Y}></rect>` : nothing}
                    ${min !== null && min > 0 ? svg`<rect data-hatch="min" fill="url(#hatch)" x=${INNER_X} y=${yOf(min)} width=${INNER_W} height=${bottom - yOf(min)}></rect>` : nothing}
                </g>
                ${max !== null ? this._marker("max", max, maxLabelY!, roomInGap ? null : this.roomLabel) : nothing}
                ${min !== null ? this._marker("min", min, minLabelY!, null) : nothing}
                ${soc !== null ? svg`
                    <text class="soc" data-soc-text x=${INNER_X + (INNER_W - 10) / 2} y=${textTop + 14} text-anchor="middle">${Math.round(soc)} %</text>
                    ${this.usableLabel ? svg`<text class="inside" data-usable x=${INNER_X + (INNER_W - 10) / 2} y=${textTop + 27} text-anchor="middle">${this.usableLabel}</text>` : nothing}
                ` : nothing}
                ${roomInGap ? svg`<text class="inside" data-room x=${INNER_X + (INNER_W - 10) / 2} y=${gapCentre + 3.5} text-anchor="middle">${this.roomLabel}</text>` : nothing}
                ${this._chevrons(textCentre)}
            </svg>
        `;
    }

    /** A dashed marker across the body at `pct`, labelled on the right at `labelY`. */
    private _marker(kind: "min" | "max", pct: number, labelY: number, joined: string | null) {
        const y = yOf(pct);
        const text = (kind === "min" ? this.minLabel : this.maxLabel) ?? Math.round(pct) + " %";
        return svg`
            <line class="marker" data-marker=${kind} data-soc=${pct} x1=${BODY_X - 1} x2=${LABEL_X - 2} y1=${y} y2=${y}></line>
            <text class="marker-label" data-marker-label=${kind} x=${LABEL_X} y=${labelY + 3.5}>${text}${joined
                ? svg`<tspan data-room x=${LABEL_X} dy="11">${joined}</tspan>` : nothing}</text>
        `;
    }

    /** Three chevrons at the body's right edge, up charging, down discharging, flat and still idle. */
    private _chevrons(centre: number) {
        const x = INNER_X + INNER_W - 7;
        const shape = this.direction === "charge" ? "M-3.5,2 L0,-1.5 L3.5,2"
            : this.direction === "discharge" ? "M-3.5,-1.5 L0,2 L3.5,-1.5"
            : "M-3.5,0 L3.5,0";
        return svg`
            <g class="chevrons ${this.direction}" data-chevrons=${this.direction}>
                ${[-6, 0, 6].map((dy) => svg`<path class="chevron" transform="translate(${x} ${centre + dy})" d=${shape}></path>`)}
            </g>
        `;
    }
}

function clampPct(value: number): number {
    return Math.max(0, Math.min(100, value));
}

/** The y of a SoC percentage inside the body. */
function yOf(pct: number): number {
    return INNER_Y + (1 - pct / 100) * INNER_H;
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-soc-glyph": HelmanSocGlyph;
    }
}
