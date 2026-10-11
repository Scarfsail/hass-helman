import type { TreeItem } from "../helman/tree-item";
import type { EnergyNodeFlowParams, NodeDetailParams, NodeType } from "./node-detail-types";

export interface NodeDetailContext extends EnergyNodeFlowParams {
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
    const flow: EnergyNodeFlowParams = { flows: context.flows, flowScaleW: context.flowScaleW };
    switch (nodeType) {
        case "battery":
            return {
                ...flow,
                nodeType: "battery",
                power: context.batteryPowerReading,
                historyBuckets: context.historyBuckets,
                historyBucketDuration: context.historyBucketDuration,
            };
        case "solar":
            return {
                ...flow,
                nodeType: "solar",
                power: context.solarPowerReading,
                batteryPower: context.batteryPowerReading,
                gridPower: context.gridPower,
            };
        case "grid":
            return {
                ...flow,
                nodeType: "grid",
                gridPower: context.gridPower,
            };
        case "house":
            return {
                ...flow,
                nodeType: "house",
                power: context.housePower,
                houseNode: context.houseNode,
            };
        case "inverter":
            return {
                ...flow,
                nodeType: "inverter",
                solarPower: context.solarPower,
                batteryPower: context.batteryPower,
            };
    }
}
