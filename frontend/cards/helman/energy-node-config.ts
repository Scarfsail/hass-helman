interface EnergyNodeConfigBase {
    entities: {
        power: string;
    }
}

export interface SolarForecastConfig {
    daily_energy_entity_ids?: string[];
    total_energy_entity_id?: string;
}

export interface SolarNodeConfig extends EnergyNodeConfigBase {
    entities:{
        power: string;
        today_energy?: string;
    }
    forecast?: SolarForecastConfig;
}

export interface GridNodeConfig extends EnergyNodeConfigBase {
    entities:{
        power: string;
        today_export?: string;
        today_import?: string;        
    }
}

export interface HouseForecastConfig {
    total_energy_entity_id: string;
}

export interface HouseNodeConfig extends EnergyNodeConfigBase {
    entities: {
        power: string;
        today_energy?: string;
    }
    forecast?: HouseForecastConfig;
}

export interface BatteryNodeConfig extends EnergyNodeConfigBase {
    forecast?: BatteryForecastConfig;
    entities: {
        power: string;
        capacity?: string;
        min_soc?: string;
        max_soc?: string;
        remaining_energy?: string;
        today_charge_energy?: string;
        today_discharge_energy?: string;
    }
}

export interface BatteryForecastConfig {
    charge_efficiency?: number;
    discharge_efficiency?: number;
    max_charge_power_w?: number;
    max_discharge_power_w?: number;
}

export type EnergyNodeConfig = SolarNodeConfig | GridNodeConfig | HouseNodeConfig | BatteryNodeConfig;
