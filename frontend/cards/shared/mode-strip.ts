import { pad2 } from "./time/slot-time";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderNowMarker } from "../helman-solar-inspector/now-marker";
import { scheduleActionToneStyles, type ScheduleActionTone } from "./schedule/action-tones";
import { formatScheduleTime, getScheduleLocalDayStartMs, getScheduleLocalTimeParts } from "./schedule/model/schedule-time";

/** One stretch of a mode: what it is, when, and the scheduler tone it takes. */
export interface ModeSegment {
    start: number;
    end: number;
    tone: ScheduleActionTone;
    /** What it is, such as "Charging". */
    label: string;
}

/** The next change the strip flags: when, in which tone, and what it says. */
export interface ModeChange {
    at: number;
    tone: ScheduleActionTone;
    /** As shown on the flag, such as "22:00 charging". */
    label: string;
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
 * A mode over a day and a half, `start` to `end`: each segment in its
 * scheduler action tone, solid where it has happened and hatched where it is
 * planned, split at `now`, with a now marker and the next change flagged in
 * its tone. Hour ticks are the wall clock in `timeZone`.
 *
 * Generic over what the segments are: the EV charger's charging, the
 * inverter's modes. A gap between segments is nothing known or planned. The
 * strip is a picture; a host that makes it a control wraps it in its own
 * button, and the strip's text (the flag, the ticks and a visually hidden
 * list of its segments) stays readable there.
 */
@customElement("helman-mode-strip")
export class HelmanModeStrip extends LitElement {
    static styles = [scheduleActionToneStyles, css`
        :host {
            display: block;
        }
        .flag-row {
            position: relative;
            height: 18px;
        }
        .flag {
            position: absolute;
            bottom: 2px;
            transform: translateX(-50%);
            white-space: nowrap;
            font-size: 0.75rem;
            font-weight: 600;
            line-height: 1.2;
            color: var(--schedule-action-tone-color);
        }
        .flag.start {
            transform: none;
        }
        .flag.end {
            transform: translateX(-100%);
        }
        .track {
            position: relative;
            height: 18px;
            border-radius: 4px;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
            overflow: hidden;
        }
        .segment {
            position: absolute;
            top: 0;
            bottom: 0;
            box-sizing: border-box;
            background: var(--schedule-action-tone-accent);
            /* The normal tone is near the track's own colour: its border keeps it apart. */
            box-shadow: inset 0 0 0 1px var(--schedule-action-tone-border);
        }
        .segment.planned {
            background: repeating-linear-gradient(
                135deg,
                var(--schedule-action-tone-accent) 0 3px,
                color-mix(in srgb, var(--schedule-action-tone-accent) 22%, transparent) 3px 7px
            );
        }
        .next-mark {
            position: absolute;
            top: 0;
            bottom: 0;
            width: 2px;
            margin-left: -1px;
            background: var(--schedule-action-tone-color);
        }
        .overlay {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            overflow: visible;
        }
        .hours {
            position: relative;
            height: 14px;
            margin-top: 2px;
            font-size: 0.7rem;
            color: var(--secondary-text-color);
        }
        .hours span {
            position: absolute;
            transform: translateX(-50%);
        }
        .hours span.start {
            transform: none;
        }
        .hours span.end {
            transform: translateX(-100%);
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
    @property({ attribute: false }) public segments: ModeSegment[] = [];
    @property({ attribute: false }) public next: ModeChange | null = null;
    @property({ attribute: false }) public timeZone = "UTC";
    @property({ attribute: false }) public locale = "en";

    render() {
        const span = Math.max(1, this.end - this.start);
        const pct = (at: number) => Math.max(0, Math.min(100, (at - this.start) / span * 100));
        const drawn = this.segments.flatMap((segment) => {
            const start = Math.max(segment.start, this.start);
            const end = Math.min(segment.end, this.end);
            if (end <= start) return [];
            // Split at now: what has happened is solid, what is planned hatched.
            const parts: Array<{ start: number; end: number; planned: boolean }> = [];
            if (start < this.now) parts.push({ start, end: Math.min(end, this.now), planned: false });
            if (end > this.now) parts.push({ start: Math.max(start, this.now), end, planned: true });
            return parts.map((part) => ({ ...part, segment }));
        });
        const next = this.next && this.next.at >= this.start && this.next.at <= this.end ? this.next : null;
        const nowIn = this.now >= this.start && this.now <= this.end;
        return html`
            <div class="flag-row">
                ${next ? html`
                    <span class="flag action-tone-${next.tone} ${this._edge(pct(next.at))}" data-next-change data-tone=${next.tone}
                        style="left: ${pct(next.at).toFixed(2)}%">${next.label}</span>
                ` : nothing}
            </div>
            <div class="track" aria-hidden="true">
                ${drawn.map(({ start, end, planned, segment }) => html`
                    <span class="segment action-tone-${segment.tone} ${planned ? "planned" : ""}"
                        data-segment data-tone=${segment.tone} data-planned=${planned ? "true" : "false"}
                        data-start=${start} data-end=${end}
                        style="left: ${pct(start).toFixed(2)}%; width: ${(pct(end) - pct(start)).toFixed(2)}%"></span>
                `)}
                ${next ? html`<span class="next-mark action-tone-${next.tone}" style="left: ${pct(next.at).toFixed(2)}%"></span>` : nothing}
                ${nowIn ? html`
                    <svg class="overlay" data-now viewBox="0 0 1000 10" preserveAspectRatio="none">${renderNowMarker(pct(this.now) * 10, 0, 10, this._time(this.now))}</svg>
                ` : nothing}
            </div>
            <div class="hours" aria-hidden="true">
                ${this._ticks().map((tick) => html`
                    <span class=${this._edge(pct(tick.at))} style="left: ${pct(tick.at).toFixed(2)}%">${pad2(tick.hour)}</span>
                `)}
            </div>
            <span class="sr">${drawn.map(({ start, end, segment }) =>
                `${this._time(start)}–${this._time(end)} ${segment.label}. `)}</span>
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
