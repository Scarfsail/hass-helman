import type { ReactiveController, ReactiveElement } from "lit";

import { cloneJson, getValueAtPath, setValueAtPath, unsetValueAtPath } from "./config-document";
import {
    ENTITY_GROUP_CONNECTED,
    ENTITY_GROUP_REVERT,
    type EntityGroupRevertDetail,
    type EntityInspectionResult,
    type HelmanEntityGroup,
} from "./entity-group";
import { stringValue } from "./form-fields";
import type { HomeAssistantLike, JsonObject, JsonValue, PathSegment } from "./types";

/**
 * How often the editor asks what its picked entities currently read.
 *
 * A poll rather than a state subscription: the reading is a hint the reader
 * glances at while configuring, not a live dashboard, and a couple of seconds
 * of lag costs nothing. Subscribing would mean tracking which entities the
 * draft names as it is edited -- and *which* entities a path resolves to is
 * knowledge this editor deliberately does not have.
 */
const ENTITY_INSPECTION_INTERVAL_MS = 2000;

/**
 * How long an immediate re-read waits before it can fire again.
 *
 * Every write into the draft asks for a fresh reading, because a reading the
 * user just invalidated is worse than no reading -- flipping a polarity and
 * watching the old direction sit there for two seconds reads as a control that
 * did nothing. But text fields write on every keystroke, and one whole config
 * document per character is not a poll, it is a flood.
 *
 * So the trigger is leading-edge: the *first* change of a burst goes out at
 * once -- which is every discrete change, a select or a picker -- and anything
 * that arrives inside the window is collapsed into a single trailing call once
 * it closes. A click costs no delay at all.
 *
 * The window has to outlast a keystroke to be worth anything. Ordinary typing
 * runs 150-300 ms per character, so a shorter window would put every character
 * on its own leading edge and send exactly the flood it was meant to stop --
 * a synthetic burst of writes with no gaps is the only case a short window
 * actually covers, and no user types that way.
 */
const ENTITY_INSPECTION_DEBOUNCE_MS = 400;

/**
 * Every match under `root`, including the ones inside nested shadow roots.
 *
 * `querySelectorAll` does not cross a shadow boundary, and the editor renders
 * part of itself through child elements that have one. Anything looking for
 * "all the groups on screen" has to walk.
 */
function queryDeep<T extends Element>(root: ParentNode | null | undefined, selector: string): T[] {
    if (!root) return [];
    const found: T[] = [...root.querySelectorAll<T>(selector)];
    for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
            found.push(...queryDeep<T>(element.shadowRoot, selector));
        }
    }
    return found;
}

/** A path the poll asks about, and whether it survives an unset picker. */
export interface EntityInspectionTarget {
    key: string;
    path: PathSegment[];
    /** Asked about even while nothing is configured at `path`. */
    always: boolean;
}

/** What the collector needs of the element that owns it. */
export interface EntityInspectionSource {
    hass(): HomeAssistantLike | undefined;
    /** The draft: what the poll sends, and what "is this picker set" reads. */
    config(): JsonObject | null;
    /** The stored document: the saved reading, and what a revert restores. */
    saved(): JsonObject | null;
    /** Paths no mounted group announces but the host still wants read. */
    extraTargets?(): EntityInspectionTarget[];
    /** Apply a write to the draft through the host's own bookkeeping. */
    mutate(mutator: (draft: JsonObject) => void): void;
}

/**
 * The entity readings of one editing surface, as a Lit controller.
 *
 * One owner per surface -- the config panel, or the device edit dialog. Every
 * mounted `helman-entity-group` announces itself, and one
 * `helman/inspect_entities` call per tick answers for all of them; the
 * appliances tab alone will hold twenty groups, and a call per group would be
 * twenty round trips every two seconds for readings that all come out of the
 * same document.
 *
 * The draft document is sent whole on every tick. It is a few KB over a local
 * socket, and any scheme for sending only what changed would be more code than
 * it saves.
 */
export class EntityInspectionController implements ReactiveController {
    /** The last answer, keyed by group. Groups read their own row from here. */
    get results(): Readonly<Record<string, EntityInspectionResult>> {
        return this._results;
    }

