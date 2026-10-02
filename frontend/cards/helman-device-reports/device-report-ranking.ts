import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
    DeviceReportMoneySide,
    DeviceReportQuery,
    RankingNode,
    RankingReportPayload,
} from "../helman-api";
import { helmanColorVars } from "../color-vars";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { formatKwhValue, formatPriceValue } from "../shared/forecast-value-format";

type ShowMode = "both" | "energy" | "money";
type SortMode = "energy" | "paid" | "forgone" | "paid_forgone";

const SHOW_MODES: readonly ShowMode[] = ["both", "energy", "money"];
const SORT_MODES: readonly SortMode[] = ["energy", "paid", "forgone", "paid_forgone"];
const SOURCES = ["solar", "battery", "grid", "unattributed"] as const;

/** Above this share of a row's kWh, a mark or a partial figure is worth showing. */
const MARK_SHARE = 0.01;
/** Below this coverage a row says how much of the period it has data for. */
const COVERAGE_MARK = 0.99;

interface RankingModel {
    byId: ReadonlyMap<string, RankingNode>;
    /** Each node's children, in display order: sorted, its remainder last. */
    ordered: ReadonlyMap<string, readonly RankingNode[]>;
    house: RankingNode;
    /** The largest top-level row's kWh: what the energy bars are relative to. */
    energyScale: number;
    /** The largest top-level money stack, either side: what the money bars are relative to. */
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

function moneyExtent(node: RankingNode): number {
    let positive = 0;
    let negative = 0;
    for (const side of [node.money.paid, node.money.forgone]) {
        const amount = side.amount ?? 0;
        if (amount >= 0) positive += amount;
        else negative -= amount;
    }
    return Math.max(positive, negative);
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

function widthStyle(fraction: number): string {
    return "width:" + Math.max(0, Math.min(1, fraction)) * 100 + "%;";
}

interface MoneySegment {
    side: "paid" | "forgone";
    amount: number;
    partial: boolean;
    style: string;
    title: string;
}

/**
 * The Ranking report: every device of the house, ranked, its kWh split by
 * source and its two money figures.
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
    /** The row whose exact split is open, from a tap. */
    @state() private _detail: string | null = null;

    private _model: RankingModel | null = null;
    private _modelKey: { payload: RankingReportPayload | undefined; sort: SortMode } | null = null;

    static styles = [
        helmanColorVars,
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
            .controls select { font: inherit; }
            .row {
                padding: 4px 0;
                border-bottom: 1px solid color-mix(in srgb, var(--divider-color, #ccc) 50%, transparent);
            }
            .row.house { font-weight: 600; }
            .head {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 0.85rem;
                cursor: pointer;
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
            .figures {
                flex: none;
                font-size: 0.75rem;
                color: var(--secondary-text-color);
                white-space: nowrap;
            }
            .marks {
                font-size: 0.7rem;
                color: var(--secondary-text-color);
                margin-left: 22px;
            }
            .track {
                position: relative;
                height: 6px;
                margin: 3px 0 0 22px;
                border-radius: 3px;
                background: color-mix(in srgb, var(--divider-color, #ccc) 35%, transparent);
                overflow: hidden;
            }
            .energy-fill {
                display: flex;
                height: 100%;
            }
            .seg { height: 100%; }
            .seg.solar { background: var(--helman-solar); }
            .seg.battery { background: var(--helman-battery); }
            .seg.grid { background: var(--helman-grid); }
            .seg.unattributed { background: var(--helman-neutral); }
            .money .center {
                position: absolute;
                left: 50%;
                top: 0;
                bottom: 0;
                width: 1px;
                background: var(--secondary-text-color);
                z-index: 1;
            }
            .money .money-seg {
                position: absolute;
                top: 0;
                bottom: 0;
            }
            .money-seg.paid { background: var(--helman-grid-import); }
            .money-seg.forgone { background: var(--helman-solar); }
            .money-seg.negative { background: var(--helman-price-negative); }
            .money-seg.forgone.negative {
                background: color-mix(in srgb, var(--helman-price-negative) 60%, transparent);
            }
            .money-seg.partial {
                background-image: repeating-linear-gradient(
                    135deg,
                    transparent 0 2px,
                    color-mix(in srgb, var(--card-background-color, #fff) 70%, transparent) 2px 4px
                );
            }
            .money-label {
                font-size: 0.72rem;
                color: var(--secondary-text-color);
                margin-left: 22px;
            }
            .partial-mark {
                color: var(--helman-neutral);
                font-style: italic;
            }
            .detail {
                margin: 4px 0 2px 22px;
                font-size: 0.75rem;
                color: var(--secondary-text-color);
                display: grid;
                grid-template-columns: auto auto auto;
                gap: 0 12px;
                justify-content: start;
            }
            .empty {
                font-size: 0.8rem;
                color: var(--secondary-text-color);
            }
        `,
    ];

    protected willUpdate(_changed: PropertyValues<this>): void {
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
        return amount === null ? "—" : formatPriceValue(amount, this.payload?.currency ?? null);
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

    private _splitTitle(node: RankingNode): string {
        const lines = SOURCES.map((source) =>
            this._t("device_reports.ranking.sources." + source) + ": "
            + formatKwhValue(node.sources[source]) + " kWh ("
            + percent(node.sources[source], node.kwh) + " %)");
        lines.push(this._t("device_reports.ranking.paid") + ": " + this._money(node.money.paid.amount));
        lines.push(this._t("device_reports.ranking.forgone") + ": " + this._money(node.money.forgone.amount));
        return lines.join("\n");
    }

    private _moneySegments(node: RankingNode, scale: number): MoneySegment[] {
        const segments: MoneySegment[] = [];
        let positive = 0;
        let negative = 0;
        for (const side of ["paid", "forgone"] as const) {
            const figure = node.money[side];
            const amount = figure.amount;
            if (amount === null || amount === 0 || scale <= 0) continue;
            const width = Math.min(50, (Math.abs(amount) / scale) * 50);
            const offset = amount > 0 ? positive : negative;
            const anchor = amount > 0 ? "left" : "right";
            segments.push({
                side,
                amount,
                partial: isPartial(figure, node.kwh),
                style: anchor + ":" + (50 + offset) + "%;width:" + width + "%;",
                title: this._t("device_reports.ranking." + side) + ": " + this._money(amount)
                    + " (" + this._pricedTitle(figure, node.kwh) + ")",
            });
            if (amount > 0) positive += width;
            else negative += width;
        }
        return segments;
    }

    private _renderMarks(node: RankingNode) {
        const marks: string[] = [];
        if (node.overallocated_kwh > MARK_SHARE * node.kwh && node.overallocated_kwh > 0) {
            marks.push(fillTemplate(this._t("device_reports.ranking.overallocated"), {
                kwh: formatKwhValue(node.overallocated_kwh),
            }));
        }
        if (node.coverage < COVERAGE_MARK) {
            marks.push(fillTemplate(this._t("device_reports.ranking.coverage"), {
                pct: String(Math.round(node.coverage * 100)),
                date: node.first_hour ? node.first_hour.slice(0, 10) : "—",
            }));
        }
        return marks.length > 0
            ? html`<div class="marks">${marks.map((mark) => html`<div class="mark">${mark}</div>`)}</div>`
            : nothing;
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
        const segments = this._moneySegments(node, scale);
        const label = (side: "paid" | "forgone") => {
            const figure = node.money[side];
            return html`
                <span class=${"money-figure " + side} title=${this._pricedTitle(figure, node.kwh)}>
                    ${this._t("device_reports.ranking." + side)} ${this._money(figure.amount)}
                    ${isPartial(figure, node.kwh)
                        ? html`<span class="partial-mark">${this._t("device_reports.ranking.partial")}</span>`
                        : nothing}
                </span>
            `;
        };
        return html`
            <div class="track money">
                <span class="center"></span>
                ${segments.map((segment) => html`
                    <span
                        class=${"money-seg " + segment.side
                            + (segment.amount < 0 ? " negative" : "")
                            + (segment.partial ? " partial" : "")}
                        style=${segment.style}
                        title=${segment.title}
                    ></span>
                `)}
            </div>
            <div class="money-label">${label("paid")} · ${label("forgone")}</div>
        `;
    }

    private _renderDetail(node: RankingNode) {
        return html`
            <div class="detail">
                ${SOURCES.map((source) => html`
                    <span>${this._t("device_reports.ranking.sources." + source)}</span>
                    <span>${formatKwhValue(node.sources[source])} kWh</span>
                    <span>${percent(node.sources[source], node.kwh)} %</span>
                `)}
                <span>${this._t("device_reports.ranking.paid")}</span>
                <span>${this._money(node.money.paid.amount)}</span>
                <span>${this._pricedTitle(node.money.paid, node.kwh)}</span>
                <span>${this._t("device_reports.ranking.forgone")}</span>
                <span>${this._money(node.money.forgone.amount)}</span>
                <span>${this._pricedTitle(node.money.forgone, node.kwh)}</span>
            </div>
        `;
    }

    private _toggleExpanded(id: string, event: Event): void {
        event.stopPropagation();
        const next = new Set(this._expanded);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this._expanded = next;
    }

    private _toggleDetail(id: string): void {
        this._detail = this._detail === id ? null : id;
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
            <div class=${"row" + (isHouse ? " house" : "")} data-id=${node.id} style=${indent}>
                <div class="head" title=${this._splitTitle(node)} @click=${() => this._toggleDetail(node.id)}>
                    ${expandable ? html`
                        <button
                            type="button"
                            class="toggle"
                            aria-expanded=${expanded ? "true" : "false"}
                            @click=${(event: Event) => this._toggleExpanded(node.id, event)}
                        >${expanded ? "▾" : "▸"}</button>
                    ` : html`<span class="toggle"></span>`}
                    <span class="label">${node.estimated ? html`<span class="estimated">≈ </span>` : nothing}${this._label(node, model.house)}</span>
                    <span class="figures">
                        ${formatKwhValue(node.kwh)} kWh${isHouse ? nothing : html` · ${fillTemplate(this._t("device_reports.ranking.of_house"), { pct: percent(node.kwh, houseKwh) })}`}
                    </span>
                </div>
                ${this._renderMarks(node)}
                ${this._show !== "money" ? this._renderEnergy(node, energyScale) : nothing}
                ${this._show !== "energy" ? this._renderMoney(node, moneyScale) : nothing}
                ${this._detail === node.id ? this._renderDetail(node) : nothing}
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
            ${this._renderRow(model.house, model, true)}
            ${top.map((node) => this._renderRow(node, model, false))}
        `;
    }
}
