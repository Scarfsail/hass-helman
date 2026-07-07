import type { DeviceNode } from "../helman/DeviceNode";
import type { HelmanUiConfig } from "../helman-api";

export type NodeType = "solar" | "battery" | "grid" | "house";

export interface BatteryDetailParams {
    nodeType: "battery";
    power: number;
    soc: number;
    socEntityId: string | null;
    remainingEnergyEntityId: string | null;
    batteryProducerNode: DeviceNode | null;
    batteryConsumerNode: DeviceNode | null;
    productionNode?: DeviceNode | null;
    consumptionNode?: DeviceNode | null;
    historyBuckets: number;
    historyBucketDuration: number;
}

export interface SolarDetailParams {
    nodeType: "solar";
    solarNode: DeviceNode | null;
    productionNode?: DeviceNode | null;
    historyBuckets: number;
    historyBucketDuration: number;
}

export interface GridDetailParams {
    nodeType: "grid";
    gridProducerNode: DeviceNode | null;
    gridConsumerNode: DeviceNode | null;
    productionNode?: DeviceNode | null;
    consumptionNode?: DeviceNode | null;
    historyBuckets: number;
    historyBucketDuration: number;
}

export interface HouseDetailParams {
    nodeType: "house";
    power: number;
    devices: DeviceNode[];
    parentPowerHistory?: number[];
    consumptionNode?: DeviceNode | null;
    historyBuckets: number;
    historyBucketDuration: number;
    uiConfig?: HelmanUiConfig;
    houseNode: DeviceNode | null;
}

export type NodeDetailParams =
    | BatteryDetailParams
    | SolarDetailParams
    | GridDetailParams
    | HouseDetailParams;