    private _results: Record<string, EntityInspectionResult> = {};
    private _timer?: ReturnType<typeof setInterval>;
    /** Open while a burst is being coalesced; see the debounce constant. */
    private _debounce?: ReturnType<typeof setTimeout>;
    /** Something changed while the window was open, so send once more at its end. */
    private _trailing = false;
    /**
     * Request ids, so a slow answer cannot overwrite a newer one.
     *
     * Requests are allowed to overlap rather than being serialised behind an
     * in-flight flag: dropping a request because an older one is still out would
     * drop exactly the state the user just typed, which is the bug this whole
     * mechanism exists to prevent. Instead every request takes the next id and
     * only an id newer than the last one applied may reach the screen -- a
     * response that arrives out of order is discarded, not rendered.
     */
    private _sequence = 0;
    private _applied = 0;
    /**
     * How many requests are out.
     *
     * Ordering is the sequence numbers' job; this is the separate concern of not
     * piling up. The interval restarts when a request *starts*, so a websocket
     * that has stalled -- HA reconnecting, a slow handler -- would otherwise put
     * another whole config document on the wire every two seconds with nothing
     * capping the pile. The idle tick yields while one is out; a poll the user
     * caused never does, because dropping that one drops the state they just
     * typed.
     */
    private _inFlight = 0;

    constructor(
        private readonly _host: ReactiveElement,
        private readonly _source: EntityInspectionSource,
    ) {
        _host.addController(this);
    }

    hostConnected(): void {
        this._host.addEventListener(ENTITY_GROUP_CONNECTED, this._handleGroupConnected);
        this._host.addEventListener(ENTITY_GROUP_REVERT, this._handleGroupRevert);
        this._restartTimer();
    }

    hostDisconnected(): void {
        this._host.removeEventListener(ENTITY_GROUP_CONNECTED, this._handleGroupConnected);
        this._host.removeEventListener(ENTITY_GROUP_REVERT, this._handleGroupRevert);
        if (this._timer !== undefined) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
        if (this._debounce !== undefined) {
            clearTimeout(this._debounce);
            this._debounce = undefined;
        }
        this._trailing = false;
    }

    /**
     * Read again now, because something the reading depends on moved.
     *
     * The single trigger for everything that is not the timer: a group mounting,
     * and every write into the draft document. It deliberately does *not* ask
     * which paths changed or which group owns them. The poll is one batched call
     * over the groups the collector finds in the DOM, and a config write is rare
     * enough that asking unconditionally is both simpler than a dependency map
     * and impossible to get subtly wrong -- a field added later cannot forget to
     * opt in.
     *
     * Leading edge, with a trailing call when the burst had more in it. Expanding
     * a section mounts several groups at once and the first of them fires before
     * its siblings exist, so the trailing call is what picks the rest up.
     */
    request = (): void => {
        if (this._debounce !== undefined) {
            this._trailing = true;
            return;
        }
        this._debounce = setTimeout(() => {
            this._debounce = undefined;
            if (this._trailing) {
                this._trailing = false;
                this.request();
            }
        }, ENTITY_INSPECTION_DEBOUNCE_MS);
        void this._poll();
    };

    /**
     * A group announcing itself as it mounts.
     *
     * Deferred to a microtask, unlike a config write, because this one arrives
     * from inside the host's own render commit: the group's `connectedCallback`
     * runs while Lit is inserting children, after the update is marked done, so
     * writing the reactive results synchronously would schedule an update from
     * inside one -- the dev warning, and an extra render pass. The write the
     * user caused has no such problem and keeps its leading edge.
     */
    private _handleGroupConnected = (): void => {
        queueMicrotask(() => this.request());
    };

    /**
     * Put this group's owned paths back to what the stored document says.
     *
     * The host does the write because it is what holds both documents; the
     * group only knows which paths are its own. A path the saved document does
     * not have is removed rather than blanked, so reverting an entity that was
     * never saved leaves the same document as never having picked one.
     *
     * Answered by the nearest owner only: a dialog opened from a surface that
     * has a collector of its own must not have its revert applied to that
     * surface's document too.
     */
    private _handleGroupRevert = (event: Event): void => {
        event.stopPropagation();
        const detail = (event as CustomEvent<EntityGroupRevertDetail>).detail;
        const saved = this._source.saved();
        if (!saved || !detail?.paths?.length) return;
        this._source.mutate((draft) => {
            for (const path of detail.paths) {
                const value = getValueAtPath(saved, path);
                if (value === undefined) {
                    unsetValueAtPath(draft, path);
                } else {
                    setValueAtPath(draft, path, cloneJson(value as JsonValue));
                }
            }
        });
    };

