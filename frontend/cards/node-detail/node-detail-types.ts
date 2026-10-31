import type { ModeSegment } from "../shared/mode-strip";
import type { TreeItem } from "../shared/data/tree-item";
import type { LiveFlows } from "./live-flows";

export type NodeType = "solar" | "battery" | "grid" | "house" | "inverter";

/** What a detail shows: an energy node by its type, or a config device by its tree item. */
export type NodeDetailTarget = NodeType | TreeItem;

export type NodeDetailSection = "schedule";

/**
 * The section a detail was asked to open, one object per request: asking for
 * the same node's Schedule section again is a new request even when the node
 * and section are the same, while a refreshed tree keeps the one it has.
 */
export interface NodeDetailSectionRequest {
    readonly section: NodeDetailSection;
}

/**
 * Asks the power card around it to show a node's detail, opening its Schedule
 * section when requested. Bubbles and is composed,
 * so it reaches the card from inside the open detail's own shadow roots.
 */
export const NODE_DETAIL_REQUEST_EVENT = "helman-node-detail-request";

/**
 * A detail reports what its node's lane did today, for the Schedule
 * section's strip: a `LaneHistory`. Bubbles to the dialog around the
 * detail, not composed.
 */
export const LANE_HISTORY_EVENT = "helman-lane-history";

/**
 * What a lane did today: its stretches, the one still going open-ended, and
 * a note when they can't be read, with the read to try again and its label.
 */
export interface LaneHistory {
    segments: ModeSegment[];
    note: string | null;
    retry: { label: string; load: () => void } | null;
}

export const NO_LANE_HISTORY: LaneHistory = { segments: [], note: null, retry: null };

export interface NodeDetailRequestDetail {
    target: NodeDetailTarget;
    section?: NodeDetailSection;
}

/**
 * What every energy node's flow is drawn from: the card's live power split,
 * rebuilt with the params on every card render, and the fixed scale.
 */
export interface EnergyNodeFlowParams {
    /** The card's live power split, W; `null` while the solar or battery meter has no reading. */
    flows: LiveFlows | null;
    /** The power the Now flow draws at full height, W: the inverter's AC rating, else the solar node's maximum; `null` with neither. */
    flowScaleW: number | null;
}

/**
 * The battery. Its readings come from `helman/get_node_detail`; the power is
 * the card's own live figure, with the polarity the card already applied.
 */
export interface BatteryDetailParams extends EnergyNodeFlowParams {
    nodeType: "battery";
    /** Battery power: positive charges, negative discharges, W; `null` without a reading. */
    power: number | null;
    /** The card's power-history window, which Helman's time estimates average over. */
    historyBuckets: number;
    historyBucketDuration: number;
}

/**
 * The solar node. Its readings come from `helman/get_node_detail`; the powers
 * are the card's own live figures, with the polarity the card already applied.
 */
export interface SolarDetailParams extends EnergyNodeFlowParams {
    nodeType: "solar";
    /** Solar production, W; `null` without a reading. */
    power: number | null;
    /** Battery power: positive charges, W; `null` without a reading. */
    batteryPower: number | null;
    /** Grid power, import positive, W; `null` without a reading. */
    gridPower: number | null;
}

/**
 * The grid. Its readings come from `helman/get_node_detail`; the total power is
 * the card's own live figure, with the polarity the card already applied.
 */
export interface GridDetailParams extends EnergyNodeFlowParams {
    nodeType: "grid";
    /** Grid power: positive imports, negative exports, W. */
    /** Signed import-positive; `null` when the grid sensor has no reading. */
    gridPower: number | null;
    powerEntityId: string | null;
}

/**
 * The house. Its readings come from `helman/get_node_detail`; the power is the
 * card's own live figure, with the polarity the card already applied, and the
 * house tree is the card's own, which the phase answer estimates from.
 */
export interface HouseDetailParams extends EnergyNodeFlowParams {
    nodeType: "house";
    /** House consumption, W. */
    power: number;
    houseNode: TreeItem | null;
}

/**
 * The inverter, opened from the card's centre. Its readings come from
 * `helman/get_node_detail`; the DC context is the card's own live figures, so
 * the detail reads them with the polarity the card already applied.
 */
export interface InverterDetailParams extends EnergyNodeFlowParams {
    nodeType: "inverter";
    /** Solar production, W. */
    solarPower: number;
    /** Battery power on the house convention: positive charges, W. */
    batteryPower: number;
}

/**
 * One config device, opened from its name. Not a `NodeType`: that union is also
 * the animated-icon vocabulary, and a device has no animated icon. Every host
 * adds the flow params, which an EV charger's detail draws the car's flow from.
 */
export interface DeviceDetailParams extends Partial<EnergyNodeFlowParams> {
    nodeType: "device";
    item: TreeItem;
    /** The config devices above it in the house tree, top down, for the breadcrumb. */
    ancestors: readonly TreeItem[];
}

export type NodeDetailParams = (
    | BatteryDetailParams
    | SolarDetailParams
    | GridDetailParams
    | HouseDetailParams
    | InverterDetailParams
    | DeviceDetailParams
) & {
    /** The section the power card was asked to open; otherwise sections start collapsed. */
    sectionRequest?: NodeDetailSectionRequest;
};
