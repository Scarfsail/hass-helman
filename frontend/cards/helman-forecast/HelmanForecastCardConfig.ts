import type { LovelaceCardConfig } from "../../hass-frontend/src/data/lovelace/config/card";

export type HelmanForecastMobileDensity = "comfortable" | "compact";

export interface HelmanForecastSectionVisibility {
    solar: boolean;
    grid: boolean;
    battery: boolean;
    house: boolean;
    price: boolean;
}

export interface HelmanForecastCardConfig extends LovelaceCardConfig {
    /** When true, the card background is transparent. Default: false. */
    transparent_background?: boolean;
    /** Layout density used on narrow screens. Default: "comfortable". */
    mobile_density?: HelmanForecastMobileDensity;
    /** Show the solar gauge in each unified day card. Default: true. */
    show_solar_gauge?: boolean;
    /** Show the solar chart in each unified day card. Default: true. */
    show_solar_chart?: boolean;
    /** Show the grid energy gauge in each unified day card. Default: true. */
    show_grid_gauge?: boolean;
    /** Show the battery gauge in each unified day card. Default: false. */
    show_battery_gauge?: boolean;
    /** Show the battery chart in each unified day card. Default: true. */
    show_battery_chart?: boolean;
    /** Show the consumption gauge in each unified day card. Default: false. */
    show_consumption_gauge?: boolean;
    /** Show the consumption chart in each unified day card. Default: false. */
    show_consumption_chart?: boolean;
    /** Show the price chart in each unified day card. Default: true. */
    show_price_chart?: boolean;
}
