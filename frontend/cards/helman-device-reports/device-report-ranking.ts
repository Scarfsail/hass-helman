import { LitElement, css, html, nothing, unsafeCSS, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
    DeviceReportMoneySide,
    DeviceReportQuery,
    RankingNode,
    RankingReportPayload,
} from "../helman-api";
import { PRICE_NEGATIVE_COLOR } from "../color-utils";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { ACTUAL_FILL_OPACITY, CHART_COLORS } from "../helman-solar-inspector/chart-colors";
import { currencyFromPriceUnit } from "../helman-solar-inspector/money-model";
import { formatKwhValue, formatPriceValue } from "../shared/forecast-value-format";
import {
    HoverTooltipController,
    hoverTooltipStyles,
    tooltipRow,
    type TooltipBody,
    type TooltipRow,
} from "../shared/hover-tooltip";

type ShowMode = "both" | "energy" | "money";
type SortMode = "energy" | "paid" | "forgone" | "paid_forgone";

const SHOW_MODES: readonly ShowMode[] = ["both", "energy", "money"];
const SORT_MODES: readonly SortMode[] = ["energy", "paid", "forgone", "paid_forgone"];
const SOURCES = ["solar", "battery", "grid", "unattributed"] as const;

/**
 * The inspector's chart colours, so a device's split reads like the inspector's
 * columns: solar, battery and grid as its stack, paid as its import cost and
 * forgone (export not realised) as its export gain.
 */
const SOURCE_COLORS: Record<(typeof SOURCES)[number], string> = {
    solar: CHART_COLORS.actual,
    battery: CHART_COLORS.battery,
    grid: CHART_COLORS.grid,
    unattributed: CHART_COLORS.unattributed,
};
const MONEY_COLORS = { paid: CHART_COLORS.gridImport, forgone: CHART_COLORS.gridExport } as const;

/** Above this share of a row's kWh, an over-allocation or a partial figure is worth showing. */
const MARK_SHARE = 0.01;

interface RankingModel {
    byId: ReadonlyMap<string, RankingNode>;
    /** Each node's children, in display order: sorted, its remainder last. */
    ordered: ReadonlyMap<string, readonly RankingNode[]>;
    house: RankingNode;
    /** The largest top-level row's kWh: what the energy bars are relative to. */
    energyScale: number;
    /** The largest top-level money stack: what the money bars are relative to. */
    moneyScale: number;
}

function sortValue(node: RankingNode, sort: SortMode): number {
    const paid = node.money.paid.amount ?? 0;
    const forgone = node.money.forgone.amount ?? 0;
    switch (sort) {
        case "energy":
            return node.kwh;
        case "paid":
            return paid;
        case "forgone":
            return forgone;
        case "paid_forgone":
            return paid + forgone;
    }
}

/** A row's money stack: a negative amount draws as nothing. */
function moneyExtent(node: RankingNode): number {
    return Math.max(0, node.money.paid.amount ?? 0) + Math.max(0, node.money.forgone.amount ?? 0);
}

function buildModel(payload: RankingReportPayload, sort: SortMode): RankingModel | null {
    const house = payload.nodes[0];
    if (!house) return null;
    const byId = new Map(payload.nodes.map((node) => [node.id, node]));
    const ordered = new Map<string, RankingNode[]>();
    for (const node of payload.nodes) {
        const children = node.children
            .map((id) => byId.get(id))
            .filter((child): child is RankingNode => child !== undefined);
        const measured = children.filter((child) => !child.unmeasured);
        measured.sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
        ordered.set(node.id, [...measured, ...children.filter((child) => child.unmeasured)]);
    }
    const top = ordered.get(house.id) ?? [];
    return {
        byId,
        ordered,
        house,
        energyScale: Math.max(0, ...top.map((node) => node.kwh)),
        moneyScale: Math.max(0, ...top.map(moneyExtent)),
    };
}

function isPartial(side: DeviceReportMoneySide, kwh: number): boolean {
    return kwh > 0 && side.unpriced_kwh > MARK_SHARE * kwh;
}

function percent(part: number, whole: number): string {
    return whole > 0 ? String(Math.round((part / whole) * 100)) : "0";
}

/** Coverage short of what still rounds to 100 % -- "data for 100 %" would contradict itself. */
export function partlyCovered(coverage: number): boolean {
    return Math.round(coverage * 100) < 100;
}

/** "data for X % of the period (from date)", as a tooltip line. */
export function coverageRow(t: (key: string) => string, coverage: number, firstHour: string | null): TooltipRow {
    return tooltipRow("", fillTemplate(t("device_reports.ranking.coverage"), {
        pct: String(Math.round(coverage * 100)),
        date: firstHour ? firstHour.slice(0, 10) : "—",
    }));
}

function widthStyle(fraction: number): string {
    return "width:" + Math.max(0, Math.min(1, fraction)) * 100 + "%;";
}

