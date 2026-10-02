import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
    DeviceReportGranularity,
    DeviceReportQuery,
    OverTimeBucket,
    OverTimeReportPayload,
    OverTimeSeries,
} from "../helman-api";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { formatKwhValue } from "../shared/forecast-value-format";
import {
    HoverTooltipController,
    hoverTooltipStyles,
    tooltipRow,
    type TooltipBody,
} from "../shared/hover-tooltip";
import { OTHER_DEVICES_COLOR, UNMEASURED_COLOR, deviceColor } from "./device-palette";

const TOP_OPTIONS = [3, 5, 10] as const;
type TopX = (typeof TOP_OPTIONS)[number];
const DEFAULT_TOP: TopX = 5;
/** Above this many columns they are drawn without gaps. */
const DENSE_COLUMNS = 60;
/** About this many axis labels, however many columns. */
const AXIS_LABELS = 8;

/** The fold keys: what is not one of the top devices. */
const OTHER = "other";
const UNMEASURED = "unmeasured";

interface Segment {
    /** A series id, or one of the fold keys. */
    id: string;
    kwh: number;
    style: string;
}

interface Column {
    bucket: OverTimeBucket;
    segments: Segment[];
    stackStyle: string;
    tickStyle: string;
    /** The stack above the house tick, when the devices measure more than it. */
    excessStyle: string | null;
    axisLabel: string;
    tooltip: TooltipBody;
}

interface LegendItem {
    id: string;
    label: string;
    color: string;
}

interface OverTimeModel {
    columns: Column[];
    legend: LegendItem[];
    /** Too many columns for gaps between them. */
    dense: boolean;
}

function heightStyle(part: number, whole: number): string {
    return whole > 0 ? Math.max(0, Math.min(1, part / whole)) * 100 + "%" : "0%";
}

/** A bucket's span, as short ISO dates: the axis has no room for more. */
function bucketLabel(bucket: OverTimeBucket, granularity: DeviceReportGranularity): string {
    if (granularity === "month") return bucket.start.slice(0, 7);
    return bucket.start.slice(5);
}

function bucketTitle(bucket: OverTimeBucket): string {
    return bucket.start === bucket.end ? bucket.start : bucket.start + " – " + bucket.end;
}

/**
 * Every top-level device's kWh per bucket, stacked: the period's top X in rank
 * order, then the rest folded into "other", then the house's remainder. Each
 * column carries a tick at the house meter.
 *
 * The ranking is the backend's, once over the period, so a device keeps its
 * colour -- its rank's, from the shared device palette -- in every column.
 * Top X is local: it refolds the payload already here and changes no fetch.
 * The model is built in `willUpdate` behind the inputs it reads.
 */
@customElement("helman-device-report-over-time")
export class HelmanDeviceReportOverTime extends LitElement {
    @property({ attribute: false }) public payload?: OverTimeReportPayload;
    @property({ attribute: false }) public query?: DeviceReportQuery;
    @property({ attribute: false }) public localize?: LocalizeFunction;

    /**
     * The last Top X picked on this page. The element is recreated whenever the
     * shell fetches a new period or granularity, and a fetch must not undo it.
     */
    private static _lastTop: TopX = DEFAULT_TOP;

    @state() private _top: TopX = HelmanDeviceReportOverTime._lastTop;

    private _tooltip = new HoverTooltipController(this);

    private _model: OverTimeModel | null = null;
    private _modelKey: {
        payload: OverTimeReportPayload | undefined;
        top: TopX;
        localize: LocalizeFunction | undefined;
    } | null = null;

