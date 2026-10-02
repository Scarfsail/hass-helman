import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type {
    DailyProfileReportPayload,
    DailyProfileRow,
    DeviceReportQuery,
} from "../helman-api";
import { GRID_EXPORT_COLOR, GRID_IMPORT_COLOR, PRICE_NEGATIVE_COLOR } from "../color-utils";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { formatPower } from "../power-format";
import { formatKwhValue } from "../shared/forecast-value-format";
import {
    HoverTooltipController,
    hoverTooltipStyles,
    tooltipRow,
    type TooltipBody,
    type TooltipRow,
} from "../shared/hover-tooltip";
import { coverageRow, partlyCovered } from "./device-report-ranking";
import { DEVICE_PALETTE, OTHER_DEVICES_COLOR, UNMEASURED_COLOR, deviceColor } from "./device-palette";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Every this many hours the axis is labelled. */
const AXIS_EVERY = 3;
/** The faintest shade a priced hour gets, so the cheapest hour still reads as priced. */
const PRICE_FLOOR_LEVEL = 0.15;

interface Cell {
    /** The cell's value over its row's peak, 0..1; null for a missing cell. */
    level: number | null;
    style: string;
    tooltip: TooltipBody;
}

interface HeatRow {
    id: string;
    label: string;
    swatchStyle: string;
    tooltip: TooltipBody;
    cells: Cell[];
}

interface DailyProfileModel {
    rows: HeatRow[];
    prices: HeatRow[];
}

function pad(hour: number): string {
    return String(hour).padStart(2, "0");
}

function hourSpan(hour: number): string {
    return pad(hour) + ":00–" + pad((hour + 1) % 24) + ":00";
}

/** A cell shaded `level` of the way from the card's background to `color`. */
function shade(color: string, level: number): string {
    const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
    return "background:color-mix(in srgb, " + color + " " + pct
        + "%, var(--secondary-background-color, #f2f2f2))";
}

/**
 * Each top-level device's, and the house remainder's, mean power per local hour
 * of day, as a heatmap, with the mean import and export price per hour below.
 *
 * A row is shaded relative to its own peak, so a small device is as readable as
 * a large one; an hour the row was never observed in is hatched, not drawn as 0.
 * A device's colour is its rank among the devices, from the shared device
 * palette, as in Over time. Every label and cell carries its hover tooltip,
 * built with the model in `willUpdate` behind the inputs it reads.
 */
@customElement("helman-device-report-daily-profile")
export class HelmanDeviceReportDailyProfile extends LitElement {
    @property({ attribute: false }) public payload?: DailyProfileReportPayload;
    @property({ attribute: false }) public query?: DeviceReportQuery;
    @property({ attribute: false }) public localize?: LocalizeFunction;

    private _tooltip = new HoverTooltipController(this);
    private _model: DailyProfileModel | null = null;
    private _modelKey: {
        payload: DailyProfileReportPayload | undefined;
        localize: LocalizeFunction | undefined;
    } | null = null;

    static styles = [hoverTooltipStyles, css`
        :host { display: block; }
        .grid {
            display: grid;
            grid-template-columns: minmax(70px, 130px) repeat(24, minmax(6px, 1fr));
            gap: 1px;
            align-items: stretch;
        }
        .label {
            display: flex;
            flex-direction: column;
            justify-content: center;
            min-width: 0;
            font-size: 0.75rem;
            padding-right: 4px;
        }
        .name {
            display: flex;
            align-items: center;
            gap: 4px;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }
        .swatch {
            width: 10px;
            height: 10px;
            border-radius: 2px;
            flex: none;
        }
        .cell {
            min-height: 20px;
            border-radius: 2px;
        }
        .cell.missing {
            background-image: repeating-linear-gradient(
                135deg,
                var(--divider-color, #ccc) 0 1px,
                transparent 1px 4px
            );
        }
        .label.price { font-size: 0.65rem; color: var(--secondary-text-color); }
        .cell.price { min-height: 8px; }
        .separator { grid-column: 1 / -1; height: 6px; }
        .axis {
            font-size: 0.65rem;
            color: var(--secondary-text-color);
            white-space: nowrap;
            overflow: visible;
        }
        .empty {
            font-size: 0.75rem;
            color: var(--secondary-text-color);
            margin-top: 6px;
        }
    `];

