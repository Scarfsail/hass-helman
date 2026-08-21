import { LitElement, css, html, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { helmanColorVars } from "../color-vars";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { BATT_COLOR, GRID_COLOR, HOUSE_COLOR, SOLAR_COLOR } from "../color-utils";
import { symmetricEnergyAxis } from "./chart-axis";
import { accumulateBands, clampToSign, stackSlots, type StackLayer, type StackSet } from "./chart-stack";

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

/** What `helman/solar_bias/day_aggregates` answers with. */
export interface SpanAggregatePayload {
    bucket: "day" | "month";
    currency: string | null;
    days: SpanAggregateRow[];
}

/** A column was clicked; the inspector holds the selection. */
export interface AggregateBucketSelectDetail {
    key: string;
}

/**
 * The chart's own geometry. It is not the inspector's: nothing else is drawn
 * against this axis, so there is no strip below to stay aligned with and no
 * reason to inherit the day chart's margins. The left gutter is a little
 * narrower than the day chart's because a kWh axis reaches two digits where a
 * kW one reaches one plus a decimal.
 */
const CHART = { height: 240, marginTop: 16, marginRight: 16, marginBottom: 24, marginLeft: 44 } as const;

/** Below this column width a label cannot be written without colliding. */
const MIN_LABEL_PX = 13;

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
    /** The bucket key currently selected, or null for none. */
    @property({ type: String }) public selectedKey: string | null = null;
    /** viewBox width; the SVG scales to its container, so this is only a ratio. */
    @property({ type: Number }) public width = 900;

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
        const set = this._buildStack(rows);
        const indices = stackSlots(set, 1);
        if (indices.length === 0) {
            return nothing;
        }
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
                layer(SOLAR_COLOR, 1, (row) => kwh(row.solarWh)),
                layer(BATT_COLOR, 1, (row) => kwh(row.batteryDischargeWh)),
                layer(GRID_COLOR, 1, (row) => row.gridImportKwh),
            ],
            negative: [
                layer(HOUSE_COLOR, -1, (row) => kwh(row.houseWh)),
                layer(BATT_COLOR, -1, (row) => kwh(row.batteryChargeWh)),
                layer(GRID_COLOR, -1, (row) => row.gridExportKwh),
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
                >
                    ${this._renderAxis(yTicks, yFor, plotWidth)}
                    ${this._renderColumns(rows, xFor, columnWidth)}
                    ${[...positive, ...negative].map((band) => indices.map((index) => {
                        const top = band.top.get(index) ?? 0;
                        const base = band.base.get(index) ?? 0;
                        if (top === base) return nothing;
                        // Half a unit of gap on each side, so neighbouring
                        // columns stay countable at a month's width and still
                        // touch nothing at a year's.
                        const left = xFor(index) + columnWidth * 0.1;
                        const barWidth = Math.max(1, columnWidth * 0.8);
                        const yTop = Math.min(yFor(top), yFor(base));
                        const barHeight = Math.max(1, Math.abs(yFor(top) - yFor(base)));
                        return svg`
                            <rect
                                x=${left} y=${yTop}
                                width=${barWidth} height=${barHeight}
                                fill=${band.layer.color} fill-opacity="0.85"
                            ></rect>
                        `;
                    }))}
                    ${this._renderBucketLabels(rows, xFor, columnWidth)}
                </svg>
            `}
            </div>
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
                ></line>
                <text
                    x=${CHART.marginLeft - 6} y=${y + 4} text-anchor="end"
                    fill="var(--secondary-text-color)" font-size="10"
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
            const selected = row.date === this.selectedKey;
            return svg`
                <rect
                    class="bucket-column ${selected ? "selected" : ""}"
                    data-bucket=${row.date}
                    x=${xFor(index)} y=${CHART.marginTop}
                    width=${columnWidth} height=${height}
                    fill=${selected ? "var(--helman-selection)" : "transparent"}
                    fill-opacity=${selected ? 0.18 : 1}
                    @click=${() => this._selectBucket(row.date)}
                ></rect>
            `;
        });
    }

    private _selectBucket(key: string) {
        this.dispatchEvent(new CustomEvent<AggregateBucketSelectDetail>("aggregate-bucket-select", {
            detail: { key },
            bubbles: true,
            composed: true,
        }));
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
