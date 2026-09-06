import { css, html } from "lit-element";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../localize/localize";
import { getScheduleGridPositiveDisplay } from "./schedule/model/grid-surplus-display";
import type {
    ScheduleTableDayAggregateModel,
    ScheduleTableDayAggregateScale,
} from "./schedule/schedule-table-types";
import {
    formatKwhValue,
    formatGridEnergy,
    formatPositiveGridDisplayValue,
    formatPriceValue,
    formatSolarGaugeTitle,
    formatSolarGaugeValue,
    formatVisiblePriceValue,
    isZeroKwhDisplayValue,
} from "./forecast-value-format";

/**
 * The whole-day gauges: one horizontal bar per metric, read at a glance against
 * the same scale across every day shown.
 *
 * The schedule table draws them at the head of each day section; the solar
 * inspector draws the same three in its day pills. They live here so the two
 * cards cannot drift into two dialects of the same bar — a day that reads
 * "sunny, battery full, exporting" in one card must read that way in the other.
 *
 * Rendering is functions plus a style block rather than a custom element: the
 * bars inherit their host's palette and sizing overrides that way, and a table
 * cell keeps its own layout instead of routing it through a wrapper element.
 */

export type DayAggregateGaugeKind = "battery" | "solar" | "grid" | "price";

export interface DayAggregateGaugeOptions {
    kind: DayAggregateGaugeKind;
    /** The day's numbers; null when the day has none at all. */
    aggregate: ScheduleTableDayAggregateModel | null;
    /** Shared across the days drawn together, so their bars compare. */
    scale: ScheduleTableDayAggregateScale;
    /** Whether the metric exists at all — an unconfigured battery has no bar. */
    available: boolean;
    priceDisplayUnit?: string | null;
    solarPair?: { actualWh: number | null; forecastWh: number | null };
    titlePrefix?: string;
    localize: LocalizeFunction;
}

