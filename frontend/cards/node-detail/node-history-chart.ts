import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { NodeHistoryDTO, NodeHistorySeriesPointDTO } from "../helman-api";
import type { LocalizeFunction } from "../localize/localize";
import { HoverTooltipController, hoverTooltipStyles, tooltipRow, type TooltipBody } from "../shared/hover-tooltip";
import type { BucketSourceMix } from "../shared/power-history-bars";
import { getCachedLocalDateTimeDescriptor } from "../shared/time/day-key";
import { formatClock } from "../shared/time/slot-time";
import { helmanColorVars } from "../color-vars";
import { SOURCE_NODES, gaugePillStyles } from "./flow-gauge";
import { EPSILON_KWH, kwhText } from "./node-detail-history";
import "../shared/power-history-bars";

/** The sources a bar stacks, bottom up: the gauges' three, then the unknown share. */
const SOURCES = [...SOURCE_NODES, "unknown"] as const;
const SOURCE_COLOR: Record<(typeof SOURCES)[number], string> = {
    solar: "var(--helman-solar)",
    battery: "var(--helman-battery)",
    grid: "var(--helman-grid)",
    unknown: "var(--helman-neutral)",
};
/** Over this many buckets (a custom period of months) a bar is a pixel or two wide: a gap would snap it away. */
const GAPLESS_BUCKETS = 62;

const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();
/** A day bucket's date, "10. 10.", or with its weekday; one formatter per locale. */
function dateFormat(locale: string, weekday: boolean): Intl.DateTimeFormat {
    const key = `${locale}|${weekday}`;
    let format = DATE_FORMATS.get(key);
    if (!format) {
        format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "numeric", ...(weekday ? { weekday: "short" } : {}) });
        DATE_FORMATS.set(key, format);
    }
    return format;
}

/**
 * The picked period's kWh as source-stacked bars, an hour or a local day
 * each, captioned with its bucket, with the first, middle and last bucket
 * on its axis; hovering or tapping a bar shows its bucket's kWh by source.
 */
@customElement("helman-node-history-chart")
export class HelmanNodeHistoryChart extends LitElement {
    @property({ attribute: false }) history!: NodeHistoryDTO;
    @property({ attribute: false }) localize!: LocalizeFunction;
    @property({ attribute: false }) locale!: string;
    /** HA's time zone, which an hour bucket's popup reads its clock in. */
    @property({ attribute: false }) timeZone!: string;

    private _tooltip = new HoverTooltipController(this);
    /** The `start` of the bucket the popup was last opened on. */
    private _shownStart: string | null = null;

    static styles = [helmanColorVars, gaugePillStyles, hoverTooltipStyles, css`
        :host { display: block; }
        .plot { position: relative; height: 96px; margin-top: 6px; border-bottom: 1px solid var(--divider-color); }
        .hits { position: absolute; inset: 0; display: flex; z-index: 2; }
        .hit { flex: 1; min-width: 0; margin: 0; padding: 0; border: 0; background: none; font: inherit; cursor: pointer; }
        .hit:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
        .axis { display: flex; justify-content: space-between; margin-top: 3px; font-size: 11px; color: var(--secondary-text-color); }
    `];

    protected updated(changed: PropertyValues<this>): void {
        // A re-read reuses the bars: an open popup takes its bucket's fresh figures, or closes once that bucket is gone.
        if (!changed.has("history") || this._tooltip.content === null) return;
        const index = this.history.series.findIndex((point) => point.start === this._shownStart);
        const hit = index < 0 ? null : this.renderRoot.querySelector(`[data-bar="${this._shownStart}"]`);
        if (hit === null) this._tooltip.hide();
        else this._tooltip.showAt(this._tooltip.point ?? this._tooltip.content, this._tooltipBody(index), hit);
    }

    private _t(key: string): string {
        return this.localize(`node_detail.shared.history.${key}`);
    }

    /** A bucket's axis label: its hour, "08:00", or its date, "10. 10.". */
    private _label(point: NodeHistorySeriesPointDTO): string {
        return this.history.bucket === "hour"
            ? point.start.slice(11, 16)
            : dateFormat(this.locale, false).format(new Date(`${point.start}T00:00:00Z`));
    }

    /**
     * The popup title of the bucket at `index`: its weekday and date, or the
     * clock from its start to the next bucket's, "08:00 – 09:00", the last
     * ending at "24:00" (on a DST day an hour bucket's clock is not its index).
     */
    private _title(index: number): string {
        const series = this.history.series;
        const point = series[index];
        if (this.history.bucket !== "hour") return dateFormat(this.locale, true).format(new Date(`${point.start}T00:00:00Z`));
        const start = getCachedLocalDateTimeDescriptor(point.start, this.timeZone);
        const next = series[index + 1];
        const end = next ? getCachedLocalDateTimeDescriptor(next.start, this.timeZone) : null;
        const minutes = (at: { hour: number; minute: number } | null) => at ? at.hour * 60 + at.minute : 1440;
        return `${formatClock(minutes(start))} – ${formatClock(minutes(end))}`;
    }

    private _tooltipBody(index: number): TooltipBody {
        const point = this.history.series[index];
        const label = (source: (typeof SOURCES)[number]) =>
            source === "unknown" ? this._t("source_unknown_cap") : this.localize(`node_detail.title.${source}`);
        return {
            title: this._title(index),
            hasActual: false,
            rows: [
                ...SOURCES.filter((source) => point[source] > EPSILON_KWH)
                    .map((source) => tooltipRow(label(source), kwhText(point[source]), SOURCE_COLOR[source])),
                tooltipRow(this._t("total"), kwhText(point.kwh)),
            ],
        };
    }

    private _show(event: MouseEvent, index: number, toggle: boolean): void {
        this._shownStart = this.history.series[index].start;
        const body = this._tooltipBody(index);
        if (toggle) this._tooltip.toggle(event, body);
        else this._tooltip.show(event, body);
    }

    render() {
        const series = this.history.series;
        const mixes: BucketSourceMix[] = series.map((point) =>
            Object.fromEntries(SOURCES.map((source) => [source, { power: point[source], color: SOURCE_COLOR[source] }])));
        // Under three buckets the middle one is the first or the last.
        const middle = series.length < 3 ? null : series[Math.floor((series.length - 1) / 2)];
        return html`
            <div class="gauge-title" data-period-chart-caption>${this._t(this.history.bucket === "hour" ? "period_chart_hour" : "period_chart_day")}</div>
            <div class="plot">
                <helman-power-history-bars .historyToRender=${series.map((point) => point.kwh)}
                    .maxHistoryPower=${Math.max(...series.map((point) => point.kwh))}
                    .historyBarColor=${SOURCE_COLOR.unknown} .sourceHistory=${mixes} .barGap=${series.length > GAPLESS_BUCKETS ? 0 : 0.25}></helman-power-history-bars>
                <div class="hits">${series.map((point, index) => html`<button class="hit" type="button" data-bar=${point.start}
                    aria-label=${`${this._title(index)}: ${kwhText(point.kwh)}`}
                    @mousemove=${(event: MouseEvent) => this._show(event, index, false)}
                    @mouseleave=${() => this._tooltip.hide()}
                    @click=${(event: MouseEvent) => this._show(event, index, true)}></button>`)}</div>
            </div>
            <div class="axis" data-period-chart-axis>
                <span>${this._label(series[0])}</span>${middle ? html`<span>${this._label(middle)}</span>` : nothing}<span>${this._label(series[series.length - 1])}</span>
            </div>
            ${this._tooltip.render()}
        `;
    }
}