    static styles = [hoverTooltipStyles, css`
        :host { display: block; }
        .controls {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            align-items: center;
            font-size: 0.8rem;
            margin-bottom: 8px;
        }
        .controls button {
            font: inherit;
            padding: 3px 8px;
            border-radius: 12px;
            border: 1px solid var(--divider-color, #ccc);
            background: transparent;
            color: var(--primary-text-color);
            cursor: pointer;
        }
        .controls button.selected {
            background: var(--primary-color);
            border-color: var(--primary-color);
            color: var(--text-primary-color, #fff);
        }
        .chart { overflow-x: auto; }
        .plot, .axis {
            display: flex;
            gap: 1px;
        }
        .chart.dense .plot, .chart.dense .axis { gap: 0; }
        .plot {
            height: 180px;
            align-items: stretch;
            border-bottom: 1px solid var(--divider-color, #ccc);
        }
        .column {
            position: relative;
            flex: 1;
            min-width: 2px;
        }
        .stack {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            flex-direction: column-reverse;
        }
        .column.partial { opacity: 0.45; }
        .seg { flex: none; }
        .tick {
            position: absolute;
            left: -1px;
            right: -1px;
            height: 2px;
            margin-bottom: -1px;
            background: var(--primary-text-color);
            z-index: 1;
        }
        .excess {
            position: absolute;
            left: 0;
            right: 0;
            background-image: repeating-linear-gradient(
                135deg,
                transparent 0 2px,
                color-mix(in srgb, var(--card-background-color, #fff) 70%, transparent) 2px 4px
            );
        }
        .axis span {
            flex: 1;
            min-width: 2px;
            overflow: visible;
            white-space: nowrap;
            font-size: 0.65rem;
            color: var(--secondary-text-color);
        }
        .legend {
            display: flex;
            flex-wrap: wrap;
            gap: 4px 12px;
            margin-top: 8px;
            font-size: 0.75rem;
        }
        .legend-item {
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .swatch {
            width: 10px;
            height: 10px;
            border-radius: 2px;
            flex: none;
        }
        .empty {
            font-size: 0.75rem;
            color: var(--secondary-text-color);
            margin-top: 6px;
        }
    `];

    protected willUpdate(_changed: PropertyValues<this>): void {
        const key = this._modelKey;
        if (
            key === null
            || key.payload !== this.payload
            || key.top !== this._top
            || key.localize !== this.localize
        ) {
            this._modelKey = { payload: this.payload, top: this._top, localize: this.localize };
            this._model = this.payload ? this._buildModel(this.payload, this._top) : null;
        }
    }

    private _t(key: string): string {
        return this.localize ? this.localize(key) : key;
    }

    private _seriesLabel(series: OverTimeSeries): string {
        return (series.estimated ? "≈ " : "") + (series.label || series.id);
    }

    private _buildModel(payload: OverTimeReportPayload, top: TopX): OverTimeModel | null {
        if (payload.buckets.length === 0 || payload.series.length === 0) return null;
        const shown = payload.series.slice(0, top);
        const folded = payload.series.slice(top);
        const legend: LegendItem[] = shown.map((series, rank) => ({
            id: series.id,
            label: this._seriesLabel(series),
            color: deviceColor(rank),
        }));
        if (folded.length > 0) {
            legend.push({
                id: OTHER,
                label: this._t("device_reports.over_time.other"),
                color: OTHER_DEVICES_COLOR,
            });
        }
        legend.push({
            id: UNMEASURED,
            label: this._t("house_section.unmeasured"),
            color: UNMEASURED_COLOR,
        });

        const stacks = payload.buckets.map((bucket) => {
            const kwh = new Map<string, number>(
                shown.map((series) => [series.id, bucket.values[series.id] ?? 0]),
            );
            if (folded.length > 0) {
                kwh.set(OTHER, folded.reduce((sum, series) => sum + (bucket.values[series.id] ?? 0), 0));
            }
            kwh.set(UNMEASURED, bucket.unmeasured);
            let total = 0;
            for (const value of kwh.values()) total += value;
            return { bucket, kwh, total };
        });
        const scale = Math.max(0, ...stacks.map(({ bucket, total }) => Math.max(total, bucket.house)));
        const every = Math.max(1, Math.ceil(stacks.length / AXIS_LABELS));

        const columns = stacks.map(({ bucket, kwh, total }, index): Column => {
            const segments = legend.map((item) => ({
                id: item.id,
                kwh: kwh.get(item.id) ?? 0,
                style: "background:" + item.color + ";height:" + heightStyle(kwh.get(item.id) ?? 0, total),
            }));
            // Exactly the over-allocation, at the top of the stack: the stack can
            // also rise above the tick in hours the house meter did not measure,
            // which is not the devices measuring more than it.
            const over = bucket.overallocated > 0;
            return {
                bucket,
                segments,
                stackStyle: "height:" + heightStyle(total, scale),
                tickStyle: "bottom:" + heightStyle(bucket.house, scale),
                excessStyle: over
                    ? "bottom:" + heightStyle(Math.max(0, total - bucket.overallocated), scale)
                        + ";height:" + heightStyle(Math.min(total, bucket.overallocated), scale)
                    : null,
                axisLabel: index % every === 0 ? bucketLabel(bucket, payload.granularity) : "",
                tooltip: this._columnTooltip(bucket, legend, segments, total),
            };
        });
        return { columns, legend, dense: columns.length > DENSE_COLUMNS };
    }

