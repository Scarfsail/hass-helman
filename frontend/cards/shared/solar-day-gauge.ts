import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { TodayGaugeDTO } from "../helman-api";
import { helmanColorVars } from "../color-vars";
import type { LocalizeFunction } from "../localize/localize";
import { hassLocale, timeZone } from "../node-detail/section-resource";
import "../node-detail/help-tip";
import { HoverTooltipController, hoverTooltipStyles, tooltipRow, type TooltipBody } from "./hover-tooltip";
import { formatScheduleTime } from "./schedule/model/schedule-time";

const KEY = "node_detail.shared.solar_day_gauge";

const kwh = (wh: number): string => (wh / 1000).toFixed(1);

/** The least share of the bar width each part, before now and after now, takes. */
const MIN_PART_SHARE = 0.25;

/** A share against the corrected forecast, signed: "−59 %", "+25 %". */
function signedPct(value: number, against: number): string {
    const pct = Math.round((value / against - 1) * 100);
    return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)} %`;
}

/**
 * Today's solar day gauge: the raw forecast against Helman's corrected one and
 * reality, and how far to trust the rest of today.
 *
 * A grey lane on top is the raw forecast, darker before now and lighter after.
 * The bar below is what was produced so far, then Helman's final rest of today
 * (hatched) with the likely range as a box. A step at now links raw so far to
 * corrected so far, a solar-coloured one at the end raw rest to Helman's rest.
 * Before now and after now each take at least a quarter of the bar and are to
 * scale within their own share, so a sliver of either part still has room.
 * Every number is the backend's (`todayGauge`), so the node detail and the
 * inspector draw the same day; every percentage is against the corrected
 * forecast. The time shows only on hover, with the step values.
 */
@customElement("helman-solar-day-gauge")
export class HelmanSolarDayGauge extends LitElement {
    static styles = [helmanColorVars, hoverTooltipStyles, css`
        /* Direction tones: the theme's warning and success colours, as the node details use them. */
        :host { display: block; min-width: 0; --gauge-lower: var(--warning-color, #ffa600); --gauge-higher: var(--success-color, #43a047); }
        .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        .chip { display: inline-block; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--divider-color);
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.04)); font-weight: 700; font-size: 0.92rem; }
        .chip .muted { color: var(--secondary-text-color); font-weight: 600; font-size: 0.85em; }
        .gauge { position: relative; font-size: 0.68rem; line-height: 1.2; cursor: default; }
        .above, .below { position: relative; height: 1.3em; white-space: nowrap; }
        .above { color: var(--secondary-text-color); }
        .above > span, .below > span { position: absolute; top: 0; }
        .raw-tag { font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
        .track { position: relative; height: 36px; }
        .lane, .bar { position: absolute; left: 0; right: 0; }
        .lane { top: 0; height: 8px; }
        .bar { top: 14px; height: 18px; border-radius: 3px; background: var(--secondary-background-color, rgba(0, 0, 0, 0.06)); }
        .fill { position: absolute; top: 0; bottom: 0; }
        .lane .fill.so-far { background: var(--helman-forecast-raw); }
        .lane .fill.rest { background: color-mix(in srgb, var(--helman-forecast-raw) 50%, transparent); }
        .bar .fill.produced { background: var(--helman-solar); }
        .bar .fill.over { background: var(--gauge-higher); }
        .bar .fill.rest { background: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--helman-solar) 55%, transparent) 0px,
            color-mix(in srgb, var(--helman-solar) 55%, transparent) 3px, transparent 3px, transparent 7px); }
        .bar .short { position: absolute; top: calc(100% + 1px); height: 2px; background: var(--gauge-lower); }
        .bar .range { position: absolute; top: 1px; bottom: 1px; box-sizing: border-box; border: 1.5px solid var(--secondary-text-color); border-radius: 3px; }
        .bar .range.lower { border-color: var(--gauge-lower); }
        .bar .range.higher { border-color: var(--gauge-higher); }
        /* Spans from now to the end of the rest, right-aligned; a label wider than
           that starts at now and runs right, never over the day so far. */
        .bar .final { position: absolute; top: 50%; transform: translateY(-50%); box-sizing: border-box; padding-right: 3px;
            text-align: right; font-weight: 700; color: var(--primary-text-color); white-space: nowrap; }
        svg.steps { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
        svg.steps polyline { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
        .step-now { stroke: var(--primary-text-color); }
        .step-end { stroke: var(--helman-solar); }
        .below { font-weight: 700; }
        .below .muted { color: var(--secondary-text-color); font-weight: 400; }
        .lower { color: var(--gauge-lower); }
        .higher { color: var(--gauge-higher); }
        .chip helman-help-tip.lower { --help-tip-tone: var(--gauge-lower); }
        .chip helman-help-tip.higher { --help-tip-tone: var(--gauge-higher); }
        .chip helman-help-tip.none { --help-tip-tone: var(--info-color, var(--primary-color)); }
    `];

    @property({ attribute: false }) public gauge!: TodayGaugeDTO;
    @property({ attribute: false }) public hass?: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;

    private readonly _tooltip = new HoverTooltipController(this);

    private _t(key: string, values?: Record<string, string | number>): string {
        return this.localize(`${KEY}.${key}`, values);
    }

    protected render() {
        const g = this.gauge;
        const measured = g.trust !== null && g.actualSoFarWh !== null && g.correctedSoFarWh !== null && g.rawSoFarWh !== null;
        const actual = g.actualSoFarWh ?? 0;
        const corrected = g.correctedSoFarWh ?? 0;
        const rawSoFar = g.rawSoFarWh ?? 0;
        // Each part is to scale within its own share: before now up to the largest
        // so-far sum, after now up to the largest rest, so the range box fits too.
        const beforeScale = Math.max(rawSoFar, corrected, actual);
        const afterScale = Math.max(g.rawRestWh, g.finalRestWh, g.likelyHighWh ?? 0);
        const split = !measured ? 0 : Math.min(1 - MIN_PART_SHARE, Math.max(MIN_PART_SHARE,
            beforeScale / ((beforeScale + afterScale) || 1)));
        const clamp = (pct: number) => Math.min(100, Math.max(0, pct));
        /** A position before now, from the start of the day. */
        const x = (wh: number) => clamp(wh / (beforeScale || 1) * split * 100);
        /** A position after now: `wh` of rest past the now boundary, the same for every lane. */
        const xa = (wh: number) => clamp((split + wh / (afterScale || 1) * (1 - split)) * 100);
        const at = (from: number, to: number) => `left: ${from}%; width: ${Math.max(0, to - from)}%;`;
        const span = (from: number, to: number) => at(x(from), x(to));
        const rawEndX = xa(g.rawRestWh);
        const finalEndX = xa(g.finalRestWh);
        const dir = g.direction ?? "";
        const directionMark = g.direction === "lower" ? "↓" : g.direction === "higher" ? "↑" : "?";
        // A track 36 px tall: the lane is 0–8, the bar 14–32, the steps cross at 11.
        const step = (top: number, bottom: number) => `${top},0 ${top},11 ${bottom},11 ${bottom},32`;
        return html`
            <div class="head">
                <span class="chip" data-chip>${measured
                    ? html`${this._t("remaining", { kwh: `${kwh(g.likelyLowWh!)}–${kwh(g.likelyHighWh!)}` })} · ${this._t("trust", { pct: Math.round(g.trust! * 100) })}<helman-help-tip
                        class=${dir || "none"} data-direction=${dir || "none"} .mark=${directionMark}
                        .explanation=${this._t(`direction_${dir || "none"}`, {
                            low: kwh(g.likelyLowWh!), high: kwh(g.likelyHighWh!), final: kwh(g.finalRestWh) })}></helman-help-tip>`
                    : html`${this._t("remaining", { kwh: kwh(g.finalRestWh) })} <span class="muted">· ${this._t("trust_pending")}</span>`}</span>
                <helman-help-tip data-legend .explanation=${this._t("help")}></helman-help-tip>
            </div>
            <div class="gauge" data-gauge
                @mousemove=${(event: MouseEvent) => this._tooltip.show(event, this._tooltipBody())}
                @mouseleave=${() => this._tooltip.hide()}
                @click=${(event: MouseEvent) => this._tooltip.toggle(event, this._tooltipBody())}>
                <div class="above">
                    <span class="raw-tag" style="left: 0">${this._t("raw")}</span>
                    ${measured ? html`<span data-label="raw-so-far" style="left: ${x(rawSoFar)}%; transform: translateX(-50%)">${kwh(rawSoFar)}</span>` : nothing}
                    <span data-label="raw-rest" style="left: ${rawEndX}%; transform: translateX(-100%)">${kwh(g.rawRestWh)}</span>
                </div>
                <div class="track">
                    <div class="lane">
                        <span class="fill so-far" style=${span(0, rawSoFar)}></span>
                        <span class="fill rest" style=${at(x(rawSoFar), rawEndX)}></span>
                    </div>
                    <div class="bar">
                        <span class="fill produced" style=${span(0, Math.min(actual, corrected))}></span>
                        ${actual > corrected ? html`<span class="fill over" data-over style=${span(corrected, actual)}></span>` : nothing}
                        ${actual < corrected ? html`<span class="short" data-short style=${span(actual, corrected)}></span>` : nothing}
                        <span class="fill rest" style=${at(x(actual), finalEndX)}></span>
                        ${measured ? html`<span class="range ${dir}" data-range style=${at(xa(g.likelyLowWh!), xa(g.likelyHighWh!))}></span>` : nothing}
                        <span class="final" data-label="final-rest" style="left: ${split * 100}%; right: ${100 - finalEndX}%">${kwh(g.finalRestWh)}</span>
                    </div>
                    <svg class="steps" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
                        ${measured ? svg`<polyline class="step-now" points=${step(x(rawSoFar), x(corrected))}></polyline>` : nothing}
                        <polyline class="step-end" points=${step(rawEndX, finalEndX)}></polyline>
                    </svg>
                </div>
                ${measured ? html`<div class="below">
                    <span data-label="so-far" style="left: 0">${kwh(actual)} <span class="muted">${this._t("of", { kwh: kwh(corrected) })}</span>
                        <span class=${actual < corrected ? "lower" : actual > corrected ? "higher" : ""}>${signedPct(actual, corrected)}</span></span>
                    <span data-label="range" style="left: min(max(${xa(g.likelyLowWh!)}%, 10em), calc(100% - 9em))">${kwh(g.likelyLowWh!)}–${kwh(g.likelyHighWh!)}${g.finalRestWh > 0
                        ? html` <span class=${dir}>${signedPct(Math.sqrt(g.likelyLowWh! * g.likelyHighWh!), g.finalRestWh)}</span>` : nothing}</span>
                </div>` : nothing}
            </div>
            ${this._tooltip.render()}
        `;
    }

    /** The time of now and the values on both steps. */
    private _tooltipBody(): TooltipBody {
        const g = this.gauge;
        const hass = this.hass;
        const time = formatScheduleTime(g.at, hass ? hassLocale(hass) : "en", hass ? timeZone(hass) : "UTC");
        const value = (wh: number) => `${kwh(wh)} kWh`;
        const rows = [];
        if (g.rawSoFarWh !== null && g.correctedSoFarWh !== null && g.actualSoFarWh !== null) {
            rows.push(
                tooltipRow(this._t("raw_so_far"), value(g.rawSoFarWh)),
                tooltipRow(this._t("corrected_so_far"), value(g.correctedSoFarWh)),
                tooltipRow(this._t("produced"), value(g.actualSoFarWh), "var(--helman-solar)"),
            );
        }
        rows.push(
            tooltipRow(this._t("raw_rest"), value(g.rawRestWh)),
            tooltipRow(this._t("final_rest"), value(g.finalRestWh), "var(--helman-solar)"),
        );
        if (g.likelyLowWh !== null && g.likelyHighWh !== null) {
            rows.push(tooltipRow(this._t("likely"), `${kwh(g.likelyLowWh)}–${kwh(g.likelyHighWh)} kWh`));
        }
        return { title: this._t("at", { time }), hasActual: false, rows };
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-day-gauge": HelmanSolarDayGauge;
    }
}
