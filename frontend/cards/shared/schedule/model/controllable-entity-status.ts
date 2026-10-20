import { isReadableState } from "../../power-reading";
import type { HassEntity } from "home-assistant-js-websocket";
import type { HomeAssistant } from "../../../../types/ha";
import type { EntityScheduleTarget } from "./entity-day-schedule-model";
import {
    describeScheduleAppliance,
    type ScheduleApplianceDescriptor,
    type ScheduleApplianceMetadata,
    type ScheduleControllable,
} from "./schedule-appliance-metadata";
import type {
    ScheduleApplianceAction,
    ScheduleActionKind,
    ScheduleInverterAction,
    ScheduleSetBy,
    ScheduleSlot,
} from "../schedule-types";
import { isScheduleInverterAction } from "../schedule-types";
import { APPLIANCE_KIND_UI } from "./schedule-appliance-kind-ui";

/**
 * One state of one controllable entity, expressed the way the slot editor
 * expresses it.
 *
 * Live state and scheduled state share this shape on purpose: the card can then
 * render "what it is doing now" and "what it will do next" with the very same
 * chips, so the two always read in the same vocabulary.
 */
export type ControllableEntityStateView =
    | { domain: "inverter"; action: ScheduleInverterAction; setBy: ScheduleSetBy | null }
    | {
        domain: "appliance";
        appliance: ScheduleApplianceDescriptor;
        action: ScheduleApplianceAction | null;
        /**
         * Who put this state in the schedule, or null when the schedule has no
         * say in it -- an entity at rest with nothing scheduled, or one somebody
         * switched on by hand.
         */
        setBy: ScheduleSetBy | null;
    };

/** The next scheduled state change, and what the entity changes into. */
export interface ControllableEntityTransition {
    atMs: number;
    view: ControllableEntityStateView;
}

export interface ControllableEntityStatus {
    entityId: string;
    name: string;
    stateObj: HassEntity;
    /**
     * The entity's state can be read right now.
     *
     * An unreachable appliance is still listed: it is configured hardware, and
     * its schedule is stored data that stays editable while the thing itself is
     * offline. What cannot be shown for it is what it is doing.
     */
    isAvailable: boolean;
    /** The entity sits in its resting state, so it is not doing anything. */
    isNormal: boolean;
    /** What the entity is doing, or null when its state cannot be read. */
    current: ControllableEntityStateView | null;
    /**
     * When the entity entered its current state, from the entity itself.
     * Only resolved while execution is enabled and the entity is non-normal:
     * with execution off nothing is driving it, so "since" tells no story about
     * the schedule.
     */
    sinceMs: number | null;
    /**
     * The first scheduled change after now, or null when the schedule keeps the
     * entity as it is for the rest of the horizon. Only resolved while
     * execution is enabled -- with execution off the schedule is not driving
     * anything, so announcing a change would be a lie.
     */
    next: ControllableEntityTransition | null;
    /**
     * The entity's lane in the schedule, or null when it has none the card can
     * author -- an appliance that does not support authoring is still worth
     * listing, but not worth offering an editor for.
     */
    scheduleTarget: EntityScheduleTarget | null;
}

/**
 * Every entity Helman can drive, with its live state and its next scheduled
 * change, in the order the configuration lists them.
 *
 * The controllable set only changes with the config, so it is fetched once;
 * this resolves it against live `hass.states` on every update, which is what
 * keeps the card reactive without polling.
 *
 * Everything configured is listed, including entities that are currently
 * unreachable -- the list doubles as the roster of controllable hardware, and a
 * missing row reads as "not configured". Only an entity Home Assistant does not
 * know at all is left out, because there is nothing to render it from.
 */
