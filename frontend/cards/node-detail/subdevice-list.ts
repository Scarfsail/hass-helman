import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import type { TreeItem } from "../shared/data/tree-item";
import { formatPower } from "../shared/format";
import { readPowerW } from "../shared/power-reading";
import { helmanColorVars } from "../color-vars";
import { fireEvent } from "../shared/fire-event";
import { NODE_DETAIL_REQUEST_EVENT, type NodeDetailRequestDetail } from "./node-detail-types";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { powerEntity } from "./node-detail-utils";
import { resolveLocale } from "../shared/resolve-locale";

/** The subdevices listed by name while collapsed; the rest is "everything else". */
const TOP_SUBDEVICES = 3;

/** The node's direct children the list shows: every one but the backend's unmeasured remainder. */
const subdevices = (parent: TreeItem | null): TreeItem[] => parent?.children.filter((child) => !child.isUnmeasured) ?? [];

/** The entities the subdevice list reads: each listed child's power sensor, or those of its children it reads through. */
export const subdeviceEntities = (parent: TreeItem | null): string[] =>
    subdevices(parent).flatMap((child) => { const id = powerEntity(child); return id ? [id] : subdeviceEntities(child); });

/**
 * A subdevice's power now, at least 0: its power sensor, or without one (an
 * energy-only row) what its own subdevices read; `null` when nothing reads.
 */
const subdeviceW = (hass: HomeAssistant, item: TreeItem): number | null => {
    const id = powerEntity(item);
    if (id) {
        const watts = readPowerW(hass, id);
        return watts === null ? null : Math.max(0, watts);
    }
    const readings = subdevices(item).map((child) => subdeviceW(hass, child)).filter((watts): watts is number => watts !== null);
    return readings.length ? readings.reduce((sum, watts) => sum + watts, 0) : null;
};

/** One row: a subdevice, or the muted Everything else and Not measured. */
interface SubdeviceRow {
    label: string;
    /** W now, at least 0; `null` without a reading. */
    watts: number | null;
    item?: TreeItem;
}

/**
 * A node's subdevices: its direct children, idle ones too, by current power
 * and then by name, each with its share of the node's headline. Collapsed,
 * the three largest and everything else; expanded, every one and what no
 * meter explains. A row opens its subdevice's detail.
 */
