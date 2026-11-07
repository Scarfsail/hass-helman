import type { HomeAssistant } from "../../types/ha";
import type { EvChargerDetailPayload } from "../helman-api";
import type { LocalizeFunction } from "../localize/localize";
import type { TreeItem } from "../shared/data/tree-item";
import { HistoryEngine } from "../shared/data/history-engine";
import type { HelmanDeviceCardConfig } from "./HelmanDeviceCardConfig";
import { formatKwh, formatPower } from "../shared/format";
import { isReadableState, readPowerW } from "../shared/power-reading";
import { isSwitchOn } from "../shared/config/devices";
import { IDLE_W } from "../node-detail/live-flows";
import { readEnergyKWh, readingNumber, readingText, type EnergyNodes, type EnergyReadings } from "../node-detail/node-detail-readings";
import { deviceDirectControls, evChargerId, evCharging, powerEntity } from "../node-detail/node-detail-utils";

/**
 * The device card's field catalog: the one place that knows which fields a
 * target offers, what each reads and how it reads as text. The editor offers
 * `availableFields`, the card renders `readField` and watches `fieldEntityIds`.
 */

export const FIELD_IDS = [
    "state", "connection", "power", "energy_today", "target_temperature", "current_temperature", "soc", "import_today", "export_today",
] as const;
export type FieldId = typeof FIELD_IDS[number];

export const ENERGY_NODE_TYPES = ["solar", "battery", "grid", "house"] as const;
export type EnergyNodeType = typeof ENERGY_NODE_TYPES[number];

/** What a tile shows: a config device, or an energy node with its tree item. */
export type DeviceCardTarget =
    | { kind: "device"; item: TreeItem }
    | { kind: "node"; node: EnergyNodeType; item: TreeItem };

/** What a field reads besides `hass.states`: the host's readings, the recorder's today, the EV overview. */
export interface FieldContext {
    hass: HomeAssistant;
    localize: LocalizeFunction;
    readings: EnergyReadings | null;
    /** The device meter's energy today, kWh; `undefined` until read. */
    todayKWh?: number | null;
    /** The EV charger's overview; `null` until read or for any other device. */
    ev: EvChargerDetailPayload | null;
}

/** Where each energy node's tree item is in the host's resolved nodes. */
const NODE_ITEMS: Record<EnergyNodeType, keyof EnergyNodes> = {
    solar: "solarNode",
    battery: "batteryProducerNode",
    grid: "gridProducerNode",
    house: "houseNode",
};

/** The target `config` names in `tree`; `null` when it is not there. */
export function resolveTarget(config: Pick<HelmanDeviceCardConfig, "device" | "node">, tree: TreeItem[], nodes: EnergyNodes): DeviceCardTarget | null {
    if (config.node) {
        const item = nodes[NODE_ITEMS[config.node]] as TreeItem | null | undefined;
        return item ? { kind: "node", node: config.node, item } : null;
    }
    if (!config.device) return null;
    const item = HistoryEngine.walkTree(tree).find((candidate) => candidate.deviceKey === config.device);
    return item ? { kind: "device", item } : null;
}

export interface FieldValue {
    text: string;
    unit: string;
}

/** The entity the device's state reads: its cover, else its switch, else its climate entity. */
function stateEntityId(item: TreeItem): string | null {
    const direct = deviceDirectControls(item);
    return direct ? direct.coverEntityId ?? direct.switchEntityId ?? direct.climateEntityId : null;
}

/** The fields `target` offers, in catalog order. */
export function availableFields(target: DeviceCardTarget): FieldId[] {
    const { item } = target;
    const offered: Record<FieldId, boolean> = target.kind === "device"
        ? {
            state: stateEntityId(item) !== null || evChargerId(item) !== null,
            connection: evChargerId(item) !== null,
            power: !!powerEntity(item),
            energy_today: !!item.energyEntityId,
            target_temperature: !!item.climateEntityId,
            current_temperature: !!item.climateEntityId,
            soc: false,
            import_today: false,
            export_today: false,
        }
        : {
            state: false,
            connection: false,
            power: true,
            energy_today: (target.node === "solar" || target.node === "house") && !!item.todayEnergyEntityId,
            target_temperature: false,
            current_temperature: false,
            soc: target.node === "battery" && !!item.socEntityId,
            import_today: target.node === "grid" && !!item.todayImportEntityId,
            export_today: target.node === "grid" && !!item.todayExportEntityId,
        };
    return FIELD_IDS.filter((field) => offered[field]);
}

/** The entities `field` reads on `target`, for the card's watch set. */
export function fieldEntityIds(target: DeviceCardTarget, field: FieldId, ev: EvChargerDetailPayload | null): Array<string | null | undefined> {
    const { item } = target;
    switch (field) {
        case "state": return [stateEntityId(item), ev?.entities.run_mode, ev?.entities.power];
        case "connection": return [ev?.entities.run_mode];
        case "power": return target.kind === "device" ? [powerEntity(item)] : [item.power?.entityId, item.powerSensorId];
        case "energy_today": return [target.kind === "device" ? item.energyEntityId : item.todayEnergyEntityId];
        case "target_temperature":
        case "current_temperature": return [item.climateEntityId];
        case "soc": return [item.socEntityId];
        case "import_today": return [item.todayImportEntityId];
        case "export_today": return [item.todayExportEntityId];
    }
}

/** The live power the target shows, W: a device's power sensor, a node's signed figure as the power card reads it. */
function powerW(target: DeviceCardTarget, ctx: FieldContext): number | null {
    if (target.kind === "device") return readPowerW(ctx.hass, powerEntity(target.item));
    const readings = ctx.readings;
    if (!readings) return null;
    switch (target.node) {
        case "solar": return readings.solarPowerReading;
        case "battery": return readings.batteryPowerReading;
        case "grid": return readings.gridPowerSigned;
        case "house": return readings.houseReadable ? readings.housePower : null;
    }
}

