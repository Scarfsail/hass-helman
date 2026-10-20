import { isReadableState, applyValueType, powerUnitFactor, readPowerW } from "../shared/power-reading";
import type { HomeAssistant } from "../../types/ha";
import { convertToKWh, isSupportedEnergyUnit } from "../helman/energy-unit-converter";
import type { TreeItem } from "../shared/data/tree-item";
import type { InverterDetailPayload } from "../helman-api";

/**
 * A reading as a node detail shows it: its state and unit, `null` when the
 * entity is missing, unavailable or unknown. A switch reads through `onOff`.
 */
export function readingText(
    hass: HomeAssistant,
    entityId: string | null | undefined,
    onOff: (on: boolean) => string,
): string | null {
    const stateObj = entityId ? hass.states[entityId] : undefined;
    if (!stateObj || !isReadableState(stateObj.state)) return null;
    if (stateObj.state === "on" || stateObj.state === "off") return onOff(stateObj.state === "on");
    const unit = stateObj.attributes.unit_of_measurement as string | undefined;
    return unit ? stateObj.state + " " + unit : stateObj.state;
}

/** A reading as a number, `null` when missing or not numeric. */
export function readingNumber(hass: HomeAssistant, entityId: string | null | undefined): number | null {
    const raw = entityId ? hass.states[entityId]?.state : undefined;
    const value = raw === undefined ? NaN : parseFloat(raw);
    return Number.isFinite(value) ? value : null;
}

/**
 * An energy reading in kWh; `null` when missing, not numeric or in a unit
 * `convertToKWh` does not know, never a guess. A reading with no unit is Wh,
 * the repository's legacy convention, unless `allowUnitless` is false.
 */
export function readEnergyKWh(hass: HomeAssistant, entityId: string | null | undefined, allowUnitless = true): number | null {
    const value = readingNumber(hass, entityId);
    if (value === null) return null;
    const unit = hass.states[entityId!]?.attributes.unit_of_measurement as string | undefined;
    if (!unit) return allowUnitless ? convertToKWh(value, unit) : null;
    return isSupportedEnergyUnit(unit) ? convertToKWh(value, unit) : null;
}

export interface EnergyNodes {
    solarNode?: TreeItem | null;
    gridProducerNode?: TreeItem | null;
    batteryProducerNode?: TreeItem | null;
    batteryConsumerNode?: TreeItem | null;
    gridConsumerNode?: TreeItem | null;
    houseNode?: TreeItem | null;
    inverter?: InverterDetailPayload | null;
}

export interface EnergyReadings {
    solarPower: number;
    solarPowerReading: number | null;
    gridPower: number;
    gridPowerSigned: number | null;
    batteryPower: number;
    batteryPowerReading: number | null;
    batterySoc: number;
    batteryMinSoc: number | null;
    /** Each node's full flow scale, W; `null` when the node is absent. */
    solarMaxPower: number | null;
    gridMaxPower: number | null;
    batteryMaxPower: number | null;
    housePower: number;
    houseReadable: boolean;
    flowScaleW: number | null;
}

function findHouse(items: TreeItem[]): TreeItem | null {
    for (const item of items) {
        if (item.sourceType === "house" || item.id === "house") return item;
        const found = findHouse(item.children);
        if (found) return found;
    }
    return null;
}

export function resolveEnergyNodes(items: TreeItem[]): EnergyNodes {
    const sourcesRoot = items.find((d) => d.id === "sources");
    const consumersRoot = items.find((d) => d.id === "consumers");
    const sources = sourcesRoot ? sourcesRoot.children : items.filter((d) => d.isSource);
    const consumers = consumersRoot ? consumersRoot.children : items.filter((d) => !d.isSource);

    const solarNode = sources.find((d) => d.sourceType === "solar") ?? null;
    const gridProducerNode = sources.find((d) => d.sourceType === "grid") ?? null;
    const batteryProducerNode = sources.find((d) => d.sourceType === "battery") ?? null;
    const batteryConsumerNode = consumers.find((d) => d.sourceType === "battery") ?? null;
    const gridConsumerNode = consumers.find((d) => d.sourceType === "grid") ?? null;
    const houseNode = findHouse(consumers) ?? null;

    return {
        solarNode,
        gridProducerNode,
        batteryProducerNode,
        batteryConsumerNode,
        gridConsumerNode,
        houseNode,
    };
}

