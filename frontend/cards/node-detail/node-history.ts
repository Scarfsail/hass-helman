import { css, html, nothing, type TemplateResult } from "lit";
import type { HomeAssistant } from "../../types/ha";
import type { DeviceStats, MoneySideDTO, NodeHistoryDTO, NodeHistoryPayload } from "../helman-api";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { currencyFromPriceUnit } from "../helman-solar-inspector/money-model";
import { callHelman } from "../shared/data/helman-commands";
import { deviceEnergyMeasures } from "../shared/devices/device-energy";
import { formatKwh, formatMoney, formatPower } from "../shared/format";
import { boldTemplate } from "./detail-section";
import { SOURCE_NODES, gaugePillStyles, nodeIcon } from "./flow-gauge";
import { historyRow, kwhText, sectionNotReady } from "./node-detail-history";
import type { DeviceDetailParams } from "./node-detail-types";
import type { SectionOptions, SectionResource } from "./section-resource";
import "./help-tip";

/**
 * Every consumer's "Last 30 days" in History & statistics: one house-subtree
 * node's energy and money gauges, how often it ran and its kWh per active day,
 * from `helman/get_node_history`, and the History header's running power with
 * what an hour of it costs. One block for every node, the EV charger included.
 */

/** Below this an amount of energy is nothing. */
const EPSILON_KWH = 1e-6;
/** Under this share of the period covered, a note names the share. */
const FULL_COVERAGE = 0.99;

/** What a detail's sections are read for: its item, through `hass`. */
type DetailHost = { hass: HomeAssistant; params: DeviceDetailParams };

/** The node's last 30 days, a rolling section read while `shown`. */
export function nodeHistorySection(host: DetailHost, shown: () => boolean): SectionOptions<NodeHistoryPayload> {
    return {
        fetch: () => callHelman(host.hass, "helman/get_node_history", { node_id: host.params.item.id }),
        shown,
        rolling: true,
    };
}

/** The learned usage record, read once while the item has a device key; `null` when there is none. */
export function deviceStatsSection(host: DetailHost): SectionOptions<DeviceStats | null> {
    return {
        // The backend resolves a metered device's id to its meter.
        fetch: () => callHelman(host.hass, "helman/get_device_stats", { device_key: host.params.item.deviceKey! }),
        shown: () => !!host.params.item.deviceKey,
        staleness: () => false,
    };
}

/** The node history's answer, when it has one: a period without energy has none. */
export function nodeHistory(payload: NodeHistoryPayload | null | undefined): NodeHistoryDTO | null {
    return payload && payload.unavailable === undefined && payload.totals.kwh > EPSILON_KWH ? payload : null;
}

/** The gauges' styles, on top of the live gauge's pills. */
export const nodeHistoryStyles = [gaugePillStyles, css`
    [data-node-history] { display: flex; flex-direction: column; gap: 10px; }
    [data-node-history] > .link-button { align-self: flex-start; }
    /* The 30 days' energy and money gauges, one under the other. */
    .gauges { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 12px; }
    .gauges .money-title { margin-top: 6px; }
    /* The label is the live gauge's title; its totals keep their units' case. */
    .gauges .gauge-title { flex-wrap: wrap; gap: 0 6px; }
    .gauge-total { text-transform: none; letter-spacing: normal; font-weight: 500; }
    /* The money pills hold a second line, its amount per kWh. */
    .pill.tall { height: auto; flex-direction: column; gap: 0; padding: 5px 8px; line-height: 1.35; }
    .pill.tall .line { display: flex; align-items: center; gap: 6px; max-width: 100%; }
    .pill.tall .rate { font-size: 11px; font-weight: 400; opacity: 0.75; }
    /* Solar's money was never paid: the export income not earned, striped. */
    .pill.missed::before { background: repeating-linear-gradient(135deg,
        color-mix(in srgb, var(--node) 50%, transparent) 0 2px, color-mix(in srgb, var(--node) 22%, transparent) 2px 8px); }
    /* Its text stays legible over the stripes, in either theme. */
    .pill.missed > * { text-shadow: 0 0 3px var(--card-background-color, var(--primary-background-color)),
        0 0 1px var(--card-background-color, var(--primary-background-color)); }
    /* The glow says "flowing now": a period's figures do not glow. */
    .gauges .pill[data-active] { animation: none; box-shadow: none; }
    [data-estimates] .row .value { text-align: end; }
`];

