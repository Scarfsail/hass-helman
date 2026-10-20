import type { HomeAssistant } from "../../../types/ha";
import { getSharedHelmanStore } from "../data/store";
import {
    _projectEntityState,
    _readCommittedApplianceAction,
} from "./model/controllable-entity-status";
import type { ScheduleControllable } from "./model/schedule-appliance-metadata";
import { resolveLocale } from "../resolve-locale";
import { getSharedScheduleOwner, type SharedScheduleOwner } from "./schedule-owner";
import type { ScheduleOwnerSnapshot, ScheduleSetBy, ScheduleSlot } from "./schedule-types";

type ScheduleConnection = HomeAssistant["connection"];
type ScheduleBadgeListener = () => void;

const badgeSources = new WeakMap<ScheduleConnection, ScheduleBadgeSourceImpl>();

/**
 * Who scheduled a controllable in the slot that is running now, for anyone who
 * only needs that one answer.
 *
 * Shared per connection in the shape of {@link getSharedScheduleOwner}, because
 * a house of shiftable appliances draws one badge per box and every one of them
 * asks the same question of the same schedule: the normalization, the appliance
 * roster and the clock are paid for once, not once per badge.
 */
export interface SharedScheduleBadgeSource {
    /** Called whenever an answer may have changed; fires once on subscribe. */
    subscribe(listener: ScheduleBadgeListener): () => void;
    /**
     * The current slot's author for a controllable, or null when the slot does
     * nothing with it.
     */
    getAuthorship(controllableId: string): ScheduleSetBy | null;
}

export function getSharedScheduleBadgeSource(hass: HomeAssistant): SharedScheduleBadgeSource {
    let source = badgeSources.get(hass.connection);
    if (!source) {
        source = new ScheduleBadgeSourceImpl(hass);
        badgeSources.set(hass.connection, source);
    } else {
        source.updateHass(hass);
    }

    return source;
}

class ScheduleBadgeSourceImpl implements SharedScheduleBadgeSource {
    private _hass: HomeAssistant;
    private _owner: SharedScheduleOwner | null = null;
    private _unsubscribeOwner: (() => void) | null = null;
    private _unsubscribeRoster: (() => void) | null = null;
    private _snapshot: ScheduleOwnerSnapshot | null = null;
    private _controllables: readonly ScheduleControllable[] = [];
    private readonly _listeners = new Set<ScheduleBadgeListener>();

    constructor(hass: HomeAssistant) {
        this._hass = hass;
    }

    public updateHass(hass: HomeAssistant): void {
        this._hass = hass;
    }

    public subscribe(listener: ScheduleBadgeListener): () => void {
        this._listeners.add(listener);
        this._ensureLifecycle();
        listener();

        let isSubscribed = true;
        return () => {
            if (!isSubscribed) {
                return;
            }

            isSubscribed = false;
            this._listeners.delete(listener);
            if (this._listeners.size === 0) {
                this._dispose();
            }
        };
    }

    /**
     * Only an action that will actually run counts as "scheduled".
     *
     * Both halves of that test are borrowed rather than restated:
     * `_readCommittedApplianceAction` owns the rule that a candidate
     * (`conditionMet === false`) is nothing, and `_projectEntityState` owns what
     * state an action leaves the entity in — so an explicit "off" on an
     * appliance whose resting state is off reads as nothing scheduled here for
     * exactly the reason it does in the entity list.
     */
    public getAuthorship(controllableId: string): ScheduleSetBy | null {
        // Normalization throws on a payload with an authorless action, and this
        // runs inside a badge's render: an uncaught throw there rejects the
        // element's update and freezes it for the rest of the session. A badge
        // that cannot read the schedule says nothing is scheduled, and says it
        // again — correctly — as soon as a good payload arrives.
        let activeSlot: ScheduleSlot | null;
        try {
            const normalized = this._owner?.getNormalized(this._timeZone, this._locale);
            activeSlot = normalized?.slots.find((slot) => slot.isCurrent) ?? null;
        } catch (error) {
            console.warn("schedule: failed to read the current slot for badges", error);
            return null;
        }

        const action = _readCommittedApplianceAction(activeSlot, controllableId);
        if (action === null) {
            return null;
        }

        // Without the roster there is no `normalState` to compare against, so
        // the badge stays grey rather than colouring a scheduled stop. The
        // roster lands once, early, and every listener is notified when it does.
        const entity = this._controllables.find((candidate) => candidate.id === controllableId);
        if (entity === undefined) {
            return null;
        }

        if (_projectEntityState({ entity, action }) === entity.normalState) {
            return null;
        }

        return activeSlot?.assignments[controllableId]?.setBy ?? null;
    }

    private get _timeZone(): string {
        return this._hass.config?.time_zone || "UTC";
    }

    private get _locale(): string {
        return resolveLocale(this._hass);
    }

    private _ensureLifecycle(): void {
        if (this._listeners.size === 0) {
            return;
        }

        this._syncOwner();
        this._unsubscribeRoster ??= getSharedHelmanStore(this._hass).subscribeRosterInvalidation(() => {
            this._controllables = [];
            this._emit();
            void this._loadRoster();
        });
    }

    private _syncOwner(): void {
        const owner = getSharedScheduleOwner(this._hass);
        if (this._owner === owner) {
            return;
        }

        this._unsubscribeOwner?.();
        this._owner = owner;
        let initial = true;
        this._unsubscribeOwner = owner.subscribe((snapshot) => {
            const scheduleChanged = snapshot.schedule !== this._snapshot?.schedule;
            this._snapshot = snapshot;
            if (initial || (scheduleChanged && this._controllables.length === 0)) {
                // The roster is the other half of an answer, and a load that
                // failed while Home Assistant was still starting would otherwise
                // never be tried again — leaving every badge grey for the life of
                // the page while the schedule beside it refreshes happily. The
                // owner's own refresh is the retry.
                void this._loadRoster();
            }
            initial = false;
            this._emit();
        });
    }

    /**
     * The controllable roster, cached by the shared store.
     *
     * It describes configuration rather than state, so one round trip per
     * connection serves every badge for the life of the page. A failed load is
     * silent and retriable: the badges simply stay grey, which is what they show
     * for an appliance with nothing scheduled anyway.
     */
    private async _loadRoster(): Promise<void> {
        const hass = this._hass;
        try {
            const controllables = await getSharedHelmanStore(hass).getControllableRoster();
            if (this._hass.connection !== hass.connection) {
                return;
            }

            this._controllables = controllables;
            this._emit();
        } catch (error) {
            if (this._hass.connection !== hass.connection) {
                return;
            }

            console.warn("schedule: failed to load the controllable roster for badges", error);
        }
    }

    private _emit(): void {
        for (const listener of this._listeners) {
            listener();
        }
    }

    /**
     * Go quiet, but keep what was loaded.
     *
     * The last badge unmounting is routine, not the end of the page: collapsing
     * the house node takes every badge with it and expanding it again brings
     * them straight back. The subscription and the timer are what cost
     * something while nobody is looking, so those are dropped; the roster and
     * the last snapshot stay, and the source keeps its place in
     * `badgeSources` — re-subscribing then costs no round trip at all.
     */
    private _dispose(): void {
        this._unsubscribeOwner?.();
        this._unsubscribeOwner = null;
        this._unsubscribeRoster?.();
        this._unsubscribeRoster = null;
        this._owner = null;
    }
}