/**
 * Returns the superset of readings (signed live-sensor readings, SoC, min SoC,
 * max powers, flowScaleW = inverter rated power else solar max, else null).
 * Only input to the node-detail context builder (D11).
 */
export function readEnergyReadings(
    hass: HomeAssistant,
    nodes: EnergyNodes | TreeItem[],
): EnergyReadings {
    const energyNodes: EnergyNodes = Array.isArray(nodes) ? resolveEnergyNodes(nodes) : nodes;
    const {
        solarNode,
        gridProducerNode,
        gridConsumerNode,
        batteryProducerNode,
        batteryConsumerNode,
        houseNode,
        inverter,
    } = energyNodes;

    const raw = (entityId: string | null | undefined): number | null =>
        readPowerW(hass, entityId);

    const solarRaw = raw(solarNode?.powerSensorId);
    const solarPower = solarRaw === null ? 0 : applyValueType(solarRaw, solarNode?.valueType ?? "default");
    const solarPowerReading = solarRaw === null ? null : solarPower;
    const solarMaxPower = solarNode?.maxPowerW ?? null;

    // The signed readings, in Helman's convention by the node's own sign:
    // positive charges the battery, positive exports to the grid.
    const signed = (node: TreeItem | null | undefined): number | null => {
        const power = node?.power;
        const reading = raw(power?.entityId);
        return power && reading !== null ? reading * power.sign : null;
    };

    const gridNode = gridProducerNode ?? gridConsumerNode;
    const gridReading = raw(gridNode?.powerSensorId);
    const gridPower = applyValueType(gridReading ?? 0, gridProducerNode?.valueType ?? "default");
    const gridExport = signed(gridNode);
    const gridPowerSigned = gridExport === null ? null : -gridExport;
    const gridMaxPower = gridNode?.maxPowerW ?? null;

    const batteryNode = batteryProducerNode ?? batteryConsumerNode;
    const batteryPowerReading = signed(batteryNode);
    const batteryPower = batteryPowerReading ?? 0;
    const socRaw = readingNumber(hass, batteryNode?.socEntityId);
    const batterySoc = socRaw === null ? 0 : Math.max(0, Math.min(100, socRaw));
    const batteryMinSoc = readingNumber(hass, batteryNode?.minSocEntityId);
    const batteryMaxPower = batteryNode?.maxPowerW ?? null;

    const houseRaw = raw(houseNode?.powerSensorId);
    const housePower = houseRaw === null ? 0 : Math.max(0, applyValueType(houseRaw, houseNode?.valueType ?? "default"));
    const houseReadable = houseRaw !== null;

    // The power a detail's flow draws at full height: the inverter's AC
    // rating, else the solar node's configured maximum.
    const ratedEntityId = inverter?.entities?.rated_power;
    const ratedValue = readingNumber(hass, ratedEntityId);
    const factor = powerUnitFactor(hass, ratedEntityId);
    const rated = ratedValue === null || factor === null ? null : ratedValue * factor;
    const flowScaleW = rated !== null && rated > 0 ? rated : solarMaxPower;

    return {
        solarPower,
        solarPowerReading,
        gridPower,
        gridPowerSigned,
        batteryPower,
        batteryPowerReading,
        batterySoc,
        batteryMinSoc,
        solarMaxPower,
        gridMaxPower,
        batteryMaxPower,
        housePower,
        houseReadable,
        flowScaleW,
    };
}
