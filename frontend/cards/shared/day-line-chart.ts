import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { formatScheduleTime, getScheduleLocalTimeParts } from "./schedule/model/schedule-time";
import {
    HoverTooltipController,
    hoverTooltipStyles,
    tooltipRow,
    type TooltipBody,
} from "./hover-tooltip";

export interface DayLinePoint {
    /** Bucket start, epoch ms. */
    t: number;
    v: number;
    min?: number;
    max?: number;
}

export interface DayLineSeries {
    key: string;
    label: string;
    color: string;
    points: DayLinePoint[];
}

export interface DayLineReference {
    value: number;
    label: string;
}

/** A labeled range of values, shaded behind the lines. */
export interface DayLineBand {
    from: number;
    to: number;
    label: string;
}

const HEIGHT = 160;
const PAD = { top: 10, right: 12, bottom: 22, left: 54 };

/**
 * A day of one or more readings as lines over local time, with optional
 * labeled reference lines and bands, and a text summary.
 *
 * Gaps stay gaps: a line breaks wherever two points are further apart than
 * `bucketMs`, so missing history is never drawn as a straight run. Every point
 * can be read without hovering: a tap selects the nearest bucket, and with the
 * plot focused the arrow keys walk the buckets (Home/End jump, Escape clears).
 * The selection's popup is the shared hover tooltip.
 */
@customElement("helman-day-line-chart")
export class HelmanDayLineChart extends LitElement {
    static styles = [hoverTooltipStyles, css`
        :host {
            display: block;
        }
        .plot {
            position: relative;
            width: 100%;
            height: ${HEIGHT}px;
            border-radius: 6px;
            touch-action: pan-y;
        }
        .plot:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: 2px;
        }
        svg {
            display: block;
            width: 100%;
            height: 100%;
            overflow: visible;
        }
        .grid {
            stroke: var(--divider-color, rgba(0, 0, 0, 0.12));
            stroke-width: 1;
        }
        .axis-label {
            fill: var(--secondary-text-color);
            font-size: 10px;
        }
        .reference {
            stroke: var(--secondary-text-color);
            stroke-width: 1;
            stroke-dasharray: 4 3;
        }
        .band {
            fill: var(--secondary-text-color);
            opacity: 0.08;
        }
        .reference-label {
            fill: var(--secondary-text-color);
            font-size: 10px;
        }
        .line {
            fill: none;
            stroke-width: 2;
            stroke-linejoin: round;
            stroke-linecap: round;
        }
        .cursor {
            stroke: var(--primary-text-color);
            stroke-width: 1;
            opacity: 0.5;
        }
        .legend {
            display: flex;
            flex-wrap: wrap;
            gap: 4px 12px;
            margin-top: 4px;
            font-size: 0.8rem;
            color: var(--secondary-text-color);
        }
        .legend-swatch {
            display: inline-block;
            width: 10px;
            height: 3px;
            margin-right: 4px;
            vertical-align: middle;
            border-radius: 2px;
        }
        .summary {
            margin: 4px 0 0;
            font-size: 0.8rem;
            color: var(--secondary-text-color);
        }
    `];

    @property({ attribute: false }) public series: DayLineSeries[] = [];
    @property({ attribute: false }) public references: DayLineReference[] = [];
    /** Always inside the drawn range, so a reading's place against a band shows. */
    @property({ attribute: false }) public bands: DayLineBand[] = [];
    /** The window drawn, epoch ms: a whole local day, in the reading's time zone. */
    @property({ type: Number }) public start = 0;
    @property({ type: Number }) public end = 0;
    @property({ type: Number }) public bucketMs = 300_000;
    @property() public timeZone = "UTC";
    @property() public locale = "en";
    @property({ attribute: false }) public formatValue: (value: number) => string = (value) => value.toFixed(1);
    /** The chart in words: what it shows and its key figures. */
    @property() public summary = "";

    @state() private _width = 0;
    @state() private _selected: number | null = null;

    private readonly _tooltip = new HoverTooltipController(this);
    private _resizeObserver?: ResizeObserver;

    connectedCallback(): void {
        super.connectedCallback();
        this._resizeObserver = new ResizeObserver((entries) => {
            const width = Math.round(entries[0]?.contentRect.width ?? 0);
            if (width !== this._width) this._width = width;
        });
        this._resizeObserver.observe(this);
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._resizeObserver?.disconnect();
    }