interface MoneySegment {
    side: "paid" | "forgone";
    partial: boolean;
    style: string;
}

/**
 * The Ranking report: every device of the house, ranked, its kWh split by
 * source and its two money figures. A row is one line: its name, its figures and its bars;
 * everything else -- the split, the pricing detail, coverage, over-allocation
 * -- is in the row's hover tooltip.
 *
 * Show and sort are local: they reshape the payload already here and change no
 * fetch. The model is built in `willUpdate` behind the two inputs it reads.
 */
@customElement("helman-device-report-ranking")
export class HelmanDeviceReportRanking extends LitElement {
    @property({ attribute: false }) public payload?: RankingReportPayload;
    @property({ attribute: false }) public query?: DeviceReportQuery;
    @property({ attribute: false }) public localize?: LocalizeFunction;

    @state() private _show: ShowMode = "both";
    @state() private _sort: SortMode = "energy";
    @state() private _expanded: ReadonlySet<string> = new Set();

    private _tooltip = new HoverTooltipController(this);
    /** Each row's tooltip, built on its first hover and kept until the next render. */
    private _tooltips = new Map<string, TooltipBody>();

    private _model: RankingModel | null = null;
    private _modelKey: { payload: RankingReportPayload | undefined; sort: SortMode } | null = null;

    static styles = [
        hoverTooltipStyles,
        css`
            :host { display: block; }
            .controls {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                align-items: center;
                font-size: 0.8rem;
                margin-bottom: 8px;
            }
            .controls button {
                font: inherit;
                padding: 2px 8px;
                border-radius: 10px;
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
            .controls select {
                font: inherit;
                padding: 2px 6px;
                border-radius: 10px;
                border: 1px solid var(--divider-color, #ccc);
                background: transparent;
                color: var(--primary-text-color);
                cursor: pointer;
            }
            .controls select option {
                background: var(--card-background-color, #fff);
                color: var(--primary-text-color);
            }
            /*
             * One line per row: name, kWh, share, paid, forgone, gauges. The rows
             * share the list's columns (subgrid), so each kind of figure lines up
             * in its own column and every gauge starts and ends at the same x,
             * keeping the bars comparable down the list.
             */
            .list {
                display: grid;
                grid-template-columns: minmax(90px, max-content) auto auto minmax(40px, 1fr);
                column-gap: 8px;
            }
            .list.with-money {
                grid-template-columns: minmax(90px, max-content) auto auto auto auto minmax(40px, 1fr);
            }
            .row {
                grid-column: 1 / -1;
                display: grid;
                grid-template-columns: subgrid;
                align-items: center;
                cursor: pointer;
                padding: 4px 0;
                border-bottom: 1px solid color-mix(in srgb, var(--divider-color, #ccc) 50%, transparent);
            }
            .row.house { font-weight: 600; }
            .name {
                display: flex;
                align-items: center;
                gap: 4px;
                min-width: 0;
                font-size: 0.85rem;
            }
            .gauges {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .toggle {
                width: 18px;
                flex: none;
                border: none;
                background: transparent;
                color: var(--secondary-text-color);
                cursor: pointer;
                padding: 0;
                font: inherit;
            }
            .label {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .num {
                text-align: right;
                white-space: nowrap;
                font-size: 0.75rem;
                color: var(--secondary-text-color);
            }
            .money-figure.paid { color: ${unsafeCSS(MONEY_COLORS.paid)}; }
            .money-figure.forgone { color: ${unsafeCSS(MONEY_COLORS.forgone)}; }
            .money-figure.negative { color: ${unsafeCSS(PRICE_NEGATIVE_COLOR)}; }
            .track {
                position: relative;
                height: 6px;
                border-radius: 3px;
                background: color-mix(in srgb, var(--divider-color, #ccc) 35%, transparent);
                overflow: hidden;
            }
            .energy-fill {
                display: flex;
                height: 100%;
            }
            /* Measured quantities, filled like the inspector's actual bands. */
            .seg, .money-seg { opacity: ${ACTUAL_FILL_OPACITY}; }
            .seg { height: 100%; }
            .seg.solar { background-color: ${unsafeCSS(SOURCE_COLORS.solar)}; }
            .seg.battery { background-color: ${unsafeCSS(SOURCE_COLORS.battery)}; }
            .seg.grid { background-color: ${unsafeCSS(SOURCE_COLORS.grid)}; }
            .seg.unattributed { background-color: ${unsafeCSS(SOURCE_COLORS.unattributed)}; }
            .money .money-seg {
                position: absolute;
                top: 0;
                bottom: 0;
            }
            .money-seg.paid { background-color: ${unsafeCSS(MONEY_COLORS.paid)}; }
            .money-seg.forgone { background-color: ${unsafeCSS(MONEY_COLORS.forgone)}; }
            .money-seg.partial {
                background-image: repeating-linear-gradient(
                    135deg,
                    transparent 0 2px,
                    color-mix(in srgb, var(--card-background-color, #fff) 70%, transparent) 2px 4px
                );
            }
            .empty {
                font-size: 0.8rem;
                color: var(--secondary-text-color);
            }
        `,
    ];