export const dayAggregateGaugeStyles = css`
    .day-aggregate-gauge {
        box-sizing: border-box;
        position: relative;
        display: flex;
        align-items: center;
        overflow: hidden;
        width: 100%;
        min-width: 0;
        min-height: 18px;
        padding: 1px 4px;
        border-radius: 4px;
        font-size: 0.62rem;
        font-weight: 700;
        line-height: 1.2;
        white-space: nowrap;
    }

    .day-aggregate-gauge > :not(.day-aggregate-gauge-fill, .day-aggregate-gauge-center) {
        position: relative;
        z-index: 1;
    }

    .day-aggregate-gauge-fill {
        position: absolute;
        inset: 0 auto 0 0;
        z-index: 0;
        border-radius: inherit;
        pointer-events: none;
    }

    .day-aggregate-gauge-center {
        position: absolute;
        top: 3px;
        bottom: 3px;
        left: 50%;
        width: 1px;
        z-index: 1;
        background: color-mix(in srgb, var(--primary-text-color) 18%, transparent);
        transform: translateX(-50%);
    }

    .day-aggregate-gauge-value {
        display: block;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
    }

    .day-aggregate-gauge.battery {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--helman-battery) 10%, transparent),
            color-mix(in srgb, var(--helman-battery) 5%, transparent)
        );
        color: color-mix(in srgb, var(--helman-battery) 26%, var(--primary-text-color));
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--helman-battery) 14%, var(--divider-color));
        text-shadow: none;
    }

    .day-aggregate-gauge.battery .day-aggregate-gauge-fill {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--helman-battery) 34%, white 4%),
            color-mix(in srgb, var(--helman-battery) 22%, transparent)
        );
    }

    .day-aggregate-gauge.solar {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--helman-solar) 8%, #171613),
            color-mix(in srgb, var(--helman-solar) 4%, #0b0b0a)
        );
        color: color-mix(in srgb, white 72%, var(--helman-solar));
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--helman-solar) 10%, #25231f);
        text-shadow: none;
    }

    .day-aggregate-gauge.solar .day-aggregate-gauge-fill {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--helman-solar) 24%, #2d2500),
            color-mix(in srgb, var(--helman-solar) 16%, #131000)
        );
    }

    .day-aggregate-gauge.grid {
        direction: ltr;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--helman-grid) 8%, #10151d),
            color-mix(in srgb, var(--helman-grid) 4%, #06090d),
            color-mix(in srgb, var(--helman-grid) 8%, #10151d)
        );
        color: color-mix(in srgb, var(--primary-text-color) 76%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--helman-grid) 9%, #1c2430);
        text-shadow: none;
    }

    .day-aggregate-gauge.grid.surplus {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, #5f5f5f 20%, #1b1b1b),
            color-mix(in srgb, #4c4c4c 11%, #0d0d0d),
            color-mix(in srgb, #5f5f5f 20%, #1b1b1b)
        );
        box-shadow: inset 0 0 0 1px color-mix(in srgb, #727272 30%, #292929);
    }

    .day-aggregate-gauge.grid .day-aggregate-gauge-fill.import {
        inset: 0 auto 0 auto;
        right: 50%;
        left: auto;
        background: linear-gradient(
            270deg,
            color-mix(in srgb, #2563eb 42%, white 2%),
            color-mix(in srgb, #2563eb 20%, transparent)
        );
        border-radius: 4px 0 0 4px;
    }

    .day-aggregate-gauge.grid .day-aggregate-gauge-fill.export {
        inset: 0 auto 0 50%;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--helman-grid-export) 42%, white 2%),
            color-mix(in srgb, var(--helman-grid-export) 20%, transparent)
        );
        border-radius: 0 4px 4px 0;
    }

    .day-aggregate-gauge.grid .day-aggregate-gauge-fill.surplus {
        inset: 0 auto 0 50%;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, #595959 76%, var(--primary-text-color)),
            color-mix(in srgb, #3a3a3a 56%, transparent)
        );
        border-radius: 0 4px 4px 0;
    }

    .day-aggregate-gauge-pair {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        min-width: 0;
    }

    .day-aggregate-gauge-pair .day-aggregate-gauge-value {
        flex: 1 1 0;
    }

    .day-aggregate-gauge-pair .day-aggregate-gauge-value.import {
        color: color-mix(in srgb, #2563eb 58%, var(--primary-text-color));
        text-align: left;
    }

    .day-aggregate-gauge-pair .day-aggregate-gauge-value.export {
        color: color-mix(in srgb, var(--helman-grid-export) 52%, var(--primary-text-color));
        text-align: right;
    }

    .day-aggregate-gauge-pair .day-aggregate-gauge-value.surplus {
        color: color-mix(in srgb, var(--secondary-text-color) 82%, #5b5b5b);
        text-align: right;
    }

    .day-aggregate-gauge.price {
        direction: ltr;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--helman-price-negative) 8%, transparent),
            color-mix(in srgb, var(--card-background-color) 94%, transparent),
            color-mix(in srgb, var(--helman-price-positive) 8%, transparent)
        );
        color: color-mix(in srgb, var(--primary-text-color) 76%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--helman-price-positive) 12%, var(--divider-color));
        text-shadow: none;
    }

    .day-aggregate-gauge.price .day-aggregate-gauge-fill.negative {
        inset: 0 auto 0 auto;
        left: auto;
        background: linear-gradient(
            270deg,
            color-mix(in srgb, var(--helman-price-negative) 40%, white 2%),
            color-mix(in srgb, var(--helman-price-negative) 18%, transparent)
        );
        border-radius: 4px 0 0 4px;
    }

    .day-aggregate-gauge.price .day-aggregate-gauge-fill.positive {
        inset: 0 auto 0 auto;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--helman-price-positive) 40%, white 2%),
            color-mix(in srgb, var(--helman-price-positive) 18%, transparent)
        );
        border-radius: 0 4px 4px 0;
    }

    .day-aggregate-price-pair {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        min-width: 0;
    }

    .day-aggregate-price-pair .day-aggregate-gauge-value {
        flex: 1 1 0;
    }

    .day-aggregate-price-pair .day-aggregate-gauge-value.negative {
        color: color-mix(in srgb, var(--helman-price-negative) 62%, var(--primary-text-color));
        text-align: left;
    }

    .day-aggregate-price-pair .day-aggregate-gauge-value.positive {
        color: color-mix(in srgb, var(--helman-price-positive) 62%, var(--primary-text-color));
        text-align: right;
    }

    .day-aggregate-gauge.zero {
        color: var(--secondary-text-color);
        background: color-mix(in srgb, var(--secondary-text-color) 12%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--secondary-text-color) 14%, transparent);
        text-shadow: none;
    }

    .day-aggregate-gauge.zero .day-aggregate-gauge-center {
        background: color-mix(in srgb, var(--secondary-text-color) 28%, transparent);
    }

    .day-aggregate-gauge.unavailable {
        opacity: 0.4;
    }
`;

