import { pad2 } from "./time/slot-time";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderNowMarker } from "./now-marker";
import { scheduleActionToneStyles, type ScheduleActionTone } from "./schedule/action-tones";
import { formatScheduleTime, getScheduleLocalDayStartMs, getScheduleLocalTimeParts } from "./schedule/model/schedule-time";

/** One stretch of a mode: what it is, when, and the scheduler tone it takes. */
export interface ModeSegment {
    start: number;
    end: number;
    tone: ScheduleActionTone;
    /** What it is, such as "Charging". */
    label: string;
    /** A candidate: planned, but only run once its condition is met. Drawn dashed and neutral. */
    candidate?: boolean;
}

const HOUR_MS = 3_600_000;

/**
 * The window a mode strip draws: midnight today to noon tomorrow, in Home
 * Assistant's time zone, exact on a daylight-saving day.
 */
export function modeStripWindow(now: number, timeZone: string): { start: number; end: number } {
    const start = getScheduleLocalDayStartMs(now, timeZone);
    let end = getScheduleLocalDayStartMs(start + 36 * HOUR_MS, timeZone) + 12 * HOUR_MS;
    // A clock change tomorrow morning moves noon by its hour.
    const parts = getScheduleLocalTimeParts(end, timeZone);
    if (parts) end -= ((parts.hour - 12) * 60 + parts.minute) * 60_000;
    return { start, end };
}

/**
 * A mode over a day and a half, `start` to `end`: what happened before `now`
 * (`history`, dimmed) and what is planned after it (`segments`), each in its
 * scheduler action tone, a candidate dashed and neutral, with a now marker,
 * the hour ticks in `timeZone` and a legend of what is drawn.
 *
 * With `rows`, the two are drawn as two labelled rows, happened above
 * planned, instead of one strip split at now.
 *
 * Generic over what the segments are: an appliance's runs, the EV charger's
 * charging, the inverter's modes. A gap between segments is nothing known or
 * planned.
 */
@customElement("helman-mode-strip")
export class HelmanModeStrip extends LitElement {
    static styles = [scheduleActionToneStyles, css`
        :host {
            display: block;
        }
        .tracks {
            position: relative;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .row-label {
            font-size: 10px;
            line-height: 1.2;
            color: var(--secondary-text-color);
        }
        .track {
            position: relative;
            height: 26px;
            border-radius: 6px;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
            overflow: hidden;
        }
        .rows .track {
            height: 14px;
            border-radius: 3px;
        }
        .segment {
            position: absolute;
            top: 0;
            bottom: 0;
            box-sizing: border-box;
            border-radius: 3px;
            background: var(--schedule-action-tone-accent);
        }
        /* Normal and neutral are the resting modes: a muted grey, never the bright accent. */
        .segment.action-tone-normal,
        .segment.action-tone-neutral {
            background: color-mix(in srgb, var(--secondary-text-color) 60%, transparent);
        }
        .segment.candidate {
            background: none;
            border: 1.5px dashed var(--secondary-text-color);
        }
        .rows .segment {
            border-radius: 0;
        }
        /* What has happened is dimmed under the surface's colour. */
        .shade {
            position: absolute;
            top: 0;
            bottom: 0;
            left: 0;
            background: var(--card-background-color, var(--ha-card-background));
            opacity: 0.5;
        }
        .overlay {
            position: absolute;
            left: 0;
            top: -6px;
            width: 100%;
            height: calc(100% + 12px);
            overflow: visible;
            pointer-events: none;
        }
        .hours {
            position: relative;
            height: 14px;
            margin-top: 6px;
            font-size: 11px;
            color: var(--secondary-text-color);
        }
        .hours span {
            position: absolute;
            transform: translateX(-50%);
            white-space: nowrap;
        }
        .hours span.start {
            transform: none;
        }
        .hours span.end {
            transform: translateX(-100%);
        }
        .hours .now {
            color: var(--primary-text-color);
        }
        .legend {
            display: flex;
            flex-wrap: wrap;
            gap: 2px 12px;
            margin-top: 6px;
            font-size: 12px;
            color: var(--secondary-text-color);
        }
        .legend span {
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .swatch {
            box-sizing: border-box;
            width: 10px;
            height: 10px;
            border-radius: 2px;
            background: var(--schedule-action-tone-accent);
        }
        .swatch.action-tone-normal,
        .swatch.action-tone-neutral {
            background: color-mix(in srgb, var(--secondary-text-color) 60%, transparent);
        }
        .swatch.candidate {
            background: none;
            border: 1.5px dashed var(--secondary-text-color);
        }
        .sr {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip: rect(0 0 0 0);
            white-space: nowrap;
        }
    `];

    @property({ type: Number }) public start = 0;
    @property({ type: Number }) public end = 0;
    @property({ type: Number }) public now = 0;
    /** What is planned; drawn from now on. */
    @property({ attribute: false }) public segments: ModeSegment[] = [];
    /** What happened; drawn up to now. */
    @property({ attribute: false }) public history: ModeSegment[] = [];
    /** The two rows' labels, to draw what happened and what is planned apart. */
    @property({ attribute: false }) public rows: { happened: string; planned: string } | null = null;
    /** The now marker's tick label. */
    @property({ attribute: false }) public nowLabel = "now";
    @property({ attribute: false }) public timeZone = "UTC";
    @property({ attribute: false }) public locale = "en";

