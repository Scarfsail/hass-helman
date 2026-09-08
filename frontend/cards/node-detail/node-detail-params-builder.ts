import type { DeviceNode } from "../helman/DeviceNode";
import type { HelmanUiConfig } from "../helman-api";
import type { NodeDetailParams, NodeType } from "./node-detail-types";

export interface NodeDetailContext {
    batteryPower: number;
    batterySoc: number;
    batterySocEntityId: string | null;
    batteryRemainingEnergyEntityId: string | null;
    batteryProducerNode: DeviceNode | null;
    batteryConsumerNode: DeviceNode | null;
    solarNode: DeviceNode | null;
    gridProducerNode: DeviceNode | null;
    gridConsumerNode: DeviceNode | null;
    productionNode: DeviceNode | null;
    consumptionNode: DeviceNode | null;
    housePower: number;
    houseDevices: DeviceNode[];
    houseNode: DeviceNode | null;
    historyBuckets: number;
    historyBucketDuration: number;
    /**
     * Bumped once per history tick by the card that owns the `HistoryEngine`. The
     * panels draw the very same rows the card does, off the very same in-place
     * buffers, so they need the same signal that the buckets moved.
     */
    historyRevision: number;
    uiConfig?: HelmanUiConfig;
}

export function buildNodeDetailParams(context: NodeDetailContext, nodeType: NodeType): NodeDetailParams {
    switch (nodeType) {
        case "battery":
            return {
                nodeType: "battery",
                power: context.batteryPower,
                soc: context.batterySoc,
                socEntityId: context.batterySocEntityId,
                remainingEnergyEntityId: context.batteryRemainingEnergyEntityId,
                batteryProducerNode: context.batteryProducerNode,
                batteryConsumerNode: context.batteryConsumerNode,
                productionNode: context.productionNode,
                consumptionNode: context.consumptionNode,
                historyBuckets: context.historyBuckets,
                historyBucketDuration: context.historyBucketDuration,
                historyRevision: context.historyRevision,
            };
        case "solar":
            return {
                nodeType: "solar",
                solarNode: context.solarNode,
                productionNode: context.productionNode,
                historyBuckets: context.historyBuckets,
                historyBucketDuration: context.historyBucketDuration,
                historyRevision: context.historyRevision,
            };
        case "grid":
            return {
                nodeType: "grid",
                gridProducerNode: context.gridProducerNode,
                gridConsumerNode: context.gridConsumerNode,
                productionNode: context.productionNode,
                consumptionNode: context.consumptionNode,
                historyBuckets: context.historyBuckets,
                historyBucketDuration: context.historyBucketDuration,
                historyRevision: context.historyRevision,
            };
        case "house":
            return {
                nodeType: "house",
                power: context.housePower,
                devices: context.houseDevices,
                parentPowerHistory: context.houseNode?.powerHistory,
                consumptionNode: context.consumptionNode,
                historyBuckets: context.historyBuckets,
                historyBucketDuration: context.historyBucketDuration,
                historyRevision: context.historyRevision,
                uiConfig: context.uiConfig,
                houseNode: context.houseNode,
            };
    }
}
