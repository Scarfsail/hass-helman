import type { ControllableEntityDTO, EntityActualHistorySlotDTO, ForecastPayload } from "../../helman-api";
import type { ScheduleDisplaySlot, ScheduleSlot } from "../schedule-types";
import {
    resolveScheduleActionFromEntityState,
    type ControllableEntityStatus,
} from "./controllable-entity-status";
import {
    buildElapsedScheduleSlots,
    buildEntityActualSegments,
    buildEntityScheduleBlocks,
    getEntityScheduleTargetKey,
    selectEntityScheduleDayBlocks,
    type EntityActualSegment,
    type EntityActualSlot,
    type EntityScheduleBlock,
    type EntityScheduleDay,
    type EntityScheduleDrafts,
    type EntityScheduleLane,
    type EntityScheduleTarget,
} from "./entity-day-schedule-model";
import { getScheduleApplianceById, type ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import {
    buildSlotForecastProjection,
    materializeSlotForecastMap,
    type SlotForecastPoint,
} from "./slot-forecast-model";

/**
 * The day-band's raw material, assembled the same way wherever it is drawn.
 *
 * Both the scheduling card and the solar inspector show the same day of the
 * same house, so both need the same three things: a roster of lanes, the slots
 * those lanes are drawn over, and the forecast behind them. Keeping the
 * assembly here rather than in either card is what stops the two surfaces from
 * drifting into two subtly different answers to "what is the boiler doing
 * today" -- which, with the same click opening the same editor from both, would
 * be a bug the user could see.
 *
 * Everything here is pure: the callers own the fetching, the caching and the
 * "is this still the connection I asked on" guards, because those belong to a
 * component's lifecycle and not to the model.
 */

/**
 * The roster of tracks: every controllable entity whose lane can be authored.
 *
 * Ordered inverter first and then by name rather than by what happens to be
 * running, because these are stacked timelines -- a row that moves between
 * refreshes is a row nobody can point at.
 */
export function buildEntityScheduleLanes({
    statuses,
    controllableEntities,
    appliances,
    actualHistory,
    slotDurationMs,
    locale,
}: {
    statuses: readonly ControllableEntityStatus[];
    controllableEntities: readonly ControllableEntityDTO[];
    appliances: readonly ScheduleApplianceMetadata[];
    actualHistory: Readonly<Record<string, EntityActualHistorySlotDTO[]>>;
    slotDurationMs: number;
    locale: string;
}): EntityScheduleLane[] {
    return statuses
        .flatMap((status) => {
            const target = status.scheduleTarget;
            if (target === null) {
                return [];
            }

            const appliance = target.kind === "inverter"
                ? null
                : getScheduleApplianceById(appliances, target.applianceId);
            return [{
                key: getEntityScheduleTargetKey(target),
                target,
                name: status.name,
                icon: (status.stateObj.attributes.icon as string | undefined)
                    ?? appliance?.icon
                    ?? "mdi:flash-outline",
                appliance,
                isAvailable: status.isAvailable,
                actualSlots: buildEntityLaneActualSlots({
                    entityId: status.entityId,
                    controllableEntities,
                    actualHistory,
                    slotDurationMs,
                }),
            }];
        })
        .sort((left, right) => {
            if ((left.target.kind === "inverter") !== (right.target.kind === "inverter")) {
                return left.target.kind === "inverter" ? -1 : 1;
            }

            return left.name.localeCompare(right.name, locale);
        });
}

/**
 * One entity's elapsed runs, as actions on the schedule's grid.
 *
 * The recorder speaks in entity states; everything the band draws speaks in
 * schedule actions, so the translation happens here, once, where the entity's
 * own definition of its states is still at hand.
 */
export function buildEntityLaneActualSlots({
    entityId,
    controllableEntities,
    actualHistory,
    slotDurationMs,
}: {
    entityId: string;
    controllableEntities: readonly ControllableEntityDTO[];
    actualHistory: Readonly<Record<string, EntityActualHistorySlotDTO[]>>;
    slotDurationMs: number;
}): EntityActualSlot[] {
    const history = actualHistory[entityId];
    const entity = controllableEntities.find((candidate) => candidate.entityId === entityId);
    if (history === undefined || entity === undefined) {
        return [];
    }

    return history.flatMap((entry) => {
        const startMs = new Date(entry.slot).getTime();
        const action = resolveScheduleActionFromEntityState({ entity, state: entry.state });
        return Number.isNaN(startMs) || action === null
            ? []
            : [{ startMs, endMs: startMs + slotDurationMs, action, ratio: entry.ratio }];
    });
}

/** One entity's row of the band: its schedule for the day, already clipped. */
export interface EntityDayBandLane {
    key: string;
    name: string;
    icon: string;
    target: EntityScheduleTarget;
    appliance: ScheduleApplianceMetadata | null;
    blocks: readonly EntityScheduleBlock[];
    /** What the entity really did earlier today, already merged into runs. */
    actualSegments: readonly EntityActualSegment[];
    isAvailable: boolean;
}

/**
 * The roster resolved onto one day: what each lane has planned and what it
 * already did.
 *
 * `drafts` is the dialog's unsaved work; a read-only surface passes none and
 * gets the schedule as stored. `activeOnly` drops the lanes with nothing on
 * them at all, which is what a surface with no room for an empty track wants --
 * the dialog keeps them, because an entity you cannot see is an entity you
 * cannot schedule.
 */
export function buildEntityDayBandLanes({
    lanes,
    slots,
    day,
    drafts = {},
    nowMs,
    activeOnly = false,
}: {
    lanes: readonly EntityScheduleLane[];
    slots: readonly ScheduleSlot[];
    day: EntityScheduleDay;
    drafts?: EntityScheduleDrafts;
    nowMs: number;
    activeOnly?: boolean;
}): EntityDayBandLane[] {
    return lanes
        .map((lane) => ({
            key: lane.key,
            name: lane.name,
            icon: lane.icon,
            target: lane.target,
            appliance: lane.appliance,
            isAvailable: lane.isAvailable,
            blocks: selectEntityScheduleDayBlocks(
                buildEntityScheduleBlocks({
                    slots,
                    target: lane.target,
                    draft: drafts[lane.key] ?? {},
                    nowMs,
                }),
                day,
            ),
            actualSegments: buildEntityActualSegments({ actualSlots: lane.actualSlots, day }),
        }))
        .filter((lane) => !activeOnly || lane.blocks.length > 0 || lane.actualSegments.length > 0);
}

export interface EntityScheduleDayView {
    /** Today padded back to midnight, then the horizon the backend serves. */
    slots: ScheduleSlot[];
    forecastPoints: ReadonlyMap<string, SlotForecastPoint>;
}

/**
 * Today back to midnight, with the forecast for the hours that have gone.
 *
 * The elapsed slots hold no schedule -- the backend prunes them -- so they are
 * forecast-only as far as the projection is concerned, which is exactly what
 * they are: hours with weather and prices but nothing left to edit.
 *
 * `baseForecastPoints` are whatever the caller already has for the horizon
 * slots, and they win: a caller that has built a full projection for those
 * hours has resolved more than a bare re-projection can (the current slot's
 * live SoC and price, for one), so re-deriving them here would be a downgrade.
 */
export function buildEntityScheduleDayView({
    scheduleSlots,
    timeZone,
    locale,
    forecast,
    baseForecastPoints,
}: {
    scheduleSlots: readonly ScheduleSlot[];
    timeZone: string;
    locale: string;
    forecast: ForecastPayload | null;
    baseForecastPoints: ReadonlyMap<string, SlotForecastPoint>;
}): EntityScheduleDayView {
    const elapsedSlots = buildElapsedScheduleSlots({ slots: scheduleSlots, timeZone, locale });
    if (elapsedSlots.length === 0) {
        return { slots: [...scheduleSlots], forecastPoints: baseForecastPoints };
    }

    const displaySlots: ScheduleDisplaySlot[] = elapsedSlots.map((slot) => ({
        ...slot,
        source: "forecast_only",
        scheduleSlot: null,
    }));
    const projection = buildSlotForecastProjection(forecast, displaySlots);
    return {
        slots: [...elapsedSlots, ...scheduleSlots],
        forecastPoints: new Map([
            ...materializeSlotForecastMap(projection, displaySlots).points,
            ...baseForecastPoints,
        ]),
    };
}
