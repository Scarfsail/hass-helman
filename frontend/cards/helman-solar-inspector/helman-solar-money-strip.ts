import { LitElement, css, html, svg, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { getScheduleLocalTimeParts } from "../shared/schedule/model/schedule-time";
import { slotSelectionModeForEvent, type SlotPickDetail } from "./slot-selection.js";
import {
    stripMinutesForSvgX,
    stripWindow,
    type ScheduleStripGeometry,
} from "./strip-geometry";
import { nowMinutesOnDay, renderNowMarker } from "./now-marker.js";
import { renderSlotGridlines, slotGridTicks } from "../shared/slot-gridlines";
import { helmanColorVars } from "../color-vars";
import { columnFitsLabel, stripValueLabel } from "../shared/strip-value-labels";
import { EMPTY_MONEY, type MoneyPoint } from "./money-model";

const MINUTES_PER_DAY = 1440;

/**
 * The strip's own geometry; it borrows only the x scale from the chart. The
 * padding is what the value labels stand in: each is written past the end of
 * its bar, so the deepest bar on either side needs a line's room beyond it.
 */
const MONEY_STRIP = { height: 88, padTop: 14, padBottom: 18 } as const;

/** One cell's money on the inspector's current slot grid. */
interface MoneyCell {
    startMinutes: number;
    endMinutes: number;
    cost: number;
    gain: number;
}

/** The popup content emitted for the inspector's shared floating tooltip. */
export interface MoneyTooltipContent {
    x: number;
    y: number;
    title?: string;
    hasActual: boolean;
    rows: Array<{
        label: string;
        actual: { value: string; color?: string } | null;
        forecast: { value: string; color?: string } | null;
    }>;
}

/**
 * What the grid cost and paid across the selected inspector day.
 *
 * Signed the way the chart above is: cost rises above the zero line and gain
 * falls below it, so the two never have to be told apart by colour alone. The
 * colours are the flow-direction pair all the same — import blue for what was
 * bought, export sky for what was sold.
 *
 * Deliberately unlike the price strip it sits beneath in two ways. Money is a
 * quantity, so slots grouped into a wider cell **sum** where prices average.
 * And a negative amount here is ordinary — a gain earned at a negative rate is
 * money you paid to export — so sign carries direction, not alarm, and there is
 * no adverse colour.
 *
 * Both vintages are drawn: actual for the part of the day that has elapsed,
 * forecast for the rest, split at the same seam the chart uses.
 */
@customElement("helman-solar-money-strip")
export class HelmanSolarMoneyStrip extends LitElement {
    static styles = [helmanColorVars, css`
        :host {
            display: block;
            width: 100%;
        }

        .strip-wrap {
            width: 100%;
        }

        .strip-wrap svg {
            display: block;
            width: 100%;
            height: auto;
        }
    `];

    @property({ attribute: false }) public hass?: HomeAssistant;
    @property({ type: String }) public date = "";
    @property({ type: String }) public timeZone = "UTC";
    @property({ attribute: false }) public geometry: ScheduleStripGeometry | null = null;
    @property({ attribute: false }) public selectedMinutes: number[] = [];
    @property({ attribute: false }) public hoverMinutes: number | null = null;
    @property({ type: Number }) public slotMinutes = 15;
    @property({ type: Number }) public nowMs = Date.now();
    /** Money for slots that have elapsed, and for those still ahead. */
    @property({ attribute: false }) public moneyActual: readonly MoneyPoint[] = EMPTY_MONEY;
    @property({ attribute: false }) public moneyForecast: readonly MoneyPoint[] = EMPTY_MONEY;
    /** The currency the amounts are in, derived from the price rail's unit. */
    @property({ type: String }) public currency = "";

    private _t(key: string): string {
        const localize: LocalizeFunction = this.hass
            ? getLocalizeFunction(this.hass)
            : (raw: string) => raw;
        return localize(key);
    }

    render() {
        if (!this.hass || this.geometry === null) {
            return nothing;
        }
        const cells = this._buildCells();
        if (cells.length === 0) {
            return nothing;
        }
        return this._renderStrip(cells, this.geometry);
    }

    /** The inspector's current slot width, guarded against a nonsense value. */
    private _slotSpan(): number {
        return this.slotMinutes > 0 ? this.slotMinutes : 15;
    }

    /**
     * Both vintages bucketed onto the inspector's slot grid, actual taking the
     * elapsed slots and forecast the rest.
     *
     * Amounts falling in one cell **sum**. That is the one place this strip must
     * not follow the price strip above it, which averages: four quarter-hours of
     * cost in an hour is their total, not their mean.
     */
    private _buildCells(): MoneyCell[] {
        const slot = this._slotSpan();
        const seam = this._seamMinutes();
        const cells = new Map<number, MoneyCell>();
        const add = (points: readonly MoneyPoint[], wantElapsed: boolean) => {
            for (const point of points ?? []) {
                const minutes = this._slotToMinutes(point.slot);
                if (minutes === null) continue;
                // Each slot is claimed by exactly one vintage, so the two can
                // never both contribute and double the day's money.
                if ((minutes < seam) !== wantElapsed) continue;
                const cost = Number(point.cost);
                const gain = Number(point.gain);
                if (!Number.isFinite(cost) || !Number.isFinite(gain)) continue;
                const start = Math.floor(minutes / slot) * slot;
                const cell = cells.get(start) ?? {
                    startMinutes: start,
                    endMinutes: Math.min(start + slot, MINUTES_PER_DAY),
                    cost: 0,
                    gain: 0,
                };
                cell.cost += cost;
                cell.gain += gain;
                cells.set(start, cell);
            }
        };
        add(this.moneyActual, true);
        add(this.moneyForecast, false);
        return [...cells.values()].sort((a, b) => a.startMinutes - b.startMinutes);
    }

    /** Turn an `HH:MM` slot label into its minute-of-day, or null if malformed. */
    private _slotToMinutes(slot: unknown): number | null {
        if (typeof slot !== "string") return null;
        const [hourText, minuteText] = slot.split(":");
        const hour = Number(hourText);
        const minute = Number(minuteText);
        if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
        return hour * 60 + minute;
    }

    /**
     * Minute-of-day the day turns from measured into upcoming — the same rule
     * the price strip and the chart apply, so the whole inspector changes
     * vintage on one line.
     */
    private _seamMinutes(): number {
        const now = getScheduleLocalTimeParts(this.nowMs, this.timeZone);
        if (now === null) return MINUTES_PER_DAY;
        if (now.dayKey === this.date) {
            const minutes = now.hour * 60 + now.minute;
            const slot = this._slotSpan();
            return Math.floor(minutes / slot) * slot;
        }
        return this.date < now.dayKey ? MINUTES_PER_DAY : 0;
    }

    private _renderStrip(cells: MoneyCell[], geometry: ScheduleStripGeometry): TemplateResult {
        const { height, padTop, padBottom } = MONEY_STRIP;
        const innerHeight = height - padTop - padBottom;
        const { start: visibleStart, end: visibleEnd } = stripWindow(geometry);
        // Scale to the cells the reader can see. The daylight-only view is the
        // default, so a night of cheap grid charging would otherwise set a
        // maximum that no drawn bar reaches -- collapsing the daytime bars to
        // slivers and labelling the axis with a column outside the window.
        const scaled = cells.filter(
            (cell) => cell.endMinutes > visibleStart && cell.startMinutes < visibleEnd,
        );
        // The bands are measured in what is actually *drawn*, not in cost and
        // gain: cost goes up and gain goes down, so a negative amount crosses
        // to the other side of the line. Reading the extents off the signed
        // amounts instead would clamp those crossings away, and a day of
        // negative export prices would then scale its bars against a maximum
        // that excludes them and silently clip whatever overshot the plot.
        const drawn = (scaled.length > 0 ? scaled : cells).flatMap(
            (cell) => [cell.cost, -cell.gain],
        );
        const maxUp = Math.max(0, ...drawn);
        const maxDown = Math.max(0, ...drawn.map((value) => -value));
        // Up and down share one scale, so a slot's two amounts stay comparable
        // by height -- which is the whole question this strip answers.
        const extent = Math.max(0.0001, maxUp, maxDown);
        // A side with nothing on it gets no band. A day that only ever exported
        // would otherwise spend half the plot on an empty half and draw its
        // gains at half the height they deserve.
        const hasUp = maxUp > 0;
        const hasDown = maxDown > 0;
        const bands = (hasUp ? 1 : 0) + (hasDown ? 1 : 0);
        const bandHeight = bands > 0 ? innerHeight / bands : innerHeight;
        const zeroY = padTop + (hasUp ? bandHeight : 0);
        const scale = bandHeight / extent;
        const yForValue = (value: number) => zeroY - value * scale;
        const seam = this._seamMinutes();
        const windowStart = visibleStart;
        const windowEnd = visibleEnd;
        const windowSpan = windowEnd - windowStart;
        const xForMinutes = (minutes: number) =>
            geometry.marginLeft + ((minutes - windowStart) / windowSpan) * geometry.plotWidth;

        return html`
            <div class="strip-wrap">
                ${svg`
                <svg
                    viewBox="0 0 ${geometry.width} ${height}"
                    role="img"
                    aria-label=${this._t("bias_correction.inspector.money_strip")}
                    style="cursor: pointer;"
                    @click=${(event: MouseEvent) => this._handleClick(event, geometry)}
                    @mousemove=${(event: MouseEvent) => this._handleHover(event, geometry, cells)}
                    @mouseleave=${() => { this._emitHover(null); this._emitTooltip(null); }}
                >
                    <defs>
                        <clipPath id="money-plot-clip">
                            <rect x=${geometry.marginLeft} y="0" width=${geometry.plotWidth} height=${height}></rect>
                        </clipPath>
                    </defs>
                    ${this._renderGuides(geometry, zeroY, yForValue, maxUp, maxDown)}
                    ${renderSlotGridlines({
                        ticks: slotGridTicks({
                            startMinutes: windowStart,
                            endMinutes: windowEnd,
                            slotMinutes: this.slotMinutes,
                            plotWidth: geometry.plotWidth,
                        }),
                        xForMinutes,
                        top: 0,
                        bottom: height,
                    })}
                    ${this._renderBand(cells, this.hoverMinutes, "hover", height, xForMinutes)}
                    ${this.selectedMinutes.map((minutes) =>
                        this._renderBand(cells, minutes, "selected", height, xForMinutes))}
                    <g clip-path="url(#money-plot-clip)">
                    ${this._renderBars(cells, { zeroY, yForValue, seam, xForMinutes })}
                    </g>
                    <g clip-path="url(#money-plot-clip)">
                    ${this._renderLabels(cells, { zeroY, yForValue, height, xForMinutes })}
                    </g>
                    ${this._renderNowMarker(xForMinutes, windowStart, windowEnd, height)}
                </svg>
            `}
            </div>
        `;
    }

    /** A cell's full width, less a hairline so neighbours stay distinct. */
    private _cellSpan(
        cell: MoneyCell,
        xForMinutes: (minutes: number) => number,
    ): { left: number; width: number } {
        const left = xForMinutes(cell.startMinutes);
        const right = xForMinutes(cell.endMinutes);
        return { left: left + 0.25, width: Math.max(1, right - left - 0.5) };
    }

    private _renderBars(
        cells: MoneyCell[],
        ctx: {
            zeroY: number;
            yForValue: (value: number) => number;
            seam: number;
            xForMinutes: (minutes: number) => number;
        },
    ) {
        return cells.map((cell) => {
            const { left, width } = this._cellSpan(cell, ctx.xForMinutes);
            const future = cell.startMinutes >= ctx.seam;
            // Cost is drawn upward and gain downward from the same zero line, so
            // a slot that did both shows both without either hiding the other.
            const bars: { value: number; color: string }[] = [
                { value: cell.cost, color: "var(--helman-grid-import)" },
                { value: -cell.gain, color: "var(--helman-grid-export)" },
            ];
            return bars.map(({ value, color }) => {
                if (value === 0) return "";
                const valueY = ctx.yForValue(value);
                const top = Math.min(ctx.zeroY, valueY);
                const barHeight = Math.max(1, Math.abs(valueY - ctx.zeroY));
                return svg`
                    <rect
                        x=${left} y=${top}
                        width=${width} height=${barHeight}
                        style="fill: ${color}; stroke: ${color};"
                        fill-opacity=${future ? 0.4 : 0.9}
                        stroke-width=${future ? 0.9 : 0}
                        stroke-dasharray=${future ? "2 2" : ""}
                    ></rect>
                `;
            });
        });
    }

    /**
     * Each amount written past the end of its own bar, in the plot's own text
     * colour: cost above its bar and gain below its, so neither label has to
     * fight the fill it belongs to. A cell too narrow for the digits loses them
     * rather than running into its neighbour.
     */
    private _renderLabels(
        cells: MoneyCell[],
        ctx: {
            zeroY: number;
            yForValue: (value: number) => number;
            height: number;
            xForMinutes: (minutes: number) => number;
        },
    ) {
        return cells.map((cell) => {
            const { left, width } = this._cellSpan(cell, ctx.xForMinutes);
            if (!columnFitsLabel(width)) {
                return "";
            }
            const centre = left + width / 2;
            const label = (amount: number, y: number) =>
                stripValueLabel({ x: centre, y, text: this._formatAmount(amount) });
            // An amount that rounds to nothing gets no label: "0.0" over a
            // hairline bar says less than the bar already did.
            const worthLabelling = (amount: number) => Math.abs(amount) >= 0.05;
            return [
                worthLabelling(cell.cost)
                    ? label(cell.cost, Math.max(ctx.yForValue(cell.cost) - 3, 9))
                    : "",
                worthLabelling(cell.gain)
                    ? label(cell.gain, Math.min(ctx.yForValue(-cell.gain) + 9, ctx.height - 3))
                    : "",
            ];
        });
    }

    /**
     * An amount at the precision the column can carry: whole units once past
     * ten, where the decimal is noise beside the size of the bar, and one place
     * below that, where it is the difference between "something" and "nothing".
     */
    private _formatAmount(amount: number): string {
        return Math.abs(amount) >= 10 ? amount.toFixed(0) : amount.toFixed(1);
    }

    private _renderGuides(
        geometry: ScheduleStripGeometry,
        zeroY: number,
        yForValue: (value: number) => number,
        maxUp: number,
        maxDown: number,
    ) {
        const xLeft = geometry.marginLeft;
        const xRight = geometry.marginLeft + geometry.plotWidth;
        const label = (y: number, text: string) => svg`
            <text x=${xLeft - 8} y=${y + 4} text-anchor="end"
                  fill="var(--secondary-text-color)" font-size="11">${text}</text>
        `;
        const line = (y: number) => svg`
            <line x1=${xLeft} y1=${y} x2=${xRight} y2=${y}
                  stroke="var(--divider-color)" stroke-width="1"></line>
        `;
        // A side whose extreme sits almost on the zero line gets no guide: its
        // line would double the zero line and its label would collide with the
        // "0", which is how a day of large gains and rounding-error costs read
        // before this. Numeric only, like the price strip's axis -- the gutter
        // is too narrow for a currency suffix, which rides in the tooltip.
        const clearOfZero = (y: number) => Math.abs(y - zeroY) >= 10;
        const guide = (value: number, text: string) => {
            const y = yForValue(value);
            return clearOfZero(y) ? svg`${line(y)}${label(y, text)}` : nothing;
        };
        return svg`
            ${maxUp > 0 ? guide(maxUp, maxUp.toFixed(1)) : nothing}
            ${line(zeroY)}${label(zeroY, "0")}
            ${maxDown > 0 ? guide(-maxDown, maxDown.toFixed(1)) : nothing}
        `;
    }

    private _renderNowMarker(
        xForMinutes: (minutes: number) => number,
        windowStart: number,
        windowEnd: number,
        height: number,
    ) {
        const minutes = nowMinutesOnDay(this.date, this.timeZone, this.nowMs);
        if (minutes === null || minutes < windowStart || minutes > windowEnd) {
            return nothing;
        }
        return renderNowMarker(xForMinutes(minutes), 0, height, this._t("scheduling.badge.now"));
    }

    private _renderBand(
        cells: MoneyCell[],
        minutes: number | null,
        kind: "selected" | "hover",
        height: number,
        xForMinutes: (minutes: number) => number,
    ) {
        if (minutes === null) return nothing;
        const cell = cells.find((c) => minutes >= c.startMinutes && minutes < c.endMinutes);
        if (!cell) return nothing;
        const x = xForMinutes(cell.startMinutes);
        const width = Math.max(2, xForMinutes(cell.endMinutes) - x);
        const fill = kind === "hover"
            ? "color-mix(in srgb, var(--helman-selection) 14%, transparent)"
            : "color-mix(in srgb, var(--helman-grid-import) 13%, transparent)";
        const stroke = kind === "hover" ? "var(--helman-selection)" : "var(--helman-grid-import)";
        return svg`
            <rect
                x=${x} y="0" width=${width} height=${height}
                style="fill: ${fill}; stroke: ${stroke};"
                stroke-width="1" stroke-opacity=${kind === "hover" ? "0.55" : "0.5"}
                rx="1"
                pointer-events="none"
            ></rect>
        `;
    }

    /** A click resolves to a minute-of-day, or null in the gutter to deselect. */
    private _handleClick(event: MouseEvent, geometry: ScheduleStripGeometry): void {
        const svgEl = event.currentTarget as SVGSVGElement;
        const rect = svgEl.getBoundingClientRect();
        const svgX = ((event.clientX - rect.left) / rect.width) * geometry.width;
        this.dispatchEvent(
            new CustomEvent<SlotPickDetail>("slot-pick", {
                detail: {
                    minutes: stripMinutesForSvgX(geometry, svgX),
                    mode: slotSelectionModeForEvent(event),
                },
                bubbles: true,
                composed: true,
            }),
        );
    }

    private _handleHover(
        event: MouseEvent,
        geometry: ScheduleStripGeometry,
        cells: MoneyCell[],
    ): void {
        const svgEl = event.currentTarget as SVGSVGElement;
        const rect = svgEl.getBoundingClientRect();
        const svgX = ((event.clientX - rect.left) / rect.width) * geometry.width;
        const minutes = stripMinutesForSvgX(geometry, svgX);
        const cell = minutes === null
            ? undefined
            : cells.find((c) => minutes >= c.startMinutes && minutes < c.endMinutes);
        if (minutes === null || !cell) {
            this._emitHover(null);
            this._emitTooltip(null);
            return;
        }
        // The whole cell counts as hovered, not either bar's own height: an
        // amount near zero would otherwise leave almost nothing to point at,
        // and cost and gain are wanted together anyway.
        // A cell behind the seam is measured money and belongs in the actual
        // column, which is the distinction the bar's solid fill just drew.
        const measured = cell.startMinutes < this._seamMinutes();
        this._emitHover(minutes);
        this._emitTooltip({
            x: event.clientX,
            y: event.clientY,
            title: `${this._formatMinutes(cell.startMinutes)} – ${this._formatMinutes(cell.endMinutes)}`,
            hasActual: measured,
            rows: [
                this._moneyRow("import_cost", cell.cost, measured, "var(--helman-grid-import)"),
                this._moneyRow("export_gain", cell.gain, measured, "var(--helman-grid-export)"),
                this._moneyRow("net_cost", cell.cost - cell.gain, measured),
            ],
        });
    }

    private _moneyRow(key: string, amount: number, measured: boolean, color?: string) {
        const cell = { value: this._formatMoney(amount), color };
        return {
            label: this._t(`bias_correction.inspector.${key}`),
            actual: measured ? cell : null,
            forecast: measured ? null : cell,
        };
    }

    private _formatMoney(amount: number): string {
        return `${amount.toFixed(2)} ${this.currency}`.trim();
    }

    private _formatMinutes(minutes: number): string {
        const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minutes)));
        const hour = Math.floor(clamped / 60) % 24;
        return `${String(hour).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
    }

    private _emitHover(minutes: number | null): void {
        this.dispatchEvent(
            new CustomEvent<{ minutes: number | null }>("slot-hover", {
                detail: { minutes },
                bubbles: true,
                composed: true,
            }),
        );
    }

    private _emitTooltip(content: MoneyTooltipContent | null): void {
        this.dispatchEvent(
            new CustomEvent<MoneyTooltipContent | null>("slot-tooltip", {
                detail: content,
                bubbles: true,
                composed: true,
            }),
        );
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-money-strip": HelmanSolarMoneyStrip;
    }
}
