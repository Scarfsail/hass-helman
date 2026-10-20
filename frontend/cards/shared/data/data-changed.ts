import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * The frontend half of automatic refresh.
 *
 * The backend fires one coarse `helman_data_changed` whenever something a card
 * draws has been rewritten — a re-planned schedule, a saved config, a retrained
 * bias profile, a finished training job. This module owns the single
 * subscription to it and hands the signal to whoever is listening.
 *
 * One subscription per *connection*, not per card: a dashboard showing the
 * scheduling card and the inspector side by side should cost Home Assistant one
 * event subscription, not one per element. Same `WeakMap`-keyed shape as
 * `getSharedHelmanStore` and `getSharedScheduleOwner`.
 */

/**
 * The events API this feed needs.
 *
 * Structural rather than HA's `Connection`, and optional throughout: the
 * Playwright mounts hand in hosts with no connection, or one without the
 * subscribe API. HA's real connection satisfies it.
 */
export interface DataChangedConnection {
    subscribeMessage?<ResultType>(
        callback: (result: ResultType) => void,
        subscribeMessage: { type: string },
    ): Promise<() => void>;
}

export interface DataChangedHost {
    connection?: DataChangedConnection | null;
}

type HelmanConnection = DataChangedConnection;

/** The kinds the backend currently emits. Advisory — see the listener contract. */
export type DataChangedKind = "schedule" | "plan" | "config" | "solar_bias" | "training";

/**
 * Called once per collapsed batch, with every kind seen in that batch.
 *
 * Reload everything unless you provably depend on one kind. Most cards draw
 * across kind boundaries: a plan announcement can also move a forecast.
 */
export type DataChangedListener = (kinds: ReadonlySet<DataChangedKind>, metadata: { configRevision?: string }) => void;

export interface DataChangedFeed {
    subscribe(listener: DataChangedListener): () => void;
}

/**
 * The backend command that carries the feed.
 *
 * Not `subscribeEvents("helman_data_changed")`: Home Assistant refuses any
 * event outside its own allowlist to a non-admin user, so a household member
 * with a normal account got an error in the log and cards that never refreshed.
 * The integration exposes the same announcements as a command of its own, which
 * every user it answers may subscribe to. See `ws_subscribe_updates`.
 */
const SUBSCRIBE_UPDATES = { type: "helman/subscribe_updates" } as const;

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

/** Nothing to listen to — the caller still gets a well-behaved unsubscribe. */
const NOOP_FEED: DataChangedFeed = { subscribe: () => () => undefined };

export function getSharedDataChangedFeed(hass: DataChangedHost): DataChangedFeed {
    const connection = hass.connection;
    if (!connection) {
        return NOOP_FEED;
    }

    let feed = feeds.get(connection);
    if (!feed) {
        feed = new DataChangedFeedImpl(connection);
        feeds.set(connection, feed);
    }

    return feed;
}

class DataChangedFeedImpl implements DataChangedFeed {
    private readonly _connection: HelmanConnection;
    private readonly _listeners = new Set<DataChangedListener>();
    private _pendingKinds = new Set<DataChangedKind>();
    private _pendingConfigRevision: string | undefined;
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

        const subscribeMessage = this._connection?.subscribeMessage?.bind(this._connection);
        if (!subscribeMessage) {
            // A connection stub without the subscribe API — the cards still
            // mount and work, they just never hear about a change on their own.
            return;
        }

        this._unsubscribeRequest = subscribeMessage<{ kind?: string; revision?: string }>(
            (message) => this._onEvent(message?.kind, message?.revision),
            SUBSCRIBE_UPDATES,
        );
        // A failed subscription must not surface as an unhandled rejection; the
        // cards degrade to manual refresh, which is what they did before.
        void this._unsubscribeRequest.catch(() => undefined);

        this._ensureVisibilityListener();
    }

    private _onEvent(kind: string | undefined, revision?: string): void {
        this._pendingKinds.add((kind ?? "schedule") as DataChangedKind);
        if (kind === "config") this._pendingConfigRevision = revision;

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
        const metadata = { configRevision: this._pendingConfigRevision };
        this._pendingKinds = new Set();
        this._pendingConfigRevision = undefined;
        for (const listener of this._listeners) {
            listener(kinds, metadata);
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
        this._pendingConfigRevision = undefined;

        if (this._visibilityListener !== null && typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this._visibilityListener);
        }
        this._visibilityListener = null;

        const request = this._unsubscribeRequest;
        this._unsubscribeRequest = null;
        void request?.then((unsubscribe) => unsubscribe()).catch(() => undefined);
    }
}

/** Bind a Lit host to the connection's shared feed, including late hass arrival. */
export class DataChangedController implements ReactiveController {
    private _connected = false;
    private _connection: DataChangedConnection | null | undefined;
    private _unsubscribe?: () => void;

    constructor(
        host: ReactiveControllerHost,
        private readonly _hass: () => DataChangedHost | undefined,
        private readonly _options: { kinds?: readonly DataChangedKind[] },
        private readonly _onChange: DataChangedListener,
    ) {
        host.addController(this);
    }

    hostConnected(): void {
        this._connected = true;
        this._sync();
    }

    hostUpdate(): void {
        this._sync();
    }

    hostDisconnected(): void {
        this._connected = false;
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._connection = undefined;
    }

    private _sync(): void {
        if (!this._connected) return;
        const hass = this._hass();
        const connection = hass?.connection;
        if (connection === this._connection) return;
        this._unsubscribe?.();
        this._connection = connection;
        this._unsubscribe = hass ? getSharedDataChangedFeed(hass).subscribe((kinds, metadata) => {
            if (!this._options.kinds || this._options.kinds.some((kind) => kinds.has(kind))) {
                this._onChange(kinds, metadata);
            }
        }) : undefined;
    }
}