const h = (localize: LocalizeFunction, key: string) => localize(`node_detail.shared.history.${key}`);

/** "≈ 12 CZK", whole units from 10 up. */
function money(amount: number, priceUnit: string | null): string {
    return `≈ ${formatMoney(amount, currencyFromPriceUnit(priceUnit), { precision: "compact" })}`;
}

/** A rate, "≈ 1.98 CZK". */
function rate(value: number, priceUnit: string | null): string {
    return `≈ ${formatMoney(value, currencyFromPriceUnit(priceUnit))}`;
}

/**
 * A money side as shown: its amount, naming its coverage when partly
 * priced unless `coverage` is off; `null` with nothing priced.
 */
export function moneyText(side: MoneySideDTO, priceUnit: string | null, localize: LocalizeFunction, coverage = true): string | null {
    if (side.pricedKwh <= EPSILON_KWH) return null;
    const amount = side.amount ?? 0;
    const value = money(Math.abs(amount), priceUnit);
    const text = amount < -EPSILON_KWH ? fillTemplate(h(localize, "period_paid_back"), { money: value }) : value;
    return coverage && side.unpricedKwh > EPSILON_KWH
        ? fillTemplate(h(localize, "period_coverage"), { money: text, priced: formatKwh(side.pricedKwh), total: kwhText(side.pricedKwh + side.unpricedKwh) })
        : text;
}

/**
 * The History header every consumer shares: its learned power while running
 * and what an hour of it costs at the last 30 days' paid rate, "**2.1 kW ·
 * ≈ 2.56 CZK/h** while running", or the power alone without a rate or
 * once the node history failed; `null` without a learned power or while the
 * node history has no answer yet, for the detail's own header.
 */
export function consumerHistorySummary(stats: DeviceStats | null | undefined, history: SectionResource<NodeHistoryPayload>, localize: LocalizeFunction): TemplateResult | null {
    const measures = deviceEnergyMeasures(stats ?? undefined);
    const watts = measures.running ?? measures.on;
    if (watts === undefined) return null;
    const status = history.state?.status;
    if (status !== "ready" && status !== "error") return null;
    const kw = formatPower(watts).display;
    const period = nodeHistory(history.payload);
    const perKwh = period?.paidPerKwh ?? null;
    const figure = period && perKwh !== null
        ? `${kw} · ≈ ${formatMoney(watts / 1000 * perKwh, currencyFromPriceUnit(period.priceUnit))}/h`
        : kw;
    return boldTemplate(h(localize, "period_while_running"), { figure });
}

/**
 * The last 30 days: two gauges drawn as the live one's pills, in its
 * order (solar, battery, grid). Energy fills each pill to its share of
 * the kWh, money to its share of the money; solar's money is the export
 * income not earned, striped apart from what was paid. Each gauge's title
 * carries its total; under them only what is not one source's, how often it
 * ran and its kWh per active day. Its loading or failure while it has no
 * answer; nothing when the node has no history.
 */
