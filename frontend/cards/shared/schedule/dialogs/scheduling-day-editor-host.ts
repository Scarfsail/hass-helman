import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../../types/ha";
import type {
    EntityActualHistorySlotDTO,
    ForecastPayload,
} from "../../../helman-api";
import { ForecastLoader } from "../../data/forecast-loader";
import { getSharedHelmanStore } from "../../data/store";
import { getLocalizeFunction, type LocalizeFunction } from "../../../localize/localize";
import { dispatchWatchedEntities } from "../../hass-change";
import { resolveLocale } from "../../resolve-locale";
import { EMPTY_SCHEDULE_OWNER_SNAPSHOT, getSharedScheduleOwner, type SharedScheduleOwner } from "../schedule-owner";
import "./scheduling-entity-day-editor";
import type { EntityScheduleSaveDetail } from "./scheduling-entity-day-editor";
import {
    buildControllableEntityStatuses,
    type ControllableEntityStatus,
    controllableWatchedEntityIds,
} from "../model/controllable-entity-status";
import {
    buildEntityScheduleDays,
    type EntityScheduleDay,
    type EntityScheduleLane,
    type EntityScheduleTarget,
} from "../model/entity-day-schedule-model";
import {
    buildEntityScheduleDayView,
    buildEntityScheduleLanes,
    type EntityScheduleDayView,
} from "../model/entity-lane-source";
import type { ScheduleControllable } from "../model/schedule-appliance-metadata";
import {
    buildScheduleApplianceProjectionIndex,
    EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX,
    type ScheduleApplianceProjectionIndex,
} from "../model/schedule-appliance-projection";
import { EMPTY_NORMALIZED_SCHEDULE } from "../model/schedule-normalizer";
import {
    buildSlotForecastMap,
    EMPTY_SLOT_FORECAST_MAP,
    type SlotForecastMap,
} from "../model/slot-forecast-model";
import type {
    NormalizedScheduleModel,
    ScheduleOwnerError,
    ScheduleOwnerSnapshot,
    ScheduleSlot,
} from "../schedule-types";

/**
 * Fired whenever the derived day changes, so a host rendering off the getters
 * below knows to re-read them. Not bubbling: it is addressed to whoever holds
 * this element, not to the card above it.
 */
export const SCHEDULE_DAY_MODEL_CHANGED_EVENT = "schedule-day-model-changed";

/** Ask the nearest host to open the day editor on a lane, or on none. */
export const OPEN_SCHEDULE_EDITOR_EVENT = "helman-open-schedule-editor";

export interface OpenScheduleEditorDetail {
    target: EntityScheduleTarget | null;
}

const EMPTY_DAY_VIEW: EntityScheduleDayView = { slots: [], forecastPoints: new Map() };

/**
 * The shared day editor, and everything it needs to be opened from anywhere.
 *
 * The schedule, the controllable roster, the recorder's morning, the forecast
 * and the projections are one pipeline, and the dialog is only readable when
 * all five agree about which day it is. That pipeline used to
 * live inside the inspector's schedule band, which is the only place that could
 * open an editor; this element is that pipeline with the band lifted off it, so
 * the power card can open the very same dialog rather than grow a second copy
 * that must be kept in agreement with the first.
 *
 * It renders nothing but the dialog (`display: contents`), and publishes what it
 * derived so a band drawn beside it is drawn from the same day, the same
 * schedule and the same clock.
 */
@customElement("scheduling-day-editor-host")
export class SchedulingDayEditorHost extends LitElement {
    static styles = css`
        :host {
            display: contents;
        }
    `;

