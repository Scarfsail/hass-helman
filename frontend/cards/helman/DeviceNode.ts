import { DeviceConfig } from "./DeviceConfig";
import { ValueType } from "../helman-api";

export class DeviceNode {
    constructor(id: string, name: string, powerSensorId: string | null, switchEntityId: string | null, historyBuckets: number, deviceConfig?: DeviceConfig) {
        this.id = id;
        this.name = name;
        this.powerSensorId = powerSensorId;
        this.switchEntityId = switchEntityId;
        this.children = [];
        this.childrenCollapsed = true;
        this.historyBuckets = historyBuckets;
        this.powerHistory = [];
        this.valueType = 'default';
        this.color = undefined;
        this.isSource = false;
        this.icon = undefined;
        this.deviceConfig = deviceConfig;
    }

    public id: string;
    public name: string;
    public powerSensorId: string | null;
    public switchEntityId: string | null;
    public children: DeviceNode[];
    public powerValue?: number;
    public childrenCollapsed?: boolean;
    public hideChildren?: boolean; // Indicates if children should be hidden in the UI
    public hideChildrenIndicator?: boolean; // Indicates if a button to show/hide children should be displayed
    public powerHistory: number[] = [];
    public historyBuckets: number;
    public isUnmeasured: boolean = false; // Indicates if this node represents unmeasured power
    public valueType: ValueType;

    public color?: string;
    public sourcePowerHistory?: { [sourceName: string]: { power: number; color: string } }[];
    public isSource: boolean;
    public sourceType?: string | null;
    public ratioSensorId?: string;
    public icon?: string;
    public sortChildrenByPower?: boolean;
    public deviceConfig?: DeviceConfig;
    public compact?: boolean; // Indicates if the device should be displayed in a compact mode
    public children_full_width?: boolean; // Indicates if the device should take full width in the UI
    public show_additional_info?: boolean; // Indicates if additional info should be shown in the UI
    public customLabelTexts?: string[]; // Custom texts to display based on matching device labels
    public labels?: string[]; // HA label names attached to this device (for grouping)
    // Virtual grouping metadata
    public displayName?: string; // Optional display name override (e.g., "Label (Emoji)")
    public virtualType?: 'labelCategory' | 'others';
    public groupCategory?: string; // Category name when grouped by labels
    public groupLabel?: string; // Label name within the category

    // Derived-color caches; invalidated by reference comparison against the latest bucket
    public _cachedDominantBucketRef?: object;
    public _cachedDominantColor?: string;
    public _cachedBlendedBucketRef?: object;
    public _cachedBlendedColor?: string;
}
