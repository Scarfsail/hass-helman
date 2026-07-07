import type { LovelaceCardConfig } from "../../hass-frontend/src/data/lovelace/config/card";

export interface HelmanSolarInspectorCardConfig extends LovelaceCardConfig {
    /** When true, the card background is transparent. Default: false. */
    transparent_background?: boolean;
}
