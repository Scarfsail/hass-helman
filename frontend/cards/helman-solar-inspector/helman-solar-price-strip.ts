import { formatMoney } from "../shared/format";
import { formatClock } from "../shared/time/slot-time";
import { LitElement, css, html, svg, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../types/ha";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import type { SlotPickDetail } from "./slot-selection.js";
import {
    EMPTY_SELECTED_MINUTES,
    renderCellBand,
    seamMinutes,
    stripClickDetail,
    stripMinutesForSvgX,
    stripWindow,
    svgXFromEvent,
    type ScheduleStripGeometry,
} from "./strip-geometry";
import { renderNowMarkerOnDay } from "./now-marker.js";
import { renderSlotGridlines, slotGridTicks } from "../shared/slot-gridlines";
import { helmanColorVars } from "../color-vars";
import { hourAnchorOffset, selectLabelledColumns, stripValueLabel } from "../shared/strip-value-labels";
import type { PriceColumn } from "./inspector-day-model";

/** The strip's own geometry; it borrows only the x scale from the chart. */
const PRICE_STRIP = { height: 65, padTop: 8, padBottom: 8 } as const;

/** Ink for a label sitting on a filled bar, per that fill's lightness. */
const INK_ON_IMPORT = "#ffffff";
const INK_ON_EXPORT = "#0f172a";
const INK_ON_NEGATIVE = "#ffffff";
/** Below this bar height the inner label is written above the bar, not in it. */
const LABEL_INSIDE_MIN_HEIGHT = 12;
/** Share of the plot height given to rates below zero, when any day has one. */
const NEGATIVE_BAND_SHARE = 0.3;

/**
 * A bar's fill. A negative rate takes the adverse colour whichever side it
 * belongs to, because a price that has gone upside down is worth seeing before
 * the direction it was flowing in.
 */
function _fillFor(value: number, side: "import" | "export"): string {
    if (value < 0) return "var(--helman-price-negative)";
    return side === "import" ? "var(--helman-grid-import)" : "var(--helman-grid-export)";
}

/** Ink that reads against a given bar's fill, or against the plot for none. */
function _inkOn(bar: { value: number; side: "import" | "export" } | null): string {
    if (bar === null) return "var(--secondary-text-color)";
    if (bar.value < 0) return INK_ON_NEGATIVE;
    return bar.side === "export" ? INK_ON_EXPORT : INK_ON_IMPORT;
}

/** One slot's two rates, zipped so the strip can draw them as a single column. */
interface PriceCell {
    startMinutes: number;
    endMinutes: number;
    importValue: number | null;
    exportValue: number | null;
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
 * shows the prices that applied then rather than an empty strip. They arrive
 * already laid out on the slot grid -- the day view's columns, the same ones the
 * inspector's selected-slot tiles quote -- so the strip only draws them.
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
            height: ${PRICE_STRIP.height}px;
        }
    `];

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** Selected inspector day, `YYYY-MM-DD`. */
    @property({ type: String }) public date = "";
    @property({ type: String }) public timeZone = "UTC";
    @property({ attribute: false }) public geometry: ScheduleStripGeometry | null = null;
    /** Minute-of-day of every selected slot; each gets a blue band. */
    @property({ attribute: false }) public selectedMinutes: readonly number[] = EMPTY_SELECTED_MINUTES;
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
    @property({ attribute: false }) public importColumns: readonly PriceColumn[] = [];
    /** What a kilowatt-hour sold to the grid earned, per slot of this day. */
    @property({ attribute: false }) public exportColumns: readonly PriceColumn[] = [];
    /** The currency-per-energy unit both rails are quoted in, e.g. `CZK/kWh`. */
    @property({ type: String }) public unit = "";

    render() {
        if (!this.hass || this.geometry === null) {
            return nothing;
        }
        if (this.importColumns.length === 0 && this.exportColumns.length === 0) {
            return nothing;
        }
        return this._renderStrip(this.importColumns, this.exportColumns, this.geometry);
    }

    private _renderStrip(
        importColumns: readonly PriceColumn[],
        exportColumns: readonly PriceColumn[],
        geometry: ScheduleStripGeometry,
    ): TemplateResult {
        const { height, padTop, padBottom } = PRICE_STRIP;
        const innerHeight = height - padTop - padBottom;
        const allColumns = [...importColumns, ...exportColumns];
        // One y-scale for both rails: they are the same unit, and the whole point
        // of drawing them together is that their heights are comparable.
        const hasNegative = allColumns.some((column) => column.value < 0);
        // Each side of zero gets its own scale. Splitting the height evenly and
        // scaling both by the larger extent would draw a lone -0.3 against a
        // 7.3 import rate as a hairline nobody can see or label -- and "the
        // rate went negative" is the one thing on this strip worth not missing.
        // The bands stay fixed so the zero line does not jump between days.
        const maxPositive = Math.max(0.0001, ...allColumns.map((c) => Math.max(0, c.value)));
        const maxNegative = Math.max(0.0001, ...allColumns.map((c) => Math.max(0, -c.value)));
        const negativeBand = hasNegative ? innerHeight * NEGATIVE_BAND_SHARE : 0;
        const positiveBand = innerHeight - negativeBand;
        const zeroY = padTop + positiveBand;
        const yForValue = (value: number) =>
            value >= 0
                ? zeroY - (value / maxPositive) * positiveBand
                : zeroY + (-value / maxNegative) * negativeBand;
        const seam = seamMinutes(this.nowMs, this.date, this.timeZone, this.slotMinutes);
        const { start: windowStart, end: windowEnd } = stripWindow(geometry);
        const windowSpan = windowEnd - windowStart;
        const xForMinutes = (minutes: number) =>
            geometry.marginLeft + ((minutes - windowStart) / windowSpan) * geometry.plotWidth;
        const cells = this._pairCells(importColumns, exportColumns);

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
                    ${this._renderGuides(geometry, zeroY, yForValue, maxPositive, maxNegative, hasNegative)}
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
                    ${renderCellBand(cells, this.hoverMinutes, "hover", height, xForMinutes)}
                    ${this.selectedMinutes.map((minutes) =>
                        renderCellBand(cells, minutes, "selected", height, xForMinutes))}
                    <g clip-path="url(#price-plot-clip)">
                    ${this._renderPairedBars(cells, { zeroY, yForValue, seam, xForMinutes })}
                    </g>
                    ${renderNowMarkerOnDay(this, { start: windowStart, end: windowEnd }, xForMinutes, 0, height, this._t("scheduling.badge.now"))}
                    <!-- The prices come after the marker so the line passes
                         behind the figure it crosses instead of through it. -->
                    <g clip-path="url(#price-plot-clip)">
                    ${this._renderPairedLabels(cells, {
                        zeroY, yForValue, height, xForMinutes,
                        window: { start: windowStart, end: windowEnd },
                    })}
                    </g>
                </svg>
            `}
            </div>
        `;
    }

    /**
     * The two rails zipped into one cell each, so a slot is drawn as a single
     * column rather than a pair of half-width ones. A cell may hold only one of
     * the two — a day whose export price was never recorded still draws its
     * import rate. Both rails sit on the one slot grid, so a cell is simply that
     * grid's cell, and the selection and hover bands snap to the same cells.
     */
    private _pairCells(
        importColumns: readonly PriceColumn[],
        exportColumns: readonly PriceColumn[],
    ): PriceCell[] {
        const byStart = new Map<number, PriceCell>();
        const put = (column: PriceColumn, side: "import" | "export") => {
            const cell = byStart.get(column.startMinutes) ?? {
                startMinutes: column.startMinutes,
                endMinutes: column.endMinutes,
                importValue: null,
                exportValue: null,
            };
            if (side === "import") cell.importValue = column.value;
            else cell.exportValue = column.value;
            byStart.set(column.startMinutes, cell);
        };
        importColumns.forEach((column) => put(column, "import"));
        exportColumns.forEach((column) => put(column, "export"));
        return [...byStart.values()].sort((a, b) => a.startMinutes - b.startMinutes);
    }

    /**
     * A cell's rates in drawing order: the one further from zero first.
     *
     * Both bars run from the zero line to their own value across the full width
     * of the cell. The nearer one is drawn second and covers the stretch they
     * share, so what stays visible of the first is exactly the gap between the
     * two rates — the spread, in the colour of whichever side is the outer one.
     * Ordering by distance from zero rather than by value is what keeps that
     * true once a rate goes negative: two negative rates put the nearer-zero
     * colour against the axis, and rates of opposite sign never overlap at all,
     * each keeping its own side of the line.
     */
    private _cellBars(cell: PriceCell): { value: number; side: "import" | "export" }[] {
        const bars: { value: number; side: "import" | "export" }[] = [];
        if (cell.importValue !== null) bars.push({ value: cell.importValue, side: "import" });
        if (cell.exportValue !== null) bars.push({ value: cell.exportValue, side: "export" });
        return bars.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    }

    /** A cell's full width, less a hairline so neighbours stay distinct. */
    private _cellSpan(
        cell: PriceCell,
        xForMinutes: (minutes: number) => number,
    ): { left: number; width: number } {
        const left = xForMinutes(cell.startMinutes);
        const right = xForMinutes(cell.endMinutes);
        return { left: left + 0.25, width: Math.max(1, right - left - 0.5) };
    }

    private _renderPairedBars(
        cells: PriceCell[],
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
            return this._cellBars(cell).map(({ value, side }) => {
                const color = _fillFor(value, side);
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
     * Which cells keep their rates: one decision per column, not per rate.
     *
     * The two rates of a cell are one reading of it. Thinned apart they would
     * be drawn on the same side of zero in neighbouring columns whenever the
     * two are close, which is a collision the per-rate spacing cannot see --
     * the money strip can afford separate series only because its cost and
     * gain sit on opposite sides of a zero line.
     *
     * Ranked and compared on *both* rates. Keyed on the outer one alone, a day
     * whose import rate barely moves reads as one long repeat and loses every
     * column after the first -- while the export rate, the one actually
     * fluctuating, never gets a say. A column is a repeat only when neither of
     * its rates has changed. Cells outside the drawn window are no candidates:
     * `xForMinutes` does not clamp, so they are laid out past the plot and
     * clipped, and letting them rank would spend the "keep the two ends" rule
     * on columns nobody can see.
     */
    private _labelledCells(
        cells: PriceCell[],
        ctx: { xForMinutes: (minutes: number) => number; window: { start: number; end: number } },
    ): boolean[] {
        const visible = (cell: PriceCell) =>
            cell.endMinutes > ctx.window.start && cell.startMinutes < ctx.window.end;
        const first = cells.find(visible);
        return selectLabelledColumns(
            cells.map((cell) => {
                const bars = this._cellBars(cell);
                return bars.length === 0 || !visible(cell)
                    ? { value: null, text: null }
                    : {
                        // Both rates in the key, so either one moving makes the
                        // column a new reading; their sum as the value, so
                        // either one swinging makes it a prominent one.
                        text: bars.map(({ value }) => formatMoney(value, "")).join("/"),
                        value: bars.reduce((total, { value }) => total + value, 0),
                    };
            }),
            {
                columnWidthPx: first === undefined ? 0 : this._cellSpan(first, ctx.xForMinutes).width,
                anchorOffset: hourAnchorOffset(cells.map((cell) => cell.startMinutes)),
            },
        );
    }

    /**
     * One label per rate. The outer rate is written past the end of the column
     * in the ordinary text colour, the way a single-series bar chart labels its
     * top. The inner one is written against a filled bar, so two things decide
     * how it is drawn.
     *
     * Where: just inside its own bar's edge when that bar is tall enough to
     * hold the digits, and just *past* that edge when it is not — which puts it
     * over the outer rate's fill rather than dropping it, because a rate near
     * zero still has a number worth reading, and a short bar is exactly when
     * the reader most needs telling how short.
     *
     * What colour: whichever ink contrasts with the fill it ends up on, which
     * is its own bar's when it fits inside and the outer bar's when it spills.
     * The export fill is the lighter of the two by design, so it takes dark ink
     * and the import fill takes white.
     */
    private _renderPairedLabels(
        cells: PriceCell[],
        ctx: {
            zeroY: number;
            yForValue: (value: number) => number;
            height: number;
            xForMinutes: (minutes: number) => number;
            window: { start: number; end: number };
        },
    ) {
        const labelled = this._labelledCells(cells, ctx);
        return cells.map((cell, cellIndex) => {
            if (!labelled[cellIndex]) {
                return "";
            }
            const { left, width } = this._cellSpan(cell, ctx.xForMinutes);
            const centre = left + width / 2;
            const bars = this._cellBars(cell);
            return bars.map(({ value, side }, index) => {
                const valueY = ctx.yForValue(value);
                if (index === 0) {
                    const y = value >= 0
                        ? Math.max(valueY - 3, 9)
                        : Math.min(valueY + 9, ctx.height - 2);
                    return stripValueLabel({ x: centre, y, text: formatMoney(value, "") });
                }
                const fitsInside = Math.abs(valueY - ctx.zeroY) >= LABEL_INSIDE_MIN_HEIGHT;
                const y = value >= 0
                    ? (fitsInside ? valueY + 9 : valueY - 3)
                    : (fitsInside ? valueY - 3 : valueY + 9);
                // Spilling past its own bar lands the label on the outer bar's
                // fill -- but only when the two share a sign and therefore
                // overlap. Rates of opposite sign sit on their own sides of
                // zero, so a spilled label there lands on the plot itself.
                const outer = bars[0];
                const shareSign = value < 0 === outer.value < 0;
                const onFill = fitsInside
                    ? { value, side }
                    : (shareSign ? outer : null);
                return stripValueLabel({
                    x: centre, y, text: formatMoney(value, ""), ink: _inkOn(onFill), bold: true,
                });
            });
        });
    }

    private _renderGuides(
        geometry: ScheduleStripGeometry,
        zeroY: number,
        yForValue: (value: number) => number,
        maxPositive: number,
        maxNegative: number,
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
        // Each guide is read off its own band's extent, so the axis states what
        // the bars were actually scaled by rather than one shared maximum.
        return svg`
            ${line(yForValue(maxPositive))}
            ${label(yForValue(maxPositive), formatMoney(maxPositive, "", { precision: "axis" }))}
            ${line(zeroY)}${label(zeroY, "0")}
            ${hasNegative
                ? svg`${line(yForValue(-maxNegative))}${label(yForValue(-maxNegative), `-${formatMoney(maxNegative, "", { precision: "axis" })}`)}`
                : nothing}
        `;
    }

    /**
     * The blue selection or orange hover band. A minute falls inside one price
     * cell, and the band covers that whole cell — so an hour-long price cell
     * reads as the full hour, not the finer slot the minute came from.
     */

    /**
     * Turn a click into the minute-of-day the inspector resolves to a slot. A
     * click in the axis gutter carries `null` so the inspector clears selection,
     * matching how clicking outside the plot on the chart deselects.
     */
    private _handleClick(event: MouseEvent, geometry: ScheduleStripGeometry): void {
        this.dispatchEvent(
            new CustomEvent<SlotPickDetail>("slot-pick", {
                detail: stripClickDetail(event, geometry),
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
        importColumns: readonly PriceColumn[],
        exportColumns: readonly PriceColumn[],
    ): void {
        const minutes = stripMinutesForSvgX(geometry, svgXFromEvent(event, geometry.width));
        const at = (columns: readonly PriceColumn[]) =>
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
                ? `${formatClock(titleColumn.startMinutes)} – ${formatClock(titleColumn.endMinutes)}`
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
            forecast: { value: formatMoney(value, this.unit), color },
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

    private _t(key: string, values?: Record<string, string | number>): string {
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