export function renderDayAggregateGauge(options: DayAggregateGaugeOptions) {
    switch (options.kind) {
        case "battery":
            return _renderBatteryGauge(options);
        case "solar":
            return _renderSolarGauge(options);
        case "grid":
            return _renderGridGauge(options);
        case "price":
            return _renderPriceGauge(options);
    }
}

function _renderBatteryGauge(options: DayAggregateGaugeOptions) {
    const aggregate = options.aggregate;
    if (
        !options.available
        || aggregate === null
        || aggregate.batteryMinSocPct === null
        || aggregate.batteryMaxSocPct === null
    ) {
        return html`<div class="day-aggregate-gauge battery unavailable" aria-hidden="true"></div>`;
    }

    const startPct = Math.max(Math.min(aggregate.batteryMinSocPct, 100), 0);
    const widthPct = Math.max(Math.min(aggregate.batteryMaxSocPct, 100) - startPct, 0);
    const title = (options.titlePrefix ? options.titlePrefix + " · " : "") + buildDayBatteryAggregateTitle(
        options.localize,
        aggregate.batteryMinSocPct,
        aggregate.batteryMaxSocPct,
    );

    return html`
        <div class="day-aggregate-gauge battery" role="img" aria-label=${title} title=${title}>
            ${widthPct > 0 ? html`
                <span
                    class="day-aggregate-gauge-fill"
                    style=${`left:${startPct}%;width:${widthPct}%;`}
                    aria-hidden="true"
                ></span>
            ` : nothing}
            <span class="day-aggregate-gauge-value">
                ${Math.round(aggregate.batteryMinSocPct)} : ${Math.round(aggregate.batteryMaxSocPct)}
            </span>
        </div>
    `;
}

function _renderSolarGauge(options: DayAggregateGaugeOptions) {
    const aggregate = options.aggregate;
    const pair = options.solarPair;
    if (!pair && (!options.available || aggregate === null || aggregate.solarWh === null)) {
        return html`<div class="day-aggregate-gauge solar unavailable" aria-hidden="true"></div>`;
    }

    const solarWh = aggregate?.solarWh ?? 0;
    const widthPct = options.scale.solarMaxWh > 0
        ? Math.min((solarWh / options.scale.solarMaxWh) * 100, 100)
        : 0;
    const title = pair ? buildDaySolarPairTitle(options.localize, pair)
        : buildDaySolarAggregateTitle(options.localize, solarWh);

    return html`
        <div class=${`day-aggregate-gauge solar${pair ? " solar-paired" : ""}`} role="img" aria-label=${title} title=${title}>
            ${widthPct > 0 ? html`
                <span
                    class="day-aggregate-gauge-fill"
                    style=${`width:${widthPct}%;`}
                    aria-hidden="true"
                ></span>
            ` : nothing}
            <span class="day-aggregate-gauge-value">${pair
                ? html`<span>${pair.actualWh === null ? "—" : formatSolarGaugeValue(pair.actualWh)} / ${pair.forecastWh === null ? "—" : formatSolarGaugeValue(pair.forecastWh)}</span><span class="solar-pair-unit">kWh</span>`
                : formatSolarGaugeValue(solarWh)}</span>
        </div>
    `;
}