    private _columnTooltip(
        bucket: OverTimeBucket,
        legend: LegendItem[],
        segments: Segment[],
        total: number,
    ): TooltipBody {
        const rows = segments.map((segment, index) =>
            tooltipRow(legend[index].label, formatKwhValue(segment.kwh) + " kWh", legend[index].color));
        rows.push(tooltipRow(this._t("device_reports.over_time.total"), formatKwhValue(total) + " kWh"));
        rows.push(tooltipRow(this._t("device_reports.over_time.house"), formatKwhValue(bucket.house) + " kWh"));
        if (bucket.overallocated > 0) {
            rows.push(tooltipRow("", fillTemplate(this._t("device_reports.over_time.overallocated"), {
                kwh: formatKwhValue(bucket.overallocated),
            })));
        }
        return {
            title: bucketTitle(bucket)
                + (bucket.partial ? " (" + this._t("device_reports.over_time.partial") + ")" : ""),
            hasActual: false,
            rows,
            note: bucket.partial ? this._t("device_reports.over_time.partial_note") : undefined,
        };
    }

    render() {
        const model = this._model;
        if (!model) {
            return html`<div class="empty">${this._t("device_reports.over_time.empty")}</div>`;
        }
        return html`
            <div class="controls">
                ${this._t("device_reports.over_time.top")}
                ${TOP_OPTIONS.map((top) => html`
                    <button
                        type="button"
                        data-top=${top}
                        class=${top === this._top ? "selected" : ""}
                        @click=${() => { this._top = HelmanDeviceReportOverTime._lastTop = top; }}
                    >${top}</button>
                `)}
            </div>
            <div class=${"chart" + (model.dense ? " dense" : "")}>
            <div class="plot">
                ${model.columns.map((column) => html`
                    <div
                        class=${"column" + (column.bucket.partial ? " partial" : "")
                            + (column.excessStyle !== null ? " overallocated" : "")}
                        data-start=${column.bucket.start}
                        @mousemove=${(event: MouseEvent) => this._tooltip.show(event, column.tooltip)}
                        @mouseleave=${() => this._tooltip.hide()}
                        @click=${(event: MouseEvent) => this._tooltip.toggle(event, column.tooltip)}
                    >
                        <div class="stack" style=${column.stackStyle}>
                            ${column.segments.map((segment) => html`
                                <div class="seg" data-series=${segment.id} style=${segment.style}></div>
                            `)}
                        </div>
                        ${column.excessStyle !== null
                            ? html`<div class="excess" style=${column.excessStyle}></div>`
                            : nothing}
                        <div class="tick" style=${column.tickStyle}></div>
                    </div>
                `)}
            </div>
            <div class="axis">
                ${model.columns.map((column) => html`<span>${column.axisLabel}</span>`)}
            </div>
            </div>
            <div class="legend">
                ${model.legend.map((item) => html`
                    <span class="legend-item" data-series=${item.id}>
                        <span class="swatch" style=${"background:" + item.color}></span>${item.label}
                    </span>
                `)}
            </div>
            ${this._tooltip.render()}
        `;
    }
}
