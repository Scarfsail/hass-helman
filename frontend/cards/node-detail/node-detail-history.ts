import { html, nothing, type TemplateResult } from "lit";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { formatKwh } from "../shared/format";
import { SectionResource, type SectionHost } from "./section-resource";
import { renderSummarySection } from "./detail-section";
import { subTitle } from "./node-detail-readings";

export { subTitle };

/**
 * What every node's History & statistics and Technical details sections
 * share: the sections around their bodies, the "today by source" share bar,
 * a statistics tile, a section's loading or failed state, HA's own
 * history graph for "the last 24 hours", and the "Show more" link from a
 * chart to HA's history page.
 */

const DAY_MS = 86_400_000;

/** A "Show more" link asks the detail's dialog to open HA's history page at `detail.href`. */
export const SHOW_HISTORY_EVENT = "helman-show-history";

/** HA's history page with `entityIds` and the last 24 hours preselected, as HA's more-info links it. */
export function historyHref(entityIds: readonly string[], now = Date.now()): string {
    const query = new URLSearchParams({ entity_id: entityIds.join(","), start_date: new Date(now - DAY_MS).toISOString() });
    return `/history?${query}`;
}

/** A "Show more" link to HA's history of `entityIds` over the last 24 hours; none without an entity. */
export function renderShowMore(entityIds: readonly string[], localize: LocalizeFunction): TemplateResult | typeof nothing {
    if (!entityIds.length) return nothing;
    return html`<button class="link-button" data-show-more @click=${(event: Event) => event.currentTarget!.dispatchEvent(
        new CustomEvent(SHOW_HISTORY_EVENT, { detail: { href: historyHref(entityIds) }, bubbles: true, composed: true }))}>${localize("node_detail.shared.history.show_more")}</button>`;
}

/** The History & statistics section; its body is rendered only while it is open. */
export function renderHistorySection(
    localize: LocalizeFunction,
    summary: TemplateResult | string,
    open: boolean,
    toggle: (open: boolean) => void,
    body: () => TemplateResult,
): TemplateResult {
    return renderSummarySection("history", "mdi:history", localize("node_detail.shared.history.title"), summary, open, toggle, body);
}

/**
 * A History header from a section's figures: `ready` once there are some, else
 * the section's loading or failure, and "No figures yet" only once it landed empty.
 */
export function historySummary(section: SectionResource<unknown>, localize: LocalizeFunction, ready: TemplateResult | string | null): TemplateResult | string {
    if (ready !== null) return ready;
    const status = section.state?.status;
    return localize(`node_detail.shared.history.${status === "loading" ? "loading" : status === "error" ? "failed_short" : "no_figures"}`);
}

/**
 * The admin-only Technical details section, without a summary: not rendered
 * at all for anyone but an admin, its body only while it is open.
 */
export function renderTechnicalSection(
    hass: HomeAssistant,
    localize: LocalizeFunction,
    open: boolean,
    toggle: (open: boolean) => void,
    body: () => TemplateResult,
): TemplateResult | typeof nothing {
    const admin = hass.user?.is_admin === true;
    if (!admin) return nothing;
    return html`
        <helman-detail-section data-technical admin-only .isAdmin=${admin} icon="mdi:wrench-outline" .title=${localize("node_detail.shared.technical.title")}
            .expanded=${open} @expanded-changed=${(event: CustomEvent<boolean>) => toggle(event.detail)}>
            ${open ? html`<div class="content" data-technical-body>${body()}</div>` : nothing}
        </helman-detail-section>
    `;
}

/** A labelled value row; `indent` for a part of the row above it. */
export function historyRow(label: unknown, value: unknown, key?: string, indent = false): TemplateResult {
    return html`<div class="row ${indent ? "indent" : ""}" data-row=${key ?? nothing}><span class="label">${label}</span><span class="value">${value}</span></div>`;
}

/** One statistics tile: its figure and what it is. */
export function statTile(value: string, caption: unknown, key?: string): TemplateResult {
    return html`<div class="tile stat" data-stat=${key ?? nothing}><span class="stat-value">${value}</span><span class="stat-caption">${caption}</span></div>`;
}

/** A node's energy, or `unknown` for energy no source explains, drawn muted. */
export type ShareNode = "solar" | "battery" | "grid" | "house" | "unknown";