    /**
     * Start the idle tick over.
     *
     * Called whenever a request actually goes out, so an immediate poll *resets*
     * the two-second rhythm instead of running beside it. Without this, a burst
     * of edits would leave the timer firing in the gaps between the polls the
     * edits already caused.
     */
    private _restartTimer(): void {
        if (this._timer !== undefined) {
            clearInterval(this._timer);
        }
        this._timer = setInterval(() => void this._poll("idle"), ENTITY_INSPECTION_INTERVAL_MS);
    }

    /**
     * The groups actually on screen, read from the DOM at the moment of asking.
     *
     * Deliberately not a set maintained by mount/unmount events. A group cannot
     * announce its own removal — `disconnectedCallback` runs after the browser
     * has detached it, and an event dispatched from a detached node never
     * reaches the host — so a bookkeeping set would grow monotonically and keep
     * polling for groups that are gone. Querying is also simply true: a
     * collapsed `details` renders no group, and a tab switch removes them all.
     *
     * It descends nested shadow roots because a plain `querySelectorAll` stops
     * at the first one: `helman-optimizer-editor` renders the Automation tab
     * inside its own, and a group placed there would simply never be polled —
     * mounted, bordered and permanently blank, with nothing to say it was
     * missed. The whole invariant is that no picker goes factless, so the
     * collector has to reach every group that exists rather than every group
     * the host happened to render itself.
     */
    private _mountedGroups(): HelmanEntityGroup[] {
        return queryDeep<HelmanEntityGroup>(this._host.renderRoot, "helman-entity-group");
    }

    private _setResults(next: Record<string, EntityInspectionResult>): void {
        this._results = next;
        this._host.requestUpdate();
    }

    /**
     * One call for every mounted group, or none at all.
     *
     * A group is worth asking about when *either* document has something at its
     * path. The draft one is obvious; the saved one is the case that is easy to
     * get wrong — clearing a configured sensor leaves the draft blank, and that
     * is exactly when the saved reading and its revert control need to appear.
     * Skipping it would remove the revert affordance from the single edit most
     * likely to want it. When neither document has anything there is genuinely
     * nothing to ask, and no call goes out at all.
     *
     * A failed tick is swallowed — the last reading stays on screen rather than
     * the host growing an error banner that reappears every two seconds.
     */
    private async _poll(trigger: "idle" | "change" = "change"): Promise<void> {
        const hass = this._source.hass();
        const config = this._source.config();
        if (!hass || !config) return;
        if (trigger === "idle" && this._inFlight > 0) return;
        const saved = this._source.saved();
        // The mounted groups plus whatever the host asks for beyond them --
        // one poll, one cache, deduplicated by key so a path both a group and
        // the host care about is asked about once.
        const seenKeys = new Set<string>();
        const candidates: EntityInspectionTarget[] = [
            ...this._mountedGroups().map((group) => ({
                key: group.key,
                path: group.path,
                always: false,
            })),
            ...(this._source.extraTargets?.() ?? []),
        ];
        const targets = candidates
            .filter((target) => {
                if (seenKeys.has(target.key)) return false;
                seenKeys.add(target.key);
                return true;
            })
            .filter(
                ({ path, always }) =>
                    always ||
                    stringValue(getValueAtPath(config, path)) !== "" ||
                    (!!saved && stringValue(getValueAtPath(saved, path)) !== ""),
            );
        if (targets.length === 0) {
            // Clearing is an answer like any other, so it takes an id too. Without
            // one, a slow earlier request could resolve after this and repaint the
            // reading for the entity that was just cleared.
            this._applied = ++this._sequence;
            if (Object.keys(this._results).length > 0) {
                this._setResults({});
            }
            return;
        }
        const sequence = ++this._sequence;
        this._restartTimer();
        this._inFlight += 1;
        try {
            const response = await hass.callWS<{ results?: EntityInspectionResult[] }>({
                type: "helman/inspect_entities",
                config,
                ...(saved ? { saved_config: saved } : {}),
                // ``always`` is the collector's own bookkeeping about which rows
                // survive the "is the picker set" filter. The request carries
                // paths and nothing else, so it is dropped here rather than sent
                // and ignored.
                targets: targets.map(({ key, path }) => ({ key, path })),
            });
            // A slower earlier request must never repaint over a newer answer:
            // that would put the stale reading back on screen, which is the
            // whole defect the immediate poll exists to remove.
            if (sequence < this._applied) return;
            this._applied = sequence;
            const next: Record<string, EntityInspectionResult> = {};
            for (const row of response?.results ?? []) {
                next[row.key] = row;
            }
            this._setResults(next);
        } catch {
            // Polled: a dropped tick costs a stale badge, not a message.
        } finally {
            this._inFlight -= 1;
        }
    }
}
