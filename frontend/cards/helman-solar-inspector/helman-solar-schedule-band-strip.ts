import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { ControllableEntityDTO, EntityActualHistorySlotDTO, ForecastPayload } from "../helman-api";
import { ForecastLoader } from "../helman/forecast-loader";
import { getSharedHelmanStore } from "../helman/store";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { getSharedScheduleOwner, type SharedScheduleOwner } from "../helman-scheduling/schedule-owner";
import "../helman-scheduling/components/scheduling-entity-day-band";
import "../helman-scheduling/dialogs/scheduling-entity-day-editor";
import type {
    EntityDayBandBlockSelectDetail,
    EntityDayBandHighlight,
    EntityDayBandLaneSelectDetail,
    EntityDayBandPointerMoveDetail,
    EntityDayBandTimeHoverDetail,
} from "../helman-scheduling/components/scheduling-entity-day-band";
import type { EntityScheduleSaveDetail } from "../helman-scheduling/dialogs/scheduling-entity-day-editor";
import {
    buildControllableEntityStatuses,
    type ControllableEntityStatus,
} from "../helman-scheduling/model/controllable-entity-status";
import {
    buildEntityScheduleDays,
    type EntityScheduleDay,
    type EntityScheduleLane,
} from "../helman-scheduling/model/entity-day-schedule-model";
import {
    buildEntityDayBandLanes,
    buildEntityScheduleDayView,
    buildEntityScheduleLanes,
    formatLaneRunRange,
    resolveLaneRunPresentation,
    type EntityDayBandLane,
    type EntityScheduleDayView,
} from "../helman-scheduling/model/entity-lane-source";
import {
    normalizeScheduleApplianceMetadata,
    type ScheduleApplianceMetadata,
} from "../helman-scheduling/model/schedule-appliance-metadata";
import {
    applyNormalizedScheduleCurrentState,
    buildNormalizedScheduleStructure,
} from "../helman-scheduling/model/schedule-normalizer";
import { formatScheduleTime } from "../helman-scheduling/model/schedule-time";
import {
    buildSlotForecastMap,
    deriveScheduleForecastParams,
    EMPTY_SLOT_FORECAST_MAP,
    type SlotForecastMap,
} from "../helman-scheduling/model/slot-forecast-model";
import type {
    NormalizedScheduleModel,
    ScheduleOwnerSnapshot,
} from "../helman-scheduling/schedule-types";
import { stripWindow, type ScheduleStripGeometry } from "./strip-geometry";
import { SLOT_MINUTES } from "./chart-stack";
import { helmanColorVars } from "../color-vars";

/** One lane's action at the hovered moment, for the fast hover popup. */
export interface ScheduleHoverTooltipRow {
    label: string;
    value: string;
    toneClass: string;
}

/** The popup content emitted for the inspector's shared floating tooltip to render. */
export interface ScheduleHoverTooltipContent {
    x: number;
    y: number;
    title: string;
    rows: ScheduleHoverTooltipRow[];
}

const MINUTES_PER_DAY = 1440;
const MINUTE_MS = 60_000;
/** Slim: the strip sits between charts, where a row is a glance and not a grip. */
const TRACK_HEIGHT_PX = 16;
/** How far the clock has to move before the day is worth rebuilding. */
const NOW_RESOLUTION_MS = 30_000;

const EMPTY_OWNER_SNAPSHOT: ScheduleOwnerSnapshot = {
    schedule: null,
    loading: false,
    refreshing: false,
    writing: false,
    togglingExecution: false,
    error: null,
    updatedAt: null,
    stale: false,
};

const EMPTY_NORMALIZED_SCHEDULE: NormalizedScheduleModel = {
    slots: [],
    currentSlotId: null,
    currentDayKey: null,
    granularityMinutes: null,
};

/**
 * The house's schedule as a stack of per-entity timelines, on the solar
 * inspector's own time axis.
 *
 * The same band the scheduling card's day editor is built around, read-only and
 * cropped to whatever window the charts above are drawing. That is the point of
 * putting it here: a run is only interesting next to the solar it was placed to
 * catch, and two surfaces drawing the same day two different ways would be two
 * things to learn instead of one.
 *
 * Only lanes with something on them get a row. The inspector has charts to fit
 * between, and an entity that did nothing today and has nothing planned has
 * nothing to say about the day being inspected -- it is still one click away in
 * the editor, which lists every lane precisely because that is where entities
 * get scheduled.
 */
