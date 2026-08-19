import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
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

const MINUTES_PER_DAY = 1440;

/** The strip's own geometry; it borrows only the x scale from the chart. */
const PRICE_STRIP = { height: 65, padTop: 8, padBottom: 8 } as const;

/** One rail's sample as the day payload serves it: an `HH:MM` slot and a rate. */
export interface PriceRailPoint {
    slot: string;
    value: number;
}

/** A single price sample placed on the selected day's timeline. */
export interface PriceColumn {
    startMinutes: number;
    endMinutes: number;
    value: number;
}

/**
 * The day's price columns for both directions, published so the inspector can
 * look either one up by slot. Kept as two sequences rather than one merged
 * series because the rails coalesce independently: a window-shaped import rate
 * holds for hours while a spot export price moves every quarter of one.
 */
export interface PriceColumnsDetail {
    importColumns: PriceColumn[];
    exportColumns: PriceColumn[];
    unit: string;
}

/**
 * The popup content emitted for the inspector's shared floating tooltip to
 * render. Price has no actual/forecast duality of its own -- it is simply a
 * rate -- so `hasActual` is always false and every row carries only a
 * forecast cell.
 */
export interface PriceTooltipContent {
    x: number;
    y: number;
    title?: string;
    hasActual: boolean;
    rows: Array<{ label: string; actual: { value: string; color?: string } | null; forecast: { value: string; color?: string } | null }>;
}

/**
 * A horizontal strip of what the grid charged and what it paid across the
 * selected inspector day, aligned to the solar inspector chart's time axis. The
 * two rails are drawn side by side inside each price cell, in the same
 * import/export colours the rest of the project uses for grid direction, so the
 * spread between them — the thing every optimizer decision turns on — reads at a
 * glance. Samples past the current moment are drawn muted, echoing how the chart
 * above mutes the part of the day the actuals have not yet reached.
 *
 * Both rails come off the inspector day payload rather than the live forecast
 * payload, and that is what makes the strip work on days other than today: the
 * backend serves elapsed slots out of recorder history (and, for import, out of
 * the window config where history cannot answer), so navigating back a week
 * shows the prices that applied then rather than an empty strip.
 *
 * `hass` is held only to read through — it is a conduit for localization, never
 * a change signal (see `../README.md`).
 */