    render() {
        const span = Math.max(1, this.end - this.start);
        const pct = (at: number) => Math.max(0, Math.min(100, (at - this.start) / span * 100));
        const clip = (segments: ModeSegment[], from: number, to: number) => segments.flatMap((segment) => {
            const start = Math.max(segment.start, from);
            const end = Math.min(segment.end, to);
            return end > start ? [{ ...segment, start, end }] : [];
        });
        const happened = clip(this.history, this.start, Math.min(this.now, this.end));
        const planned = clip(this.segments, Math.max(this.now, this.start), this.end);
        const nowIn = this.now >= this.start && this.now <= this.end;
        const draw = (segments: ModeSegment[], past: boolean) => segments.map((segment) => html`
            <span class="segment action-tone-${segment.tone} ${segment.candidate ? "candidate" : ""}"
                data-segment data-tone=${segment.tone} data-planned=${past ? "false" : "true"}
                data-candidate=${segment.candidate ? "true" : "false"}
                data-start=${segment.start} data-end=${segment.end}
                style="left: ${pct(segment.start).toFixed(2)}%; width: ${(pct(segment.end) - pct(segment.start)).toFixed(2)}%"></span>
        `);
        const marker = nowIn ? html`
            <svg class="overlay" data-now viewBox="0 0 1000 10" preserveAspectRatio="none">${renderNowMarker(pct(this.now) * 10, 0, 10, this._time(this.now))}</svg>
        ` : nothing;
        return html`
            ${this.rows ? html`
                <div class="tracks rows" aria-hidden="true">
                    <span class="row-label">${this.rows.happened}</span>
                    <div class="track" data-row="happened">${draw(happened, true)}</div>
                    <span class="row-label">${this.rows.planned}</span>
                    <div class="track" data-row="planned">${draw(planned, false)}</div>
                    ${marker}
                </div>
            ` : html`
                <div class="tracks" aria-hidden="true">
                    <div class="track">
                        ${draw(happened, true)}
                        ${draw(planned, false)}
                        ${nowIn ? html`<span class="shade" style="width: ${pct(this.now).toFixed(2)}%"></span>` : nothing}
                    </div>
                    ${marker}
                </div>
            `}
            <div class="hours" aria-hidden="true">
                ${this._ticks().filter((tick) => !nowIn || Math.abs(pct(tick.at) - pct(this.now)) > 7).map((tick) => html`
                    <span class=${this._edge(pct(tick.at))} style="left: ${pct(tick.at).toFixed(2)}%">${pad2(tick.hour)}</span>
                `)}
                ${nowIn ? html`<span class="now ${this._edge(pct(this.now))}" style="left: ${pct(this.now).toFixed(2)}%">${this.nowLabel}</span>` : nothing}
            </div>
            ${this._renderLegend([...happened, ...planned])}
            <span class="sr">${[...happened, ...planned].map((segment) =>
                `${this._time(segment.start)}–${this._time(segment.end)} ${segment.label}. `)}</span>
        `;
    }

    /**
     * One entry per swatch drawn, in the order first drawn: modes that share
     * a tone share a swatch, so they share an entry, their labels joined.
     */
    private _renderLegend(segments: ModeSegment[]) {
        const entries = new Map<string, { segment: ModeSegment; labels: Set<string> }>();
        for (const segment of segments) {
            const key = segment.candidate ? "candidate" : segment.tone;
            const label = segment.label.charAt(0).toUpperCase() + segment.label.slice(1);
            const entry = entries.get(key);
            if (entry) entry.labels.add(label);
            else entries.set(key, { segment, labels: new Set([label]) });
        }
        if (entries.size === 0) return nothing;
        return html`
            <div class="legend" data-legend aria-hidden="true">
                ${[...entries.values()].map(({ segment, labels }) => html`
                    <span data-legend-entry><span class="swatch action-tone-${segment.tone} ${segment.candidate ? "candidate" : ""}"></span>${[...labels].join(" / ")}</span>
                `)}
            </div>
        `;
    }

    /** Every sixth wall-clock hour from midnight: whole hours from a local midnight land on them. */
    private _ticks(): Array<{ at: number; hour: number }> {
        const ticks: Array<{ at: number; hour: number }> = [];
        for (let at = this.start; at <= this.end; at += HOUR_MS) {
            const hour = getScheduleLocalTimeParts(at, this.timeZone)?.hour;
            if (hour !== undefined && hour % 6 === 0) ticks.push({ at, hour });
        }
        return ticks;
    }

    /** A label near an edge is aligned to it, so it never runs out of the strip. */
    private _edge(pct: number): string {
        return pct < 6 ? "start" : pct > 94 ? "end" : "";
    }

    private _time(ms: number): string {
        return formatScheduleTime(ms, this.locale, this.timeZone);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-mode-strip": HelmanModeStrip;
    }
}
