import type { HomeAssistant } from "../../hass-frontend/src/types";

/**
 * Deciding whether a new `hass` object means anything.
 *
 * Home Assistant replaces `hass` on every state change anywhere in the house —
 * measured here at 17-24 times a second — and Lit re-renders on identity. A card
 * that forwards every replacement re-renders at that rate forever. See
 * `frontend/cards/README.md`, "Card rendering discipline", for the rule these
 * two predicates exist to make followable.
 *
 * Both are deliberately policy-free: they answer "did this change?" and nothing
 * else. What an *empty* watch set means is a per-card decision and stays in the
 * card's own setter — `helman-card` reads it as "the device tree has not
 * hydrated yet, pass everything through", `helman-solar-inspector-card` reads
 * it as "watch nothing", and both are right for their own tree.
 */

/** Did any of the watched entities' state objects change identity? */
export function watchedEntityChanged(
    previous: HomeAssistant | undefined,
    next: HomeAssistant,
    watchedEntityIds: Iterable<string>,
): boolean {
    if (!previous) return true;
    for (const id of watchedEntityIds) {
        if (previous.states[id] !== next.states[id]) return true;
    }
    return false;
}

/**
 * Did anything a card reads *through* `hass` — rather than out of `hass.states`
 * — change?
 *
 * Four fields, each with a traced reader: `connection` (every `callWS`, and the
 * `WeakMap` key of the shared schedule owner, data-changed feed, Helman store
 * and forecast loader — a new one means everything loaded through the old one is
 * stale), `config.time_zone` (the inspector's `_haTimeZone()` and
 * `ScheduleOwnerImpl.updateHass`), `language` (`getLocalizeFunction`) and
 * `locale.language` (the `_locale` getters driving all `Intl` date formatting in
 * the band, the pills and the day editor).
 *
 * `hass.themes` is deliberately *not* compared. It was proposed on the theory
 * that HA's `state-badge` reads it for dark-mode state colouring, but that
 * dependency was never confirmed against the pinned `hass-frontend`; most of the
 * badge's colour arrives through document-level CSS custom properties, which
 * reach the subtree whatever `hass`'s identity is. It goes in if a stale-colour
 * bug actually appears, when there is a symptom to verify the fix against.
 */
export function hassContextChanged(
    previous: HomeAssistant | undefined,
    next: HomeAssistant,
): boolean {
    return !previous
        || previous.connection !== next.connection
        || previous.config?.time_zone !== next.config?.time_zone
        || previous.language !== next.language
        || previous.locale?.language !== next.locale?.language;
}

/**
 * Bubbled up by anything inside a card that has resolved entity ids the card
 * must watch, so the card at the top can filter `hass` without duplicating the
 * fetch that discovered them.
 *
 * The detail carries the dispatcher's *whole* set, never a delta, and the card
 * unions the sets it receives. Composed as well as bubbling: every dispatcher is
 * at least one shadow root deep inside its card.
 */
export const WATCHED_ENTITIES_EVENT = "helman-watched-entities";

export interface WatchedEntitiesDetail {
    entityIds: readonly string[];
}

/** Dispatch a watched-entity set from inside a card's shadow tree. */
export function dispatchWatchedEntities(
    element: EventTarget,
    entityIds: readonly string[],
): void {
    element.dispatchEvent(
        new CustomEvent<WatchedEntitiesDetail>(WATCHED_ENTITIES_EVENT, {
            bubbles: true,
            composed: true,
            detail: { entityIds },
        }),
    );
}