    protected willUpdate(changed: PropertyValues<this>): void {
        // A refresh reuses the hovered node: its popup would keep the old figures.
        if (changed.has("payload")) this._tooltip.hide();
        const key = this._modelKey;
        if (key === null || key.payload !== this.payload || key.localize !== this.localize) {
            this._modelKey = { payload: this.payload, localize: this.localize };
            this._model = this.payload ? this._buildModel(this.payload) : null;
        }
    }

    private _t(key: string): string {
        return this.localize ? this.localize(key) : key;
    }

    private _rowLabel(row: DailyProfileRow): string {
        if (row.unmeasured) return this._t("house_section.unmeasured");
        return (row.estimated ? "≈ " : "") + (row.label || row.id);
    }

    /**
     * A mean price for the hover, the only place its value is shown: two
     * decimals, since hours a few hundredths apart are what this view compares.
     * The payload's currency is already the price unit (CZK/kWh).
     */
    private _rate(rate: number | null, unit: string | null): string {
        return rate === null ? "—" : rate.toFixed(2) + (unit ? " " + unit : "");
    }

    /** What every cell of an hour carries in its hover: that hour's mean prices. */
    private _priceRows(payload: DailyProfileReportPayload, hour: number): TooltipRow[] {
        return (["import", "export"] as const).map((side) => {
            const rate = (side === "import" ? payload.import_rate : payload.export_rate)[hour] ?? null;
            const color = rate !== null && rate < 0
                ? PRICE_NEGATIVE_COLOR
                : side === "import" ? GRID_IMPORT_COLOR : GRID_EXPORT_COLOR;
            return tooltipRow(
                this._t("device_reports.daily_profile." + side),
                this._rate(rate, payload.currency),
                color,
            );
        });
    }

    private _coverageRow(row: DailyProfileRow): TooltipRow {
        return coverageRow(this._t.bind(this), row.coverage, row.first_hour);
    }

    /** A device's label: its coverage, its peak hour and its mean energy per day. */
    private _deviceTooltip(row: DailyProfileRow, label: string, color: string): TooltipBody {
        const observed = HOURS.filter((hour) => row.watts[hour] != null);
        const peakHour = observed.reduce<number | null>(
            (best, hour) => best === null || row.watts[hour]! > row.watts[best]! ? hour : best,
            null,
        );
        const perDay = observed.reduce((sum, hour) => sum + row.watts[hour]!, 0) / 1000;
        return {
            title: label,
            hasActual: false,
            rows: [
                this._coverageRow(row),
                tooltipRow(
                    this._t("device_reports.daily_profile.peak"),
                    peakHour === null
                        ? "—"
                        : hourSpan(peakHour) + " · " + formatPower(row.watts[peakHour]!).display,
                    color,
                ),
                tooltipRow(
                    this._t("device_reports.daily_profile.per_day"),
                    formatKwhValue(perDay) + " kWh",
                    color,
                ),
            ],
            note: this._t("device_reports.daily_profile.note"),
        };
    }

    /** A price row's label: the min, mean and max over the hours it has a rate for. */
    private _priceTooltip(label: string, rates: readonly (number | null)[], unit: string | null): TooltipBody {
        const known = rates.filter((rate): rate is number => rate !== null);
        const stat = (value: number) => this._rate(known.length > 0 ? value : null, unit);
        return {
            title: label,
            hasActual: false,
            rows: [
                tooltipRow(this._t("device_reports.daily_profile.min"), stat(Math.min(...known))),
                tooltipRow(
                    this._t("device_reports.daily_profile.mean"),
                    stat(known.reduce((sum, rate) => sum + rate, 0) / known.length),
                ),
                tooltipRow(this._t("device_reports.daily_profile.max"), stat(Math.max(...known))),
            ],
            note: this._t("device_reports.daily_profile.price_note"),
        };
    }