    protected willUpdate(changed: PropertyValues<this>): void {
        // A refresh reuses the hovered node: its popup would keep the old figures.
        if (changed.has("payload")) this._tooltip.hide();
        this._tooltips.clear();
        const key = this._modelKey;
        if (key === null || key.payload !== this.payload || key.sort !== this._sort) {
            this._modelKey = { payload: this.payload, sort: this._sort };
            this._model = this.payload ? buildModel(this.payload, this._sort) : null;
        }
    }

    private _t(key: string): string {
        return this.localize ? this.localize(key) : key;
    }

    private _label(node: RankingNode, house: RankingNode): string {
        if (node.unmeasured) return this._t("house_section.unmeasured");
        if (node.id === house.id) return this._t("device_reports.ranking.house");
        return node.label || node.id;
    }

    private _money(amount: number | null): string {
        // The payload's currency is the price unit (CZK/kWh); an amount is in CZK.
        const currency = currencyFromPriceUnit(this.payload?.currency);
        return amount === null ? "—" : formatPriceValue(amount, currency || null);
    }

    private _pricedTitle(side: DeviceReportMoneySide, kwh: number): string {
        let title = fillTemplate(this._t("device_reports.ranking.priced"), {
            priced: formatKwhValue(side.priced_kwh),
            total: formatKwhValue(kwh),
        });
        if ((side.tariff_kwh ?? 0) > 0) {
            title += "; " + fillTemplate(this._t("device_reports.ranking.tariff"), {
                kwh: formatKwhValue(side.tariff_kwh ?? 0),
            });
        }
        return title;
    }

    private _moneyRows(node: RankingNode, side: "paid" | "forgone"): TooltipRow[] {
        const figure = node.money[side];
        const amount = figure.amount;
        let value = this._money(amount);
        if (isPartial(figure, node.kwh)) value += " (" + this._t("device_reports.ranking.partial") + ")";
        return [
            tooltipRow(
                this._t("device_reports.ranking." + side),
                value,
                amount !== null && amount < 0 ? PRICE_NEGATIVE_COLOR : MONEY_COLORS[side],
            ),
            tooltipRow("", this._pricedTitle(figure, node.kwh)),
        ];
    }

    private _tooltipContent(node: RankingNode, model: RankingModel): TooltipBody {
        let body = this._tooltips.get(node.id);
        if (body === undefined) {
            body = this._buildTooltip(node, model);
            this._tooltips.set(node.id, body);
        }
        return body;
    }

    private _buildTooltip(node: RankingNode, model: RankingModel): TooltipBody {
        let total = formatKwhValue(node.kwh) + " kWh";
        if (node.id !== model.house.id) {
            total += " · " + fillTemplate(this._t("device_reports.ranking.of_house"), {
                pct: percent(node.kwh, model.house.kwh),
            });
        }
        const rows = [
            tooltipRow(this._t("device_reports.over_time.total"), total),
            ...SOURCES.map((source) => tooltipRow(
                this._t("device_reports.ranking.sources." + source),
                formatKwhValue(node.sources[source]) + " kWh ("
                    + percent(node.sources[source], node.kwh) + " %)",
                SOURCE_COLORS[source],
            )),
            ...this._moneyRows(node, "paid"),
            ...this._moneyRows(node, "forgone"),
        ];
        if (partlyCovered(node.coverage)) rows.push(coverageRow(this._t.bind(this), node.coverage, node.first_hour));
        if (node.overallocated_kwh > MARK_SHARE * node.kwh && node.overallocated_kwh > 0) {
            rows.push(tooltipRow("", fillTemplate(this._t("device_reports.ranking.overallocated"), {
                kwh: formatKwhValue(node.overallocated_kwh),
            })));
        }
        return { title: this._label(node, model.house), hasActual: false, rows };
    }

    /** Paid then forgone, stacked from zero; a negative amount draws as nothing. */
    private _moneySegments(node: RankingNode, scale: number): MoneySegment[] {
        let left = 0;
        return (["paid", "forgone"] as const).map((side) => {
            const figure = node.money[side];
            const fraction = scale > 0 ? Math.max(0, figure.amount ?? 0) / scale : 0;
            const style = "left:" + left * 100 + "%;" + widthStyle(fraction);
            left += fraction;
            return { side, partial: isPartial(figure, node.kwh), style };
        });
    }