    willUpdate(changed: Map<string, unknown>): void {
        if (changed.has("series")) {
            this._selected = null;
            this._tooltip.hide();
        }
    }

    render() {
        return html`
            <div
                class="plot"
                tabindex="0"
                role="group"
                aria-label=${this.summary}
                @pointermove=${this._onPointerMove}
                @mouseleave=${this._onLeave}
                @click=${this._onClick}
                @keydown=${this._onKeyDown}
                @blur=${this._onLeave}
            >
                ${this._width > 0 ? this._renderSvg() : nothing}
            </div>
            ${this.series.length > 1 ? html`
                <div class="legend">
                    ${this.series.map((series) => html`
                        <span><span class="legend-swatch" style="background: ${series.color}"></span>${series.label}</span>
                    `)}
                </div>
            ` : nothing}
            ${this.summary ? html`<p class="summary">${this.summary}</p>` : nothing}
            ${this._tooltip.render()}
        `;
    }

    private get _times(): number[] {
        const times = new Set<number>();
        for (const series of this.series) for (const point of series.points) times.add(point.t);
        return [...times].sort((a, b) => a - b);
    }

    private _scales() {
        const values: number[] = [
            ...this.references.map((reference) => reference.value),
            ...this.bands.flatMap((band) => [band.from, band.to]),
        ];
        for (const series of this.series) {
            for (const point of series.points) {
                values.push(point.min ?? point.v, point.max ?? point.v);
            }
        }
        let low = values.length ? Math.min(...values) : 0;
        let high = values.length ? Math.max(...values) : 1;
        if (high - low < 1e-9) {
            low -= 1;
            high += 1;
        }
        const margin = (high - low) * 0.1;
        low -= margin;
        high += margin;
        const width = this._width;
        const innerWidth = Math.max(1, width - PAD.left - PAD.right);
        const innerHeight = HEIGHT - PAD.top - PAD.bottom;
        const span = Math.max(1, this.end - this.start);
        return {
            low,
            high,
            x: (t: number) => PAD.left + ((t - this.start) / span) * innerWidth,
            y: (v: number) => PAD.top + (1 - (v - low) / (high - low)) * innerHeight,
            tFromX: (px: number) => this.start + ((px - PAD.left) / innerWidth) * span,
        };
    }

    private _renderSvg() {
        const scales = this._scales();
        const { x, y } = scales;
        const ticks = [scales.low + (scales.high - scales.low) * 0.1, (scales.low + scales.high) / 2, scales.high - (scales.high - scales.low) * 0.1];
        const hourTicks = this._hourTicks();
        const selectedT = this._selected !== null ? this._times[this._selected] : null;
        return html`
            <svg viewBox="0 0 ${this._width} ${HEIGHT}" aria-hidden="true">
                ${this.bands.map((band) => svg`
                    <rect class="band" x=${PAD.left} width=${Math.max(0, this._width - PAD.left - PAD.right)}
                        y=${y(Math.max(band.from, band.to))} height=${Math.abs(y(band.from) - y(band.to))}></rect>
                    <text class="reference-label" x=${PAD.left + 4} y=${y(Math.max(band.from, band.to)) + 11}>${band.label}</text>
                `)}
                ${ticks.map((value) => svg`
                    <line class="grid" x1=${PAD.left} x2=${this._width - PAD.right} y1=${y(value)} y2=${y(value)}></line>
                    <text class="axis-label" x=${PAD.left - 4} y=${y(value) + 3} text-anchor="end">${this.formatValue(value)}</text>
                `)}
                ${hourTicks.map(({ t, label }) => svg`
                    <text class="axis-label" x=${x(t)} y=${HEIGHT - 6} text-anchor="middle">${label}</text>
                `)}
                ${this.references.map((reference) => svg`
                    <line class="reference" x1=${PAD.left} x2=${this._width - PAD.right} y1=${y(reference.value)} y2=${y(reference.value)}></line>
                    <text class="reference-label" x=${this._width - PAD.right} y=${y(reference.value) - 3} text-anchor="end">${reference.label}</text>
                `)}
                ${this.series.map((series) => svg`
                    <path class="line" stroke=${series.color} d=${this._path(series.points, x, y)}></path>
                `)}
                ${selectedT !== null ? svg`
                    <line class="cursor" x1=${x(selectedT)} x2=${x(selectedT)} y1=${PAD.top} y2=${HEIGHT - PAD.bottom}></line>
                    ${this.series.map((series) => {
                        const point = series.points.find((candidate) => candidate.t === selectedT);
                        return point ? svg`<circle cx=${x(point.t)} cy=${y(point.v)} r="3.5" fill=${series.color}></circle>` : nothing;
                    })}
                ` : nothing}
            </svg>
        `;
    }

