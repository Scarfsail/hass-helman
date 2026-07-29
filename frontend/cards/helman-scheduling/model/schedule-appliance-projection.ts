import type {
    ApplianceProjectionMethod,
    ApplianceProjectionPointDTO,
    ApplianceProjectionsPayload,
} from "../../helman-api";
import type { ScheduleApplianceAction } from "../schedule-types";
import {
    isScheduleClimateApplianceAction,
    isScheduleApplianceActionEnabled,
    isScheduleEvChargerAction,
    isScheduleGenericApplianceAction,
} from "../schedule-types";

export interface ScheduleApplianceProjectionPoint {
    vehicleId: string | null;
    mode: string | null;
    expectedVehicleSocPct: number | null;
    energyKwh: number | null;
    projectionMethod: ApplianceProjectionMethod | null;
}

export type ScheduleApplianceProjectionBadge =
    | {
        kind: "vehicle_soc";
        text: string;
        expectedVehicleSocPct: number;
    }
    | {
        kind: "energy";
        text: string;
        energyKwh: number;
        applianceKind: "generic" | "climate" | "aggregate";
        mode: string | null;
        projectionMethod: ApplianceProjectionMethod | null;
    };

export interface ScheduleApplianceProjectionIndex {
    generatedAt: string | null;
    points: ReadonlyMap<string, ReadonlyMap<string, readonly ScheduleApplianceProjectionPoint[]>>;
}

export const EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX: ScheduleApplianceProjectionIndex = {
    generatedAt: null,
    points: new Map(),
};

export function buildScheduleApplianceProjectionIndex(
    payload: ApplianceProjectionsPayload,
): ScheduleApplianceProjectionIndex {
    const points = new Map<string, Map<string, readonly ScheduleApplianceProjectionPoint[]>>();

    for (const [applianceId, projection] of Object.entries(payload.appliances)) {
        if (!_isNonEmptyString(applianceId)) {
            continue;
        }

        const slotPoints = new Map<string, ScheduleApplianceProjectionPoint[]>();
        for (const point of projection.series) {
            const normalized = _normalizeProjectionPoint(point);
            if (normalized === null) {
                continue;
            }

            slotPoints.set(normalized.slotId, [
                ...(slotPoints.get(normalized.slotId) ?? []),
                normalized.point,
            ]);
        }

        if (slotPoints.size > 0) {
            points.set(applianceId, slotPoints);
        }
    }

    if (points.size === 0) {
        return EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
    }

    return {
        generatedAt: payload.generatedAt,
        points,
    };
}

export function getScheduleApplianceProjectionBadge({
    projectionIndex,
    applianceKind,
    applianceId,
    action,
    slotId,
}: {
    projectionIndex: ScheduleApplianceProjectionIndex;
    applianceKind: string | null | undefined;
    applianceId: string;
    action: ScheduleApplianceAction;
    slotId: string;
}): ScheduleApplianceProjectionBadge | null {
    if (isScheduleApplianceActionEnabled(action) !== true) {
        return null;
    }

    const resolvedApplianceKind = _resolveProjectionApplianceKind(applianceKind, action);
    const candidates = projectionIndex.points.get(applianceId)?.get(slotId);
    if (!candidates || candidates.length === 0) {
        return null;
    }

    if (resolvedApplianceKind === "ev_charger" && isScheduleEvChargerAction(action)) {
        const matches = candidates
            .filter((candidate) => _matchesEvProjectedAction(action, candidate))
            .flatMap((candidate) => candidate.expectedVehicleSocPct === null
                ? []
                : [candidate.expectedVehicleSocPct]);
        if (matches.length === 0) {
            return null;
        }

        const expectedVehicleSocPct = Math.max(...matches);
        return {
            kind: "vehicle_soc",
            text: String(expectedVehicleSocPct),
            expectedVehicleSocPct,
        };
    }

    if (resolvedApplianceKind === "generic") {
        const energyPoints = _collectEnergyProjectionPoints(candidates);
        if (energyPoints.length === 0) {
            return null;
        }

        const energyKwh = energyPoints.reduce((sum, candidate) => sum + candidate.energyKwh!, 0);
        return {
            kind: "energy",
            text: _formatEnergyBadgeText(energyKwh),
            energyKwh,
            applianceKind: "generic",
            mode: null,
            projectionMethod: _mergeProjectionMethods(
                energyPoints.map((candidate) => candidate.projectionMethod),
            ),
        };
    }

    if (resolvedApplianceKind === "climate" && isScheduleClimateApplianceAction(action)) {
        const energyPoints = _collectEnergyProjectionPoints(
            candidates.filter((candidate) => _matchesClimateProjectedAction(action, candidate)),
        );
        if (energyPoints.length === 0) {
            return null;
        }

        const energyKwh = energyPoints.reduce((sum, candidate) => sum + candidate.energyKwh!, 0);
        return {
            kind: "energy",
            text: _formatEnergyBadgeText(energyKwh),
            energyKwh,
            applianceKind: "climate",
            mode: action.mode,
            projectionMethod: _mergeProjectionMethods(
                energyPoints.map((candidate) => candidate.projectionMethod),
            ),
        };
    }

    return null;
}

