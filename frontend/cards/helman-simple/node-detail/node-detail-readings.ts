import type { HomeAssistant } from "../../../hass-frontend/src/types";

/**
 * A reading as a node detail shows it: its state and unit, `null` when the
 * entity is missing, unavailable or unknown. A switch reads through `onOff`.
 */
export function readingText(
    hass: HomeAssistant,
    entityId: string | null | undefined,
    onOff: (on: boolean) => string,
): string | null {
    const stateObj = entityId ? hass.states[entityId] : undefined;
    if (!stateObj || stateObj.state === "unavailable" || stateObj.state === "unknown") return null;
    if (stateObj.state === "on" || stateObj.state === "off") return onOff(stateObj.state === "on");
    const unit = stateObj.attributes.unit_of_measurement as string | undefined;
    return unit ? stateObj.state + " " + unit : stateObj.state;
}

/** A reading as a number, `null` when missing or not numeric. */
export function readingNumber(hass: HomeAssistant, entityId: string | null | undefined): number | null {
    const raw = entityId ? hass.states[entityId]?.state : undefined;
    const value = raw === undefined ? NaN : parseFloat(raw);
    return Number.isFinite(value) ? value : null;
}

/**
 * Fired by a node detail with the entity ids it reads live. The card only
 * re-renders on entities it watches, so it adds these while the detail is open.
 */
export const WATCH_ENTITIES_EVENT = "helman-watch-entities";

export function announceWatchedEntities(element: HTMLElement, entityIds: Iterable<string | null | undefined>): void {
    const ids = [...new Set([...entityIds].filter((id): id is string => !!id))];
    element.dispatchEvent(new CustomEvent<string[]>(WATCH_ENTITIES_EVENT, { detail: ids, bubbles: true, composed: true }));
}
