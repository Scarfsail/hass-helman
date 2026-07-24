import type { HassEntity } from "home-assistant-js-websocket";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { ControllableEntityDTO } from "../../helman-api";

const UNAVAILABLE_STATES = new Set(["unknown", "unavailable", ""]);

/** A controllable entity that is currently not in its resting state. */
export interface RunningEntity extends ControllableEntityDTO {
    stateObj: HassEntity;
}

/**
 * Which of the entities Helman can drive are currently running.
 *
 * The controllable set only changes with the config, so it is fetched once;
 * this filters it against live `hass.states` on every update, which is what
 * keeps the card's list reactive without polling. An entity is running exactly
 * when its state differs from the resting state the backend reported.
 *
 * Entities that cannot be read are left out rather than guessed at: an
 * unavailable entity is not something the user can act on from the card.
 */
export function buildRunningEntities({
    controllableEntities,
    states,
}: {
    controllableEntities: readonly ControllableEntityDTO[];
    states: HomeAssistant["states"] | undefined;
}): RunningEntity[] {
    if (!states) {
        return [];
    }

    const running: RunningEntity[] = [];
    for (const entity of controllableEntities) {
        const stateObj = states[entity.entityId];
        if (!stateObj || UNAVAILABLE_STATES.has(stateObj.state)) {
            continue;
        }
        if (stateObj.state === entity.normalState) {
            continue;
        }
        running.push({ ...entity, stateObj });
    }
    return running;
}