function _renderGridGauge(options: DayAggregateGaugeOptions) {
    const aggregate = options.aggregate;
    if (
        !options.available
        || aggregate === null
        || aggregate.gridImportKwh === null
        || aggregate.gridExportKwh === null
    ) {
        return html`<div class="day-aggregate-gauge grid unavailable" aria-hidden="true"></div>`;
    }

    const positiveDisplay = getScheduleGridPositiveDisplay({
        exportKwh: aggregate.gridExportKwh,
        availableSurplusKwh: aggregate.availableSurplusKwh,
    });
    const hasImport = !isZeroKwhDisplayValue(aggregate.gridImportKwh);
    const hasPositiveDisplay = positiveDisplay.kind !== null;
    const importWidthPct = options.scale.gridMaxKwh > 0 && hasImport
        ? Math.min((aggregate.gridImportKwh / options.scale.gridMaxKwh) * 50, 50)
        : 0;
    const positiveWidthPct = options.scale.gridMaxKwh > 0 && hasPositiveDisplay
        ? Math.min((positiveDisplay.valueKwh / options.scale.gridMaxKwh) * 50, 50)
        : 0;
    const title = buildDayGridAggregateTitle(options.localize, aggregate);

    return html`
        <div
            class=${`day-aggregate-gauge grid${positiveDisplay.kind === "surplus" ? " surplus" : ""}${!hasImport && !hasPositiveDisplay ? " zero" : ""}`}
            role="img"
            aria-label=${title}
            title=${title}
        >
            <span class="day-aggregate-gauge-center" aria-hidden="true"></span>
            ${importWidthPct > 0 ? html`
                <span
                    class="day-aggregate-gauge-fill import"
                    style=${`width:${importWidthPct}%;`}
                    aria-hidden="true"
                ></span>
            ` : nothing}
            ${positiveWidthPct > 0 && positiveDisplay.kind !== null ? html`
                <span
                    class=${`day-aggregate-gauge-fill ${positiveDisplay.kind}`}
                    style=${`width:${positiveWidthPct}%;`}
                    aria-hidden="true"
                ></span>
            ` : nothing}
            <span class="day-aggregate-gauge-pair">
                ${hasImport ? html`
                    <span class="day-aggregate-gauge-value import">
                        ${formatKwhValue(aggregate.gridImportKwh)}
                    </span>
                ` : nothing}
                ${hasPositiveDisplay && positiveDisplay.kind !== null ? html`
                    <span class=${`day-aggregate-gauge-value ${positiveDisplay.kind}`}>
                        ${formatPositiveGridDisplayValue(positiveDisplay.valueKwh)}
                    </span>
                ` : nothing}
            </span>
        </div>
    `;
}

function _renderPriceGauge(options: DayAggregateGaugeOptions) {
    const aggregate = options.aggregate;
    if (!options.available || !aggregate?.priceHasData) {
        return html`<div class="day-aggregate-gauge price unavailable" aria-hidden="true"></div>`;
    }

    const unit = options.priceDisplayUnit ?? null;
    const hasNegative = aggregate.priceNegativeMin !== null && aggregate.priceNegativeMax !== null;
    const hasPositive = aggregate.pricePositiveMin !== null && aggregate.pricePositiveMax !== null;
    const isZero = !hasNegative && !hasPositive;
    const priceMaxAbs = options.scale.priceMaxAbs;
    const negativeStartPct = priceMaxAbs > 0 && hasNegative
        ? Math.min((Math.abs(aggregate.priceNegativeMax!) / priceMaxAbs) * 50, 50)
        : 0;
    const negativeWidthPct = priceMaxAbs > 0 && hasNegative
        ? Math.min(
            ((Math.abs(aggregate.priceNegativeMin!) - Math.abs(aggregate.priceNegativeMax!)) / priceMaxAbs) * 50,
            50,
        )
        : 0;
    const positiveStartPct = priceMaxAbs > 0 && hasPositive
        ? Math.min((aggregate.pricePositiveMin! / priceMaxAbs) * 50, 50)
        : 0;
    const positiveWidthPct = priceMaxAbs > 0 && hasPositive
        ? Math.min(((aggregate.pricePositiveMax! - aggregate.pricePositiveMin!) / priceMaxAbs) * 50, 50)
        : 0;
    const title = buildDayPriceAggregateTitle(options.localize, aggregate, unit);

    return html`
        <div
            class=${`day-aggregate-gauge price${isZero ? " zero" : ""}`}
            role="img"
            aria-label=${title}
            title=${title}
        >
            <span class="day-aggregate-gauge-center" aria-hidden="true"></span>
            ${hasNegative && negativeWidthPct > 0 ? html`
                <span
                    class="day-aggregate-gauge-fill negative"
                    style=${`right:calc(50% + ${negativeStartPct}%);width:${negativeWidthPct}%;`}
                    aria-hidden="true"
                ></span>
            ` : nothing}
            ${hasPositive && positiveWidthPct > 0 ? html`
                <span
                    class="day-aggregate-gauge-fill positive"
                    style=${`left:calc(50% + ${positiveStartPct}%);width:${positiveWidthPct}%;`}
                    aria-hidden="true"
                ></span>
            ` : nothing}
            <span class="day-aggregate-price-pair">
                ${hasNegative ? html`
                    <span class="day-aggregate-gauge-value negative">
                        ${formatVisiblePriceValue(aggregate.priceNegativeMin!)}
                    </span>
                ` : nothing}
                ${hasPositive ? html`
                    <span class="day-aggregate-gauge-value positive">
                        ${formatVisiblePriceValue(aggregate.pricePositiveMin!)} : ${formatVisiblePriceValue(aggregate.pricePositiveMax!)}
                    </span>
                ` : nothing}
            </span>
        </div>
    `;
}

