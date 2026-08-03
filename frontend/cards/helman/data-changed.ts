import type { HomeAssistant } from "../../hass-frontend/src/types";

/**
 * The frontend half of automatic refresh.
 *
 * The backend fires one coarse `helman_data_changed` whenever something a card
 * draws has been rewritten — a re-planned schedule, a saved config, a retrained
 * bias profile. This module owns the single subscription to it and hands the
 * signal to whoever is listening.
 *
 * One subscription per *connection*, not per card: a dashboard showing the
 * scheduling card and the inspector side by side should cost Home Assistant one
 * event subscription, not one per element. Same `WeakMap`-keyed shape as
 * `getSharedHelmanStore` and `getSharedScheduleOwner`.
 */

type HelmanConnection = HomeAssistant["connection"];

/** The kinds the backend currently emits. Advisory — see the listener contract. */
export type DataChangedKind = "schedule" | "plan" | "config" | "solar_bias";

/**
 * Called once per collapsed batch, with every kind seen in that batch.
 *
 * The kinds are informational. A listener is expected to reload everything it
 * renders regardless of which arrived: the cards draw across the boundaries the
 * kinds describe (the inspector's one payload carries plan, forecast and bias
 * contributions at once), so filtering on them would be a bug waiting for the
 * day a `plan` event is the only thing announcing a moved forecast.
 */
export type DataChangedListener = (kinds: ReadonlySet<DataChangedKind>) => void;

export interface DataChangedFeed {
    subscribe(listener: DataChangedListener): () => void;
}

const EVENT_DATA_CHANGED = "helman_data_changed";

/**
 * How long to collect events before telling listeners.
 *
 * A single automation run legitimately fires more than one: the schedule
 * document write and the run-result record are separate announcements, and
 * horizon pruning during the reload that follows can add a third. Refresh cost
 * on the target hardware has not been measured, so this is deliberately long
 * enough to swallow a burst and short enough to stay imperceptible.
 */
const COLLECT_WINDOW_MS = 400;

const feeds = new WeakMap<HelmanConnection, DataChangedFeedImpl>();

export function getSharedDataChangedFeed(hass: HomeAssistant): DataChangedFeed {
    let feed = feeds.get(hass.connection);
    if (!feed) {
        feed = new DataChangedFeedImpl(hass.connection);
        feeds.set(hass.connection, feed);
    }

    return feed;
}

class DataChangedFeedImpl implements DataChangedFeed {
    private readonly _connection: HelmanConnection;
    private readonly _listeners = new Set<DataChangedListener>();
    private _pendingKinds = new Set<DataChangedKind>();
    private _flushTimer: number | null = null;
    private _unsubscribeRequest: Promise<() => void> | null = null;
    private _visibilityListener: (() => void) | null = null;

    constructor(connection: HelmanConnection) {
        this._connection = connection;
    }

    public subscribe(listener: DataChangedListener): () => void {
        this._listeners.add(listener);
        this._ensureSubscribed();

        let isSubscribed = true;
        return () => {
            if (!isSubscribed) {
                return;
            }

            isSubscribed = false;
            this._listeners.delete(listener);
            if (this._listeners.size === 0) {
                this._dispose();
                feeds.delete(this._connection);
            }
        };
    }

    private _ensureSubscribed(): void {
        if (this._unsubscribeRequest !== null) {
            return;
        }

        const subscribeEvents = this._connection?.subscribeEvents?.bind(this._connection);
        if (!subscribeEvents) {
            // A connection stub without the events API — the cards still mount
            // and work, they just never hear about a change on their own.
            return;
        }

        this._unsubscribeRequest = subscribeEvents<{ data?: { kind?: string } }>(
            (event) => this._onEvent(event?.data?.kind),
            EVENT_DATA_CHANGED,
        );
        // A failed subscription must not surface as an unhandled rejection; the
        // cards degrade to manual refresh, which is what they did before.
        void this._unsubscribeRequest.catch(() => undefined);

        this._ensureVisibilityListener();
    }

    private _onEvent(kind: string | undefined): void {
        this._pendingKinds.add((kind ?? "schedule") as DataChangedKind);

        if (this._isHidden()) {
            // Reloading a background tab on every re-plan is a round-trip
            // nobody is looking at. The kinds stay pending and go out whole the
            // moment the tab comes back.
            return;
        }

        this._scheduleFlush();
    }

    private _scheduleFlush(): void {
        if (this._flushTimer !== null || typeof window === "undefined") {
            return;
        }

        // Timed from the *first* event of the batch rather than restarted on
        // each: a steady trickle of events must still reach the user.
        this._flushTimer = window.setTimeout(() => {
            this._flushTimer = null;
            this._flush();
        }, COLLECT_WINDOW_MS);
    }

    private _flush(): void {
        if (this._pendingKinds.size === 0) {
            return;
        }

        const kinds = this._pendingKinds;
        this._pendingKinds = new Set();
        for (const listener of this._listeners) {
            listener(kinds);
        }
    }

    private _ensureVisibilityListener(): void {
        if (this._visibilityListener !== null || typeof document === "undefined") {
            return;
        }

        this._visibilityListener = () => {
            if (!this._isHidden() && this._pendingKinds.size > 0) {
                this._clearFlushTimer();
                this._flush();
            }
        };
        document.addEventListener("visibilitychange", this._visibilityListener);
    }

    private _isHidden(): boolean {
        return typeof document !== "undefined" && document.hidden === true;
    }

    private _clearFlushTimer(): void {
        if (this._flushTimer !== null && typeof window !== "undefined") {
            window.clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
    }

    private _dispose(): void {
        this._clearFlushTimer();
        this._pendingKinds = new Set();

        if (this._visibilityListener !== null && typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this._visibilityListener);
        }
        this._visibilityListener = null;

        const request = this._unsubscribeRequest;
        this._unsubscribeRequest = null;
        void request?.then((unsubscribe) => unsubscribe()).catch(() => undefined);
    }
}
