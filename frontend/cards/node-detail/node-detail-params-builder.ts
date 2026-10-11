import type { TreeItem } from "../helman/tree-item";
import type { NodeDetailParams, NodeType } from "./node-detail-types";

export interface NodeDetailContext {
    batteryPower: number;
    /** The battery meter, positive charging; `null` without a reading. */
    batteryPowerReading: number | null;
    /** Solar production as its node carries it, W; `null` without a reading. */
    solarPowerReading: number | null;
    /** Grid power: positive imports, negative exports, W. */
    gridPower: number | null;
    housePower: number;
    solarPower: number;
    houseNode: TreeItem | null;
    historyBuckets: number;
    historyBucketDuration: number;
}

export function buildNodeDetailParams(context: NodeDetailContext, nodeType: NodeType): NodeDetailParams {
    switch (nodeType) {
        case "battery":
            return {
                nodeType: "battery",
                power: context.batteryPowerReading,
                historyBuckets: context.historyBuckets,
                historyBucketDuration: context.historyBucketDuration,
            };
        case "solar":
            return {
                nodeType: "solar",
                power: context.solarPowerReading,
                batteryPower: context.batteryPowerReading,
                gridPower: context.gridPower,
            };
        case "grid":
            return {
                nodeType: "grid",
                gridPower: context.gridPower,
            };
        case "house":
            return {
                nodeType: "house",
                power: context.housePower,
                houseNode: context.houseNode,
            };
        case "inverter":
            return {
                nodeType: "inverter",
                solarPower: context.solarPower,
                batteryPower: context.batteryPower,
            };
    }
}