    private _path(points: DayLinePoint[], x: (t: number) => number, y: (v: number) => number): string {
        let path = "";
        let previous: number | null = null;
        for (const point of points) {
            const command = previous === null || point.t - previous > this.bucketMs * 1.5 ? "M" : "L";
            path += `${command}${x(point.t).toFixed(1)},${y(point.v).toFixed(1)}`;
            previous = point.t;
        }
        return path;
    }

    /** Local 00/06/12/18 within the window, as the reading's time zone tells them. */
    private _hourTicks(): Array<{ t: number; label: string }> {
        const ticks: Array<{ t: number; label: string }> = [];
        const hourMs = 3_600_000;
        for (let t = Math.ceil(this.start / hourMs) * hourMs; t <= this.end; t += hourMs) {
            const parts = getScheduleLocalTimeParts(t, this.timeZone);
            if (parts && parts.minute === 0 && parts.hour % 6 === 0) {
                ticks.push({ t, label: String(parts.hour).padStart(2, "0") });
            }
        }
        return ticks;
    }

    private _tooltipBody(index: number): TooltipBody {
        const t = this._times[index];
        const rows = [];
        for (const series of this.series) {
            const point = series.points.find((candidate) => candidate.t === t);
            if (!point) continue;
            rows.push(tooltipRow(series.label, this.formatValue(point.v), series.color));
            if (point.min !== undefined && point.max !== undefined && point.min !== point.max) {
                rows.push(tooltipRow("", `${this.formatValue(point.min)} – ${this.formatValue(point.max)}`));
            }
        }
        const title = `${formatScheduleTime(t, this.locale, this.timeZone)}–${formatScheduleTime(t + this.bucketMs, this.locale, this.timeZone)}`;
        return { title, hasActual: false, rows };
    }

    private _nearestIndex(clientX: number): number | null {
        const times = this._times;
        if (!times.length) return null;
        const rect = this.renderRoot.querySelector(".plot")!.getBoundingClientRect();
        const t = this._scales().tFromX(clientX - rect.left);
        let best = 0;
        for (let index = 1; index < times.length; index += 1) {
            if (Math.abs(times[index] - t) < Math.abs(times[best] - t)) best = index;
        }
        return best;
    }

    private _onPointerMove = (event: PointerEvent): void => {
        if (event.pointerType === "touch") return;
        const index = this._nearestIndex(event.clientX);
        if (index === null) return;
        this._selected = index;
        this._tooltip.show(event, this._tooltipBody(index));
    };

    private _onClick = (event: MouseEvent): void => {
        if (event.detail === 0) return;
        const index = this._nearestIndex(event.clientX);
        if (index === null) return;
        this._selected = index;
        this._tooltip.toggle(event, this._tooltipBody(index));
    };

    private _onLeave = (): void => {
        this._selected = null;
        this._tooltip.hide();
    };

    private _onKeyDown = (event: KeyboardEvent): void => {
        const count = this._times.length;
        if (!count) return;
        const current = this._selected;
        let next: number | null = current;
        switch (event.key) {
            case "ArrowRight": next = current === null ? count - 1 : Math.min(count - 1, current + 1); break;
            case "ArrowLeft": next = current === null ? count - 1 : Math.max(0, current - 1); break;
            case "Home": next = 0; break;
            case "End": next = count - 1; break;
            case "Escape":
                if (current === null) return;
                this._onLeave();
                event.stopPropagation();
                event.preventDefault();
                return;
            default: return;
        }
        event.preventDefault();
        this._selected = next;
        this._showAtSelection(next!);
    };

    /** A keyboard selection has no pointer: its popup sits on the selected bucket. */
    private _showAtSelection(index: number): void {
        const rect = this.renderRoot.querySelector(".plot")!.getBoundingClientRect();
        const x = rect.left + this._scales().x(this._times[index]);
        const point = { x, y: rect.top + PAD.top };
        this._tooltip.content = { ...this._tooltipBody(index), ...point };
        this._tooltip.point = point;
        this.requestUpdate();
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-day-line-chart": HelmanDayLineChart;
    }
}