/** Energy by node as one bar, each part in its node's colour, sized by its share; `unknownLabel` names the `unknown` part. */
export function renderShareBar(localize: LocalizeFunction, parts: ReadonlyArray<{ node: ShareNode; kwh: number }>, unknownLabel = ""): TemplateResult | typeof nothing {
    const shown = parts.filter((part) => part.kwh > 0);
    const total = shown.reduce((sum, part) => sum + part.kwh, 0);
    if (total <= 0) return nothing;
    const label = (node: ShareNode) => node === "unknown" ? unknownLabel : localize(`node_detail.title.${node}`);
    const color = (node: ShareNode) => node === "unknown" ? "var(--helman-neutral-light)" : `var(--helman-${node})`;
    return html`<div class="share-bar" data-share-bar role="img"
        aria-label=${shown.map((part) => `${label(part.node)} ${Math.round(part.kwh / total * 100)} %`).join(", ")}>
        ${shown.map((part) => html`<span data-share=${part.node} style=${`flex-grow: ${part.kwh / total * 100}; background: ${color(part.node)}`}></span>`)}
    </div>`;
}

/** "1.2 kWh". */
export function kwhText(kwh: number): string {
    return `${formatKwh(Math.abs(kwh))} kWh`;
}

/**
 * A section read only once its body is open: its loading note, or its
 * failure with a retry; `null` once it has landed. A failed read is retried
 * on its own at the section's staleness, never on every render.
 */
export function sectionNotReady(section: SectionResource<unknown>, localize: LocalizeFunction): TemplateResult | null {
    const state = section.state;
    if (state === null || state.status === "loading") return html`<p class="note" data-history-loading>${localize("node_detail.shared.history.loading")}</p>`;
    if (state.status === "error") {
        return html`
            <p class="note" data-history-failed>${localize("node_detail.shared.history.failed")}</p>
            <button class="link-button" @click=${() => section.load()}>${localize("node_detail.shared.forecast.retry")}</button>
        `;
    }
    return null;
}

export type HistoryGraphCard = HTMLElement & { hass?: HomeAssistant };

/** HA's own history graph of `entities` over the last 24 hours. */
export async function createHistoryGraph(hass: HomeAssistant, entities: string[]): Promise<HistoryGraphCard> {
    const helpers = await (window as unknown as { loadCardHelpers: () => Promise<{ createCardElement: (config: unknown) => HTMLElement }> }).loadCardHelpers();
    const chart = helpers.createCardElement({ type: "history-graph", hours_to_show: 24, entities }) as HistoryGraphCard;
    chart.hass = hass;
    return chart;
}

/** Whether HA's card helpers are there to build a history graph with. */
export function canCreateHistoryGraph(): boolean {
    return typeof (window as unknown as { loadCardHelpers?: unknown }).loadCardHelpers === "function";
}

/**
 * HA's history graph of `entities()` over the last 24 hours, built once
 * `open()` holds and kept as built while it stays open: it is no section of
 * the detail's, so a data change neither rebuilds nor re-reads it.
 */
export class HistoryGraphResource extends SectionResource<HistoryGraphCard> {
    constructor(host: SectionHost, private readonly _entities: () => string[], open: () => boolean) {
        super(host, "chart", {
            fetch: () => createHistoryGraph(host.hass, this._entities()),
            shown: () => open() && this.available(),
            staleness: () => false,
        });
    }

    /** Whether there is something to draw and HA's card helpers to draw it with. */
    available(): boolean {
        return this._entities().length > 0 && canCreateHistoryGraph();
    }

    /** Build or drop the graph as shown, and hand it HA's latest state. */
    follow(hass: HomeAssistant): void {
        this.sync();
        const chart = this.payload;
        if (chart && chart.hass !== hass) chart.hass = hass;
    }

    /** "Last 24 hours" and the graph with its Show more, or its loading or failure; none without one to draw. */
    render(localize: LocalizeFunction): TemplateResult | typeof nothing {
        if (!this.available()) return nothing;
        return html`${subTitle(localize("node_detail.shared.history.last_24h"))}${sectionNotReady(this, localize) ?? html`${this.payload}${renderShowMore(this._entities(), localize)}`}`;
    }
}
