import type { HaEntityPickerEntityFilterFunc } from "../../../hass-frontend/src/data/entity/entity";

/** What a sensor field measures, and so which sensors its picker offers. */
export type SensorKind = "energy" | "power" | "soc";

/**
 * A sensor is of a kind when its device class or its unit says so. Units are
 * lowercase and matched case-insensitively, the way `convertToKWh` reads them.
 */
const SENSOR_KINDS: Record<SensorKind, { deviceClasses: string[]; units: string[] }> = {
    energy: {
        deviceClasses: ["energy", "energy_storage"],
        units: ["wh", "kwh", "mwh", "gwh", "w⋅h", "kw⋅h", "mw⋅h", "gw⋅h"],
    },
    power: { deviceClasses: ["power"], units: ["w", "kw", "mw"] },
    soc: { deviceClasses: ["battery"], units: ["%"] },
};

function sensorKindFilter(kind: SensorKind): HaEntityPickerEntityFilterFunc {
    const { deviceClasses, units } = SENSOR_KINDS[kind];
    return (stateObj) =>
        !stateObj.entity_id.startsWith("sensor.") ||
        deviceClasses.includes(stateObj.attributes.device_class ?? "") ||
        units.includes((stateObj.attributes.unit_of_measurement ?? "").toLowerCase());
}

/**
 * `ha-entity-picker`'s `entityFilter` per kind. Module constants, so a picker
 * sees the same function on every render: the picker memoises on it. Only
 * sensors are filtered; which domains appear is `includeDomains`' business.
 */
export const SENSOR_KIND_FILTERS: Record<SensorKind, HaEntityPickerEntityFilterFunc> = {
    energy: sensorKindFilter("energy"),
    power: sensorKindFilter("power"),
    soc: sensorKindFilter("soc"),
};