    private _renderEnergy(node: RankingNode, scale: number) {
        return html`
            <div class="track energy">
                <div class="energy-fill" style=${widthStyle(scale > 0 ? node.kwh / scale : 0)}>
                    ${SOURCES.map((source) => node.sources[source] > 0 ? html`
                        <div
                            class=${"seg " + source}
                            style=${widthStyle(node.kwh > 0 ? node.sources[source] / node.kwh : 0)}
                        ></div>
                    ` : nothing)}
                </div>
            </div>
        `;
    }

    private _renderMoney(node: RankingNode, scale: number) {
        return html`
            <div class="track money">
                ${this._moneySegments(node, scale).map((segment) => html`
                    <span
                        class=${"money-seg " + segment.side + (segment.partial ? " partial" : "")}
                        style=${segment.style}
                    ></span>
                `)}
            </div>
        `;
    }

    /** A head-line money figure, coloured like its bar -- or as a negative price when below zero. */
    private _renderMoneyFigure(node: RankingNode, side: "paid" | "forgone") {
        const amount = node.money[side].amount;
        const negative = amount !== null && amount < 0;
        return html`<span class=${"num money-figure " + (negative ? "negative" : side)}>${this._money(amount)}</span>`;
    }

    private _toggleExpanded(id: string, event: Event): void {
        event.stopPropagation();
        const next = new Set(this._expanded);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this._expanded = next;
    }

    private _renderRow(node: RankingNode, model: RankingModel, isHouse: boolean): unknown {
        const children = model.ordered.get(node.id) ?? [];
        const expandable = !isHouse && children.length > 0;
        const expanded = this._expanded.has(node.id);
        const energyScale = isHouse ? node.kwh : model.energyScale;
        const moneyScale = isHouse ? moneyExtent(node) : model.moneyScale;
        const houseKwh = model.house.kwh;
        const indent = "padding-left:" + Math.max(0, node.depth - 1) * 14 + "px;";
        return html`
            <div
                class=${"row" + (isHouse ? " house" : "")}
                data-id=${node.id}
                @mousemove=${(event: MouseEvent) => this._tooltip.show(event, this._tooltipContent(node, model))}
                @mouseleave=${() => this._tooltip.hide()}
                @click=${(event: MouseEvent) => this._tooltip.toggle(event, this._tooltipContent(node, model))}
            >
                <div class="name" style=${indent}>
                    ${expandable ? html`
                        <button
                            type="button"
                            class="toggle"
                            aria-expanded=${expanded ? "true" : "false"}
                            @click=${(event: Event) => this._toggleExpanded(node.id, event)}
                        >${expanded ? "▾" : "▸"}</button>
                    ` : html`<span class="toggle"></span>`}
                    <span class="label">${node.estimated ? html`<span class="estimated">≈ </span>` : nothing}${this._label(node, model.house)}</span>
                </div>
                <span class="num kwh">${formatKwhValue(node.kwh)} kWh</span>
                <span class="num share">${isHouse ? nothing : percent(node.kwh, houseKwh) + " %"}</span>
                ${this._show !== "energy" ? html`
                    ${this._renderMoneyFigure(node, "paid")}
                    ${this._renderMoneyFigure(node, "forgone")}
                ` : nothing}
                <div class="gauges">
                    ${this._show !== "money" ? this._renderEnergy(node, energyScale) : nothing}
                    ${this._show !== "energy" ? this._renderMoney(node, moneyScale) : nothing}
                </div>
            </div>
            ${expandable && expanded ? children.map((child) => this._renderRow(child, model, false)) : nothing}
        `;
    }

    render() {
        const model = this._model;
        if (!model) {
            return html`<div class="empty">${this._t("device_reports.ranking.empty")}</div>`;
        }
        const top = model.ordered.get(model.house.id) ?? [];
        return html`
            <div class="controls">
                <span class="show-control">
                    ${this._t("device_reports.ranking.show")}
                    ${SHOW_MODES.map((mode) => html`
                        <button
                            type="button"
                            data-show=${mode}
                            class=${mode === this._show ? "selected" : ""}
                            @click=${() => { this._show = mode; }}
                        >${this._t("device_reports.ranking.show_options." + mode)}</button>
                    `)}
                </span>
                <label>
                    ${this._t("device_reports.ranking.sort")}
                    <select
                        class="sort"
                        @change=${(event: Event) => { this._sort = (event.target as HTMLSelectElement).value as SortMode; }}
                    >
                        ${SORT_MODES.map((mode) => html`
                            <option value=${mode} ?selected=${mode === this._sort}>${this._t("device_reports.ranking.sort_options." + mode)}</option>
                        `)}
                    </select>
                </label>
            </div>
            <div class=${"list" + (this._show !== "energy" ? " with-money" : "")}>
                ${this._renderRow(model.house, model, true)}
                ${top.map((node) => this._renderRow(node, model, false))}
            </div>
            ${this._tooltip.render()}
        `;
    }
}