export function renderNodeHistory(
    section: SectionResource<NodeHistoryPayload>,
    localize: LocalizeFunction,
    options: { locale: string; timeZone: string; estimatesOpen: boolean; toggleEstimates: () => void; note?: string },
): TemplateResult | typeof nothing {
    const notReady = sectionNotReady(section, localize);
    if (notReady) return html`<div data-node-history-not-ready>${notReady}</div>`;
    const period = nodeHistory(section.payload);
    if (!period) return nothing;
    const totals = period.totals;
    const sources = totals.sources;
    const pct = (kwh: number) => totals.kwh > 0 ? Math.round(kwh / totals.kwh * 100) : 0;
    const perWeek = period.perWeek.toFixed(1);
    const unknownKwh = sources ? sources.unknown : totals.kwh;
    const periodDays = Math.round((Date.parse(period.endDate) - Date.parse(period.startDate)) / 86_400_000) + 1;
    const fewerDays = period.coveredDays < periodDays;
    const partial = period.coverage < FULL_COVERAGE;
    // A late first hour dates the gap; otherwise the gaps are inside the period.
    const since = partial && period.firstHour && period.firstHour.slice(0, 10) > period.startDate
        ? new Date(period.firstHour).toLocaleDateString(options.locale, { day: "numeric", month: "short", timeZone: options.timeZone })
        : null;
    const pctCovered = Math.round(period.coverage * 100);
    return html`
        <div class="section-title" data-node-history-title>${fewerDays ? fillTemplate(h(localize, "period_last_30_covered"), { days: period.coveredDays }) : h(localize, "period_last_30")}<helman-help-tip .explanation=${h(localize, "period_last_30_help")}></helman-help-tip></div>
        <div data-node-history>
            ${partial ? html`<p class="note" data-node-history-coverage>${since
                ? fillTemplate(h(localize, "period_coverage_note"), { pct: pctCovered, date: since })
                : fillTemplate(h(localize, "period_coverage_note_gaps"), { pct: pctCovered })}</p>` : nothing}
            <div class="gauges" data-gauges>
                ${renderEnergyGauge(period, localize)}
                ${renderMoneyGauge(period, localize)}
            </div>
            <div class="rows" data-node-history-summary>
                ${unknownKwh > EPSILON_KWH ? historyRow(h(localize, "source_unknown_cap"), `${kwhText(unknownKwh)} · ${pct(unknownKwh)} %`, "source-unknown") : nothing}
                ${historyRow(h(localize, "period_row_often"), `${fillTemplate(h(localize, "period_per_week"), { n: perWeek })} · ${fillTemplate(h(localize, "period_days"), { days: period.activeDays, covered: period.coveredDays })}`, "how-often")}
                ${period.kwhPerActiveDay !== null ? historyRow(h(localize, "period_row_per_day"), `≈ ${kwhText(period.kwhPerActiveDay)}`, "per-day") : nothing}
            </div>
            <button class="link-button" data-estimates-toggle aria-expanded=${options.estimatesOpen ? "true" : "false"} aria-controls="node-history-estimates"
                @click=${options.toggleEstimates}>${h(localize, "period_how")}</button>
            ${options.estimatesOpen ? renderEstimates(period, localize, options.note) : nothing}
        </div>
    `;
}

/** The kWh by source: each pill its kWh, the title's unit, and share, "—" while no source is known; an estimated node's total is "≈". */
function renderEnergyGauge(period: NodeHistoryDTO, localize: LocalizeFunction) {
    const totals = period.totals;
    const sources = totals.sources;
    return html`<div class="gauge-title" data-energy-title>${h(localize, "period_gauge_energy")}<span class="gauge-total">· ${period.estimated ? "≈ " : ""}${kwhText(totals.kwh)}</span></div>
        <div class="pills" data-energy>${SOURCE_NODES.map((node) => {
            const kwh = sources ? sources[node] : null;
            const pct = kwh !== null && kwh > EPSILON_KWH && totals.kwh > 0 ? Math.max(1, Math.round(kwh / totals.kwh * 100)) : 0;
            return html`<div class="pill" data-source=${node} ?data-active=${pct > 0} style=${`--node: var(--helman-${node}); --fill: ${pct}%`}
                title=${localize(`node_detail.title.${node}`)}>
                <ha-icon icon=${nodeIcon(node)}></ha-icon><span class="gauge-figure">${kwh === null ? "—" : formatKwh(Math.abs(kwh))}${pct > 0 ? html` <span class="percent">${pct} %</span>` : nothing}</span>
            </div>`;
        })}</div>`;
}

/**
 * The money by source: solar's export income not earned, the battery's
 * and the grid's paid, each pill filled to its share of the three and
 * holding its amount and that per kWh. Nothing with none of them priced.
 */
