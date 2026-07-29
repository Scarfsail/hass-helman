import type { LocalizeFunction } from "../../localize/localize";
import type { ControllableEntityDTO, EntityActualHistorySlotDTO, ForecastPayload } from "../../helman-api";
import { isScheduleEvChargerAction } from "../schedule-types";
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
    isEntityInverterAction,
    selectEntityScheduleDayBlocks,
    type EntityActualSegment,
    type EntityActualSlot,
    type EntityScheduleAction,
    type EntityScheduleBlock,
    type EntityScheduleDay,
    type EntityScheduleDrafts,
    type EntityScheduleLane,
    type EntityScheduleTarget,
} from "./entity-day-schedule-model";
import { getScheduleApplianceById, type ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import {
    buildScheduleVehicleSocSlots,
    EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX,
    getScheduleApplianceRunEnergyProjection,
    type ScheduleApplianceProjectionBadge,
    type ScheduleApplianceProjectionIndex,
} from "./schedule-appliance-projection";
import { getScheduleActionPresentation } from "./schedule-action-presentation";
import { getScheduleApplianceActionPresentation } from "./schedule-appliance-action-presentation";
import { formatScheduleTime } from "./schedule-time";
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
    /**
     * What each block is still projected to consume, keyed by block key.
     *
     * Resolved here rather than in the band because it is a question about the
     * schedule and the projection, and the band draws what it is handed.
     */
    blockProjections: ReadonlyMap<string, ScheduleApplianceProjectionBadge>;
    /**
     * What each charging run does to the vehicle, keyed by block key.
     *
     * Only an EV lane has any, and only for the runs the projection reaches --
     * the charge is a fact about the run, so it lives and dies with the run
     * rather than being smeared across the day around it.
     */
    blockVehicleSoc: ReadonlyMap<string, EntityDayBandBlockSoc>;
}

/** One charging run's projected charge, as the band needs to draw it. */
export interface EntityDayBandBlockSoc {
    /** The run's own slots and where each leaves the vehicle, for the ramp. */
    endPctBySlotId: ReadonlyMap<string, number>;
    /** Where the run finds the vehicle, when the capacity makes that derivable. */
    startPct: number | null;
    /** Where it leaves it. */
    endPct: number;
}

/**
 * How one lane presents a run of its own -- an inverter reads its actions
 * against the inverter's own presentation table, everything else against its
 * appliance's, and both need this same routing. Shared so every surface that
 * draws or summarizes a lane's blocks (the day editor, the inspector's
 * read-only band and its hover popup) tells the same story for the same run.
 */
export function resolveLaneRunPresentation(
    lane: EntityDayBandLane,
    run: { action: EntityScheduleAction },
    localize: LocalizeFunction,
) {
    if (lane.target.kind === "inverter" && isEntityInverterAction(run.action)) {
        return getScheduleActionPresentation(run.action, localize);
    }

    return getScheduleApplianceActionPresentation({
        appliance: lane.appliance ?? { kind: "generic", icon: lane.icon },
        action: run.action === null || isEntityInverterAction(run.action) ? null : run.action,
        localize,
    });
}

/**
 * "08:00–12:00 (4 h)" -- the span answers when, the total answers how much,
 * and for a run that really happened those can differ (it may have spent
 * only part of a slot running), which is why `totalMs` is its own parameter
 * rather than always the span's own length. Shared with the day band's own
 * segment titles so a run reads identically wherever it is summarized.
 */
export function formatLaneRunRange(
    run: { startMs: number; endMs: number },
    locale: string,
    timeZone: string,
    totalMs?: number,
): string {
    const format = (atMs: number): string => formatScheduleTime(atMs, locale, timeZone);
    const hours = (totalMs ?? run.endMs - run.startMs) / 3_600_000;
    const hoursLabel = `${hours.toLocaleString(locale, { maximumFractionDigits: 1 })} h`;
    return `${format(run.startMs)}–${format(run.endMs)} (${hoursLabel})`;
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
    projectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX,
}: {
    lanes: readonly EntityScheduleLane[];
    slots: readonly ScheduleSlot[];
    day: EntityScheduleDay;
    drafts?: EntityScheduleDrafts;
    nowMs: number;
    activeOnly?: boolean;
    /** Projected consumption and SoC; the default index simply draws none. */
    projectionIndex?: ScheduleApplianceProjectionIndex;
}): EntityDayBandLane[] {
    const slotStartMsById = new Map<string, number>(
        slots.map((slot): [string, number] => [slot.id, slot.startMs]),
    );
    return lanes
        .map((lane) => {
            const blocks = selectEntityScheduleDayBlocks(
                buildEntityScheduleBlocks({
                    slots,
                    target: lane.target,
                    draft: drafts[lane.key] ?? {},
                    nowMs,
                }),
                day,
            );
            return {
                key: lane.key,
                name: lane.name,
                icon: lane.icon,
                target: lane.target,
                appliance: lane.appliance,
                isAvailable: lane.isAvailable,
                blocks,
                actualSegments: buildEntityActualSegments({ actualSlots: lane.actualSlots, day }),
                blockProjections: _buildLaneBlockProjections({
                    appliance: lane.appliance,
                    blocks,
                    projectionIndex,
                    slotStartMsById,
                    nowMs,
                }),
                blockVehicleSoc: _buildLaneBlockVehicleSoc({
                    appliance: lane.appliance,
                    blocks,
                    projectionIndex,
                }),
            };
        })
        .filter((lane) => !activeOnly || lane.blocks.length > 0 || lane.actualSegments.length > 0);
}

