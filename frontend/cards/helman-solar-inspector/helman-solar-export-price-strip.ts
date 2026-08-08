import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { ForecastPayload } from "../helman-api";
import { ForecastLoader } from "../helman/forecast-loader";
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

/** A single export-price sample placed on the selected day's timeline. */
export interface PriceColumn {
    startMinutes: number;
    endMinutes: number;
    value: number;
}

/** The day's price columns, published so the inspector can look one up by slot. */
export interface PriceColumnsDetail {
    columns: PriceColumn[];
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
 * A horizontal strip of the grid export price across the selected inspector day,
 * aligned to the solar inspector chart's time axis and coloured to match the
 * price column on the scheduling card. Past and future samples are both shown;
 * samples past the current moment are drawn muted, echoing how the chart above
 * mutes the part of the day the actuals have not yet reached.
 *
 * The export price comes straight from the live forecast payload, whose sell-price
 * entity exposes the whole day (already-elapsed hours included), so navigating to
 * today shows the day in full. Other days carry no live price data and render empty.
 */
@customElement("helman-solar-export-price-strip")
export class HelmanSolarExportPriceStrip extends LitElement {
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

    @state() private _forecast: ForecastPayload | null = null;

    private _loader: ForecastLoader | null = null;
    private _loadedConnection: unknown = null;

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("hass") && this.hass) {
            if (this._loadedConnection !== this.hass.connection) {
                this._loadedConnection = this.hass.connection;
                this._loader = new ForecastLoader(60);
                this._forecast = null;
            }
            void this._load();
        }
    }

    protected updated(changed: PropertyValues<this>): void {
        // The inspector's own selected-slot panel has no other way to reach this
        // component's day of prices -- it lives only here, behind the loader --
        // so every change that could move a value at a given minute is echoed up.
        if (changed.has("_forecast") || changed.has("date")) {
            this._emitColumns();
        }
    }

    /** Publish this day's price columns, so the inspector can look one up by slot. */
    private _emitColumns(): void {
        this.dispatchEvent(
            new CustomEvent<PriceColumnsDetail>("price-columns", {
                detail: { columns: this._buildColumns(), unit: this._forecast?.grid.exportPriceUnit ?? "" },
                bubbles: true,
                composed: true,
            }),
        );
    }

    render() {
        if (!this.hass || this.geometry === null) {
            return nothing;
        }
        const columns = this._buildColumns();
        if (columns.length === 0) {
            return nothing;
        }
        return this._renderStrip(columns, this.geometry);
    }

    private async _load(): Promise<void> {
        const hass = this.hass;
        const loader = this._loader;
        if (!hass || !loader) {
            return;
        }
        try {
            const payload = await loader.load(hass);
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            this._forecast = payload;
        } catch (error) {
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            console.error("helman-solar-inspector: failed to load export price forecast", error);
        }
    }

    /** Export-price samples that fall on the selected day, on its 0..1440 timeline. */
    private _buildColumns(): PriceColumn[] {
        const points = this._forecast?.grid.exportPricePoints ?? [];
        const raw: { minutes: number; value: number }[] = [];
        for (const point of points) {
            const value = Number(point.value);
            if (!Number.isFinite(value)) {
                continue;
            }
            const parts = getScheduleLocalTimeParts(point.timestamp, this.timeZone);
            if (parts === null || parts.dayKey !== this.date) {
                continue;
            }
            raw.push({ minutes: parts.hour * 60 + parts.minute, value });
        }
        raw.sort((a, b) => a.minutes - b.minutes);
        return raw.map((entry, index) => {
            const next = raw[index + 1];
            const endMinutes = next ? next.minutes : MINUTES_PER_DAY;
            return {
                startMinutes: entry.minutes,
                endMinutes: endMinutes > entry.minutes ? endMinutes : MINUTES_PER_DAY,
                value: entry.value,
            };
        });
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

    private _renderStrip(columns: PriceColumn[], geometry: ScheduleStripGeometry): TemplateResult {
        const { height, padTop, padBottom } = PRICE_STRIP;
        const innerHeight = height - padTop - padBottom;
        const maxAbs = Math.max(0.0001, ...columns.map((column) => Math.abs(column.value)));
        const hasNegative = columns.some((column) => column.value < 0);
        const zeroY = hasNegative ? padTop + innerHeight / 2 : padTop + innerHeight;
        const scale = hasNegative ? innerHeight / 2 / maxAbs : innerHeight / maxAbs;
        const yForValue = (value: number) => zeroY - value * scale;
        const seam = this._seamMinutes();
        const unit = this._forecast?.grid.exportPriceUnit ?? "";
        const { start: windowStart, end: windowEnd } = stripWindow(geometry);
        const windowSpan = windowEnd - windowStart;
        const xForMinutes = (minutes: number) =>
            geometry.marginLeft + ((minutes - windowStart) / windowSpan) * geometry.plotWidth;

        return html`
            <div class="strip-wrap">
                ${svg`
                <svg
                    viewBox="0 0 ${geometry.width} ${height}"
                    role="img"
                    aria-label=${this._t("bias_correction.inspector.export_price_strip")}
                    style="cursor: pointer;"
                    @click=${(event: MouseEvent) => this._handleClick(event, geometry)}
                    @mousemove=${(event: MouseEvent) =>
                        this._handleHover(event, geometry, columns, unit)}
                    @mouseleave=${() => { this._emitHover(null); this._emitTooltip(null); }}
                >
                    <defs>
                        <clipPath id="export-price-plot-clip">
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
                    ${this._renderBand(columns, this.hoverMinutes, "hover", height, xForMinutes)}
                    ${this.selectedMinutes.map((minutes) =>
                        this._renderBand(columns, minutes, "selected", height, xForMinutes))}
                    <g clip-path="url(#export-price-plot-clip)">
                    ${columns.map((column) => {
                        const positive = column.value >= 0;
                        const color = positive
                            ? "var(--helman-price-positive)"
                            : "var(--helman-price-negative)";
                        const valueY = yForValue(column.value);
                        const top = Math.min(zeroY, valueY);
                        const barHeight = Math.max(1, Math.abs(valueY - zeroY));
                        const left = xForMinutes(column.startMinutes);
                        const right = xForMinutes(column.endMinutes);
                        const width = Math.max(1, right - left - 0.5);
                        const future = column.startMinutes >= seam;
                        return svg`
                            <rect
                                x=${left + 0.25} y=${top}
                                width=${width} height=${barHeight}
                                style="fill: ${color}; stroke: ${color};"
                                fill-opacity=${future ? 0.4 : 0.85}
                                stroke-width=${future ? 0.9 : 0}
                                stroke-dasharray=${future ? "2 2" : ""}
                            ></rect>
                        `;
                    })}
                    </g>
                    ${this._renderNowMarker(xForMinutes, windowStart, windowEnd, height)}
                    <!-- The prices come after the marker so the line passes
                         behind the figure it crosses instead of through it. -->
                    <g clip-path="url(#export-price-plot-clip)">
                    ${columns.map((column) => {
                        const left = xForMinutes(column.startMinutes);
                        const width = Math.max(1, xForMinutes(column.endMinutes) - left - 0.5);
                        if (width < 18) {
                            return "";
                        }
                        const valueY = yForValue(column.value);
                        const top = Math.min(zeroY, valueY);
                        // The label sits outside the bar, on the far side from zero,
                        // so it never has to fight the bar's own fill for contrast.
                        const labelY = column.value >= 0
                            ? Math.max(top - 3, 9)
                            : Math.min(top + Math.max(1, Math.abs(valueY - zeroY)) + 9, height - 2);
                        return svg`
                            <text x=${left + width / 2} y=${labelY} text-anchor="middle" font-size="9"
                                  fill="var(--secondary-text-color)">${column.value.toFixed(1)}</text>
                        `;
                    })}
                    </g>
                </svg>
            `}
            </div>
        `;
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
     * The blue selection or orange hover band. A minute falls inside one price
     * sample, and the band covers that whole sample — so an hour-long price cell
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
     * and the popup content. The whole column's slot counts as "on" it, not just
     * its own bar height -- a single-series bar has nothing else there to
     * disambiguate, so a value near zero would otherwise leave almost no
     * pointable area.
     */
    private _handleHover(
        event: MouseEvent,
        geometry: ScheduleStripGeometry,
        columns: PriceColumn[],
        unit: string,
    ): void {
        const svgEl = event.currentTarget as SVGSVGElement;
        const rect = svgEl.getBoundingClientRect();
        const svgX = ((event.clientX - rect.left) / rect.width) * geometry.width;
        const minutes = stripMinutesForSvgX(geometry, svgX);
        const column = minutes === null
            ? undefined
            : columns.find((c) => minutes >= c.startMinutes && minutes < c.endMinutes);
        if (minutes === null || !column) {
            this._emitHover(null);
            this._emitTooltip(null);
            return;
        }
        this._emitHover(minutes);
        this._emitTooltip({
            x: event.clientX,
            y: event.clientY,
            title: `${this._formatMinutes(column.startMinutes)} – ${this._formatMinutes(column.endMinutes)}`,
            hasActual: false,
            rows: [
                {
                    label: this._t("bias_correction.inspector.export_price"),
                    actual: null,
                    forecast: { value: `${column.value.toFixed(1)} ${unit}`.trim() },
                },
            ],
        });
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
        "helman-solar-export-price-strip": HelmanSolarExportPriceStrip;
    }
}