/**
 * What a whole run is projected to consume, whatever appliance it belongs to.
 *
 * `getScheduleApplianceProjectionBadge` answers one slot at a time, and for an
 * EV charger it answers with the vehicle's SoC instead -- the right badge for a
 * chip, but it leaves a charging run with no consumption figure at all. A lane
 * draws runs rather than slots, and the question a run raises is how much it
 * costs, so the energy is summed here for every kind, against the same action
 * matchers the per-slot badge uses.
 *
 * Slots the caller leaves out simply do not count, which is how a run that is
 * half over reports only what it has left to draw.
 */
export function getScheduleApplianceRunEnergyProjection({
    projectionIndex,
    applianceKind,
    applianceId,
    action,
    slotIds,
}: {
    projectionIndex: ScheduleApplianceProjectionIndex;
    applianceKind: string | null | undefined;
    applianceId: string;
    action: ScheduleApplianceAction;
    slotIds: readonly string[];
}): Extract<ScheduleApplianceProjectionBadge, { kind: "energy" }> | null {
    if (isScheduleApplianceActionEnabled(action) !== true) {
        return null;
    }

    const resolvedApplianceKind = _resolveProjectionApplianceKind(applianceKind, action);
    const slotPoints = projectionIndex.points.get(applianceId);
    if (slotPoints === undefined || resolvedApplianceKind === null) {
        return null;
    }

    const matched: ScheduleApplianceProjectionPoint[] = [];
    for (const slotId of slotIds) {
        const candidates = slotPoints.get(slotId);
        if (candidates === undefined) {
            continue;
        }

        matched.push(..._collectEnergyProjectionPoints(
            candidates.filter((candidate) =>
                _matchesRunProjectedAction(resolvedApplianceKind, action, candidate)),
        ));
    }

    if (matched.length === 0) {
        return null;
    }

    const energyKwh = matched.reduce((sum, candidate) => sum + candidate.energyKwh!, 0);
    return {
        kind: "energy",
        text: _formatEnergyBadgeText(energyKwh),
        energyKwh,
        // The badge's own kinds are about how the figure is labelled, and an EV
        // charger's kilowatt-hours are labelled like any other appliance's.
        applianceKind: resolvedApplianceKind === "climate" ? "climate" : "generic",
        mode: resolvedApplianceKind === "climate" && isScheduleClimateApplianceAction(action)
            ? action.mode
            : null,
        projectionMethod: _mergeProjectionMethods(
            matched.map((candidate) => candidate.projectionMethod),
        ),
    };
}

/** What one charging slot does to the vehicle: the level in, the level out. */
export interface ScheduleVehicleSocSlot {
    slotId: string;
    /** Where the slot leaves the vehicle. */
    endPct: number;
    /** Where it found it, or null when the capacity to work that out is missing. */
    startPct: number | null;
}

/**
 * A vehicle's projected charge, slot by slot, for the slots that actually
 * charge it.
 *
 * The backend emits a point only where charging happens, and the SoC it carries
 * is cumulative -- the vehicle's live reading plus everything charged up to
 * that slot -- so a point is where the slot *leaves* the car. The level it
 * found is that minus what the slot itself puts in, which is why the capacity
 * is needed: without it a run can still say where it ends up, just not where it
 * started.
 *
 * Nothing is emitted for the hours in between. A vehicle that is not charging
 * is not doing anything the schedule is responsible for, and drawing its level
 * across the evening would claim the plan put it there.
 */
