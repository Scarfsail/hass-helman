import type { LovelaceCardConfig } from "../../types/ha";
import type { EnergyNodeType, FieldId } from "./device-card-fields";

/** One tile for one target: a config device by its `deviceKey`, or an energy node. */
export interface HelmanDeviceCardConfig extends LovelaceCardConfig {
    /** A config device's `deviceKey` (its energy entity); exactly one of `device` and `node`. */
    device?: string;
    node?: EnergyNodeType;
    /** Defaults to the device's or node's name. */
    name?: string;
    /** The fields shown, in this order. */
    fields?: FieldId[];
    /** The fields omitted while the target is idle; a subset of `fields`. */
    hide_when_idle?: FieldId[];
}
