import type { ReactiveControllerHost } from "lit";
import type { HomeAssistant } from "../../types/ha";
import { isoDateInTimeZone, todayKey } from "../shared/time/day-key";

/** How stale a "today so far" answer may get before it is re-read, while visible. */
export const TODAY_REFRESH_MS = 5 * 60_000;

/** Retry an answer from the previous day without issuing a read on every power tick. */
export const NEW_DAY_RETRY_MS = 30_000;

export type SectionState<T> =
    | { status: "loading" }
    | { status: "ready"; payload: T }
    | { status: "error" };

/** What a section is read for: an element that renders it, in HA's time zone. */
export type SectionHost = ReactiveControllerHost & HTMLElement & { hass: HomeAssistant };

export interface SectionOptions<T> {
    /** Reads the section. */
    fetch: () => Promise<T>;
    /** Whether the section is shown now: a shown section is read and kept current, a hidden one is dropped. */
    shown: () => boolean;
    /**
     * Whether figures requested at `requestedAt` need a re-read while shown,
     * or with `null` whether a failed read does; {@link staleToday} by default.
     */
    staleness?(payload: T | null, requestedAt: number): boolean;
    /** `false`: a failed read replaces the figures shown, which may be out of date, with its error. */
    keepOnError?: boolean;
    /** Called as each read is sent, to stamp what it was read under. */
    onRequest?: () => void;
}

/** HA's time zone, which "today" is judged in. */
export function timeZone(hass: HomeAssistant): string {
    return hass.config?.time_zone || "UTC";
}

/** HA's language, which times and figures are formatted in. */
export function hassLocale(hass: HomeAssistant): string {
    return hass.locale?.language ?? hass.language ?? "cs";
}

/** Whether figures are for another day: their period's, or without one the day they were requested. */
function otherDay(payload: unknown, requestedAt: number, zone: string): boolean {
    const start = (payload as { period?: { start: string } } | null)?.period?.start;
    return isoDateInTimeZone(new Date(start ?? requestedAt), zone) !== todayKey(zone);
}

/**
 * Whether "today so far" figures need a re-read: older than
 * {@link TODAY_REFRESH_MS}, or for another day — their period's, or without
 * one the day they were requested — retried at most every {@link NEW_DAY_RETRY_MS}.
 */
export function staleToday(payload: unknown, requestedAt: number, hass: HomeAssistant): boolean {
    const age = Date.now() - requestedAt;
    if (age > TODAY_REFRESH_MS) return true;
    return otherDay(payload, requestedAt, timeZone(hass)) && age > NEW_DAY_RETRY_MS;
}

/**
 * One lazily read section of a detail, and its one keep rule: a refresh
 * within the day it was read keeps the figures on screen until the new ones
 * land, a refresh on a new day replaces them, and a failed refresh keeps them.
 * An answer to a read that a newer read, a drop or a cancel overtook answers
 * nobody.
 */
export class SectionResource<T> {
    state: SectionState<T> | null = null;
    /** When the figures shown, or the read in flight, were requested. */
    requestedAt = 0;
    private _request = 0;
    /** Whether a read is in flight that still answers. */
    private _pending = false;
    /** `requestedAt` as of the last read that answered: what a cancel restores. */
    private _settledAt = 0;

    constructor(private readonly _host: SectionHost, readonly name: string, private readonly _options: SectionOptions<T>) {}

    /** The figures, once they have landed. */
    get payload(): T | null {
        return this.state?.status === "ready" ? this.state.payload : null;
    }

    async load(): Promise<void> {
        const request = ++this._request;
        if (this.state?.status !== "ready" || otherDay(this.state.payload, this.requestedAt, timeZone(this._host.hass))) {
            this._set({ status: "loading" });
        }
        this.requestedAt = Date.now();
        this._pending = true;
        this._options.onRequest?.();
        try {
            const payload = await this._options.fetch();
            if (request !== this._request) return;
            this._settle();
            this._set({ status: "ready", payload });
        } catch (error) {
            if (request !== this._request) return;
            this._settle();
            console.error(`${this._host.localName}: failed to load the ${this.name} section`, error);
            if (this._options.keepOnError === false || this.state?.status !== "ready") this._set({ status: "error" });
        }
    }

    /**
     * Read a shown section that has nothing yet or is stale, while the page
     * is visible. A hidden one is dropped, or with `keepHidden` keeps its
     * figures for when it is shown again.
     */
    sync(keepHidden = false): void {
        if (!this._options.shown()) {
            if (keepHidden) this.cancel();
            else this.drop();
        } else if (this.state === null) {
            void this.load();
        } else if (this.state.status !== "loading" && !document.hidden) {
            // A failed read is retried once it is as stale as figures read then would be.
            const payload = this.state.status === "ready" ? this.state.payload : null;
            const stale = this._options.staleness
                ? this._options.staleness(payload, this.requestedAt)
                : staleToday(payload, this.requestedAt, this._host.hass);
            if (stale) void this.load();
        }
    }

    /**
     * Re-read the figures shown, if the section is still shown; figures kept
     * while hidden are marked stale, so they are re-read once shown.
     */
    reload(): void {
        if (this.state === null) return;
        if (this._options.shown()) void this.load();
        else this.requestedAt = this._settledAt = 0;
    }

    /** Forget the figures; a read in flight answers nobody. */
    drop(): void {
        if (this.state === null) return;
        this._request += 1;
        this._pending = false;
        this._set(null);
    }

    /**
     * A read in flight answers nobody, and the figures kept are as old as
     * they were; one left loading or failed is dropped, so it is read again.
     */
    cancel(): void {
        if (this._pending) {
            this._request += 1;
            this._pending = false;
            this.requestedAt = this._settledAt;
        }
        if (this.state !== null && this.state.status !== "ready") this._set(null);
    }

    /** The read in flight answered. */
    private _settle(): void {
        this._pending = false;
        this._settledAt = this.requestedAt;
    }

    private _set(state: SectionState<T> | null): void {
        this.state = state;
        this._host.requestUpdate();
    }
}
