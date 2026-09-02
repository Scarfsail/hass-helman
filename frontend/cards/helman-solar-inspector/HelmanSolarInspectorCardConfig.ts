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
    /**
     * When true, the bias-correction diagnostics are visible from the moment the
     * card opens: the uncorrected ("raw") forecast overlay on the chart, the
     * correction-impact strip below it, and in the selected-slot detail the
     * fitted per-slot factor (the actual-over-forecast bias ratio) and the
     * training-contribution table. The chart legend and the strip's own switch
     * can still hide them again at runtime. Default: false.
     */
    show_bias_ratio?: boolean;
    /**
     * When true, a chart column whose data is incomplete — a slot the sensor
     * behind one of its series published nothing for — is drawn dimmed, so a
     * column that is short of readings cannot be read as one that was genuinely
     * low. Default: true.
     *
     * Turning it off removes only the dimming. The daily total of an incomplete
     * series still carries its marker, and the selected-slot panel still names
     * what is missing: those state a number's limits rather than colouring the
     * chart, and a total that quietly reads low is the thing worth knowing
     * whatever the chart looks like.
     */
    dim_incomplete_slots?: boolean;
}
