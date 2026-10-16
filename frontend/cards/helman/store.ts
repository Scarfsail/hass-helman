import type { HomeAssistant } from "../../types/ha";
import type {
    ApplianceProjectionsPayload,
    AppliancesPayload,
    EntityActualHistoryPayload,
    GetNodeDetailRequest,
    HistoryPayload,
    SchedulePayload,
    TreePayload,
} from "../helman-api";
import { callHelman } from "../shared/data/helman-commands";
import type { HelmanSchedulePatch } from "./models";

type HelmanConnection = HomeAssistant["connection"];

const helmanStores = new WeakMap<HelmanConnection, HelmanStoreImpl>();

/** In-flight reads a schedule write invalidates. */
const SCHEDULE_DERIVED_KEYS = ["get_schedule"] as const;

export interface HelmanStore {
    getSchedule(): Promise<SchedulePayload>;
    applySchedulePatches(patches: readonly HelmanSchedulePatch[]): Promise<SchedulePayload>;
    setScheduleExecution(enabled: boolean): Promise<SchedulePayload>;
    getEntityActualHistory(): Promise<EntityActualHistoryPayload>;
    getAppliances(): Promise<AppliancesPayload>;
    getApplianceProjections(): Promise<ApplianceProjectionsPayload>;
    getDeviceTree(options?: { fresh?: boolean }): Promise<TreePayload>;
    getHistory(options?: { fresh?: boolean }): Promise<HistoryPayload>;
    getNodeDetail<T>(request: GetNodeDetailRequest, options?: { fresh?: boolean }): Promise<T>;
}

export function getSharedHelmanStore(hass: HomeAssistant): HelmanStore {
    let store = helmanStores.get(hass.connection);
    if (!store) {
        store = new HelmanStoreImpl(hass);
        helmanStores.set(hass.connection, store);
    } else {
        store.updateHass(hass);
    }

    return store;
}

class HelmanStoreImpl implements HelmanStore {
    private _hass: HomeAssistant;
    /**
     * Read requests currently awaiting a response, keyed by command.
     *
     * A dashboard load fans out to several independent consumers that each ask for
     * the same data, so without this every one of them would put another frame on
     * the wire inside the window when the backend is busiest. Callers arriving
     * while a request is in flight share its promise instead.
     *
     * This is de-duplication, not caching: the entry is dropped as soon as the
     * request settles — success or failure alike — so the next caller re-fetches
     * and a failure propagates to everyone who was waiting.
     */
    private readonly _inFlight = new Map<string, Promise<unknown>>();

    constructor(hass: HomeAssistant) {
        this._hass = hass;
    }

    public updateHass(hass: HomeAssistant): void {
        this._hass = hass;
    }

    private _dedupe<T>(key: string, request: () => Promise<T>): Promise<T> {
        const pending = this._inFlight.get(key);
        if (pending) return pending as Promise<T>;

        const promise = request().finally(() => {
            // Only clear our own entry: a later request for the same command may
            // already have replaced it.
            if (this._inFlight.get(key) === promise) this._inFlight.delete(key);
        });
        this._inFlight.set(key, promise);
        return promise;
    }

    /**
     * Drop the schedule-derived entries once a write settles, so a read issued
     * after it starts a fresh request rather than joining one that may have left
     * before the write. Requests already awaited still resolve normally.
     *
     * Only the schedule keys: a device tree, history buffer, appliance roster or
     * controllable list is unaffected by a schedule write, and clearing those
     * would re-open the very fan-out this map exists to collapse — a toggle while
     * a dashboard is still loading would send both cards back for their own copy.
     *
     * Note the narrow gap this does *not* close: a read issued while the write is
     * still in flight can still join a request that left before it. Nothing
     * currently does that — `schedule-owner` awaits its pending read before
     * writing — and closing it would mean clearing on issue rather than on
     * settle, which drops entries the write may yet fail to change.
     */
    private _afterMutation<T>(mutation: Promise<T>): Promise<T> {
        return mutation.finally(() => {
            for (const key of SCHEDULE_DERIVED_KEYS) this._inFlight.delete(key);
        });
    }

    public getSchedule(): Promise<SchedulePayload> {
        return this._dedupe("get_schedule", () => callHelman(this._hass, "helman/get_schedule", {}));
    }

    public applySchedulePatches(
        patches: readonly HelmanSchedulePatch[],
    ): Promise<SchedulePayload> {
        return this._afterMutation(callHelman(this._hass, "helman/set_schedule", { slots: [...patches] }));
    }

    public setScheduleExecution(enabled: boolean): Promise<SchedulePayload> {
        return this._afterMutation(callHelman(this._hass, "helman/set_schedule_execution", { enabled }));
    }

    public getEntityActualHistory(): Promise<EntityActualHistoryPayload> {
        return this._dedupe("get_entity_actual_history", () => callHelman(this._hass, "helman/get_entity_actual_history", {}));
    }

    public getAppliances(): Promise<AppliancesPayload> {
        return this._dedupe("get_appliances", () => callHelman(this._hass, "helman/get_appliances", {}));
    }

    /**
     * Never de-duplicated: a projection is a function of the schedule, and its
     * caller re-reads it precisely *because* the schedule just changed. Sharing
     * an in-flight request would hand back figures computed against the
     * previous schedule, and the caller's generation check cannot tell — it was
     * bumped before the join, so the stale answer looks current and is kept.
     */
    public getApplianceProjections(): Promise<ApplianceProjectionsPayload> {
        return callHelman(this._hass, "helman/get_appliance_projections", {});
    }

    public getDeviceTree(options?: { fresh?: boolean }): Promise<TreePayload> {
        if (options?.fresh) this._inFlight.delete("get_device_tree");
        return this._dedupe("get_device_tree", () => callHelman(this._hass, "helman/get_device_tree", {}));
    }

    public getHistory(options?: { fresh?: boolean }): Promise<HistoryPayload> {
        if (options?.fresh) this._inFlight.delete("get_history");
        return this._dedupe("get_history", () => callHelman(this._hass, "helman/get_history", {}));
    }

    /**
     * De-duplicated per node, device and section: the card's cell and its dialog
     * ask together. `fresh` skips joining a request sent before a state changed.
     */
    public getNodeDetail<T>(request: GetNodeDetailRequest, options?: { fresh?: boolean }): Promise<T> {
        const key = `get_node_detail:${request.node}:${request.device_id ?? ""}:${request.section ?? ""}`;
        // A config refresh replaces the inverter overview for every card sharing
        // this connection, including one mounted while the new read is pending.
        if (options?.fresh && request.node === "inverter" && !request.section) this._inFlight.delete(key);
        else if (options?.fresh) return callHelman(this._hass, "helman/get_node_detail", request) as Promise<T>;
        return this._dedupe(key, () => callHelman(this._hass, "helman/get_node_detail", request) as Promise<T>);
    }
}