    @property({ attribute: false }) public hass?: HomeAssistant;
    @property({ type: String }) public timeZone = "UTC";
    /**
     * Something beside this host draws the day, so it must always be complete.
     *
     * The inspector's band is that something. A card that only ever opens the
     * dialog — the power card — leaves this off and pays for the recorder's
     * morning and the projections when somebody actually asks for an editor,
     * rather than on every schedule refresh for every user who never does.
     */
    @property({ type: Boolean }) public preload = false;
    @state() private _ownerSnapshot: ScheduleOwnerSnapshot = EMPTY_SCHEDULE_OWNER_SNAPSHOT;
    @state() private _controllables: readonly ScheduleControllable[] = [];
    @state() private _actualHistory: Record<string, EntityActualHistorySlotDTO[]> = {};
    @state() private _projectionIndex: ScheduleApplianceProjectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
    @state() private _forecast: ForecastPayload | null = null;
    @state() private _nowMs = Date.now();
    /** The lane the dialog opened on, or null when it opened on no lane at all. */
    @state() private _editorLane: EntityScheduleLane | null = null;
    @state() private _editorOpen = false;
    /**
     * The dialog is in the DOM.
     *
     * Kept apart from `_editorOpen` because closing is a transition the dialog
     * itself runs: a save sets `_editorOpen` false and waits for the `closed`
     * event, which never arrives if the element was torn out at the same moment.
     */
    @state() private _editorMounted = false;
    /**
     * The day the open dialog was asked for, or null for today.
     *
     * Per opening, not per host: a band press means the day the band is
     * drawing, while a badge press means today whatever day is on screen
     * around it, since a badge reports the slot running now.
     */
    @state() private _editorDayKey: string | null = null;
    /** The schedule changed under the open draft; Save will overwrite what arrived. */
    @state() private _editorScheduleChanged = false;
    /**
     * Why the open draft's last Save was rejected, or null if none was.
     *
     * Held here rather than read from the owner snapshot at render time: the
     * owner's error is shared by every view of the schedule and outlives this
     * dialog, while this is about the draft on screen and dies with it.
     */
    @state() private _editorSaveError: ScheduleOwnerError | null = null;

    private _localizeFn?: LocalizeFunction;
    private _scheduleOwner?: SharedScheduleOwner;
    private _unsubscribeOwner?: () => void;
    private _unsubscribeRoster?: () => void;
    private _loadedConnection: unknown = null;
    private _forecastLoader: ForecastLoader | null = null;
    private _projectionLoadGeneration = 0;
    /** An editor has been asked for, so the day is worth keeping complete. */
    private _opened = false;
    /** The schedule the open draft was seeded from, to notice a refresh under it. */
    private _editorScheduleAtOpen: unknown = null;
    /** Bumped per opening, so a write can tell whether its draft is still up. */
    private _editorOpening = 0;

    private _normalized: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;

    /**
     * The clock, snapped back to the schedule's own grid.
     *
     * Everything derived below reads the clock the same way -- `startMs > now`,
     * `endMs <= now` -- so no answer can move until the clock crosses a slot
     * edge. Keying the derivation on the raw `_nowMs` therefore rebuilt the
     * forecast map, the day view, the lanes and the days twice a minute to
     * arrive at exactly what was already there. The marker still runs on
     * `_nowMs`; only the model waits for the boundary.
     */
    public clockSlotMs = 0;

    /** The slot length of the last schedule seen, kept across a gap with none. */
    private _lastSlotMinutes: number | null = null;
    private _dayView: EntityScheduleDayView = EMPTY_DAY_VIEW;
    private _lanes: EntityScheduleLane[] = [];
    private _days: EntityScheduleDay[] = [];
    private _forecastMap: SlotForecastMap = EMPTY_SLOT_FORECAST_MAP;
    private _derivedFor: {
        normalized: unknown;
        controllables: unknown;
        history: unknown;
        forecast: unknown;
        projections: unknown;
        states: unknown;
        clockSlotMs: number;
        timeZone: string;
    } | null = null;

    /** Every lane the schedule has, whether or not anything is on it. */
    public get lanes(): readonly EntityScheduleLane[] {
        return this._lanes;
    }

    /** The day's slots and the forecast over them. */
    public get dayView(): EntityScheduleDayView {
        return this._dayView;
    }

    /** Every day the schedule reaches, in order. */
    public get days(): readonly EntityScheduleDay[] {
        return this._days;
    }

    public get normalized(): NormalizedScheduleModel {
        return this._normalized;
    }

    public get projectionIndex(): ScheduleApplianceProjectionIndex {
        return this._projectionIndex;
    }

    /** The coarse clock everything derived here moves in step with. */
    public get nowMs(): number {
        return this._nowMs;
    }