@customElement("helman-solar-schedule-band-strip")
export class HelmanSolarScheduleBandStrip extends LitElement {
    static styles = [helmanColorVars, css`
        :host {
            display: block;
            width: 100%;
        }

        /* The tracks are inset to the chart's plot area, so an hour here is the
           same column of pixels as that hour on every chart above; the wrap
           itself keeps the card's full width, which is where the names start. */
        .band-wrap {
            --entity-day-band-track-height: ${TRACK_HEIGHT_PX}px;
        }
    `];

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** Selected inspector day, `YYYY-MM-DD`. */
    @property({ type: String }) public date = "";
    @property({ type: String }) public timeZone = "UTC";
    @property({ attribute: false }) public geometry: ScheduleStripGeometry | null = null;
    /** Inspector slot width, in minutes; how wide a highlighted slot reads. */
    @property({ attribute: false }) public slotMinutes = SLOT_MINUTES;
    /** Minute-of-day of every slot in the inspector's selection. */
    @property({ attribute: false }) public selectedMinutes: number[] = [];
    /** Minute-of-day under the pointer, wherever in the inspector it is. */
    @property({ attribute: false }) public hoverMinutes: number | null = null;

    @state() private _ownerSnapshot: ScheduleOwnerSnapshot = EMPTY_OWNER_SNAPSHOT;
    @state() private _appliances: ScheduleApplianceMetadata[] = [];
    @state() private _controllableEntities: ControllableEntityDTO[] = [];
    @state() private _actualHistory: Record<string, EntityActualHistorySlotDTO[]> = {};
    @state() private _forecast: ForecastPayload | null = null;
    @state() private _nowMs = Date.now();
    @state() private _editorTarget: EntityScheduleLane | null = null;
    @state() private _editorOpen = false;
    /** The schedule changed under the open draft; Save will overwrite what arrived. */
    @state() private _editorScheduleChanged = false;

    private _localizeFn?: LocalizeFunction;
    private _scheduleOwner?: SharedScheduleOwner;
    private _unsubscribeOwner?: () => void;
    private _loadedConnection: unknown = null;
    private _appliancesRequested = false;
    private _entitiesRequested = false;
    private _forecastLoader: ForecastLoader | null = null;
    private _forecastLoaderKey: string | null = null;
    /** The schedule the open draft was seeded from, to notice a refresh under it. */
    private _editorScheduleAtOpen: unknown = null;

    private _normalized: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;
    private _normalizedFor: { schedule: unknown; timeZone: string } | null = null;

