import type { TreeItem } from "../shared/data/tree-item";
import { liveFlows, type LiveFlows } from "./live-flows";
import type { NodeDetailParams, NodeDetailTabRequest, NodeDetailTarget } from "./node-detail-types";
import type { EnergyReadings } from "./node-detail-readings";

export interface NodeDetailContext {
    /** The card's live power split, W. */
    flows: LiveFlows;
    flowScaleW: number | null;
    batteryPower: number;
    /** The battery meter, positive charging; `null` without a reading. */
    batteryPowerReading: number | null;
    /** Solar production as its node carries it, W; `null` without a reading. */
    solarPowerReading: number | null;
    /** Grid power: positive imports, negative exports, W. */
    gridPower: number | null;
    housePower: number;
    /** Whether the house meter has a reading; `housePower` is 0 without one. */
    houseReadable: boolean;
    solarPower: number;
    houseNode: TreeItem | null;
    historyBuckets: number;
    historyBucketDuration: number;
}

/** Build node detail context from energy readings (the only input to readings fields) and options. */
export function buildNodeDetailContext(
    readings: EnergyReadings,
    options: {
        houseNode: TreeItem | null | undefined;
        historyBuckets: number;
        historyBucketDuration: number;
    },
): NodeDetailContext {
    return {
        flows: liveFlows({
            solarPower: readings.solarPowerReading ?? 0,
            housePower: readings.housePower,
            batteryPower: readings.batteryPowerReading ?? 0,
            gridPower: readings.gridPowerSigned ?? 0,
        }),
        flowScaleW: readings.flowScaleW,
        batteryPower: readings.batteryPower,
        batteryPowerReading: readings.batteryPowerReading,
        solarPowerReading: readings.solarPowerReading,
        gridPower: readings.gridPowerSigned,
        housePower: readings.housePower,
        houseReadable: readings.houseReadable,
        solarPower: readings.solarPower,
        houseNode: options.houseNode ?? null,
        historyBuckets: options.historyBuckets,
        historyBucketDuration: options.historyBucketDuration,
    };
}

/** The params of an energy node's detail, or of a device opened from its name, opening on the tab requested. */
export function buildNodeDetailParams(
    context: NodeDetailContext,
    request: NodeDetailTarget,
    tabRequest?: NodeDetailTabRequest,
): NodeDetailParams {
    // The split reads a missing meter as 0 and every edge is a residual of the
    // others: without the solar, battery or house reading it is not known, never a zero.
    const known = context.solarPowerReading !== null && context.batteryPowerReading !== null && context.houseReadable;
    const flow = { flows: known ? context.flows : null, flowScaleW: context.flowScaleW, tabRequest };
    if (typeof request !== "string") return { ...flow, nodeType: "device", item: request };
    switch (request) {
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
