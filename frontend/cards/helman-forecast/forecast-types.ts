export type HelmanForecastMobileDensity = "comfortable" | "compact";

export interface HelmanForecastSectionVisibility {
    solar: boolean;
    grid: boolean;
    battery: boolean;
    house: boolean;
    price: boolean;
}
