import type { LovelaceCardConfig } from "../../types/ha";
export type { HelmanUiConfig } from "../helman-api";

export interface HelmanCardConfig extends LovelaceCardConfig {
    card_size?: number;
    max_power?: number;
    collapsed_consumers_count?: number;
    /** While a "Group by" filter is active, list groups with no devices; default false. */
    show_empty_groups?: boolean;
    /** While a "Group by" filter is active, list ungrouped devices under Others; default true. */
    show_others_group?: boolean;
}
