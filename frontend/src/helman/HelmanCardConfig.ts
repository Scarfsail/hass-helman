import type { LovelaceCardConfig } from "../../hass-frontend/src/data/lovelace/config/card";
export type { HelmanUiConfig } from "../helman-api";

export interface HelmanCardConfig extends LovelaceCardConfig {
    card_size?: number;
    max_power?: number;
}