export function buildControllableEntityStatuses({
    controllables,
    states,
    slots,
    nowMs,
    executionEnabled,
}: {
    controllables: readonly ScheduleControllable[];
    states: HomeAssistant["states"] | undefined;
    slots: readonly ScheduleSlot[];
    nowMs: number;
    executionEnabled: boolean;
}): ControllableEntityStatus[] {
    if (!states) {
        return [];
    }

    const activeSlot = slots.find((slot) => slot.isCurrent) ?? null;

    const statuses: ControllableEntityStatus[] = [];
    for (const entity of controllables) {
        const stateObj = states[entity.primaryEntityId];
        if (!stateObj) {
            continue;
        }

        const isAvailable = isReadableState(stateObj.state);
        // An entity nobody can read is not "running", so it counts as at rest
        // rather than as doing something.
        const isNormal = !isAvailable || stateObj.state === entity.normalState;
        const current = isAvailable
            ? _buildLiveStateView({
                entity,
                state: stateObj.state,
                states,
                activeSlot,
                setBy: _readAssignmentSetBy(entity, activeSlot),
                unscheduled: executionEnabled
                    && isNormal
                    && _readCommittedApplianceAction(activeSlot, entity.id) === null,
            })
            : null;

        statuses.push({
            entityId: entity.primaryEntityId,
            // The Helman-configured name is what the user named the appliance
            // in this integration, so it is the more meaningful label here;
            // the entity's own friendly name is the fallback.
            name: entity.name
                || (stateObj.attributes.friendly_name as string | undefined)
                || entity.primaryEntityId,
            stateObj,
            isAvailable,
            isNormal,
            current,
            sinceMs: executionEnabled && !isNormal
                ? _readLastChangedMs(stateObj)
                : null,
            next: executionEnabled
                ? _resolveNextTransition({
                    entity,
                    // An unreadable entity is assumed to be at rest, so "next"
                    // answers "when will the schedule next do something with
                    // it?" rather than treating unavailability as a state the
                    // schedule is about to change.
                    currentState: isAvailable ? stateObj.state : entity.normalState,
                    slots,
                    nowMs,
                })
                : null,
            // The inverter's entry carries its reserved id, so every lane is
            // keyed by the roster's own id.
            scheduleTarget: entity.supportsAuthoring ? entity.id : null,
        });
    }

    // Left in the roster's own order, which is the order the controllables were
    // configured in: the surfaces that draw them are stacked timelines, and they
    // want a row that stays where the user put it rather than one that jumps as
    // things switch on and off.
    return statuses;
}

function _buildLiveStateView({
    entity,
    state,
    states,
    activeSlot,
    setBy,
    unscheduled,
}: {
    entity: ScheduleControllable;
    state: string;
    states: HomeAssistant["states"];
    activeSlot: ScheduleSlot | null;
    setBy: ScheduleSetBy | null;
    unscheduled: boolean;
}): ControllableEntityStateView {
    if (entity.kind === "inverter") {
        return {
            domain: "inverter",
            action: _buildLiveInverterAction({ entity, state, activeSlot }),
            setBy,
        };
    }

    return {
        domain: "appliance",
        appliance: describeScheduleAppliance(entity),
        // Nothing scheduled means nobody authored what the entity is doing, so
        // the chip is left undecorated rather than credited to the schedule.
        setBy: unscheduled ? null : setBy,
        // An appliance sitting at rest with nothing scheduled for it is not
        // being "turned off" -- the schedule simply has no opinion, which is
        // what the slot editor calls "no action". Say that instead of restating
        // the resting state as if it were a decision.
        action: unscheduled
            ? null
            : _buildLiveApplianceAction({ entity, state, states }),
    };
}

/**
 * The active slot's action for an appliance, if it is one that will be applied.
 *
 * Candidates (`conditionMet === false`) are never executed, so they count as
 * nothing being scheduled.
 */
export function _readCommittedApplianceAction(
    activeSlot: ScheduleSlot | null,
    applianceId: string | null,
): ScheduleApplianceAction | null {
    if (activeSlot === null || applianceId === null) {
        return null;
    }

    const action = activeSlot.assignments[applianceId]?.action ?? null;
    return action === null || action.conditionMet === false
        ? null
        : (action as ScheduleApplianceAction);
}

