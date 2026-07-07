interface PowerDeviceConfigBase {
    entities: {
        power: string;
    }
    source_name?: string;
    consumption_name?: string;
    power_sensor_label?: string;
    power_switch_label?: string;
}

export interface SolarForecastConfig {
    daily_energy_entity_ids?: string[];
    total_energy_entity_id?: string;
}

export interface SolarDeviceConfig extends PowerDeviceConfigBase {
    entities:{
        power: string;
        today_energy?: string;
        remaining_today_energy_forecast?: string;
    }
    forecast?: SolarForecastConfig;
}

export interface GridDeviceConfig extends PowerDeviceConfigBase {
    entities:{
        power: string;
        today_export?: string;
        today_import?: string;        
    }
}

export interface HouseForecastDeferrableConsumerConfig {
    energy_entity_id: string;
    label?: string;
}

export interface HouseForecastConfig {
    total_energy_entity_id: string;
    min_history_days?: number;
    training_window_days?: number;
    deferrable_consumers?: HouseForecastDeferrableConsumerConfig[];
}

export interface HouseDeviceConfig extends PowerDeviceConfigBase {
    unmeasured_power_title?: string;
    entities: {
        power: string;
        today_energy?: string;
    }
    forecast?: HouseForecastConfig;
}

export interface BatteryDeviceConfig extends PowerDeviceConfigBase {
    forecast?: BatteryForecastConfig;
    entities: {
        power: string;
        capacity?: string;
        min_soc?: string;
        max_soc?: string;
        remaining_energy?: string;
    }
}

export interface BatteryForecastConfig {
    charge_efficiency?: number;
    discharge_efficiency?: number;
    max_charge_power_w?: number;
    max_discharge_power_w?: number;
}

export type DeviceConfig = SolarDeviceConfig | GridDeviceConfig | HouseDeviceConfig | BatteryDeviceConfig;
