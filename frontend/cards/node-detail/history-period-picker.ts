import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { DeviceReportQuery } from "../helman-api";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { periodBarStyles, presetQuery } from "../helman-device-reports/report-period";
import { fireEvent } from "../shared/fire-event";
import { addDays, daysBetween, parseDayKey, todayKey } from "../shared/time/day-key";
import { hassLocale, timeZone } from "./section-resource";
import "./help-tip";

/**
 * The period a consumer's History shows: its shortcuts, how a period steps,
 * how it is named, and the picker that changes it.
 */

/** The detail's shortcuts, in the order the picker offers them. */
export const DETAIL_PERIOD_SHORTCUTS = ["today", "yesterday", "last_7", "last_30", "this_month", "last_month", "custom"] as const;

/** The longest period read, the backend's `MAX_REPORT_DAYS`. */
const MAX_PERIOD_DAYS = 366;

export type DetailPeriodPreset = (typeof DETAIL_PERIOD_SHORTCUTS)[number];

/** A picked period: its dates, both inclusive, and the shortcut it was picked by, kept through its steps. */
export interface HistoryPeriod extends DeviceReportQuery {
    preset: DetailPeriodPreset;
}

/** The period a detail opens on: the last 30 days. */
export function defaultPeriod(today: string): HistoryPeriod {
    return { preset: "last_30", ...presetQuery("last_30", today)! };
}

/**
 * The period one step before (`-1`) or after (`1`): a month shortcut's
 * whole calendar month, ended today at the latest; any other by its length
 * in days, ending today at the latest with its length kept.
 */
export function shiftPeriod(period: HistoryPeriod, direction: -1 | 1, today: string): HistoryPeriod {
    const latest = (day: string) => day < today ? day : today;
    if (period.preset === "this_month" || period.preset === "last_month") {
        const { year, month } = parseDayKey(period.start_date)!;
        const monthStart = (offset: number) => new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10);
        return { ...period, start_date: monthStart(direction), end_date: latest(addDays(monthStart(direction + 1), -1)) };
    }
    const days = daysBetween(period.start_date, period.end_date) + 1;
    const end = latest(addDays(period.end_date, direction * days));
    return { ...period, start_date: addDays(end, 1 - days), end_date: end };
}

/**
 * The period's dates in `locale`, "October 10 – November 8, 2026", one
 * day with its weekday; `brief` leaves out the year and the weekday.
 */
export function formatPeriod(period: DeviceReportQuery, locale: string, brief = false): string {
    const single = period.start_date === period.end_date;
    return new Intl.DateTimeFormat(locale, {
        timeZone: "UTC", day: "numeric", month: "long",
        year: brief ? undefined : "numeric", weekday: single && !brief ? "long" : undefined,
    }).formatRange(new Date(`${period.start_date}T00:00:00Z`), new Date(`${period.end_date}T00:00:00Z`));
}

/**
 * The shortcut chips, the period's dates between ‹ › steps, and on Custom…
 * two date fields bounded by the dates there is history for. It shows
 * `period` and asks for another with `period-change`, never changing its own.
 */
@customElement("helman-history-period-picker")
export class HelmanHistoryPeriodPicker extends LitElement {
    static styles = [periodBarStyles, css`
        :host { display: block; }
        /* One row of chips, scrolled sideways where it does not fit. */
        .presets { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
        .presets button { flex: none; }
        .bar button:disabled { opacity: 0.45; cursor: not-allowed; }
        .bar button ha-icon { --mdc-icon-size: 16px; display: block; }
        .dates { flex: 1; text-align: center; font-weight: 600; }
        .covered { display: block; font-size: 0.8rem; font-weight: 400; color: var(--secondary-text-color); }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public period!: HistoryPeriod;
    /** The dates there is history for; unknown until the first answer. */
    @property({ attribute: false }) public navigationRange?: { minDate: string; maxDate: string };
    /** The days of the period with any data, once answered. */
    @property({ attribute: false }) public coveredDays?: number;

    private _change(period: HistoryPeriod): void {
        fireEvent(this, "period-change", period);
    }

    /**
     * A custom date as picked, the other one kept, or moved to keep the
     * start before the end and the period at most {@link MAX_PERIOD_DAYS},
     * neither after today: a typed date passes the fields' min and max.
     */
    private _custom(event: Event, key: "start_date" | "end_date"): void {
        const typed = (event.target as HTMLInputElement).value;
        if (!typed) return;
        const today = todayKey(timeZone(this.hass));
        const value = typed > today ? today : typed;
        const clamp = (day: string, first: string, last: string) => day < first ? first : day > last ? last : day;
        this._change(key === "start_date"
            ? { ...this.period, start_date: value, end_date: clamp(this.period.end_date, value, addDays(value, MAX_PERIOD_DAYS - 1)) }
            : { ...this.period, start_date: clamp(this.period.start_date, addDays(value, 1 - MAX_PERIOD_DAYS), value), end_date: value });
    }

    render() {
        const period = this.period;
        const range = this.navigationRange;
        const today = todayKey(timeZone(this.hass));
        const h = (key: string) => this.localize(`node_detail.shared.history.${key}`);
        const days = daysBetween(period.start_date, period.end_date) + 1;
        return html`
            <div class="bar presets" data-period-picker>
                ${DETAIL_PERIOD_SHORTCUTS.map((preset) => html`<button type="button" data-preset=${preset}
                    class=${preset === period.preset ? "selected" : ""}
                    @click=${() => this._change({ ...(presetQuery(preset, today) ?? period), preset })}
                >${this.localize(`device_reports.presets.${preset}`)}${preset === "custom" ? "…" : ""}</button>`)}
            </div>
            ${period.preset === "custom" ? html`
                <div class="bar custom">
                    <label>${this.localize("device_reports.from")}
                        <input type="date" data-custom-start .value=${period.start_date}
                            min=${range?.minDate ?? nothing} max=${period.end_date}
                            @change=${(event: Event) => this._custom(event, "start_date")} />
                    </label>
                    <label>${this.localize("device_reports.to")}
                        <input type="date" data-custom-end .value=${period.end_date}
                            min=${period.start_date} max=${range?.maxDate ?? nothing}
                            @change=${(event: Event) => this._custom(event, "end_date")} />
                    </label>
                </div>
            ` : nothing}
            <div class="bar">
                <button type="button" data-step-prev aria-label=${h("period_step_prev")}
                    ?disabled=${!range || shiftPeriod(period, -1, today).start_date < range.minDate}
                    @click=${() => this._change(shiftPeriod(period, -1, today))}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
                <span class="dates" data-node-history-title>
                    <span data-primary-date>${formatPeriod(period, hassLocale(this.hass))}</span><helman-help-tip .explanation=${h("period_help")}></helman-help-tip>
                    ${this.coveredDays !== undefined && this.coveredDays < days
                        ? html`<span class="covered" data-subtitle>${fillTemplate(h("period_covered_days"), { days: this.coveredDays })}</span>`
                        : nothing}
                </span>
                <button type="button" data-step-next aria-label=${h("period_step_next")}
                    ?disabled=${period.end_date >= today}
                    @click=${() => this._change(shiftPeriod(period, 1, today))}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
            </div>
        `;
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-history-period-picker": HelmanHistoryPeriodPicker;
    }
}