export function buildScheduleVehicleSocSlots({
    projectionIndex,
    applianceId,
    vehicleId,
    batteryCapacityKwh,
    slotIds,
}: {
    projectionIndex: ScheduleApplianceProjectionIndex;
    applianceId: string;
    vehicleId: string | null;
    batteryCapacityKwh: number;
    slotIds: readonly string[];
}): ScheduleVehicleSocSlot[] {
    const slotPoints = projectionIndex.points.get(applianceId);
    if (slotPoints === undefined) {
        return [];
    }

    const series: ScheduleVehicleSocSlot[] = [];
    for (const slotId of slotIds) {
        let endPct: number | null = null;
        let energyKwh = 0;
        for (const candidate of slotPoints.get(slotId) ?? []) {
            if (candidate.expectedVehicleSocPct === null) {
                continue;
            }
            if (
                vehicleId !== null
                && _isNonEmptyString(candidate.vehicleId)
                && candidate.vehicleId !== vehicleId
            ) {
                continue;
            }

            endPct = endPct === null
                ? candidate.expectedVehicleSocPct
                : Math.max(endPct, candidate.expectedVehicleSocPct);
            energyKwh += candidate.energyKwh ?? 0;
        }

        if (endPct === null) {
            continue;
        }

        const gainPct = batteryCapacityKwh > 0
            ? (energyKwh / batteryCapacityKwh) * 100
            : null;
        series.push({
            slotId,
            endPct,
            startPct: gainPct === null ? null : Math.max(0, Math.round(endPct - gainPct)),
        });
    }

    return series;
}

export function mergeScheduleApplianceProjectionBadges(
    current: ScheduleApplianceProjectionBadge | null,
    next: ScheduleApplianceProjectionBadge | null,
): ScheduleApplianceProjectionBadge | null {
    if (current === null) {
        return next;
    }
    if (next === null || current.kind !== next.kind) {
        return current;
    }

    if (current.kind === "vehicle_soc") {
        const expectedVehicleSocPct = Math.max(current.expectedVehicleSocPct, next.expectedVehicleSocPct);
        return {
            kind: "vehicle_soc",
            text: String(expectedVehicleSocPct),
            expectedVehicleSocPct,
        };
    }

    const energyKwh = current.energyKwh + next.energyKwh;
    return {
        kind: "energy",
        text: _formatEnergyBadgeText(energyKwh),
        energyKwh,
        applianceKind: current.applianceKind,
        mode: _mergeOptionalString(current.mode, next.mode),
        projectionMethod: _mergeProjectionMethods([
            current.projectionMethod,
            next.projectionMethod,
        ]),
    };
}

export function aggregateScheduleApplianceEnergyProjectionBadges(
    badges: readonly (ScheduleApplianceProjectionBadge | null)[],
): Extract<ScheduleApplianceProjectionBadge, { kind: "energy" }> | null {
    const energyBadges = badges.filter((badge): badge is Extract<ScheduleApplianceProjectionBadge, { kind: "energy" }> =>
        badge !== null && badge.kind === "energy");
    if (energyBadges.length === 0) {
        return null;
    }

    const energyKwh = energyBadges.reduce((sum, badge) => sum + badge.energyKwh, 0);
    return {
        kind: "energy",
        text: _formatEnergyBadgeText(energyKwh),
        energyKwh,
        applianceKind: "aggregate",
        mode: null,
        projectionMethod: _mergeProjectionMethods(
            energyBadges.map((badge) => badge.projectionMethod),
        ),
    };
}

function _resolveProjectionApplianceKind(
    applianceKind: string | null | undefined,
    action: ScheduleApplianceAction,
): "ev_charger" | "generic" | "climate" | null {
    if (applianceKind === "ev_charger" || applianceKind === "generic" || applianceKind === "climate") {
        return applianceKind;
    }

    if (isScheduleEvChargerAction(action)) {
        return "ev_charger";
    }

    if (isScheduleGenericApplianceAction(action)) {
        return "generic";
    }

    if (isScheduleClimateApplianceAction(action)) {
        return "climate";
    }

    return null;
}

