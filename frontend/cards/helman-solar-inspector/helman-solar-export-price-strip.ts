import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { ForecastPayload } from "../helman-api";
import { ForecastLoader } from "../helman/forecast-loader";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { getScheduleLocalTimeParts } from "../helman-scheduling/model/schedule-time";
import type { ScheduleStripGeometry, ScheduleStripHoverDetail } from "./helman-solar-schedule-actions-strip";

const MINUTES_PER_DAY = 1440;

/** The strip's own geometry; it borrows only the x scale from the chart. */
const PRICE_STRIP = { height: 65, padTop: 8, padBottom: 8 } as const;

/** A single export-price sample placed on the selected day's timeline. */
interface PriceColumn {
    startMinutes: number;
    endMinutes: number;
    value: number;
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
    static styles = css`
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
    `;

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** Selected inspector day, `YYYY-MM-DD`. */
    @property({ type: String }) public date = "";
    @property({ type: String }) public timeZone = "UTC";
    @property({ attribute: false }) public geometry: ScheduleStripGeometry | null = null;
    /** Currently selected impact slot (`HH:MM`), highlighted across the strip. */
    @property({ type: String }) public selectedSlot: string | null = null;
    /** Time band of a hovered schedule action, echoed as an amber "linked" band. */
    @property({ attribute: false }) public hoverRange: ScheduleStripHoverDetail = null;

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
     * Minute-of-day the day turns from measured into upcoming: the current wall
     * clock when the selected day is today, otherwise the whole day is past
     * (an earlier day) or entirely upcoming (a later day).
     */
    private _seamMinutes(): number {
        const now = getScheduleLocalTimeParts(Date.now(), this.timeZone);
        if (now === null) {
            return MINUTES_PER_DAY;
        }
        if (now.dayKey === this.date) {
            return now.hour * 60 + now.minute;
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
        const xForMinutes = (minutes: number) =>
            geometry.marginLeft + (Math.max(0, Math.min(MINUTES_PER_DAY, minutes)) / MINUTES_PER_DAY) * geometry.plotWidth;

        return html`
            <div class="strip-wrap">
                ${svg`
                <svg
                    viewBox="0 0 ${geometry.width} ${height}"
                    role="img"
                    aria-label=${this._t("bias_correction.inspector.export_price_strip")}
                    style="cursor: pointer;"
                    @click=${(event: MouseEvent) => this._handleClick(event, geometry)}
                >
                    ${this._renderGuides(geometry, zeroY, yForValue, maxAbs, hasNegative)}
                    ${this._renderHoverHighlight(height, xForMinutes)}
                    ${this._renderHighlight(geometry, height, xForMinutes)}
                    ${columns.map((column) => {
                        const positive = column.value >= 0;
                        const color = positive
                            ? "var(--forecast-price-positive, #8d6e63)"
                            : "var(--forecast-price-negative, #6d4c41)";
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
                                fill=${color} fill-opacity=${future ? 0.4 : 0.85}
                                stroke=${color} stroke-width=${future ? 0.9 : 0}
                                stroke-dasharray=${future ? "2 2" : ""}
                            >
                                <title>${this._formatMinutes(column.startMinutes)} ${column.value.toFixed(1)} ${unit}</title>
                            </rect>
                        `;
                    })}
                </svg>
            `}
            </div>
        `;
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

    /** The time band of a hovered schedule action, mirroring the chart's amber band. */
    private _renderHoverHighlight(
        height: number,
        xForMinutes: (minutes: number) => number,
    ) {
        const range = this.hoverRange;
        if (!range) {
            return nothing;
        }
        const x = xForMinutes(range.startMinutes);
        const width = Math.max(2, xForMinutes(range.endMinutes) - x);
        return svg`
            <rect
                x=${x} y="0" width=${width} height=${height}
                fill="rgba(245,158,11,0.14)"
                stroke="#f59e0b" stroke-width="1" stroke-opacity="0.55"
                rx="1"
                pointer-events="none"
            ></rect>
        `;
    }

    /** The column of the selected slot, mirroring the chart's selection band. */
    private _renderHighlight(
        geometry: ScheduleStripGeometry,
        height: number,
        xForMinutes: (minutes: number) => number,
    ) {
        if (!this.selectedSlot) {
            return nothing;
        }
        const match = /^(\d{2}):(\d{2})$/.exec(this.selectedSlot);
        if (!match) {
            return nothing;
        }
        const minutes = Number(match[1]) * 60 + Number(match[2]);
        const x = xForMinutes(minutes);
        const width = Math.max(3, geometry.plotWidth / 96);
        return svg`
            <rect
                x=${x} y="0" width=${width} height=${height}
                fill="rgba(37,99,235,0.13)"
                stroke="#2563eb" stroke-width="1" stroke-opacity="0.5"
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
        const plotRight = geometry.marginLeft + geometry.plotWidth;
        const minutes = svgX < geometry.marginLeft || svgX > plotRight
            ? null
            : ((svgX - geometry.marginLeft) / geometry.plotWidth) * MINUTES_PER_DAY;
        this.dispatchEvent(
            new CustomEvent<{ minutes: number | null }>("slot-pick", {
                detail: { minutes },
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
