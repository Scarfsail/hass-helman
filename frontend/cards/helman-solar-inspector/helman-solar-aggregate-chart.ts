import { LitElement, css, html, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { helmanColorVars } from "../color-vars";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { CHART_COLORS } from "./chart-colors";
import { slotSelectionModeForEvent, type SlotSelectionMode } from "./slot-selection";
import { columnFitsLabel, stripValueLabel } from "../shared/strip-value-labels";
import { symmetricEnergyAxis } from "./chart-axis";
import { accumulateBands, clampToSign, stackSlots, type StackBand, type StackLayer, type StackSet } from "./chart-stack";

/** One bucket of the span read: a local day, or a local month. */
export interface SpanAggregateRow {
    /** `YYYY-MM-DD` for a day bucket, `YYYY-MM-01` for a month one. */
    date: string;
    solarWh: number | null;
    gridImportKwh: number | null;
    gridExportKwh: number | null;
    batteryMinSocPct: number | null;
    batteryMaxSocPct: number | null;
    houseWh: number | null;
    batteryChargeWh: number | null;
    batteryDischargeWh: number | null;
    moneyCost: number | null;
    moneyGain: number | null;
}

/**
 * How far the inspector may be navigated, in either direction.
 *
 * Both payloads carry it, so a card that opened straight into a span view
 * navigates against the same floor a day view would have given it.
 */
export interface NavigationRange {
    minDate: string;
    maxDate: string;
}

/** What `helman/solar_bias/day_aggregates` answers with. */
export interface SpanAggregatePayload {
    bucket: "day" | "month";
    currency: string | null;
    days: SpanAggregateRow[];
    range?: NavigationRange;
}

/**
 * A column was clicked; the inspector holds the selection.
 *
 * `key` is null for a click that landed outside the plot -- the axis gutter or
 * the margins -- which is the day view's "clear the selection" gesture, read
 * here from where the click landed rather than from a pointer coordinate.
 *
 * The modifier keys travel with it as a {@link SlotSelectionMode}, so the card
 * can run a bucket click through exactly the semantics a slot click gets. This
 * element stays a reporter: it says what was pressed and how, and the card
 * decides what that does to the selection.
 */
export interface AggregateBucketSelectDetail {
    key: string | null;
    mode: SlotSelectionMode;
}

/**
 * The pointer moved onto a column, or off the chart entirely (`key: null`).
 *
 * The coordinates are the pointer's own, in client space, because the popup the
 * inspector draws from them is `position: fixed` -- the same contract the day
 * chart's hover already uses, so one tooltip serves both views.
 */
export interface AggregateBucketHoverDetail {
    key: string | null;
    x: number;
    y: number;
}

/**
 * The chart's own geometry. It is not the inspector's: nothing else is drawn
 * against this axis, so there is no strip below to stay aligned with and no
 * reason to inherit the day chart's margins. The left gutter is a little
 * narrower than the day chart's because a kWh axis reaches two digits where a
 * kW one reaches one plus a decimal.
 */
const CHART = { height: 240, marginTop: 16, marginRight: 16, marginBottom: 24, marginLeft: 44 } as const;

/**
 * The fill opacity the day chart gives a measured band, repeated here so the
 * two views read as one language rather than as two charts that happen to share
 * colours.
 */
const BAND_FILL_OPACITY = 0.45;

/**
 * How a picked column is drawn, and how a pointed-at one is -- the day view's
 * own two treatments, character for character.
 *
 * Selected is the blue `_renderSlotHighlight` paints a selected slot in; hover
 * is the amber the day chart's hover band uses. Keeping them apart by *hue*
 * rather than by opacity is the point: a selection that wore the hover colour
 * left the two tellable apart only by how strong they were.
 */
const SELECTED_STYLE = "fill: color-mix(in srgb, var(--helman-grid-import) 13%, transparent);"
    + " stroke: var(--helman-grid-import); stroke-width: 1; stroke-opacity: 0.5;";
const HOVER_STYLE = "fill: color-mix(in srgb, var(--helman-selection) 14%, transparent);"
    + " stroke: var(--helman-selection); stroke-width: 1;";

/** Below this column width a label cannot be written without colliding. */
const MIN_LABEL_PX = 13;

/**
 * The two rows drawn under the energy chart, on its x geometry.
 *
 * They keep the chart's left and right margins and take their column positions
 * from it, so the three panels line up by construction rather than by two sets
 * of numbers that have to be kept equal. Each is its own `<svg>` because each
 * has its own y scale -- a percentage, and an amount of money -- and nothing
 * about them belongs on the kWh axis above.
 */
const SOC_ROW = { height: 96, marginTop: 14, marginBottom: 10 } as const;

/**
 * How solidly the low-water bar fills, against the high-water one behind it.
 *
 * The two are the same colour because they are the same quantity read twice, so
 * only weight separates them: the darker one is the level the battery never went
 * below, the lighter one how far it climbed above that.
 */
const SOC_MIN_FILL_OPACITY = 0.85;
const MONEY_ROW = { height: 96, marginTop: 14, marginBottom: 10 } as const;

/** A state of charge is a percentage, so its axis is the fixed 0..100. */
const SOC_TICKS = [0, 50, 100] as const;

/**
 * The buckets that have something to draw, split into unbroken stretches.
 *
 * A gap is a break rather than a zero, in every row of this chart: a bucket the
 * meter has no reading for, a bucket whose SoC bounds are missing, a bucket that
 * cost nothing. Each stretch becomes its own path, so an absent bucket stays
 * visibly absent instead of being bridged by a straight edge across it.
 */
function contiguousRuns(indices: readonly number[], has: (index: number) => boolean): number[][] {
    const runs: number[][] = [];
    for (const index of indices) {
        if (!has(index)) continue;
        const current = runs[runs.length - 1];
        if (current && current[current.length - 1] === index - 1) current.push(index);
        else runs.push([index]);
    }
    return runs;
}

/**
 * A money gridline's label: enough digits to tell two ticks apart, and no more.
 *
 * A row's ticks are its extremes and zero, so they are far apart; two decimals
 * on a month's worth of import cost would be four digits of noise in a
 * left gutter sized for two.
 */
function formatMoneyTick(value: number): string {
    if (value === 0) return "0";
    return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/**
 * One run of buckets as a closed step area: along the top edge and back along
 * the base.
 *
 * Every filled shape in this chart is built this way -- the energy bands, the
 * SoC ranges and the money cells alike -- because a bucket is an *interval*:
 * its edge runs flat across the whole width it stands for and meets its
 * neighbour's, which is what makes the aggregate views read as the day chart at
 * a wider zoom rather than as a bar chart of separate things.
 */
function stepAreaPath(
    run: readonly number[],
    topAt: (index: number) => number,
    baseAt: (index: number) => number,
    xFor: (index: number) => number,
): string {
    const edge = (index: number, at: (index: number) => number) => {
        const y = at(index);
        return [[xFor(index), y], [xFor(index + 1), y]] as const;
    };
    const outer = run.flatMap((index) => [...edge(index, topAt)]);
    const inner = [...run].reverse().flatMap((index) => [...edge(index, baseAt)].reverse());
    return [...outer, ...inner]
        .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
        .join(" ") + " Z";
}

/**
 * A span of history as one column per bucket.
 *
 * Its own element rather than a mode of the inspector's day chart, and that is
 * the load-bearing decision of this feature: at a month's or a year's width a
 * whole day collapses into a single column, so the price rail, the planned
 * actions band, the SoC trajectory and the forecast each describe something
 * that only exists *inside* a day. The inspector's `_renderContent` is built
 * around them -- two dozen render methods deep -- and threading a wider axis
 * through it would have put every one of them at risk to reach the six that
 * generalise. Here nothing about the day view can move, because none of it is
 * running.
 *
 * What it does share is the arithmetic: `StackSet`, `accumulateBands` and
 * `clampToSign` are generic over numeric positions, so a bucket *index* stands
 * in for the day chart's minute-of-day and the stacking is the same code. The
 * columns carry **energy in kWh**, not average power: a day has no meaningful
 * average power, and `toAveragePower` would divide its watt-hours by a bucket
 * width that no longer exists.
 *
 * History only. The backend serves these buckets from long-term statistics,
 * which hold what happened and nothing about what was planned, so there is no
 * forecast half to compare against and no seam to draw.
 */
@customElement("helman-solar-aggregate-chart")
export class HelmanSolarAggregateChart extends LitElement {
    static styles = [helmanColorVars, css`
        :host {
            display: block;
            width: 100%;
        }

        .chart-wrap {
            width: 100%;
        }

        .chart-wrap svg {
            display: block;
            width: 100%;
            height: auto;
        }
    `];

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** The span's buckets, oldest first, gaps included as all-null rows. */
    @property({ attribute: false }) public rows: readonly SpanAggregateRow[] = [];
    /** What one column is: a day of a month view, or a month of a year view. */
    @property({ type: String }) public bucket: "day" | "month" = "day";
    /**
     * Every selected bucket key, in the order the span draws them.
     *
     * A set rather than one key, because a bucket selects exactly as a slot
     * does at 15/30/60 -- ctrl toggles, shift extends -- and the panel below
     * describes the whole selection.
     */
    @property({ attribute: false }) public selectedKeys: readonly string[] = [];
    /** viewBox width; the SVG scales to its container, so this is only a ratio. */
    @property({ type: Number }) public width = 900;
    /**
     * The currency the money row's amounts are in, as the span payload carries
     * it. Empty where the backend could not derive one -- the amounts are still
     * drawn, because their relative sizes are the point of the row.
     */
    @property({ type: String }) public currency = "";

    /**
     * The bucket the card says is hovered, or null.
     *
     * Owned there rather than here, and this element draws what comes back
     * rather than what its own pointer did. That round trip is the point: at D
     * the day pills are showing the same days as these columns, and a hover
     * either of them kept to itself could not light the other. The pointer
     * handlers below still *report* -- they just no longer decide.
     */
    @property({ type: String }) public hoveredKey: string | null = null;

    private _t(key: string): string {
        const localize: LocalizeFunction = this.hass
            ? getLocalizeFunction(this.hass)
            : (raw: string) => raw;
        return localize(key);
    }

    render() {
        const rows = this.rows ?? [];
        if (rows.length === 0) {
            return nothing;
        }
        // Deliberately no bail on an empty stack. A span whose energy meters
        // have no statistics -- purged, or never configured -- still has SoC
        // bounds and money to show, and the energy chart is where the hit rects
        // live, so dropping it would take the pointing surface with it. The
        // chart draws its axis over an empty field instead, which is the honest
        // reading of "no energy here", and the two rows below carry on.
        const set = this._buildStack(rows);
        const indices = stackSlots(set, 1);
        return this._renderChart(rows, set, indices);
    }

    /**
     * The six meters as two mirrored stacks, keyed by bucket index.
     *
     * Supply above the line, demand below, in the same order and the same
     * colours the day chart uses -- moving between the two views is meant to be
     * a change of width, not a change of language. Unlike the day chart the two
     * battery and grid directions are *separate meters* here rather than one
     * signed series, so each gets its own layer and neither needs clamping to a
     * side it can never reach.
     */
    private _buildStack(rows: readonly SpanAggregateRow[]): StackSet {
        const layer = (
            color: string,
            sign: 1 | -1,
            read: (row: SpanAggregateRow) => number | null,
        ): StackLayer => {
            const values = new Map<number, number>();
            rows.forEach((row, index) => {
                const value = read(row);
                if (value === null || !Number.isFinite(value)) return;
                // A bucket with no reading is left out of the map entirely, so
                // the column simply has no band there. Writing a zero would
                // claim the meter measured nothing, which is a different -- and
                // for a purged or not-yet-configured meter, wrong -- statement.
                values.set(index, clampToSign(Math.abs(value) * sign, sign));
            });
            return { color, values };
        };
        const kwh = (wh: number | null) => (wh === null ? null : wh / 1000);
        return {
            positive: [
                layer(CHART_COLORS.corrected, 1, (row) => kwh(row.solarWh)),
                layer(CHART_COLORS.battery, 1, (row) => kwh(row.batteryDischargeWh)),
                layer(CHART_COLORS.grid, 1, (row) => row.gridImportKwh),
            ],
            negative: [
                layer(CHART_COLORS.house, -1, (row) => kwh(row.houseWh)),
                layer(CHART_COLORS.battery, -1, (row) => kwh(row.batteryChargeWh)),
                layer(CHART_COLORS.grid, -1, (row) => row.gridExportKwh),
            ],
        };
    }

    private _renderChart(
        rows: readonly SpanAggregateRow[],
        set: StackSet,
        indices: number[],
    ) {
        const plotWidth = this.width - CHART.marginLeft - CHART.marginRight;
        const plotHeight = CHART.height - CHART.marginTop - CHART.marginBottom;
        const columnWidth = plotWidth / rows.length;

        const positive = accumulateBands(set.positive, indices, 1);
        const negative = accumulateBands(set.negative, indices, -1);
        const peak = Math.max(
            0,
            ...positive.flatMap((band) => [...band.top.values()]),
            ...negative.flatMap((band) => [...band.top.values()].map((value) => -value)),
        );
        const { maxKwh, yTicks } = symmetricEnergyAxis(peak);
        const zeroY = CHART.marginTop + plotHeight / 2;
        const yFor = (kwh: number) => zeroY - (kwh / maxKwh) * (plotHeight / 2);
        const xFor = (index: number) => CHART.marginLeft + index * columnWidth;

        return html`
            <div class="chart-wrap">
                ${svg`
                <svg
                    viewBox="0 0 ${this.width} ${CHART.height}"
                    role="img"
                    class="aggregate-chart"
                    aria-label=${this._t("bias_correction.inspector.aggregate_chart")}
                    style="cursor: pointer;"
                    @click=${this._clickOutside}
                    @mouseleave=${this._clearHover}
                >
                    ${this._renderAxis(yTicks, yFor, plotWidth)}
                    ${this._renderColumns(rows, xFor, columnWidth)}
                    ${this._renderHoverHighlight(xFor, columnWidth)}
                    ${[...positive, ...negative].map(
                        (band) => this._renderBand(band, indices, xFor, yFor),
                    )}
                    ${this._renderBucketLabels(rows, xFor, columnWidth)}
                </svg>
            `}
            </div>
            ${this._renderSocRow(rows, xFor, columnWidth, plotWidth)}
            ${this._renderMoneyRow(rows, xFor, columnWidth, plotWidth)}
        `;
    }

    /**
     * The battery's SoC as one range per bucket, on a fixed 0..100 axis.
     *
     * A *range*, not a trajectory. The day view's SoC bars are the level each
     * slot ended at, with a measured/forecast seam and charge/discharge
     * colouring -- none of which survives collapsing a day: there is no level a
     * day "ended at" worth drawing, no forecast here at all, and a direction is
     * not a property a whole day has. What a day does have is how low the
     * battery got and how high it came back, which is why this is the one panel
     * of the day view that is rebuilt here rather than reused. `buildSocBars`
     * and the inspector's SoC section stay day-only and untouched.
     *
     * One neutral battery colour for the same reason: `resolveSocDirection`
     * answers a question a range does not ask.
     *
     * A bucket missing *either* bound draws nothing, rather than a zero-height
     * range at the bound that is known -- a half-known range is not a range, and
     * drawing it at the known end would read as a battery that never moved. That
     * is P1's null-not-zero rule applied to a pair.
     *
     * The axis is fixed rather than fitted to the span: a percentage has its own
     * ends, and scaling to the data would make a month that stayed between 40
     * and 60 look like one that swung the full range.
     */
    private _renderSocRow(
        rows: readonly SpanAggregateRow[],
        xFor: (index: number) => number,
        columnWidth: number,
        plotWidth: number,
    ) {
        const bounds = (row: SpanAggregateRow | undefined) => {
            const min = row?.batteryMinSocPct ?? null;
            const max = row?.batteryMaxSocPct ?? null;
            if (min === null || max === null) return null;
            if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
            // Clamped to the axis this row draws. A BMS that rounds to 100.4 %
            // would otherwise push the range's top edge above the plot and
            // through the caption sitting in the margin, and a negative reading
            // would spill out of the bottom. The shared gauge clamps for the
            // same reason.
            const clamp = (pct: number) => Math.max(0, Math.min(100, pct));
            return { min: clamp(Math.min(min, max)), max: clamp(Math.max(min, max)) };
        };
        const indices = rows.map((_, index) => index);
        const runs = contiguousRuns(indices, (index) => bounds(rows[index]) !== null);
        if (runs.length === 0) return nothing;

        const plotHeight = SOC_ROW.height - SOC_ROW.marginTop - SOC_ROW.marginBottom;
        const yFor = (pct: number) => SOC_ROW.marginTop + (1 - pct / 100) * plotHeight;
        return html`
            <div class="chart-wrap">
                ${svg`
                <svg
                    viewBox="0 0 ${this.width} ${SOC_ROW.height}"
                    role="img"
                    class="soc-row"
                    aria-label=${this._t("bias_correction.inspector.aggregate_soc_row")}
                    style="cursor: pointer;"
                    @click=${this._clickOutside}
                    @mouseleave=${this._clearHover}
                >
                    ${this._renderRowGuides(SOC_TICKS, yFor, plotWidth, (tick) => String(tick))}
                    ${this._renderRowColumns(rows, xFor, columnWidth, SOC_ROW.marginTop, plotHeight)}
                    ${runs.map((run) => svg`
                        <path
                            class="soc-band max"
                            d=${stepAreaPath(
                                run,
                                (index) => yFor(bounds(rows[index])!.max),
                                () => yFor(0),
                                xFor,
                            )}
                            fill=${CHART_COLORS.battery} fill-opacity=${BAND_FILL_OPACITY}
                            stroke=${CHART_COLORS.battery} stroke-width="0.75" stroke-opacity="0.6"
                            pointer-events="none"
                        ></path>
                        <path
                            class="soc-band min"
                            d=${stepAreaPath(
                                run,
                                (index) => yFor(bounds(rows[index])!.min),
                                () => yFor(0),
                                xFor,
                            )}
                            fill=${CHART_COLORS.battery} fill-opacity=${SOC_MIN_FILL_OPACITY}
                            stroke=${CHART_COLORS.battery} stroke-width="0.75" stroke-opacity="0.6"
                            pointer-events="none"
                        ></path>
                    `)}
                    ${this._renderSocLabels(rows, bounds, xFor, columnWidth, yFor)}
                    ${this._renderRowCaption(this._t("bias_correction.inspector.aggregate_soc_row"))}
                </svg>
            `}
            </div>
        `;
    }

    /**
     * Each bucket's two percentages, written where the day view writes its one.
     *
     * The high-water mark sits above the column and the low-water mark just
     * above its own bar, so each number is next to the edge it describes. Both
     * go through the shared strip label, which means they disappear at the same
     * column width the day view's percentages, prices and amounts do -- the
     * whole point of that helper being shared.
     *
     * The low mark is drawn on the darker fill, so it takes the on-fill
     * treatment the helper offers: bold, in the primary ink.
     */
    private _renderSocLabels(
        rows: readonly SpanAggregateRow[],
        bounds: (row: SpanAggregateRow | undefined) => { min: number; max: number } | null,
        xFor: (index: number) => number,
        columnWidth: number,
        yFor: (pct: number) => number,
    ) {
        if (!columnFitsLabel(columnWidth)) return nothing;
        return rows.map((row, index) => {
            const pair = bounds(row);
            if (pair === null) return nothing;
            const centre = xFor(index) + columnWidth / 2;
            const low = svg`${stripValueLabel({
                x: centre,
                y: Math.min(yFor(pair.min) + 8, yFor(0) - 2),
                text: `${Math.round(pair.min)}%`,
                ink: "var(--primary-text-color)",
                bold: true,
            })}`;
            // A range too shallow to hold two lines of digits says everything
            // with one: the high mark, which is the number a reader scans for.
            const separated = yFor(pair.min) - yFor(pair.max) >= 14;
            return svg`
                ${stripValueLabel({
                    x: centre,
                    y: Math.max(yFor(pair.max) - 3, 9),
                    text: `${Math.round(pair.max)}%`,
                })}
                ${separated ? low : nothing}
            `;
        });
    }

    /**
     * What each bucket cost and earned, cost above the line and gain below it.
     *
     * Not `helman-solar-money-strip`: that strip is day-shaped where it counts
     * -- its cells are minute positions, floored by the inspector's slot width,
     * and split at a measured/forecast seam that a span has no equivalent of. It
     * stays day-only. What *is* reused is the model underneath it, unchanged:
     * `MoneyPoint` and `sumMoney` match on a slot key and never parse it, so a
     * bucket key works where an `HH:MM` one did, and the inspector's totals sum
     * these buckets through the same function the day's selection uses.
     *
     * Signed the way the strip is: cost rises, gain falls, so the two are never
     * told apart by colour alone, and a negative amount -- a gain earned at a
     * negative export rate -- simply crosses the line. The two directions share
     * one scale so their heights stay comparable, and a side with nothing on it
     * gets no half of the plot.
     */
    private _renderMoneyRow(
        rows: readonly SpanAggregateRow[],
        xFor: (index: number) => number,
        columnWidth: number,
        plotWidth: number,
    ) {
        const amount = (value: number | null | undefined) =>
            value === null || value === undefined || !Number.isFinite(value) ? null : value;
        const cost = (index: number) => amount(rows[index]?.moneyCost);
        // Drawn downward, so the sign is flipped once here and nowhere else.
        const gain = (index: number) => {
            const value = amount(rows[index]?.moneyGain);
            return value === null ? null : -value;
        };
        const indices = rows.map((_, index) => index);
        const drawn = indices.flatMap((index) => [cost(index), gain(index)])
            .filter((value): value is number => value !== null);
        if (drawn.length === 0) return nothing;

        const plotHeight = MONEY_ROW.height - MONEY_ROW.marginTop - MONEY_ROW.marginBottom;
        const maxUp = Math.max(0, ...drawn);
        const maxDown = Math.max(0, ...drawn.map((value) => -value));
        // A side with nothing on it gets no half of the plot: cost alone grows
        // up from the floor, gain alone down from the ceiling. A span priced at
        // exactly zero throughout has *neither* side, and is drawn as though it
        // had both -- otherwise the baseline lands on the row's top edge with an
        // empty field beneath it, which reads as a row of pure gain rather than
        // a row of nothing.
        const empty = maxUp === 0 && maxDown === 0;
        const upBand = maxUp > 0 || empty;
        const downBand = maxDown > 0 || empty;
        const bands = (upBand ? 1 : 0) + (downBand ? 1 : 0);
        const bandHeight = plotHeight / bands;
        const zeroY = MONEY_ROW.marginTop + (upBand ? bandHeight : 0);
        const extent = Math.max(0.0001, maxUp, maxDown);
        const yFor = (value: number) => zeroY - (value / extent) * bandHeight;
        const ticks = [
            ...(maxUp > 0 ? [maxUp] : []),
            0,
            ...(maxDown > 0 ? [-maxDown] : []),
        ];
        const caption = this.currency
            ? `${this._t("bias_correction.inspector.aggregate_money_row")} (${this.currency})`
            : this._t("bias_correction.inspector.aggregate_money_row");
        const cell = (
            klass: string,
            color: string,
            read: (index: number) => number | null,
        ) => contiguousRuns(indices, (index) => {
            const value = read(index);
            return value !== null && value !== 0;
        }).map((run) => svg`
            <path
                class=${klass}
                d=${stepAreaPath(run, (index) => yFor(read(index)!), () => zeroY, xFor)}
                fill=${color} fill-opacity=${BAND_FILL_OPACITY}
                stroke=${color} stroke-width="0.75" stroke-opacity="0.6"
                pointer-events="none"
            ></path>
        `);
        return html`
            <div class="chart-wrap">
                ${svg`
                <svg
                    viewBox="0 0 ${this.width} ${MONEY_ROW.height}"
                    role="img"
                    class="money-row"
                    aria-label=${caption}
                    style="cursor: pointer;"
                    @click=${this._clickOutside}
                    @mouseleave=${this._clearHover}
                >
                    ${this._renderRowGuides(ticks, yFor, plotWidth, formatMoneyTick)}
                    ${this._renderRowColumns(rows, xFor, columnWidth, MONEY_ROW.marginTop, plotHeight)}
                    ${cell("money-band cost", CHART_COLORS.gridImport, cost)}
                    ${cell("money-band gain", CHART_COLORS.gridExport, gain)}
                    ${this._renderMoneyLabels(rows, xFor, columnWidth, yFor, zeroY)}
                    ${this._renderRowCaption(caption)}
                </svg>
            `}
            </div>
        `;
    }

    /**
     * Each bucket's cost and gain, written past the end of their own bars.
     *
     * The money strip's rule, kept: cost above its bar and gain below its, so
     * neither number fights the fill it belongs to, and an amount that rounds to
     * nothing gets no label -- "0.0" over a hairline bar says less than the bar
     * already did. The amounts are unitless here because the currency is stated
     * once, in the row's caption, rather than repeated thirty-one times.
     */
    private _renderMoneyLabels(
        rows: readonly SpanAggregateRow[],
        xFor: (index: number) => number,
        columnWidth: number,
        yFor: (value: number) => number,
        zeroY: number,
    ) {
        if (!columnFitsLabel(columnWidth)) return nothing;
        const worthLabelling = (amount: number | null): amount is number =>
            amount !== null && Number.isFinite(amount) && Math.abs(amount) >= 0.05;
        return rows.map((row, index) => {
            const centre = xFor(index) + columnWidth / 2;
            const costValue = row.moneyCost;
            const gainValue = row.moneyGain;
            return svg`
                ${worthLabelling(costValue)
                    ? stripValueLabel({
                        x: centre,
                        y: Math.max(yFor(costValue) - 3, 9),
                        text: formatMoneyTick(costValue),
                    })
                    : nothing}
                ${worthLabelling(gainValue)
                    ? stripValueLabel({
                        x: centre,
                        y: Math.max(yFor(-gainValue) + 8, zeroY + 8),
                        text: formatMoneyTick(gainValue),
                    })
                    : nothing}
            `;
        });
    }

    /** A row's gridlines and their left-gutter labels, on the chart's x span. */
    private _renderRowGuides(
        ticks: readonly number[],
        yFor: (value: number) => number,
        plotWidth: number,
        label: (tick: number) => string,
    ) {
        const right = CHART.marginLeft + plotWidth;
        return ticks.map((tick) => {
            const y = yFor(tick);
            return svg`
                <line
                    x1=${CHART.marginLeft} y1=${y} x2=${right} y2=${y}
                    stroke="var(--divider-color)" stroke-width="1"
                    opacity=${tick === 0 ? 0.9 : 0.35}
                    pointer-events="none"
                ></line>
                <text
                    x=${CHART.marginLeft - 6} y=${y + 4} text-anchor="end"
                    fill="var(--secondary-text-color)" font-size="10"
                    pointer-events="none"
                >${label(tick)}</text>
            `;
        });
    }

    /** What the row is, written into its top margin -- it has no legend. */
    private _renderRowCaption(text: string) {
        return svg`
            <text
                class="row-caption"
                x=${CHART.marginLeft + 2} y="10"
                fill="var(--secondary-text-color)" font-size="9"
                pointer-events="none"
            >${text}</text>
        `;
    }

    /**
     * One hit target per bucket in a row below the chart, tinted like the chart's.
     *
     * These carry the pointer as well as showing it. Pointing once, on the
     * chart, was the wrong economy: a reader looking at the SoC row is looking
     * *at* the SoC row, and asking them to move up to the energy chart to find
     * out what a column says is exactly the seam between panels this feature
     * keeps trying to close. Hover and click here mean what they mean up there,
     * and reach the same popup.
     */
    private _renderRowColumns(
        rows: readonly SpanAggregateRow[],
        xFor: (index: number) => number,
        columnWidth: number,
        top: number,
        height: number,
    ) {
        return rows.map((row, index) => {
            const selected = this._isSelected(row.date);
            const hovered = row.date === this.hoveredKey;
            // Hover reads over selection, as it does on the chart: the pointer
            // is about the column under it, whatever is already picked.
            const style = hovered
                ? HOVER_STYLE
                : selected
                    ? SELECTED_STYLE
                    // Transparent rather than `none`: a fill of `none` is not
                    // hit-tested, and this rect exists to be pointed at.
                    : "fill: transparent;";
            return svg`
                <rect
                    class="bucket-tint ${selected ? "selected" : ""} ${hovered ? "hovered" : ""}"
                    data-bucket=${row.date}
                    x=${xFor(index)} y=${top}
                    width=${columnWidth} height=${height}
                    style=${style}
                    @click=${(event: MouseEvent) => this._selectBucket(row.date, event)}
                    @mousemove=${(event: MouseEvent) => this._hoverBucket(index, event)}
                ></rect>
            `;
        });
    }

    /**
     * One band as a run of flat-topped steps, exactly as the day chart draws it.
     *
     * Contiguous, with no gap between neighbouring buckets: a bucket is an
     * interval, not a sample, so its band spans the whole width it stands for
     * and meets the next one. Inset bars would read as a bar chart of discrete
     * things and, more to the point, would not look like the same chart the
     * reader was just looking at one zoom level down.
     *
     * A bucket the meter has no reading for breaks the run rather than closing
     * to zero, so a gap in the data stays visibly a gap.
     */
    private _renderBand(
        band: StackBand,
        indices: number[],
        xFor: (index: number) => number,
        yFor: (kwh: number) => number,
    ) {
        const thickness = (index: number) =>
            (band.top.get(index) ?? 0) - (band.base.get(index) ?? 0);
        const runs = contiguousRuns(indices, (index) => thickness(index) !== 0);
        return runs.map((run) => {
            const d = stepAreaPath(
                run,
                (index) => yFor(band.top.get(index) ?? 0),
                (index) => yFor(band.base.get(index) ?? 0),
                xFor,
            );
            // Painted over the hit rects, so it must not take the pointer: the
            // bands cover most of a column, and without this a click or hover
            // aimed at the stack itself -- the obvious place to aim -- reaches
            // nothing. Every drawn element in the day chart does the same.
            return svg`
                <path
                    class="energy-band"
                    d=${d}
                    fill=${band.layer.color} fill-opacity=${BAND_FILL_OPACITY}
                    stroke=${band.layer.color} stroke-width="0.75" stroke-opacity="0.6"
                    pointer-events="none"
                ></path>
            `;
        });
    }

    /**
     * The hovered column, in the day chart's own hover treatment.
     *
     * Drawn under the bands and over the selection, so a hover reads on top of
     * whatever is already highlighted without hiding the data it is about.
     */
    private _renderHoverHighlight(
        xFor: (index: number) => number,
        columnWidth: number,
    ) {
        const index = this._hoveredIndex();
        if (index === null) return nothing;
        const height = CHART.height - CHART.marginTop - CHART.marginBottom;
        return svg`
            <rect
                class="bucket-hover"
                x=${xFor(index)} y=${CHART.marginTop}
                width=${columnWidth} height=${height}
                style=${HOVER_STYLE}
                pointer-events="none"
            ></rect>
        `;
    }

    private _renderAxis(
        yTicks: number[],
        yFor: (kwh: number) => number,
        plotWidth: number,
    ) {
        const right = CHART.marginLeft + plotWidth;
        return yTicks.map((tick) => {
            const y = yFor(tick);
            return svg`
                <line
                    x1=${CHART.marginLeft} y1=${y} x2=${right} y2=${y}
                    stroke="var(--divider-color)" stroke-width="1"
                    opacity=${tick === 0 ? 0.9 : 0.35}
                    pointer-events="none"
                ></line>
                <text
                    x=${CHART.marginLeft - 6} y=${y + 4} text-anchor="end"
                    fill="var(--secondary-text-color)" font-size="10"
                    pointer-events="none"
                >${tick}</text>
            `;
        });
    }

    /**
     * One full-height rect per bucket, behind the bars.
     *
     * It is both the hit target and the selection highlight, which is why it is
     * a real element per column rather than one click handler on the SVG that
     * works the index out from the pointer's x. A bucket with no data at all
     * still gets one: a column that measured nothing is still a column a reader
     * can point at and ask about, and inverting a scaled viewBox to find out
     * which one they meant is arithmetic with nothing to gain.
     */
    private _renderColumns(
        rows: readonly SpanAggregateRow[],
        xFor: (index: number) => number,
        columnWidth: number,
    ) {
        const height = CHART.height - CHART.marginTop - CHART.marginBottom;
        return rows.map((row, index) => {
            const selected = this._isSelected(row.date);
            return svg`
                <rect
                    class="bucket-column ${selected ? "selected" : ""}"
                    data-bucket=${row.date}
                    x=${xFor(index)} y=${CHART.marginTop}
                    width=${columnWidth} height=${height}
                    style=${selected ? SELECTED_STYLE : "fill: transparent;"}
                    @click=${(event: MouseEvent) => this._selectBucket(row.date, event)}
                    @mousemove=${(event: MouseEvent) => this._hoverBucket(index, event)}
                ></rect>
            `;
        });
    }

    /**
     * Where {@link hoveredKey} falls in {@link rows}, or null if nowhere.
     *
     * Only the full-height overlay needs this -- it is positioned by index --
     * and a key naming a bucket this span does not have is a miss, not a zero:
     * the card's key can outlive a span change by a frame.
     */
    private _hoveredIndex(): number | null {
        if (this.hoveredKey === null) return null;
        const index = this.rows.findIndex((row) => row.date === this.hoveredKey);
        return index === -1 ? null : index;
    }

    /**
     * Track the hovered column and tell the inspector where the pointer is.
     *
     * The popup itself is the inspector's, not this element's: the day view
     * already owns one, `position: fixed` over the whole card, and growing a
     * second here would be two popups to keep looking alike. So this reports
     * the bucket and the pointer, and the card draws the same popup it draws
     * for a slot.
     *
     * `mousemove` rather than `mouseenter`, because the popup follows the
     * cursor within a column as well as between columns.
     */
    private _hoverBucket(index: number, event: MouseEvent) {
        const row = this.rows[index];
        if (!row) return;
        this.dispatchEvent(new CustomEvent<AggregateBucketHoverDetail>("aggregate-bucket-hover", {
            detail: { key: row.date, x: event.clientX, y: event.clientY },
            bubbles: true,
            composed: true,
        }));
    }

    private _clearHover = () => {
        if (this.hoveredKey === null) return;
        this.dispatchEvent(new CustomEvent<AggregateBucketHoverDetail>("aggregate-bucket-hover", {
            detail: { key: null, x: 0, y: 0 },
            bubbles: true,
            composed: true,
        }));
    };

    /**
     * A column was pressed: report which one, and with which modifiers.
     *
     * The click is stopped here so it never reaches {@link _clickOutside} on the
     * SVG above -- that handler is the gutter, and a press that landed on a
     * column is by definition not one. The select event is a separate,
     * still-bubbling `CustomEvent`, so the card hears it either way.
     */
    private _selectBucket(key: string, event: MouseEvent) {
        event.stopPropagation();
        this._dispatchSelect(key, slotSelectionModeForEvent(event));
    }

    /**
     * A press in the axis gutter: left of the plot or right of it. It clears the
     * selection, exactly as a gutter click does in the day view -- and it is
     * bounded the same way, on x alone, so that the strip above the plot and the
     * label strip below it are dead space rather than a way to lose a selection
     * by aiming a few pixels under the column meant to join it.
     */
    private _clickOutside = (event: MouseEvent) => {
        if (this._insidePlot(event)) return;
        this._dispatchSelect(null, slotSelectionModeForEvent(event));
    };

    /**
     * Whether a press landed between the plot's left and right edges.
     *
     * Measured through the element's own box because the SVG is scaled to its
     * container while the geometry above is written in viewBox units; a click
     * synthesised without coordinates reads as x = 0, which is the gutter, and
     * that is the right answer for it.
     */
    private _insidePlot(event: MouseEvent): boolean {
        const svg = event.currentTarget as SVGSVGElement | null;
        const box = svg?.getBoundingClientRect();
        if (!box || box.width === 0) return false;
        const x = (event.clientX - box.left) * (this.width / box.width);
        return x >= CHART.marginLeft && x <= this.width - CHART.marginRight;
    }

    private _dispatchSelect(key: string | null, mode: SlotSelectionMode) {
        this.dispatchEvent(new CustomEvent<AggregateBucketSelectDetail>("aggregate-bucket-select", {
            detail: { key, mode },
            bubbles: true,
            composed: true,
        }));
    }

    /** Whether a bucket is in the card's selection. */
    private _isSelected(key: string): boolean {
        return this.selectedKeys.includes(key);
    }

    /**
     * One label per column where they fit, and every second or fifth where they
     * do not. A year's twelve months always fit; a month's thirty-one days on a
     * phone do not, and thinning is what keeps the axis readable rather than a
     * smear -- the same choice the day chart's hour labels make.
     */
    private _renderBucketLabels(
        rows: readonly SpanAggregateRow[],
        xFor: (index: number) => number,
        columnWidth: number,
    ) {
        const stride = columnWidth >= MIN_LABEL_PX
            ? 1
            : columnWidth * 2 >= MIN_LABEL_PX
                ? 2
                : 5;
        const y = CHART.height - CHART.marginBottom + 14;
        return rows.map((row, index) => {
            if (index % stride !== 0) return nothing;
            return svg`
                <text
                    class="bucket-label"
                    x=${xFor(index) + columnWidth / 2} y=${y} text-anchor="middle"
                    fill="var(--secondary-text-color)" font-size="10"
                    pointer-events="none"
                >${this._bucketLabel(row.date)}</text>
            `;
        });
    }

    /**
     * A bucket's short label: the day of the month, or the month's short name.
     *
     * Formatted from the key's own parts rather than by parsing it into a
     * `Date`: the key is already a *local* calendar date, and round-tripping it
     * through a UTC-parsed `Date` is how a day view ends up labelling its
     * columns one off.
     */
    private _bucketLabel(key: string): string {
        const [year, month, day] = key.split("-").map((part) => Number(part));
        if (this.bucket === "day") {
            return String(day);
        }
        const locale = this.hass?.locale?.language || this.hass?.language || "en";
        return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" })
            .format(new Date(Date.UTC(year, (month || 1) - 1, 1)));
    }

}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-aggregate-chart": HelmanSolarAggregateChart;
    }
}