    private _buildModel(payload: DailyProfileReportPayload): DailyProfileModel | null {
        if (payload.rows.length === 0) return null;
        const priceRows = HOURS.map((hour) => this._priceRows(payload, hour));
        let rank = 0;
        const rows = payload.rows.map((row): HeatRow => {
            // Past the palette, devices share the neutral "other" colour rather
            // than repeat a ranked device's -- as Over time folds them into Other.
            const color = row.unmeasured
                ? UNMEASURED_COLOR
                : rank < DEVICE_PALETTE.length ? deviceColor(rank++) : OTHER_DEVICES_COLOR;
            const label = this._rowLabel(row);
            const peak = Math.max(0, ...row.watts.map((watts) => watts ?? 0));
            return {
                id: row.id,
                label,
                swatchStyle: "background:" + color,
                tooltip: this._deviceTooltip(row, label, color),
                cells: HOURS.map((hour): Cell => {
                    const watts = row.watts[hour] ?? null;
                    const level = watts === null ? null : peak > 0 ? watts / peak : 0;
                    const rows = [
                        tooltipRow(
                            this._t("device_reports.daily_profile.average"),
                            watts === null
                                ? this._t("device_reports.daily_profile.no_data")
                                : formatPower(watts).display,
                            color,
                        ),
                    ];
                    if (level !== null) {
                        rows.push(tooltipRow(
                            this._t("device_reports.daily_profile.of_peak"),
                            Math.round(level * 100) + " %",
                        ));
                    }
                    rows.push(...priceRows[hour]);
                    if (partlyCovered(row.coverage)) rows.push(this._coverageRow(row));
                    return {
                        level,
                        style: level === null ? "" : shade(color, level),
                        tooltip: { title: label + " · " + hourSpan(hour), hasActual: false, rows },
                    };
                }),
            };
        });
        const prices = (["import", "export"] as const).map((side): HeatRow => {
            const rates = side === "import" ? payload.import_rate : payload.export_rate;
            const color = side === "import" ? GRID_IMPORT_COLOR : GRID_EXPORT_COLOR;
            // Shaded from the row's cheapest hour to its dearest, not from zero:
            // prices that differ by fees on top of a common base would otherwise
            // all look the same. A negative rate is drawn in its own colour.
            const known = rates.filter((rate): rate is number => rate !== null && rate >= 0);
            const low = known.length > 0 ? Math.min(...known) : 0;
            const high = known.length > 0 ? Math.max(...known) : 0;
            const label = this._t("device_reports.daily_profile." + side);
            return {
                id: side,
                label,
                swatchStyle: "",
                tooltip: this._priceTooltip(label, rates, payload.currency),
                cells: HOURS.map((hour): Cell => {
                    const rate = rates[hour] ?? null;
                    const level = rate === null
                        ? null
                        : rate < 0 || high <= low
                            ? 1
                            : PRICE_FLOOR_LEVEL + (1 - PRICE_FLOOR_LEVEL) * (rate - low) / (high - low);
                    return {
                        level,
                        style: rate === null
                            ? ""
                            : shade(rate < 0 ? PRICE_NEGATIVE_COLOR : color, level),
                        tooltip: { title: hourSpan(hour), hasActual: false, rows: priceRows[hour] },
                    };
                }),
            };
        });
        return { rows, prices };
    }

    private _renderRow(row: HeatRow, kind: "device" | "price") {
        return html`
            <div
                class=${"label " + kind}
                data-row=${row.id}
                @mousemove=${(event: MouseEvent) => this._tooltip.show(event, row.tooltip)}
                @mouseleave=${() => this._tooltip.hide()}
                @click=${(event: MouseEvent) => this._tooltip.toggle(event, row.tooltip)}
            >
                <span class="name">
                    ${row.swatchStyle ? html`<span class="swatch" style=${row.swatchStyle}></span>` : nothing}
                    ${row.label}
                </span>
            </div>
            ${row.cells.map((cell, hour) => html`
                <div
                    class=${"cell " + kind + (cell.level === null ? " missing" : "")}
                    data-row=${row.id}
                    data-hour=${hour}
                    data-level=${cell.level === null ? "" : cell.level.toFixed(3)}
                    style=${cell.style}
                    @mousemove=${(event: MouseEvent) => this._tooltip.show(event, cell.tooltip)}
                    @mouseleave=${() => this._tooltip.hide()}
                    @click=${(event: MouseEvent) => this._tooltip.toggle(event, cell.tooltip)}
                ></div>
            `)}
        `;
    }

    render() {
        const model = this._model;
        if (!model) {
            return html`<div class="empty">${this._t("device_reports.daily_profile.empty")}</div>`;
        }
        return html`
            <div class="grid">
                ${model.rows.map((row) => this._renderRow(row, "device"))}
                <div class="separator"></div>
                ${model.prices.map((row) => this._renderRow(row, "price"))}
                <div></div>
                ${HOURS.map((hour) => html`<div class="axis">${hour % AXIS_EVERY === 0 ? pad(hour) : ""}</div>`)}
            </div>
            ${this._tooltip.render()}
        `;
    }
}
