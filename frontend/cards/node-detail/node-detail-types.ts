import type { TreeItem } from "../helman/tree-item";

export type NodeType = "solar" | "battery" | "grid" | "house" | "inverter";

/**
 * The battery. Its readings come from `helman/get_node_detail`; the power is
 * the card's own live figure, with the polarity the card already applied.
 */
export interface BatteryDetailParams {
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
export interface SolarDetailParams {
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
export interface GridDetailParams {
    nodeType: "grid";
    /** Grid power: positive imports, negative exports, W. */
    /** Signed import-positive; `null` when the grid sensor has no reading. */
    gridPower: number | null;
}

/**
 * The house. Its readings come from `helman/get_node_detail`; the power is the
 * card's own live figure, with the polarity the card already applied, and the
 * house tree is the card's own, which the phase answer estimates from.
 */
export interface HouseDetailParams {
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
export interface InverterDetailParams {
    nodeType: "inverter";
    /** Solar production, W. */
    solarPower: number;
    /** Battery power on the house convention: positive charges, W. */
    batteryPower: number;
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
    | InverterDetailParams
    | DeviceDetailParams;
