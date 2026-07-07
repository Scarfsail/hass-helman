import type { LovelaceCardConfig } from "../../hass-frontend/src/data/lovelace/config/card";

// No entity config required — all entity IDs are discovered from the helman backend.
export interface HelmanSimpleCardConfig extends LovelaceCardConfig {
    /** Overall card grid width in pixels. Default: 200. */
    width?: number;
    /** Overall card grid height in pixels. Default: auto (content-sized). */
    height?: number;
    /** When true, the card background is transparent. Default: false. */
    transparent_background?: boolean;
}