function _normalizeProjectionPoint(
    point: ApplianceProjectionPointDTO,
): { slotId: string; point: ScheduleApplianceProjectionPoint } | null {
    if (!_isNonEmptyString(point.slotId)) {
        return null;
    }

    const expectedVehicleSocPct = _normalizeSocPct(point.vehicleSoc);
    const energyKwh = _normalizeEnergyKwh(point.energyKwh);
    if (expectedVehicleSocPct === null && energyKwh === null) {
        return null;
    }

    return {
        slotId: point.slotId,
        point: {
            vehicleId: _normalizeOptionalString(point.vehicleId),
            mode: _normalizeOptionalString(point.mode),
            expectedVehicleSocPct,
            energyKwh,
            projectionMethod: _normalizeProjectionMethod(point.projectionMethod),
        },
    };
}

function _matchesEvProjectedAction(
    action: Extract<ScheduleApplianceAction, { charge: boolean }>,
    candidate: ScheduleApplianceProjectionPoint,
): boolean {
    if (
        _isNonEmptyString(action.vehicleId)
        && _isNonEmptyString(candidate.vehicleId)
        && action.vehicleId !== candidate.vehicleId
    ) {
        return false;
    }

    if (
        _isNonEmptyString(action.useMode)
        && _isNonEmptyString(candidate.mode)
        && action.useMode !== candidate.mode
    ) {
        return false;
    }

    return true;
}

function _matchesClimateProjectedAction(
    action: Extract<ScheduleApplianceAction, { mode: string }>,
    candidate: ScheduleApplianceProjectionPoint,
): boolean {
    if (
        _isNonEmptyString(action.mode)
        && _isNonEmptyString(candidate.mode)
        && action.mode !== candidate.mode
    ) {
        return false;
    }

    return true;
}

/** The per-kind action matchers, routed the way the per-slot badge routes them. */
function _matchesRunProjectedAction(
    applianceKind: "ev_charger" | "generic" | "climate",
    action: ScheduleApplianceAction,
    candidate: ScheduleApplianceProjectionPoint,
): boolean {
    if (applianceKind === "ev_charger") {
        return isScheduleEvChargerAction(action)
            && _matchesEvProjectedAction(action, candidate);
    }

    if (applianceKind === "climate") {
        return isScheduleClimateApplianceAction(action)
            && _matchesClimateProjectedAction(action, candidate);
    }

    return true;
}

function _collectEnergyProjectionPoints(
    candidates: readonly ScheduleApplianceProjectionPoint[],
): ScheduleApplianceProjectionPoint[] {
    return candidates.flatMap((candidate) =>
        candidate.energyKwh === null ? [] : [candidate],
    );
}

function _mergeProjectionMethods(
    methods: readonly (ApplianceProjectionMethod | null)[],
): ApplianceProjectionMethod | null {
    const normalizedMethods = methods.filter((method): method is ApplianceProjectionMethod => method !== null);
    if (normalizedMethods.length === 0) {
        return null;
    }

    return normalizedMethods.every((method) => method === normalizedMethods[0])
        ? normalizedMethods[0]
        : null;
}

function _formatEnergyBadgeText(value: number): string {
    if (!Number.isFinite(value)) {
        return "";
    }

    return String(Number(value.toFixed(value >= 10 ? 0 : 1)));
}

function _normalizeProjectionMethod(
    value: ApplianceProjectionPointDTO["projectionMethod"],
): ApplianceProjectionMethod | null {
    return value === "fixed" || value === "history_average" || value === "fixed_fallback"
        ? value
        : null;
}

function _normalizeSocPct(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }

    return Math.max(0, Math.min(100, Math.round(value)));
}

function _normalizeEnergyKwh(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return null;
    }

    return value;
}

function _normalizeOptionalString(value: string | null | undefined): string | null {
    return _isNonEmptyString(value) ? value : null;
}

function _mergeOptionalString(
    current: string | null,
    next: string | null,
): string | null {
    if (current === next) {
        return current;
    }

    return current ?? next;
}

function _isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
