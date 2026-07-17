import type { LovelaceCardConfig } from "../../hass-frontend/src/data/lovelace/config/card";

export interface HelmanSolarInspectorCardConfig extends LovelaceCardConfig {
    /** When true, the card background is transparent. Default: false. */
    transparent_background?: boolean;
    /**
     * Solar power at or above which a slot counts as carrying sun energy, in
     * watts. Sets where the "hours with solar energy" view crops the day.
     * Default: 100.
     */
    daylight_threshold_w?: number;
    /**
     * Whether the "hours with solar energy" view is on when the card first opens.
     * The header toggle still overrides it at runtime. Default: true.
     */
    daylight_only_default?: boolean;
    /**
     * Slot width the chart is bucketed into when the card first opens, in
     * minutes. One of 15, 30 or 60. The header toggle still overrides it at
     * runtime. When unset the width is chosen from the page width — a phone opens
     * at 60, a laptop at 30.
     */
    slot_minutes?: 15 | 30 | 60;
}