    private _dayView: EntityScheduleDayView = { slots: [], forecastPoints: new Map() };
    private _lanes: EntityScheduleLane[] = [];
    private _days: EntityScheduleDay[] = [];
    /** The lanes actually drawn on the last render, for the hover popup to read. */
    private _lastBandLanes: EntityDayBandLane[] = [];
    private _forecastMap: SlotForecastMap = EMPTY_SLOT_FORECAST_MAP;
    private _derivedFor: {
        normalized: unknown;
        appliances: unknown;
        entities: unknown;
        history: unknown;
        forecast: unknown;
        nowMs: number;
        timeZone: string;
    } | null = null;

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("hass") && this.hass) {
            // Coarse on purpose: hass updates land on every state change in the
            // house, and every move of this clock rebuilds the day.
            const now = Date.now();
            if (now - this._nowMs >= NOW_RESOLUTION_MS) {
                this._nowMs = now;
            }
            this._localizeFn = getLocalizeFunction(this.hass);
            if (this._loadedConnection !== this.hass.connection) {
                this._loadedConnection = this.hass.connection;
                this._appliancesRequested = false;
                this._entitiesRequested = false;
                this._actualHistory = {};
                this._syncOwner();
                void this._loadAppliances();
                void this._loadControllableEntities();
            } else {
                this._syncOwner();
            }
        }
        this._rebuildNormalizedIfNeeded();
        this._rebuildDerivedIfNeeded();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._emitHover(null);
        this._unsubscribeOwner?.();
        this._unsubscribeOwner = undefined;
        this._scheduleOwner = undefined;
    }

    render() {
        if (!this.hass || this.geometry === null) {
            return nothing;
        }

        const day = this._selectedDay();
        if (day === null) {
            return nothing;
        }

        const lanes = this._buildBandLanes(day);
        if (lanes.length === 0) {
            return nothing;
        }
        this._lastBandLanes = lanes;

        const { start, end } = stripWindow(this.geometry);
        // The wrap spans the card, and only the tracks are inset to the plot
        // area -- so the lane names get the axis gutter to start in instead of
        // eating into the day on a narrow screen.
        const startInsetPct = (this.geometry.marginLeft / this.geometry.width) * 100;
        const endInsetPct = Math.max(
            0,
            100 - startInsetPct - (this.geometry.plotWidth / this.geometry.width) * 100,
        );
        return html`
            <div
                class="band-wrap"
                style=${`--entity-day-band-track-inset-start:${startInsetPct}%;--entity-day-band-track-inset-end:${endInsetPct}%;`}
            >
                <scheduling-entity-day-band
                    .localize=${this._localize}
                    .day=${day}
                    .lanes=${lanes}
                    .nowMs=${this._nowMs}
                    .locale=${this._locale}
                    .timeZone=${this.timeZone}
                    .windowStartMs=${day.startMs + start * MINUTE_MS}
                    .windowEndMs=${day.startMs + end * MINUTE_MS}
                    .highlightRanges=${this._buildHighlights(day)}
                    .laneLabels=${"track"}
                    .readonly=${true}
                    .showForecastRows=${false}
                    .showAxis=${false}
                    @entity-day-band-lane-select=${this._handleLaneSelect}
                    @entity-day-band-block-select=${this._handleBlockSelect}
                    @entity-day-band-time-hover=${this._handleTimeHover}
                    @entity-day-band-pointer-move=${this._handlePointerMove}
                ></scheduling-entity-day-band>
            </div>
            ${this._renderEditor()}
        `;
    }

    /**
     * The day editor, opened on whichever lane was pressed.
     *
     * It is the same dialog the scheduling card opens, fed from the same
     * builders -- so what the user gets from here is not an inspector-flavoured
     * editor but *the* editor, already looking at the entity they pointed at.
     */
    private _renderEditor() {
        const lane = this._editorTarget;
        if (lane === null) {
            return nothing;
        }

        return html`
            <scheduling-entity-day-editor
                .open=${this._editorOpen}
                .localize=${this._localize}
                .target=${lane.target}
                .appliance=${lane.appliance}
                .lanes=${this._lanes}
                .slots=${this._dayView.slots}
                .forecastPoints=${this._dayView.forecastPoints}
                .priceUnit=${this._forecastMap.priceDisplayUnit}
                .entityName=${lane.name}
                .entityIcon=${lane.icon}
                .currentDayKey=${this._normalized.currentDayKey}
                .initialDayKey=${this.date}
                .locale=${this._locale}
                .timeZone=${this.timeZone}
                .nowMs=${this._nowMs}
                .busy=${this._ownerSnapshot.writing}
                .scheduleChanged=${this._editorScheduleChanged}
                @closed=${this._handleEditorClosed}
                @entity-schedule-save=${this._handleEditorSave}
            ></scheduling-entity-day-editor>
        `;
    }

    /**
     * The inspector's selected and hovered slots, as stretches of the day.
     *
     * The band knows nothing about minutes-of-day or about what the inspector
     * counts as selected; it is handed the times and the reason, which is what
     * keeps the same marks usable by any other host.
     */
    private _buildHighlights(day: EntityScheduleDay): EntityDayBandHighlight[] {
        const toRange = (minutes: number, kind: "selected" | "hover"): EntityDayBandHighlight => {
            // Snap to the inspector's own slot grid, so the mark covers the slot
            // the pointer is in rather than a slot's width starting under it.
            const startMinutes = Math.floor(minutes / this.slotMinutes) * this.slotMinutes;
            return {
                startMs: day.startMs + startMinutes * MINUTE_MS,
                endMs: day.startMs + Math.min(startMinutes + this.slotMinutes, MINUTES_PER_DAY) * MINUTE_MS,
                kind,
            };
        };

        const highlights = this.selectedMinutes.map((minutes) => toRange(minutes, "selected"));
        return this.hoverMinutes === null
            ? highlights
            : [...highlights, toRange(this.hoverMinutes, "hover")];
    }

    /**
     * The day the inspector is showing, if the schedule reaches it.
     *
     * It only ever reaches today and the horizon ahead: the backend prunes what
     * has gone, and the recorder read behind the band is today's. On any other
     * day there is nothing to draw, and the strip renders nothing rather than a
     * row of empty tracks that would read as "nothing was scheduled".
     */
    private _selectedDay(): EntityScheduleDay | null {
        return this._days.find((day) => day.dayKey === this.date) ?? null;
    }

    private _buildBandLanes(day: EntityScheduleDay): EntityDayBandLane[] {
        return buildEntityDayBandLanes({
            lanes: this._lanes,
            slots: this._dayView.slots,
            day,
            nowMs: this._nowMs,
            activeOnly: true,
        });
    }

    private get _controllableEntityStatuses(): ControllableEntityStatus[] {
        return buildControllableEntityStatuses({
            controllableEntities: this._controllableEntities,
            appliances: this._appliances,
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
     * The inspector re-renders on every pointer move -- the hover travels
     * through it -- and the day view alone means padding the morning back in
     * and projecting a forecast over it. Deriving that per frame would make
     * moving the mouse across a chart the most expensive thing the card does.
     */
    private _rebuildDerivedIfNeeded(): void {
        const previous = this._derivedFor;
        if (
            previous !== null
            && previous.normalized === this._normalized
            && previous.appliances === this._appliances
            && previous.entities === this._controllableEntities
            && previous.history === this._actualHistory
            && previous.forecast === this._forecast
            && previous.nowMs === this._nowMs
            && previous.timeZone === this.timeZone
        ) {
            return;
        }

        this._derivedFor = {
            normalized: this._normalized,
            appliances: this._appliances,
            entities: this._controllableEntities,
            history: this._actualHistory,
            forecast: this._forecast,
            nowMs: this._nowMs,
            timeZone: this.timeZone,
        };
        this._forecastMap = this._buildForecastMap();
        this._dayView = buildEntityScheduleDayView({
            scheduleSlots: this._normalized.slots,
            timeZone: this.timeZone,
            locale: this._locale,
            forecast: this._forecast,
            baseForecastPoints: this._forecastMap.points,
        });
        this._lanes = buildEntityScheduleLanes({
            statuses: this._controllableEntityStatuses,
            controllableEntities: this._controllableEntities,
            appliances: this._appliances,
            actualHistory: this._actualHistory,
            slotDurationMs: (this._normalized.granularityMinutes ?? 60) * 60_000,
            locale: this._locale,
        });
        this._days = buildEntityScheduleDays({
            slots: this._dayView.slots,
            timeZone: this.timeZone,
            locale: this._locale,
            currentDayKey: this._normalized.currentDayKey,
            todayLabel: this._localize("scheduling.day.today"),
            tomorrowLabel: this._localize("scheduling.day.tomorrow"),
            nowMs: this._nowMs,
        });
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

    private _handleLaneSelect = (event: CustomEvent<EntityDayBandLaneSelectDetail>): void => {
        event.stopPropagation();
        this._openEditor(event.detail.laneKey);
    };

    private _handleBlockSelect = (event: CustomEvent<EntityDayBandBlockSelectDetail>): void => {
        event.stopPropagation();
        this._openEditor(event.detail.laneKey);
    };

    /**
     * Whatever was pressed, the answer is the same: open the day on that entity.
     *
     * Which run was pressed is deliberately dropped. The editor opens with the
     * lane selected and nothing under edit, which is the state a person can
     * read -- landing straight in an open edit session on a run they only meant
     * to look at would be an edit they did not ask for.
     */
    private _openEditor(laneKey: string): void {
        const lane = this._lanes.find((candidate) => candidate.key === laneKey);
        if (lane === undefined || this._normalized.slots.length === 0) {
            return;
        }

        void this._loadActualHistory();
        void this._loadForecast();
        this._editorScheduleChanged = false;
        this._editorScheduleAtOpen = this._ownerSnapshot.schedule;
        this._editorTarget = lane;
        this._editorOpen = true;
    }

    private _handleEditorClosed = (event: Event): void => {
        event.stopPropagation();
        this._editorOpen = false;
        this._editorTarget = null;
        this._editorScheduleChanged = false;
        this._editorScheduleAtOpen = null;
    };

    /**
     * The day's draft, as one write, through the same owner the scheduling card
     * writes through -- so a change made from here lands on that card too.
     *
     * The dialog stays open until the write settles, so a failure leaves the
     * draft on screen rather than closing over a change that never happened.
     */
    private _handleEditorSave = async (event: CustomEvent<EntityScheduleSaveDetail>): Promise<void> => {
        event.stopPropagation();
        const patches = event.detail.patches;
        if (patches.length > 0) {
            await this._scheduleOwner?.applySchedulePatches(patches);
            if (this._ownerSnapshot.error !== null) {
                return;
            }
        }

        this._editorOpen = false;
    };

    private _handleTimeHover = (event: CustomEvent<EntityDayBandTimeHoverDetail>): void => {
        event.stopPropagation();
        const day = this._selectedDay();
        const atMs = event.detail.atMs;
        this._emitHover(
            atMs === null || day === null ? null : (atMs - day.startMs) / MINUTE_MS,
        );
        if (atMs === null) {
            this._emitTooltip(null);
        }
    };

    /**
     * Every lane with something active at the hovered moment, in one fast
     * popup -- the native per-block `title` a lane's own segment carries is
     * still there underneath, but reading eight of them one at a time is not
     * how "what does the house look like at 14:00" gets answered.
     */
    private _handlePointerMove = (event: CustomEvent<EntityDayBandPointerMoveDetail>): void => {
        event.stopPropagation();
        const { atMs, clientX, clientY } = event.detail;
        if (atMs === null) {
            this._emitTooltip(null);
            return;
        }
        const rows: ScheduleHoverTooltipRow[] = [];
        for (const lane of this._lastBandLanes) {
            const run =
                lane.actualSegments.find((segment) => atMs >= segment.startMs && atMs < segment.endMs)
                ?? lane.blocks.find((block) => atMs >= block.startMs && atMs < block.endMs);
            if (run === undefined) continue;
            const presentation = resolveLaneRunPresentation(lane, run, this._localize);
            // An actual segment's real running time can be shorter than its
            // slot, the same distinction the segment's own native title draws.
            const totalMs = "activeMs" in run ? run.activeMs : undefined;
            const range = formatLaneRunRange(run, this._locale, this.timeZone, totalMs);
            rows.push({
                label: lane.name,
                value: `${presentation.label} · ${range}`,
                toneClass: presentation.toneClass,
            });
        }
        if (rows.length === 0) {
            this._emitTooltip(null);
            return;
        }
        this._emitTooltip({
            x: clientX,
            y: clientY,
            title: formatScheduleTime(atMs, this._locale, this.timeZone),
            rows,
        });
    };

    private _emitTooltip(content: ScheduleHoverTooltipContent | null): void {
        this.dispatchEvent(new CustomEvent<ScheduleHoverTooltipContent | null>("slot-tooltip", {
            detail: content,
            bubbles: true,
            composed: true,
        }));
    }

    private _emitHover(minutes: number | null): void {
        this.dispatchEvent(new CustomEvent<{ minutes: number | null }>("slot-hover", {
            detail: { minutes },
            bubbles: true,
            composed: true,
        }));
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
     * The elapsed half of the band would otherwise stop growing at whatever the
     * morning looked like when the card loaded. Riding the schedule's own
     * refresh keeps the two halves the same age without a clock of its own.
     */
    private _applyOwnerSnapshot(snapshot: ScheduleOwnerSnapshot): void {
        const scheduleChanged = snapshot.schedule !== this._ownerSnapshot.schedule;
        this._ownerSnapshot = snapshot;
        if (!scheduleChanged) {
            return;
        }

        if (this._editorOpen && this._editorScheduleAtOpen !== null) {
            this._editorScheduleChanged = snapshot.schedule !== this._editorScheduleAtOpen;
        }
        if (snapshot.schedule !== null) {
            void this._loadActualHistory();
        }
    }

    private async _loadAppliances(): Promise<void> {
        const hass = this.hass;
        if (!hass || this._appliancesRequested) {
            return;
        }

        this._appliancesRequested = true;
        try {
            const payload = await getSharedHelmanStore(hass).getAppliances();
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            this._appliances = normalizeScheduleApplianceMetadata(payload);
        } catch (error) {
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            this._appliancesRequested = false;
            this._appliances = [];
            console.error("helman-solar-inspector: failed to load appliance metadata", error);
        }
    }

    private async _loadControllableEntities(): Promise<void> {
        const hass = this.hass;
        if (!hass || this._entitiesRequested) {
            return;
        }

        this._entitiesRequested = true;
        try {
            const payload = await getSharedHelmanStore(hass).getControllableEntities();
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            this._controllableEntities = payload.entities;
            void this._loadActualHistory();
        } catch {
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            this._entitiesRequested = false;
            this._controllableEntities = [];
        }
    }

    /**
     * What the entities really did earlier today, from the recorder.
     *
     * Failure is silent: the strip is perfectly readable with the morning
     * blank, and an error banner between two charts would be louder than the
     * loss.
     */
    private async _loadActualHistory(): Promise<void> {
        const hass = this.hass;
        if (!hass || this._controllableEntities.length === 0) {
            return;
        }

        try {
            const payload = await getSharedHelmanStore(hass).getEntityActualHistory();
            if (this.hass?.connection === hass.connection) {
                this._actualHistory = payload.entities;
            }
        } catch (error) {
            console.warn("helman-solar-inspector: failed to load entity history", error);
        }
    }

    /**
     * Loaded when the editor opens rather than with the strip.
     *
     * The band draws no forecast rows here -- the inspector's own charts are
     * the forecast, at far more detail -- so the only thing that needs it is the
     * dialog, and only once somebody asks for one.
     */
    private async _loadForecast(): Promise<void> {
        const hass = this.hass;
        const schedule = this._ownerSnapshot.schedule;
        if (!hass || schedule === null) {
            return;
        }

        const params = deriveScheduleForecastParams(schedule.slots);
        if (params === null) {
            return;
        }

        const key = `${params.granularity}:${params.forecastDays ?? ""}`;
        if (this._forecastLoader === null || this._forecastLoaderKey !== key) {
            this._forecastLoader = new ForecastLoader(params.granularity, params.forecastDays ?? null);
            this._forecastLoaderKey = key;
        }

        try {
            const forecast = await this._forecastLoader.load(hass);
            if (this.hass?.connection === hass.connection) {
                this._forecast = forecast;
            }
        } catch (error) {
            console.error("helman-solar-inspector: failed to load forecast", error);
        }
    }

    /**
     * The schedule as slots, with the one the clock is inside marked.
     *
     * The structure is rebuilt only when the schedule itself changes, but which
     * slot is current is a fact about the clock, so it is re-applied on every
     * pass -- cheaply, since the model is returned unchanged when the answer has
     * not moved. Without it nothing is `isCurrent`, and the forecast's fallback
     * to the battery's live SoC and the live price -- the only readings the
     * in-progress slot has, since the projection starts at the next boundary --
     * never fires, leaving that slot blank in every chart drawn from it. The
     * day it belongs to goes unnamed too, which is what turns the editor's
     * "today" chip back into a date.
     */
    private _rebuildNormalizedIfNeeded(): void {
        const schedule = this._ownerSnapshot.schedule;
        if (
            this._normalizedFor === null
            || this._normalizedFor.schedule !== schedule
            || this._normalizedFor.timeZone !== this.timeZone
        ) {
            this._normalized = buildNormalizedScheduleStructure({
                schedule,
                timeZone: this.timeZone,
                locale: this._locale,
            });
            this._normalizedFor = { schedule, timeZone: this.timeZone };
        }

        this._normalized = applyNormalizedScheduleCurrentState(
            this._normalized,
            this.timeZone,
            new Date(this._nowMs),
        );
    }

    private get _localize(): LocalizeFunction {
        return this._localizeFn ?? ((key: string) => key);
    }

    private get _locale(): string {
        if (this.hass?.locale?.language) {
            return this.hass.locale.language;
        }

        return typeof navigator !== "undefined" ? navigator.language : "cs";
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-schedule-band-strip": HelmanSolarScheduleBandStrip;
    }
}