    /**
     * Open the day editor on a lane, or on none.
     *
     * A null target is a legitimate request, not a failure to resolve one: a
     * group row stands for several controllables, so the dialog opens with the
     * whole stack and its "pick an entity" hint rather than guessing which of
     * them the press meant. A target with no lane behind it lands there too —
     * the roster has not loaded, or the appliance cannot be authored, and an
     * editor listing the day beats a press that does nothing.
     */
    public openFor(target: EntityScheduleTarget | null, dayKey: string | null = null): void {
        if (this._normalized.slots.length === 0) {
            return;
        }

        this._opened = true;
        void this._loadActualHistory();
        void this._loadForecast();
        void this._loadProjections();
        this._editorOpening += 1;
        this._editorScheduleChanged = false;
        this._editorSaveError = null;
        this._editorScheduleAtOpen = this._ownerSnapshot.schedule;
        this._editorLane = target === null
            ? null
            : this._lanes.find((lane) => lane.target === target) ?? null;
        this._editorDayKey = dayKey;
        this._editorMounted = true;
        this._editorOpen = true;
    }

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("hass") && this.hass) {
            this._localizeFn = getLocalizeFunction(this.hass);
            if (this._loadedConnection !== this.hass.connection) {
                this._loadedConnection = this.hass.connection;
                this._unsubscribeRoster?.();
                this._unsubscribeRoster = undefined;
                this._subscribeRoster();
                this._actualHistory = {};
                this._projectionLoadGeneration += 1;
                this._projectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
                this._syncOwner();
                void this._loadControllables();
            } else {
                this._syncOwner();
            }
        }
        this._rebuildNormalizedIfNeeded();
        this.clockSlotMs = _resolveClockSlotMs(this._normalized.slots, this._nowMs);
        this._rebuildDerivedIfNeeded();
    }

    connectedCallback(): void {
        super.connectedCallback();
        // Back in the DOM on the connection it was loaded for: `willUpdate`
        // will not take the new-connection branch, and the card above filters
        // `hass`, so it may not run at all for a while. Pick the subscriptions
        // back up here, and re-read the roster an invalidation may have
        // replaced while nobody was listening -- the store caches it.
        if (this.hass && this._loadedConnection === this.hass.connection) {
            this._subscribeRoster();
            this._syncOwner();
            void this._loadControllables();
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._unsubscribeOwner?.();
        this._unsubscribeOwner = undefined;
        this._unsubscribeRoster?.();
        this._unsubscribeRoster = undefined;
        this._scheduleOwner = undefined;
    }

    render() {
        // The last known slot length, not the current one: a reconnect drops
        // the schedule to null until it is read again, and unmounting the
        // dialog over that gap would throw away the draft on screen.
        const slotMinutes = this._lastSlotMinutes;
        if (!this.hass || !this._editorMounted || slotMinutes === null) {
            return nothing;
        }

        const lane = this._editorLane;
        return html`
            <scheduling-entity-day-editor
                .hass=${this.hass}
                .open=${this._editorOpen}
                .localize=${this._localize}
                .target=${lane?.target ?? null}
                .appliance=${lane?.appliance}
                .lanes=${this._lanes}
                .slots=${this._dayView.slots}
                .slotMinutes=${slotMinutes}
                .forecastPoints=${this._dayView.forecastPoints}
                .projectionIndex=${this._projectionIndex}
                .priceUnit=${this._forecastMap.priceDisplayUnit}
                .currentDayKey=${this._normalized.currentDayKey}
                .initialDayKey=${this._editorDayKey ?? this._normalized.currentDayKey}
                .locale=${this._locale}
                .timeZone=${this.timeZone}
                .nowMs=${this._nowMs}
                .busy=${this._ownerSnapshot.writing}
                .scheduleChanged=${this._editorScheduleChanged}
                .saveError=${this._editorSaveError}
                @closed=${this._handleEditorClosed}
                @entity-schedule-save=${this._handleEditorSave}
            ></scheduling-entity-day-editor>
        `;
    }

    private _handleEditorClosed = (event: Event): void => {
        event.stopPropagation();
        this._editorOpen = false;
        this._editorMounted = false;
        this._editorLane = null;
        this._editorDayKey = null;
        this._editorScheduleChanged = false;
        this._editorSaveError = null;
        this._editorScheduleAtOpen = null;
    };

    /**
     * The day's draft, as one write, through the shared schedule owner -- so a
     * change made from here lands on every other view of the same day.
     *
     * The dialog stays open until the write settles, so a failure leaves the
     * draft on screen rather than closing over a change that never happened.
     */
    private _handleEditorSave = async (event: CustomEvent<EntityScheduleSaveDetail>): Promise<void> => {
        event.stopPropagation();
        // Cleared per attempt, so the banner is never the previous press's
        // answer to a draft the user has since changed.
        this._editorSaveError = null;
        const opening = this._editorOpening;
        const patches = event.detail.patches;
        if (patches.length > 0) {
            const writeError = await this._scheduleOwner?.applySchedulePatches(patches) ?? null;
            // The dialog was closed and opened again while the write was in
            // flight: whatever it answered is about a draft that is no longer
            // on screen, and pinning it to the fresh one would accuse an edit
            // nobody has tried to save yet.
            if (opening !== this._editorOpening) {
                return;
            }

            if (writeError !== null) {
                // Kept open over the draft that was refused -- and now saying
                // so. Without the message this is a dead button: nothing
                // closes, nothing is written, and the reason reaches only the
                // console.
                //
                // The write's own error, not the owner's: the owner's error is
                // shared by every view of the schedule and may come from a
                // read that has nothing to do with this save, and reporting it
                // here would tell the user their save failed over a day that
                // was written.
                this._editorSaveError = writeError;
                return;
            }
        }

        this._editorOpen = false;
    };

    private _subscribeRoster(): void {
        if (!this.hass) {
            return;
        }

        this._unsubscribeRoster ??= getSharedHelmanStore(this.hass).subscribeRosterInvalidation(() => {
            this._controllables = [];
            this._actualHistory = {};
            this._emitWatchedEntities();
            void this._loadControllables();
        });
    }

    private _syncOwner(): void {
        const hass = this.hass;
        if (!hass) {
            return;
        }

        const owner = getSharedScheduleOwner(hass);
        if (this._scheduleOwner === owner) {
            this._applyOwnerSnapshot(owner.getSnapshot());
            return;
        }

        this._unsubscribeOwner?.();
        this._scheduleOwner = owner;
        this._applyOwnerSnapshot(owner.getSnapshot());
        this._unsubscribeOwner = owner.subscribe((snapshot) => this._applyOwnerSnapshot(snapshot));
    }

    /**
     * A new schedule is also the cue to re-read the recorder.
     *
     * What was measured earlier today would otherwise stop growing at whatever
     * the morning looked like when the card loaded. Riding the schedule's own
     * refresh keeps the two the same age without a clock of its own.
     */
    private _applyOwnerSnapshot(snapshot: ScheduleOwnerSnapshot): void {
        const nowMs = this._scheduleOwner?.getNowMs() ?? this._nowMs;
        if (nowMs !== this._nowMs) {
            this._nowMs = nowMs;
            this.dispatchEvent(new CustomEvent(SCHEDULE_DAY_MODEL_CHANGED_EVENT));
        }
        const scheduleChanged = snapshot.schedule !== this._ownerSnapshot.schedule;
        this._ownerSnapshot = snapshot;
        if (!scheduleChanged) {
            return;
        }

        if (this._editorOpen && this._editorScheduleAtOpen !== null) {
            this._editorScheduleChanged = snapshot.schedule !== this._editorScheduleAtOpen;
        }
        this._projectionLoadGeneration += 1;
        this._projectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
        if (snapshot.schedule !== null && (this.preload || this._opened)) {
            void this._loadActualHistory();
            void this._loadProjections();
        }
    }

    /**
     * What each scheduled run is projected to consume, and where it leaves the
     * car.
     *
     * Reloaded with the schedule, because that is what it is a projection of:
     * moving a charging run changes both the energy under it and every SoC
     * after it. Failure is silent -- the day is entirely readable as bare runs,
     * and this only ever adds a figure to one.
     */
    private async _loadProjections(): Promise<void> {
        const hass = this.hass;
        if (!hass) {
            return;
        }

        const generation = this._projectionLoadGeneration;
        try {
            const payload = await getSharedHelmanStore(hass).getApplianceProjections();
            if (generation !== this._projectionLoadGeneration || this.hass?.connection !== hass.connection) {
                return;
            }
            this._projectionIndex = buildScheduleApplianceProjectionIndex(payload);
        } catch (error) {
            if (generation !== this._projectionLoadGeneration || this.hass?.connection !== hass.connection) {
                return;
            }
            this._projectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
            console.warn("scheduling: failed to load appliance projections", error);
        }
    }

    /**
     * Every entity id this host resolves out of `hass.states`, bubbled up so
     * the card at the top can filter `hass` without repeating the fetch that
     * found them: each controllable's primary entity, plus the EV charger's
     * `useMode`/`ecoGear` selects, which describe a running charger.
     */
    private _emitWatchedEntities(): void {
        const ids = new Set<string>();
        for (const controllable of this._controllables) {
            for (const id of controllableWatchedEntityIds(controllable)) ids.add(id);
        }
        dispatchWatchedEntities(this, "schedule-editor", [...ids]);
    }

    private async _loadControllables(): Promise<void> {
        const hass = this.hass;
        if (!hass) {
            return;
        }

        try {
            const controllables = await getSharedHelmanStore(hass).getControllableRoster();
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            this._controllables = controllables;
            this._emitWatchedEntities();
            if (this.preload || this._opened) {
                void this._loadActualHistory();
            }
        } catch (error) {
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            this._controllables = [];
            console.error("scheduling: failed to load the controllable roster", error);
        }
    }

    /**
     * What the entities really did earlier today, from the recorder.
     *
     * Failure is silent: the day is perfectly readable with the morning blank,
     * and an error banner would be louder than the loss.
     */
    private async _loadActualHistory(): Promise<void> {
        const hass = this.hass;
        if (!hass || this._controllables.length === 0) {
            return;
        }

        try {
            const payload = await getSharedHelmanStore(hass).getEntityActualHistory();
            if (this.hass?.connection === hass.connection) {
                this._actualHistory = payload.entities;
            }
        } catch (error) {
            console.warn("scheduling: failed to load entity history", error);
        }
    }

    /**
     * Loaded when the editor opens rather than with the host.
     *
     * Only the dialog draws a forecast over the day, so the fetch waits until
     * somebody asks for one.
     */
    private async _loadForecast(): Promise<void> {
        const hass = this.hass;
        const schedule = this._ownerSnapshot.schedule;
        if (!hass || schedule === null) {
            return;
        }

        // Nothing to draw a forecast against until the schedule has slots.
        if (schedule.slots.length === 0) {
            return;
        }

        this._forecastLoader ??= new ForecastLoader();

        try {
            const forecast = await this._forecastLoader.load(hass);
            if (this.hass?.connection === hass.connection) {
                this._forecast = forecast;
            }
        } catch (error) {
            console.error("scheduling: failed to load forecast", error);
        }
    }

    /** The owner's normalized slots use the same clock this host reads. */
    private _rebuildNormalizedIfNeeded(): void {
        this._normalized = this._scheduleOwner?.getNormalized(this.timeZone, this._locale)
            ?? EMPTY_NORMALIZED_SCHEDULE;
    }

    /** `hass.states`, or null while no roster has named anything to read in it. */
    private get _watchedStates(): unknown {
        return this._controllables.length === 0 ? null : this.hass?.states;
    }

    private get _controllableEntityStatuses(): ControllableEntityStatus[] {
        return buildControllableEntityStatuses({
            controllables: this._controllables,
            states: this.hass?.states,
            slots: this._normalized.slots,
            nowMs: this._nowMs,
            executionEnabled: this._ownerSnapshot.schedule?.executionEnabled ?? false,
        });
    }

    /**
     * Everything derived from the loaded data, rebuilt only when that data
     * changes.
     *
     * A host may re-render on every pointer move -- the inspector's hover
     * travels through it -- and the day view alone means padding the morning
     * back in and projecting a forecast over it. Deriving that per frame would
     * make moving the mouse across a chart the most expensive thing the card
     * does.
     */
    private _rebuildDerivedIfNeeded(): void {
        const previous = this._derivedFor;
        if (
            previous !== null
            && previous.normalized === this._normalized
            && previous.controllables === this._controllables
            && previous.history === this._actualHistory
            && previous.forecast === this._forecast
            // A band drawn off this host reads the projections through a getter,
            // and they land a round trip after the schedule they belong to. Leave
            // them out of the memo and the run labels keep the blank index the
            // refresh installed until some unrelated update happens by.
            && previous.projections === this._projectionIndex
            // The statuses below read `hass.states`, and the clock is no
            // substitute for it: every card holding this host filters `hass`
            // down to the entities the host itself named, so a new `states`
            // means one of them moved -- a lane's icon or availability, which
            // the band draws. Gated on the roster having landed, because until
            // it does there is nothing to read out of `states` and an
            // unfiltered `hass` would rebuild an empty day at the churn rate.
            && previous.states === this._watchedStates
            && previous.clockSlotMs === this.clockSlotMs
            && previous.timeZone === this.timeZone
        ) {
            return;
        }

        this._derivedFor = {
            normalized: this._normalized,
            controllables: this._controllables,
            history: this._actualHistory,
            forecast: this._forecast,
            projections: this._projectionIndex,
            states: this._watchedStates,
            clockSlotMs: this.clockSlotMs,
            timeZone: this.timeZone,
        };
        this._forecastMap = this._buildForecastMap();
        const { slotMinutes } = this._normalized;
        // Lanes come from the roster, so they are listed with or without a
        // schedule; only their elapsed runs need its slot length.
        this._lanes = buildEntityScheduleLanes({
            statuses: this._controllableEntityStatuses,
            controllables: this._controllables,
            actualHistory: this._actualHistory,
            slotDurationMs: slotMinutes === null ? null : slotMinutes * 60_000,
        });
        if (slotMinutes === null) {
            // No schedule yet, so no grid to lay a day on.
            this._dayView = EMPTY_DAY_VIEW;
            this._days = [];
        } else {
            this._lastSlotMinutes = slotMinutes;
            this._dayView = buildEntityScheduleDayView({
                scheduleSlots: this._normalized.slots,
                slotMinutes,
                timeZone: this.timeZone,
                locale: this._locale,
                forecast: this._forecast,
                baseForecastPoints: this._forecastMap.points,
            });
            this._days = buildEntityScheduleDays({
                slots: this._dayView.slots,
                slotMinutes,
                timeZone: this.timeZone,
                locale: this._locale,
                currentDayKey: this._normalized.currentDayKey,
                todayLabel: this._localize("scheduling.day.today"),
                tomorrowLabel: this._localize("scheduling.day.tomorrow"),
                nowMs: this._nowMs,
            });
        }
        // The band beside the dialog renders off the getters above, and nothing
        // it owns changed -- so without this it would keep drawing the day it
        // derived before the schedule, the roster or the clock moved.
        this.dispatchEvent(new CustomEvent(SCHEDULE_DAY_MODEL_CHANGED_EVENT));
    }

    private _buildForecastMap(): SlotForecastMap {
        if (this._forecast === null || this._normalized.slots.length === 0) {
            return EMPTY_SLOT_FORECAST_MAP;
        }

        return buildSlotForecastMap(
            this._forecast,
            this._normalized.slots.map((slot) => ({
                ...slot,
                source: "schedule" as const,
                scheduleSlot: slot,
            })),
        );
    }

    private get _localize(): LocalizeFunction {
        return this._localizeFn ?? ((key: string) => key);
    }

    private get _locale(): string {
        return resolveLocale(this.hass);
    }
}

/**
 * The last slot edge the clock has reached, or 0 before it reaches the first.
 *
 * Everything derived from the clock here is a slot-boundary test, so bucketing
 * the clock by `[edge, next edge)` is what makes "the model cannot have moved"
 * decidable. The builders are still handed the real `_nowMs`, so the one value
 * this cannot distinguish is a model first derived at the very millisecond of
 * an edge -- where a `startMs >= nowMs` test still counts the slot that is only
 * just starting. `Date.now()` does not land there.
 */
function _resolveClockSlotMs(slots: readonly ScheduleSlot[], nowMs: number): number {
    let boundary = 0;
    for (const slot of slots) {
        if (slot.startMs <= nowMs && slot.startMs > boundary) {
            boundary = slot.startMs;
        }
        if (slot.endMs <= nowMs && slot.endMs > boundary) {
            boundary = slot.endMs;
        }
    }
    return boundary;
}

declare global {
    interface HTMLElementTagNameMap {
        "scheduling-day-editor-host": SchedulingDayEditorHost;
    }
}