/**
 * What each of a lane's runs still has left to consume.
 *
 * Only the slots that have not started count. A run's projection is what it is
 * going to draw, and the hours it already drew are not a plan any more -- so an
 * in-progress run's figure shrinks slot by slot instead of standing at its
 * opening estimate all evening, and a finished run carries no figure at all.
 */
function _buildLaneBlockProjections({
    appliance,
    blocks,
    projectionIndex,
    slotStartMsById,
    nowMs,
}: {
    appliance: ScheduleApplianceMetadata | null;
    blocks: readonly EntityScheduleBlock[];
    projectionIndex: ScheduleApplianceProjectionIndex;
    slotStartMsById: ReadonlyMap<string, number>;
    nowMs: number;
}): ReadonlyMap<string, ScheduleApplianceProjectionBadge> {
    const projections = new Map<string, ScheduleApplianceProjectionBadge>();
    if (appliance === null) {
        return projections;
    }

    for (const block of blocks) {
        const action = block.action;
        if (action === null || isEntityInverterAction(action)) {
            continue;
        }

        const slotIds = block.slotIds.filter((slotId) => {
            const startMs = slotStartMsById.get(slotId);
            return startMs !== undefined && startMs >= nowMs;
        });
        if (slotIds.length === 0) {
            continue;
        }

        const projection = getScheduleApplianceRunEnergyProjection({
            projectionIndex,
            applianceKind: appliance.kind,
            applianceId: appliance.id,
            action,
            slotIds,
        });
        if (projection !== null) {
            projections.set(block.key, projection);
        }
    }

    return projections;
}

/**
 * What each of an EV lane's charging runs does to the vehicle.
 *
 * Resolved a run at a time, over that run's own slots: a charge belongs to the
 * run that causes it, and a run is what the band draws. Which vehicle comes
 * from the run's own action rather than from the projection -- a charger with
 * two cars on it emits points for both, and the one the plan names is the one
 * the plan is about.
 */
function _buildLaneBlockVehicleSoc({
    appliance,
    blocks,
    projectionIndex,
}: {
    appliance: ScheduleApplianceMetadata | null;
    blocks: readonly EntityScheduleBlock[];
    projectionIndex: ScheduleApplianceProjectionIndex;
}): ReadonlyMap<string, EntityDayBandBlockSoc> {
    const blockSoc = new Map<string, EntityDayBandBlockSoc>();
    if (appliance === null || appliance.kind !== "ev_charger") {
        return blockSoc;
    }

    for (const block of blocks) {
        const action = block.action;
        if (
            action === null
            || isEntityInverterAction(action)
            || !isScheduleEvChargerAction(action)
        ) {
            continue;
        }

        const vehicleId = _isNonEmptyVehicleId(action.vehicleId) ? action.vehicleId : null;
        const series = buildScheduleVehicleSocSlots({
            projectionIndex,
            applianceId: appliance.id,
            vehicleId,
            batteryCapacityKwh: _resolveVehicleCapacityKwh(appliance, vehicleId),
            slotIds: block.slotIds,
        });
        if (series.length === 0) {
            continue;
        }

        blockSoc.set(block.key, {
            endPctBySlotId: new Map<string, number>(
                series.map((slot): [string, number] => [slot.slotId, slot.endPct]),
            ),
            startPct: series[0].startPct,
            endPct: series[series.length - 1].endPct,
        });
    }

    return blockSoc;
}

/**
 * The named vehicle's capacity, or the only vehicle's when the run names none.
 *
 * A charger with one car does not need the schedule to say which car, so the
 * common case still gets a starting level; with several on it and no name
 * there is no honest answer, and the run reports only where it ends up.
 */
function _resolveVehicleCapacityKwh(
    appliance: ScheduleApplianceMetadata,
    vehicleId: string | null,
): number {
    const vehicles = "vehicles" in appliance ? appliance.vehicles : [];
    if (vehicleId === null) {
        return vehicles.length === 1 ? vehicles[0].batteryCapacityKwh : 0;
    }

    return vehicles.find((vehicle) => vehicle.id === vehicleId)?.batteryCapacityKwh ?? 0;
}

function _isNonEmptyVehicleId(value: string | undefined): value is string {
    return typeof value === "string" && value.trim().length > 0;
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