function renderMoneyGauge(period: NodeHistoryDTO, localize: LocalizeFunction) {
    const totals = period.totals;
    const unit = period.priceUnit;
    const parts = [
        { node: "solar" as const, side: totals.solarForgone, rate: period.solarForgonePerKwh, hint: h(localize, "period_money_solar_hint") },
        { node: "battery" as const, side: totals.batteryPaid, rate: period.batteryPricePerKwh, hint: localize("node_detail.title.battery") },
        { node: "grid" as const, side: totals.gridPaid, rate: period.gridPricePerKwh, hint: localize("node_detail.title.grid") },
    ].map((part) => ({ ...part, text: moneyText(part.side, unit, localize, false) }));
    // The title's totals, each over the kWh it prices: what was paid (solar free), and
    // virtually, paid plus the direct solar's export income not earned.
    const paid = moneyText(totals.paid, unit, localize, false);
    if (!paid && parts.every((part) => part.text === null)) return nothing;
    const total = parts.reduce((sum, part) => sum + Math.max(0, part.side.amount ?? 0), 0);
    const perKwh = (value: number | null) => value !== null ? ` · ${rate(value, unit)}/kWh` : "";
    // Paid back says so itself: it is not "paid".
    const paidText = paid && (totals.paid.amount ?? 0) < -EPSILON_KWH ? paid : paid && fillTemplate(h(localize, "period_gauge_paid"), { money: paid });
    const virtual = period.virtualPerKwh !== null ? moneyText(totals.virtual, unit, localize, false) : null;
    return html`<div class="gauge-title money-title" data-money-title>${h(localize, "period_gauge_money")}
            ${paidText ? html`<span class="gauge-total" data-money-paid>· ${paidText}${perKwh(period.paidPerKwh)}</span>` : nothing}
            ${virtual ? html`<span class="gauge-total" data-money-virtual title=${h(localize, "period_gauge_virtual_hint")}>· ${fillTemplate(h(localize, "period_gauge_virtual"), { money: virtual })}${perKwh(period.virtualPerKwh)}</span>` : nothing}
        </div>
        <div class="pills" data-money>${parts.map(({ node, side, rate: perKwhRate, hint, text }) => {
            const amount = side.amount ?? 0;
            const pct = text !== null && amount > EPSILON_KWH && total > 0 ? Math.max(1, Math.round(amount / total * 100)) : 0;
            return html`<div class="pill tall ${node === "solar" ? "missed" : ""}" data-money-source=${node} ?data-active=${pct > 0}
                style=${`--node: var(--helman-${node}); --fill: ${pct}%`} title=${hint} role="group" aria-label=${hint}>
                <span class="line"><ha-icon icon=${nodeIcon(node)}></ha-icon><span class="gauge-figure">${text ?? "—"}</span></span>
                ${text !== null && perKwhRate !== null ? html`<span class="line rate">${rate(perKwhRate, unit)}/kWh</span>` : nothing}
            </div>`;
        })}</div>`;
}

/** What the 30-day figures rest on, disclosed in place. */
function renderEstimates(period: NodeHistoryDTO, localize: LocalizeFunction, note: string | undefined) {
    const totals = period.totals;
    const of = (part: number) => fillTemplate(h(localize, "period_of"), { part: formatKwh(part), total: kwhText(totals.kwh) });
    return html`<div class="rows" id="node-history-estimates" data-estimates>
        ${historyRow(h(localize, "period_how_energy"), h(localize, "period_how_energy_value"), "how-energy")}
        ${historyRow(h(localize, "period_how_split"), h(localize, "period_how_split_value"), "how-split")}
        ${historyRow(h(localize, "period_how_paid"), h(localize, "period_how_paid_value"), "how-paid")}
        ${historyRow(h(localize, "period_how_priced"), of(totals.paid.pricedKwh), "how-priced")}
        ${historyRow(h(localize, "period_how_known"), of(totals.knownKwh), "how-known")}
        ${historyRow(h(localize, "period_how_forgone"), h(localize, "period_how_forgone_value"), "how-forgone")}
        <p class="note" data-estimates-note>${h(localize, "period_how_note")}</p>
        ${note ? html`<p class="note" data-estimates-detail-note>${note}</p>` : nothing}
    </div>`;
}