@customElement("helman-subdevice-list")
export class HelmanSubdeviceList extends LitElement {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        :host { display: flex; flex-direction: column; gap: 14px; }
        .user-list { display: flex; flex-direction: column; gap: 2px; }
        .user-row {
            box-sizing: border-box;
            display: flex;
            align-items: center;
            gap: 12px;
            width: 100%;
            min-height: 32px;
            padding: 0 12px;
            border: 0;
            border-radius: 8px;
            color: var(--primary-text-color);
            font: inherit;
            font-size: 14px;
            text-align: start;
            background: linear-gradient(to right,
                color-mix(in srgb, var(--helman-house) 35%, var(--secondary-background-color)) var(--share),
                var(--secondary-background-color) var(--share));
        }
        button.user-row { cursor: pointer; }
        button.user-row:hover { filter: brightness(1.08); }
        button.user-row:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .user-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .user-row.muted .user-name { color: var(--secondary-text-color); }
        .user-amount { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .user-amount .percent { color: var(--secondary-text-color); }
        .user-chevron { flex: none; width: 16px; --mdc-icon-size: 16px; color: var(--secondary-text-color); }
        .show-less { align-self: flex-start; }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public parent: TreeItem | null = null;
    /** The node's headline power, W; `null` without a reading. */
    @property({ attribute: false }) public powerW: number | null = null;
    @state() private _all = false;

    /** Another node's list opens collapsed. */
    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("parent") && changed.get("parent")?.id !== this.parent?.id) this._all = false;
    }

    render() {
        if (!this.parent) return nothing;
        const title = html`<div class="section-title">${this.localize("node_detail.shared.subdevices")}</div>`;
        const locale = resolveLocale(this.hass);
        const rows = subdevices(this.parent).map((item): SubdeviceRow => ({ label: item.name, watts: subdeviceW(this.hass, item), item }))
            .sort((a, b) => (b.watts ?? 0) - (a.watts ?? 0) || a.label.localeCompare(b.label, locale));
        if (!rows.length) return html`${title}<p class="note" data-no-subdevices>${this.localize("node_detail.shared.no_subdevices")}</p>`;
        // A negative meter reading is no share of anything: the headline counts from 0.
        const power = this.powerW === null ? null : Math.max(0, this.powerW);
        const measuredW = rows.reduce((sum, row) => sum + (row.watts ?? 0), 0);
        // A headline lagging its meters is no smaller than their sum.
        const total = Math.max(power ?? 0, measuredW);
        // What no meter explains is the headline less the rows, from the same
        // states: the rows then add up to the node. The backend's remainder
        // sensor is a median over several seconds and never adds up to it.
        const hasUnmeasured = power !== null;
        const unmeasuredW = hasUnmeasured ? Math.max(0, power - measuredW) : 0;
        const notMeasured = this._row({ label: this.localize("node_detail.shared.not_measured"), watts: unmeasuredW }, total);
        // Three or fewer need no folding: all of them, and what no meter explains when there is some.
        if (rows.length <= TOP_SUBDEVICES) return html`
            ${title}
            <div class="user-list">
                ${rows.map((row) => this._row(row, total))}
                ${hasUnmeasured && unmeasuredW >= 1 ? notMeasured : nothing}
            </div>
        `;
        const otherW = rows.slice(TOP_SUBDEVICES).reduce((sum, row) => sum + (row.watts ?? 0), unmeasuredW);
        const otherCount = rows.length - TOP_SUBDEVICES + (hasUnmeasured ? 1 : 0);
        return html`
            ${title}
            <div class="user-list">
                ${(this._all ? rows : rows.slice(0, TOP_SUBDEVICES)).map((row) => this._row(row, total))}
                ${this._all && hasUnmeasured ? notMeasured : nothing}
                ${!this._all ? this._row({ label: fillTemplate(this.localize("node_detail.shared.everything_else"), { count: otherCount }), watts: otherW }, total, () => { this._all = true; }) : nothing}
            </div>
            ${this._all ? html`<button type="button" class="link-button show-less" @click=${() => { this._all = false; }}>${this.localize("node_detail.shared.show_less")}</button>` : nothing}
        `;
    }

    /** A subdevice opens its detail; Everything else expands the list; Not measured is neither. */
    private _row(row: SubdeviceRow, total: number, onExpand?: () => void) {
        const pct = total && row.watts ? Math.round(row.watts / total * 100) : 0;
        const amount = row.watts === null ? "—" : html`${formatPower(row.watts).display} <span class="percent">${pct} %</span>`;
        const inner = html`<span class="user-name">${row.label}</span><span class="user-amount">${amount}</span>${row.item || onExpand
            ? html`<ha-icon class="user-chevron" icon=${onExpand ? "mdi:chevron-down" : "mdi:chevron-right"}></ha-icon>` : html`<span class="user-chevron"></span>`}`;
        const style = `--share: ${Math.max(0, Math.min(100, pct))}%`;
        // Everything else and Not measured are no device: their names read muted.
        const rowClass = row.item ? "user-row" : "user-row muted";
        return row.item || onExpand ? html`<button type="button" class=${rowClass} style=${style}
            @click=${onExpand ?? (() => fireEvent<NodeDetailRequestDetail>(this, NODE_DETAIL_REQUEST_EVENT, { target: row.item! }))}>${inner}</button>`
            : html`<div class=${rowClass} style=${style}>${inner}</div>`;
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-subdevice-list": HelmanSubdeviceList;
    }
}