function stateText(target: DeviceCardTarget, ctx: FieldContext): string | null {
    const { hass, localize, ev } = ctx;
    const item = target.item;
    if (evChargerId(item) !== null) {
        if (!ev) return null;
        const switchId = deviceDirectControls(item)?.switchEntityId;
        if (switchId && hass.states[switchId]?.state === "off") return localize("node_detail.shared.ev_off");
        if (evCharging(hass, ev)) return localize("node_detail.shared.ev_charging");
        switch (ev.status?.kind) {
            case "no_car": return localize("node_detail.ev_charger.waiting.no_car_short");
            case "fault": return localize("node_detail.ev_charger.trust.fault");
            case "waiting": return localize("device_card.waiting");
            default: return localize("device_card.idle");
        }
    }
    const entityId = stateEntityId(item);
    const stateObj = entityId ? hass.states[entityId] : undefined;
    if (!stateObj || !isReadableState(stateObj.state)) return null;
    if (entityId === item.coverEntityId) return localize(`node_detail.cover.state_${stateObj.state}`);
    if (entityId === item.climateEntityId) {
        return stateObj.attributes.hvac_action
            ? hass.formatEntityAttributeValue(stateObj, "hvac_action")
            : hass.formatEntityState(stateObj);
    }
    return readingText(hass, entityId, (on) => localize(on ? "node_detail.shared.device_state_on" : "node_detail.shared.device_state_off"));
}

/** Whether a car is connected, read from the run mode alone (never the switch); otherwise the run mode as HA shows it. */
function connectionText(ctx: FieldContext): string | null {
    const { hass, localize, ev } = ctx;
    if (!ev) return null;
    switch (ev.status?.kind) {
        case "charging": return localize("device_card.connection.charging");
        case "waiting": return localize("device_card.connection.connected");
        case "no_car": return localize("device_card.connection.disconnected");
    }
    const runMode = ev.entities.run_mode;
    const stateObj = runMode ? hass.states[runMode] : undefined;
    return stateObj && isReadableState(stateObj.state) ? hass.formatEntityState(stateObj) : null;
}

function kwhValue(kwh: number | null | undefined): FieldValue | null {
    return kwh === null || kwh === undefined ? null : { text: formatKwh(kwh), unit: "kWh" };
}

function temperature(ctx: FieldContext, item: TreeItem, attribute: string): FieldValue | null {
    const stateObj = item.climateEntityId ? ctx.hass.states[item.climateEntityId] : undefined;
    // HA's own display: the locale's number format with the temperature unit.
    return typeof stateObj?.attributes[attribute] === "number" ? { text: ctx.hass.formatEntityAttributeValue(stateObj, attribute), unit: "" } : null;
}

/** `field` on `target` as text, `null` when the target does not offer it or has no reading. */
export function readField(target: DeviceCardTarget, field: FieldId, ctx: FieldContext): FieldValue | null {
    if (!availableFields(target).includes(field)) return null;
    const { hass } = ctx;
    const item = target.item;
    switch (field) {
        case "state": {
            const text = stateText(target, ctx);
            return text === null ? null : { text, unit: "" };
        }
        case "connection": {
            const text = connectionText(ctx);
            return text === null ? null : { text, unit: "" };
        }
        case "power": {
            const watts = powerW(target, ctx);
            if (watts === null) return null;
            const { value, unit } = formatPower(watts);
            return { text: value, unit };
        }
        case "energy_today":
            return kwhValue(target.kind === "device" ? ctx.todayKWh : readEnergyKWh(hass, item.todayEnergyEntityId));
        case "target_temperature": return temperature(ctx, item, "temperature");
        case "current_temperature": return temperature(ctx, item, "current_temperature");
        case "soc": {
            const soc = readingNumber(hass, item.socEntityId);
            return soc === null ? null : { text: String(Math.round(soc)), unit: "%" };
        }
        case "import_today": return kwhValue(readEnergyKWh(hass, item.todayImportEntityId));
        case "export_today": return kwhValue(readEnergyKWh(hass, item.todayExportEntityId));
    }
}

/**
 * Whether the target is idle: its state reads off or not charging, a cover
 * is not moving, a climate entity is off or idle; a target without a state
 * by its power, |W| ≤ `IDLE_W`.
 */
export function isIdle(target: DeviceCardTarget, ctx: FieldContext): boolean {
    const { hass, ev } = ctx;
    const item = target.item;
    if (target.kind === "device" && evChargerId(item) !== null && ev) return !evCharging(hass, ev);
    const entityId = target.kind === "device" && evChargerId(item) === null ? stateEntityId(item) : null;
    const stateObj = entityId ? hass.states[entityId] : undefined;
    if (stateObj) {
        if (entityId === item.coverEntityId) return stateObj.state !== "opening" && stateObj.state !== "closing";
        if (entityId === item.climateEntityId) {
            const action = stateObj.attributes.hvac_action as string | undefined;
            return action ? action === "idle" || action === "off" : stateObj.state === "off";
        }
        return !isSwitchOn(stateObj.state);
    }
    const watts = powerW(target, ctx);
    return watts === null || Math.abs(watts) <= IDLE_W;
}

/** Whether an EV charger has a car connected that is not charging, which tints its icon apart from no car. */
export function isConnected(target: DeviceCardTarget, ctx: FieldContext): boolean {
    return target.kind === "device" && evChargerId(target.item) !== null && ctx.ev?.status?.kind === "waiting";
}