export function buildDayBatteryAggregateTitle(
    localize: LocalizeFunction,
    minSocPct: number,
    maxSocPct: number,
): string {
    return `${localize("scheduling.forecast.battery_label")}: ${Math.round(minSocPct)}% : ${Math.round(maxSocPct)}%`;
}

export function buildDaySolarAggregateTitle(localize: LocalizeFunction, wh: number): string {
    return `${localize("scheduling.forecast.solar_label")}: ${formatSolarGaugeTitle(wh)}`;
}

export function buildDayGridAggregateTitle(
    localize: LocalizeFunction,
    aggregate: ScheduleTableDayAggregateModel,
): string {
    const titleParts = [
        localize("scheduling.forecast.grid_label"),
        `${localize("scheduling.forecast.import")}: ${formatGridEnergy(aggregate.gridImportKwh ?? 0)}`,
        `${localize("scheduling.forecast.export")}: ${formatGridEnergy(aggregate.gridExportKwh ?? 0)}`,
    ];
    if (
        aggregate.availableSurplusKwh !== null
        && !isZeroKwhDisplayValue(aggregate.availableSurplusKwh)
    ) {
        titleParts.push(
            `${localize("scheduling.forecast.surplus")}: ${formatGridEnergy(aggregate.availableSurplusKwh)}`,
        );
    }
    return titleParts.join(" · ");
}

export function buildDayPriceAggregateTitle(
    localize: LocalizeFunction,
    aggregate: ScheduleTableDayAggregateModel,
    unit: string | null,
): string {
    const ranges: string[] = [];
    if (aggregate.priceNegativeMin !== null && aggregate.priceNegativeMax !== null) {
        ranges.push(
            `${formatPriceValue(aggregate.priceNegativeMin, unit)} to ${formatPriceValue(aggregate.priceNegativeMax, unit)}`,
        );
    }
    if (aggregate.pricePositiveMin !== null && aggregate.pricePositiveMax !== null) {
        ranges.push(
            `${formatPriceValue(aggregate.pricePositiveMin, unit)} to ${formatPriceValue(aggregate.pricePositiveMax, unit)}`,
        );
    }

    const title = ranges.length > 0 ? ranges.join(" · ") : formatPriceValue(0, unit);
    return `${localize("scheduling.forecast.price_label")}: ${title}`;
}

export function buildDaySolarPairTitle(
    localize: LocalizeFunction,
    pair: { actualWh: number | null; forecastWh: number | null },
): string {
    return `${localize("bias_correction.inspector.solar_actual_so_far")}: ${pair.actualWh === null ? "—" : formatSolarGaugeTitle(pair.actualWh)} · ${localize("bias_correction.inspector.solar_full_day_forecast")}: ${pair.forecastWh === null ? "—" : formatSolarGaugeTitle(pair.forecastWh)}`;
}
