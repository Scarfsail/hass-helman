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
import { DEVICE_PALETTE, OTHER_DEVICES_COLOR, UNMEASURED_COLOR, deviceColor } from "./device-palette";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Every this many hours the axis is labelled. */
const AXIS_EVERY = 3;
/** The faintest shade a priced hour gets, so the cheapest hour still reads as priced. */
const PRICE_FLOOR_LEVEL = 0.15;
/** Below this coverage a row says how much of the period it has data for, as in Ranking. */
const COVERAGE_MARK = 0.99;

interface Cell {
    /** The cell's value over its row's peak, 0..1; null for a missing cell. */
    level: number | null;
    style: string;
    title: string;
}

interface HeatRow {
    id: string;
    label: string;
    swatchStyle: string;
    mark: string | null;
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
 * palette, as in Over time. The model is built in `willUpdate` behind the
 * inputs it reads.
 */
@customElement("helman-device-report-daily-profile")
export class HelmanDeviceReportDailyProfile extends LitElement {
    @property({ attribute: false }) public payload?: DailyProfileReportPayload;
    @property({ attribute: false }) public query?: DeviceReportQuery;
    @property({ attribute: false }) public localize?: LocalizeFunction;

    private _model: DailyProfileModel | null = null;
    private _modelKey: {
        payload: DailyProfileReportPayload | undefined;
        localize: LocalizeFunction | undefined;
    } | null = null;

    static styles = css`
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
        .mark {
            font-size: 0.65rem;
            color: var(--secondary-text-color);
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
        .note, .empty {
            font-size: 0.75rem;
            color: var(--secondary-text-color);
            margin-top: 6px;
        }
    `;

    protected willUpdate(_changed: PropertyValues<this>): void {
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
    private _priceLines(payload: DailyProfileReportPayload, hour: number): string {
        return [
            this._t("device_reports.daily_profile.import") + ": "
                + this._rate(payload.import_rate[hour] ?? null, payload.currency),
            this._t("device_reports.daily_profile.export") + ": "
                + this._rate(payload.export_rate[hour] ?? null, payload.currency),
        ].join("\n");
    }

    private _buildModel(payload: DailyProfileReportPayload): DailyProfileModel | null {
        if (payload.rows.length === 0) return null;
        const priceLines = HOURS.map((hour) => this._priceLines(payload, hour));
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
                mark: row.coverage < COVERAGE_MARK
                    ? fillTemplate(this._t("device_reports.ranking.coverage"), {
                        pct: String(Math.round(row.coverage * 100)),
                        date: row.first_hour ? row.first_hour.slice(0, 10) : "—",
                    })
                    : null,
                cells: HOURS.map((hour): Cell => {
                    const watts = row.watts[hour] ?? null;
                    const level = watts === null ? null : peak > 0 ? watts / peak : 0;
                    return {
                        level,
                        style: level === null ? "" : shade(color, level),
                        title: [
                            label + " · " + hourSpan(hour),
                            this._t("device_reports.daily_profile.average") + ": "
                                + (watts === null
                                    ? this._t("device_reports.daily_profile.no_data")
                                    : formatPower(watts).display),
                            priceLines[hour],
                        ].join("\n"),
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
            return {
                id: side,
                label: this._t("device_reports.daily_profile." + side),
                swatchStyle: "",
                mark: null,
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
                        title: hourSpan(hour) + "\n" + priceLines[hour],
                    };
                }),
            };
        });
        return { rows, prices };
    }

    private _renderRow(row: HeatRow, kind: "device" | "price") {
        return html`
            <div class=${"label " + kind} data-row=${row.id}>
                <span class="name">
                    ${row.swatchStyle ? html`<span class="swatch" style=${row.swatchStyle}></span>` : nothing}
                    ${row.label}
                </span>
                ${row.mark !== null ? html`<span class="mark">${row.mark}</span>` : nothing}
            </div>
            ${row.cells.map((cell, hour) => html`
                <div
                    class=${"cell " + kind + (cell.level === null ? " missing" : "")}
                    data-row=${row.id}
                    data-hour=${hour}
                    data-level=${cell.level === null ? "" : cell.level.toFixed(3)}
                    style=${cell.style}
                    title=${cell.title}
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
            <div class="note">${this._t("device_reports.daily_profile.note")}</div>
        `;
    }
}
