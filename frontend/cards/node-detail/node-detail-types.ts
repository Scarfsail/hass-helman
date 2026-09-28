import type { TreeItem } from "../helman/tree-item";
import type { HelmanUiConfig } from "../helman-api";

export type NodeType = "solar" | "battery" | "grid" | "house";

export interface BatteryDetailParams {
    nodeType: "battery";
    power: number;
    soc: number;
    socEntityId: string | null;
    remainingEnergyEntityId: string | null;
    batteryProducerNode: TreeItem | null;
    batteryConsumerNode: TreeItem | null;
    productionNode?: TreeItem | null;
    consumptionNode?: TreeItem | null;
    historyBuckets: number;
    historyBucketDuration: number;
    historyRevision: number;
}

export interface SolarDetailParams {
    nodeType: "solar";
    solarNode: TreeItem | null;
    productionNode?: TreeItem | null;
    historyBuckets: number;
    historyBucketDuration: number;
    historyRevision: number;
}

export interface GridDetailParams {
    nodeType: "grid";
    gridProducerNode: TreeItem | null;
    gridConsumerNode: TreeItem | null;
    productionNode?: TreeItem | null;
    consumptionNode?: TreeItem | null;
    historyBuckets: number;
    historyBucketDuration: number;
    historyRevision: number;
}

export interface HouseDetailParams {
    nodeType: "house";
    power: number;
    devices: TreeItem[];
    parentPowerHistory?: number[];
    consumptionNode?: TreeItem | null;
    historyBuckets: number;
    historyBucketDuration: number;
    historyRevision: number;
    uiConfig?: HelmanUiConfig;
    houseNode: TreeItem | null;
}

/**
 * One config device, opened from its name. Not a `NodeType`: that union is also
 * the animated-icon vocabulary, and a device has no animated icon.
 */
export interface DeviceDetailParams {
    nodeType: "device";
    item: TreeItem;
}

export type NodeDetailParams =
    | BatteryDetailParams
    | SolarDetailParams
    | GridDetailParams
    | HouseDetailParams
    | DeviceDetailParams;