@customElement("helman-solar-price-strip")
export class HelmanSolarPriceStrip extends LitElement {
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
            min-width: 360px;
            height: ${PRICE_STRIP.height}px;
        }
    `];

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** Selected inspector day, `YYYY-MM-DD`. */
    @property({ type: String }) public date = "";
    @property({ type: String }) public timeZone = "UTC";
    @property({ attribute: false }) public geometry: ScheduleStripGeometry | null = null;
    /** Minute-of-day of the selected slot; its price cell reads as selected (blue). */
    /** Minute-of-day of every selected slot; each gets a blue band. */
    @property({ attribute: false }) public selectedMinutes: number[] = [];
    /** Minute-of-day under the pointer; its price cell reads as hovered (orange). */
    @property({ attribute: false }) public hoverMinutes: number | null = null;
    /** The chart's active slot width, so the seam lands on the same grid it does. */
    @property({ type: Number }) public slotMinutes = 15;
    /**
     * The inspector's clock, so the seam and the "now" line here move with the
     * ones on the charts above rather than on this component's own reads.
     */
    @property({ type: Number }) public nowMs = Date.now();

    /** What a kilowatt-hour bought from the grid cost, per slot of this day. */
    @property({ attribute: false }) public importPrice: readonly PriceRailPoint[] = [];
    /** What a kilowatt-hour sold to the grid earned, per slot of this day. */
    @property({ attribute: false }) public exportPrice: readonly PriceRailPoint[] = [];
    /** The currency-per-energy unit both rails are quoted in, e.g. `CZK/kWh`. */
    @property({ type: String }) public unit = "";

    protected updated(changed: PropertyValues<this>): void {
        // The inspector's own selected-slot panel wants this day's prices already
        // laid out on the 0..1440 timeline, which only happens here, so every
        // change that could move a value at a given minute is echoed up.
        if (
            changed.has("importPrice")
            || changed.has("exportPrice")
            || changed.has("unit")
            || changed.has("slotMinutes")
        ) {
            this._emitColumns();
        }
    }

    /** Publish this day's price columns, so the inspector can look one up by slot. */
    private _emitColumns(): void {
        this.dispatchEvent(
            new CustomEvent<PriceColumnsDetail>("price-columns", {
                detail: {
                    importColumns: this._buildColumns(this.importPrice),
                    exportColumns: this._buildColumns(this.exportPrice),
                    unit: this.unit,
                },
                bubbles: true,
                composed: true,
            }),
        );
    }

    render() {
        if (!this.hass || this.geometry === null) {
            return nothing;
        }
        const importColumns = this._buildColumns(this.importPrice);
        const exportColumns = this._buildColumns(this.exportPrice);
        if (importColumns.length === 0 && exportColumns.length === 0) {
            return nothing;
        }
        return this._renderStrip(importColumns, exportColumns, this.geometry);
    }

    /**
     * One rail's samples bucketed onto the inspector's current slot grid.
     *
     * Both rails use this same grid, which is the point: a cell is split in half
     * to hold one bar per rail, so the two must agree on where cells begin or
     * the halves belong to different spans. Coalescing equal neighbours into
     * natural cells — an hourly export price into one column, a fixed import
     * window into a morning-long one — was tried first and gives each rail its
     * own grid, which draws as a wide backdrop with unrelated bars across it
     * rather than a pair per slot.
     *
     * Density is therefore the slot-size control's business, not this element's:
     * at 15 minutes the day is 96 narrow pairs, at 60 it is 24 wide ones.
     * Several samples landing in one cell average, a price being a rate rather
     * than a quantity to accumulate.
     */
    private _buildColumns(points: readonly PriceRailPoint[]): PriceColumn[] {
        const slot = this._slotSpan();
        const cells = new Map<number, { total: number; count: number }>();
        for (const point of points ?? []) {
            const value = Number(point.value);
            if (!Number.isFinite(value)) {
                continue;
            }
            const minutes = this._slotToMinutes(point.slot);
            if (minutes === null) {
                continue;
            }
            const start = Math.floor(minutes / slot) * slot;
            const cell = cells.get(start);
            if (cell) {
                cell.total += value;
                cell.count += 1;
            } else {
                cells.set(start, { total: value, count: 1 });
            }
        }
        return [...cells.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([startMinutes, { total, count }]) => ({
                startMinutes,
                endMinutes: Math.min(startMinutes + slot, MINUTES_PER_DAY),
                value: total / count,
            }));
    }

    /** The inspector's current slot width, guarded against a nonsense value. */
    private _slotSpan(): number {
        return this.slotMinutes > 0 ? this.slotMinutes : 15;
    }

    /** Turn an `HH:MM` slot label into its minute-of-day, or null if malformed. */
    private _slotToMinutes(slot: unknown): number | null {
        if (typeof slot !== "string") {
            return null;
        }
        const [hourText, minuteText] = slot.split(":");
        const hour = Number(hourText);
        const minute = Number(minuteText);
        if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
            return null;
        }
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            return null;
        }
        return hour * 60 + minute;
    }

    /**
     * Minute-of-day the day turns from measured into upcoming: the start of the
     * slot we are currently inside when the selected day is today, otherwise the
     * whole day is past (an earlier day) or entirely upcoming (a later day).
     *
     * The seam snaps back to the slot start rather than sitting on the exact
     * minute because a slot only counts as measured once it has fully elapsed —
     * the same rule the chart above applies to its actuals. Splitting the price
     * mid-column would claim part of a slot as history while the chart still
     * draws that slot as a projection.
     */
    private _seamMinutes(): number {
        const now = getScheduleLocalTimeParts(this.nowMs, this.timeZone);
        if (now === null) {
            return MINUTES_PER_DAY;
        }
        if (now.dayKey === this.date) {
            const minutes = now.hour * 60 + now.minute;
            const slot = this.slotMinutes > 0 ? this.slotMinutes : 15;
            return Math.floor(minutes / slot) * slot;
        }
        return this.date < now.dayKey ? MINUTES_PER_DAY : 0;
    }

    private _renderStrip(
        importColumns: PriceColumn[],
        exportColumns: PriceColumn[],
        geometry: ScheduleStripGeometry,
    ): TemplateResult {
        const { height, padTop, padBottom } = PRICE_STRIP;
        const innerHeight = height - padTop - padBottom;
        const allColumns = [...importColumns, ...exportColumns];
        // One y-scale for both rails: they are the same unit, and the whole point
        // of drawing them together is that their heights are comparable.
        const maxAbs = Math.max(0.0001, ...allColumns.map((column) => Math.abs(column.value)));
        const hasNegative = allColumns.some((column) => column.value < 0);
        const zeroY = hasNegative ? padTop + innerHeight / 2 : padTop + innerHeight;
        const scale = hasNegative ? innerHeight / 2 / maxAbs : innerHeight / maxAbs;
        const yForValue = (value: number) => zeroY - value * scale;
        const seam = this._seamMinutes();
        const { start: windowStart, end: windowEnd } = stripWindow(geometry);
        const windowSpan = windowEnd - windowStart;
        const xForMinutes = (minutes: number) =>
            geometry.marginLeft + ((minutes - windowStart) / windowSpan) * geometry.plotWidth;
        const bandColumns = this._bandColumns(importColumns, exportColumns);

        return html`
            <div class="strip-wrap">
                ${svg`
                <svg
                    viewBox="0 0 ${geometry.width} ${height}"
                    role="img"
                    aria-label=${this._t("bias_correction.inspector.price_strip")}
                    style="cursor: pointer;"
                    @click=${(event: MouseEvent) => this._handleClick(event, geometry)}
                    @mousemove=${(event: MouseEvent) =>
                        this._handleHover(event, geometry, importColumns, exportColumns)}
                    @mouseleave=${() => { this._emitHover(null); this._emitTooltip(null); }}
                >
                    <defs>
                        <clipPath id="price-plot-clip">
                            <rect x=${geometry.marginLeft} y="0" width=${geometry.plotWidth} height=${height}></rect>
                        </clipPath>
                    </defs>
                    ${this._renderGuides(geometry, zeroY, yForValue, maxAbs, hasNegative)}
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
                    ${this._renderBand(bandColumns, this.hoverMinutes, "hover", height, xForMinutes)}
                    ${this.selectedMinutes.map((minutes) =>
                        this._renderBand(bandColumns, minutes, "selected", height, xForMinutes))}
                    <g clip-path="url(#price-plot-clip)">
                    ${this._renderBars(importColumns, "import", { zeroY, yForValue, seam, xForMinutes })}
                    ${this._renderBars(exportColumns, "export", { zeroY, yForValue, seam, xForMinutes })}
                    </g>
                    ${this._renderNowMarker(xForMinutes, windowStart, windowEnd, height)}
                    <!-- The prices come after the marker so the line passes
                         behind the figure it crosses instead of through it. -->
                    <g clip-path="url(#price-plot-clip)">
                    ${this._renderLabels(importColumns, "import", { zeroY, yForValue, height, xForMinutes })}
                    ${this._renderLabels(exportColumns, "export", { zeroY, yForValue, height, xForMinutes })}
                    </g>
                </svg>
            `}
            </div>
        `;
    }

    /**
     * Where one rail's bar sits inside a slot cell: import on the left half,
     * export on the right. Halving rather than overlaying or stacking keeps both
     * values readable at their true height against the shared scale, and the two
     * halves are the same span because both rails were bucketed onto one grid.
     */
    private _barSpan(
        column: PriceColumn,
        side: "import" | "export",
        xForMinutes: (minutes: number) => number,
    ): { left: number; width: number } {
        const cellLeft = xForMinutes(column.startMinutes);
        const cellRight = xForMinutes(column.endMinutes);
        const middle = (cellLeft + cellRight) / 2;
        const left = side === "import" ? cellLeft : middle;
        const right = side === "import" ? middle : cellRight;
        return { left: left + 0.25, width: Math.max(1, right - left - 0.5) };
    }

    private _renderBars(
        columns: PriceColumn[],
        side: "import" | "export",
        ctx: {
            zeroY: number;
            yForValue: (value: number) => number;
            seam: number;
            xForMinutes: (minutes: number) => number;
        },
    ) {
        const color = side === "import" ? "var(--helman-grid-import)" : "var(--helman-grid-export)";
        return columns.map((column) => {
            const valueY = ctx.yForValue(column.value);
            const top = Math.min(ctx.zeroY, valueY);
            const barHeight = Math.max(1, Math.abs(valueY - ctx.zeroY));
            const { left, width } = this._barSpan(column, side, ctx.xForMinutes);
            const future = column.startMinutes >= ctx.seam;
            return svg`
                <rect
                    x=${left} y=${top}
                    width=${width} height=${barHeight}
                    style="fill: ${color}; stroke: ${color};"
                    fill-opacity=${future ? 0.4 : 0.85}
                    stroke-width=${future ? 0.9 : 0}
                    stroke-dasharray=${future ? "2 2" : ""}
                ></rect>
            `;
        });
    }

    private _renderLabels(
        columns: PriceColumn[],
        side: "import" | "export",
        ctx: {
            zeroY: number;
            yForValue: (value: number) => number;
            height: number;
            xForMinutes: (minutes: number) => number;
        },
    ) {
        return columns.map((column) => {
            const { left, width } = this._barSpan(column, side, ctx.xForMinutes);
            // A half-cell is half the room the single-series strip had, so the
            // threshold is halved with it; narrower than this and the digits
            // would overrun into the neighbouring rail.
            if (width < 12) {
                return "";
            }
            const valueY = ctx.yForValue(column.value);
            const top = Math.min(ctx.zeroY, valueY);
            // The label sits outside the bar, on the far side from zero, so it
            // never has to fight the bar's own fill for contrast.
            const labelY = column.value >= 0
                ? Math.max(top - 3, 9)
                : Math.min(top + Math.max(1, Math.abs(valueY - ctx.zeroY)) + 9, ctx.height - 2);
            return svg`
                <text x=${left + width / 2} y=${labelY} text-anchor="middle" font-size="9"
                      fill="var(--secondary-text-color)">${column.value.toFixed(1)}</text>
            `;
        });
    }

    /**
     * The same vertical "now" line the charts above and the schedule band below
     * draw, so the whole inspector marks the moment in one continuous stroke.
     * Only today gets one, and only while it falls inside the drawn window.
     */
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

    private _renderGuides(
        geometry: ScheduleStripGeometry,
        zeroY: number,
        yForValue: (value: number) => number,
        maxAbs: number,
        hasNegative: boolean,
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
        // Labels sit in the narrow axis gutter, so they stay numeric only — the
        // unit rides along in each bar's tooltip. A unit suffix here would run
        // off the left of the viewBox and clip the value out of sight.
        return svg`
            ${line(yForValue(maxAbs))}
            ${label(yForValue(maxAbs), maxAbs.toFixed(1))}
            ${hasNegative
                ? svg`${line(zeroY)}${label(zeroY, "0")}${line(yForValue(-maxAbs))}${label(yForValue(-maxAbs), `-${maxAbs.toFixed(1)}`)}`
                : svg`${line(zeroY)}${label(zeroY, "0")}`}
        `;
    }

    /**
     * The cells the selection and hover bands snap to. Both rails sit on the one
     * slot grid, so a band is simply that grid's cell — the union of the two
     * rails' starts, since either may be missing cells the other has.
     */
    private _bandColumns(
        importColumns: PriceColumn[],
        exportColumns: PriceColumn[],
    ): PriceColumn[] {
        const slot = this._slotSpan();
        const starts = new Set<number>(
            [...importColumns, ...exportColumns].map((column) => column.startMinutes),
        );
        return [...starts]
            .sort((a, b) => a - b)
            .map((startMinutes) => ({
                startMinutes,
                endMinutes: Math.min(startMinutes + slot, MINUTES_PER_DAY),
                value: 0,
            }));
    }

    /**
     * The blue selection or orange hover band. A minute falls inside one price
     * cell, and the band covers that whole cell — so an hour-long price cell
     * reads as the full hour, not the finer slot the minute came from.
     */
    private _renderBand(
        columns: PriceColumn[],
        minutes: number | null,
        kind: "selected" | "hover",
        height: number,
        xForMinutes: (minutes: number) => number,
    ) {
        if (minutes === null) {
            return nothing;
        }
        const column = columns.find((c) => minutes >= c.startMinutes && minutes < c.endMinutes);
        if (!column) {
            return nothing;
        }
        const x = xForMinutes(column.startMinutes);
        const width = Math.max(2, xForMinutes(column.endMinutes) - x);
        const fill = kind === "hover" ? "color-mix(in srgb, var(--helman-selection) 14%, transparent)" : "color-mix(in srgb, var(--helman-grid-import) 13%, transparent)";
        const stroke = kind === "hover" ? "var(--helman-selection)" : "var(--helman-grid-import)";
        const strokeOpacity = kind === "hover" ? "0.55" : "0.5";
        return svg`
            <rect
                x=${x} y="0" width=${width} height=${height}
                style="fill: ${fill}; stroke: ${stroke};"
                stroke-width="1" stroke-opacity=${strokeOpacity}
                rx="1"
                pointer-events="none"
            ></rect>
        `;
    }

    /**
     * Turn a click into the minute-of-day the inspector resolves to a slot. A
     * click in the axis gutter carries `null` so the inspector clears selection,
     * matching how clicking outside the plot on the chart deselects.
     */
    private _handleClick(event: MouseEvent, geometry: ScheduleStripGeometry): void {
        const svgEl = event.currentTarget as SVGSVGElement;
        const rect = svgEl.getBoundingClientRect();
        const svgX = ((event.clientX - rect.left) / rect.width) * geometry.width;
        const minutes = stripMinutesForSvgX(geometry, svgX);
        this.dispatchEvent(
            new CustomEvent<SlotPickDetail>("slot-pick", {
                detail: { minutes, mode: slotSelectionModeForEvent(event) },
                bubbles: true,
                composed: true,
            }),
        );
    }

    /**
     * Report the hovered minute-of-day so the inspector can echo it everywhere,
     * and the popup content. The whole cell's slot counts as "on" it, not just
     * either bar's own height -- a value near zero would otherwise leave almost
     * no pointable area, and both rails are wanted at once anyway: the spread
     * between them is what the reader came for.
     */
    private _handleHover(
        event: MouseEvent,
        geometry: ScheduleStripGeometry,
        importColumns: PriceColumn[],
        exportColumns: PriceColumn[],
    ): void {
        const svgEl = event.currentTarget as SVGSVGElement;
        const rect = svgEl.getBoundingClientRect();
        const svgX = ((event.clientX - rect.left) / rect.width) * geometry.width;
        const minutes = stripMinutesForSvgX(geometry, svgX);
        const at = (columns: PriceColumn[]) =>
            minutes === null
                ? undefined
                : columns.find((c) => minutes >= c.startMinutes && minutes < c.endMinutes);
        const importColumn = at(importColumns);
        const exportColumn = at(exportColumns);
        if (minutes === null || (!importColumn && !exportColumn)) {
            this._emitHover(null);
            this._emitTooltip(null);
            return;
        }
        // The title names the tighter of the two cells, so it describes the span
        // the highlight actually covers rather than the looser rail's window.
        const titleColumn = this._narrower(importColumn, exportColumn);
        const rows: PriceTooltipContent["rows"] = [];
        if (importColumn) {
            rows.push(this._priceRow("import_price", importColumn.value));
        }
        if (exportColumn) {
            rows.push(this._priceRow("export_price", exportColumn.value));
        }
        this._emitHover(minutes);
        this._emitTooltip({
            x: event.clientX,
            y: event.clientY,
            title: titleColumn
                ? `${this._formatMinutes(titleColumn.startMinutes)} – ${this._formatMinutes(titleColumn.endMinutes)}`
                : undefined,
            hasActual: false,
            rows,
        });
    }

    private _narrower(
        first: PriceColumn | undefined,
        second: PriceColumn | undefined,
    ): PriceColumn | undefined {
        if (!first) return second;
        if (!second) return first;
        const firstSpan = first.endMinutes - first.startMinutes;
        const secondSpan = second.endMinutes - second.startMinutes;
        return secondSpan < firstSpan ? second : first;
    }

    private _priceRow(key: "import_price" | "export_price", value: number): PriceTooltipContent["rows"][number] {
        const color = key === "import_price"
            ? "var(--helman-grid-import)"
            : "var(--helman-grid-export)";
        return {
            label: this._t(`bias_correction.inspector.${key}`),
            actual: null,
            forecast: { value: `${value.toFixed(1)} ${this.unit}`.trim(), color },
        };
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

    private _emitTooltip(content: PriceTooltipContent | null): void {
        this.dispatchEvent(
            new CustomEvent<PriceTooltipContent | null>("slot-tooltip", {
                detail: content,
                bubbles: true,
                composed: true,
            }),
        );
    }

    private _formatMinutes(minutes: number): string {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
    }

    private _t(key: string): string {
        const localize: LocalizeFunction = this.hass
            ? getLocalizeFunction(this.hass)
            : (raw: string) => raw;
        return localize(key);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-price-strip": HelmanSolarPriceStrip;
    }
}