/**
 * The live inverter mode, as the schedule action that selects it.
 *
 * The mode entity alone cannot say which target SoC a charge/discharge mode is
 * working towards, so the active slot supplies it when it agrees on the kind.
 * An option Helman does not drive maps to "empty": honest about the fact that
 * no schedule action put it there.
 */
function _buildLiveInverterAction({
    entity,
    state,
    activeSlot,
}: {
    entity: ScheduleControllable;
    state: string;
    activeSlot: ScheduleSlot | null;
}): ScheduleInverterAction {
    const kind = _resolveInverterActionKind(entity, state);
    if (kind === null) {
        return { kind: "empty" };
    }

    const scheduled = activeSlot?.assignments[entity.id]?.action ?? null;
    const scheduledAction =
        scheduled !== null && isScheduleInverterAction(scheduled) ? scheduled : null;
    if (scheduledAction !== null && scheduledAction.kind === kind && scheduledAction.targetSoc !== undefined) {
        return { kind, targetSoc: scheduledAction.targetSoc };
    }

    return { kind };
}

function _resolveInverterActionKind(
    entity: ScheduleControllable,
    state: string,
): ScheduleActionKind | null {
    for (const [kind, option] of Object.entries(entity.actionOptions ?? {})) {
        if (option === state) {
            return kind as ScheduleActionKind;
        }
    }

    return null;
}

/**
 * The live appliance state, as the schedule action that produces it.
 *
 * A running EV charger takes its mode from the charger's own select entities
 * rather than from the schedule, so the chip describes what the hardware is
 * actually doing even when a person set it by hand.
 */
function _buildLiveApplianceAction({
    entity,
    state,
    states,
}: {
    entity: ScheduleApplianceMetadata;
    state: string;
    states: HomeAssistant["states"];
}): ScheduleApplianceAction | null {
    const action = resolveScheduleActionFromEntityState({ entity, state }) as ScheduleApplianceAction;
    if (entity.kind === "ev_charger" && "charge" in action && action.charge) {

        // Only the live view can say which mode a running charger is in: it
        // reads the charger's own selects, which the recorder is not asked for.
        const useMode = _readOptionalState(states, entity.controls.useMode.entityId);
        const ecoGear = _readOptionalState(states, entity.controls.ecoGear.entityId);
        return {
            charge: true,
            ...(useMode === "ECO" || useMode === "Fast" ? { useMode } : {}),
            ...(ecoGear === null ? {} : { ecoGear }),
        };
    }

    return action;
}

/**
 * The first slot after now whose scheduled state differs from the live one.
 *
 * Only future slots count. A slot that is already running yet disagrees with
 * the hardware is a reconciliation gap, not a scheduled change, and reporting
 * its start time would put a change "at" a moment already past.
 */
function _resolveNextTransition({
    entity,
    currentState,
    slots,
    nowMs,
}: {
    entity: ScheduleControllable;
    currentState: string;
    slots: readonly ScheduleSlot[];
    nowMs: number;
}): ControllableEntityTransition | null {
    const futureSlots = slots
        .filter((slot) => slot.startMs > nowMs)
        .sort((left, right) => left.startMs - right.startMs);

    for (const slot of futureSlots) {
        const action = slot.assignments[entity.id]?.action ?? null;
        const projectedState = _projectEntityState({ entity, action });
        if (projectedState === currentState) {
            continue;
        }

        return {
            atMs: slot.startMs,
            view: _buildScheduledStateView({
                entity,
                action,
                projectedState,
                setBy: _readAssignmentSetBy(entity, slot),
            }),
        };
    }

    return null;
}

/**
 * A scheduled action as the state it will leave the entity in.
 *
 * Built from the projected state rather than the raw action so that "no action"
 * and "candidate" read as the resting state the executor will actually apply,
 * not as the blank the schedule stores them as. The raw action still supplies
 * the detail the state string cannot carry, such as a charge target.
 */
function _buildScheduledStateView({
    entity,
    action,
    projectedState,
    setBy,
}: {
    entity: ScheduleControllable;
    action: ScheduleInverterAction | ScheduleApplianceAction | null;
    projectedState: string;
    setBy: ScheduleSetBy | null;
}): ControllableEntityStateView {
    if (entity.kind === "inverter") {
        const kind = _resolveInverterActionKind(entity, projectedState) ?? "normal";
        const inverterAction = action as ScheduleInverterAction | null;
        return {
            domain: "inverter",
            action: inverterAction !== null && inverterAction.kind === kind && inverterAction.targetSoc !== undefined
                ? { kind, targetSoc: inverterAction.targetSoc }
                : { kind },
            setBy,
        };
    }

    const projectedAction = _projectedApplianceAction(action as ScheduleApplianceAction | null);
    return {
        domain: "appliance",
        appliance: describeScheduleAppliance(entity),
        action: projectedAction,
        setBy: projectedAction === null ? null : setBy,
    };
}

/** Who authored this entity's action in a slot, if anyone did. */
function _readAssignmentSetBy(
    entity: ScheduleControllable,
    slot: ScheduleSlot | null,
): ScheduleSetBy | null {
    return slot?.assignments[entity.id]?.setBy ?? null;
}

/**
 * The entity state a scheduled action will produce.
 *
 * Candidates (`conditionMet === false`) are never executed, and a slot with no
 * action for an appliance stops it, so both land on the resting state -- which
 * is what makes "does this slot change anything?" a plain string comparison.
 */
export function _projectEntityState({
    entity,
    action,
}: {
    entity: ScheduleControllable;
    action: ScheduleInverterAction | ScheduleApplianceAction | null;
}): string {
    if (action === null || action.conditionMet === false) {
        return entity.normalState;
    }

    if (entity.kind === "inverter") {
        const inverterAction = action as ScheduleInverterAction;
        // "empty" leaves no override standing: the executor restores the normal
        // mode when a previous slot had driven the inverter elsewhere.
        if (inverterAction.kind === "empty") {
            return entity.normalState;
        }

        return entity.actionOptions?.[inverterAction.kind] ?? entity.normalState;
    }

    return APPLIANCE_KIND_UI[entity.kind].stateFromAction(action as ScheduleApplianceAction);
}

/**
 * The appliance action to show for a slot.
 *
 * A slot with no action -- or only a candidate, which is never executed -- has
 * nothing scheduled, and the chip says exactly that rather than spelling out
 * the stop it implies. It matches how the slot editor labels the same slot.
 */
function _projectedApplianceAction(
    action: ScheduleApplianceAction | null,
): ScheduleApplianceAction | null {
    return action !== null && action.conditionMet !== false ? action : null;
}

/**
 * The schedule action that would have produced an entity state.
 *
 * Read in the opposite direction from the rest of this module -- state to
 * action rather than action to state -- because that is how the past has to be
 * read: the recorder kept what the entity was, and the card draws actions.
 */
export function resolveScheduleActionFromEntityState({
    entity,
    state,
}: {
    entity: ScheduleControllable;
    state: string;
}): ScheduleInverterAction | ScheduleApplianceAction | null {
    if (entity.kind === "inverter") {
        const kind = _resolveInverterActionKind(entity, state);
        return kind === null ? null : { kind };
    }

    return APPLIANCE_KIND_UI[entity.kind].actionFromState(state);
}

function _readOptionalState(
    states: HomeAssistant["states"],
    entityId: string,
): string | null {
    const state = states[entityId]?.state;
    return isReadableState(state) ? state : null;
}

function _readLastChangedMs(stateObj: HassEntity): number | null {
    const lastChangedMs = new Date(stateObj.last_changed).getTime();
    return Number.isNaN(lastChangedMs) ? null : lastChangedMs;
}
