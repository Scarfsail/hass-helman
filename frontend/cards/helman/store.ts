import type { HomeAssistant } from "../../hass-frontend/src/types";
import type {
    ApplianceProjectionsPayload,
    AppliancesPayload,
    ControllableEntitiesPayload,
    EntityActualHistoryPayload,
    HistoryPayload,
    SchedulePayload,
    SetScheduleExecutionResponse,
    SetScheduleResponse,
    TreePayload,
} from "../helman-api";
import { HelmanClient } from "./client";
import {
    buildScheduleSlotDTO,
    type HelmanSchedulePatch,
} from "./models";

type HelmanConnection = HomeAssistant["connection"];

const helmanStores = new WeakMap<HelmanConnection, HelmanStoreImpl>();

export interface HelmanStore {
    getSchedule(): Promise<SchedulePayload>;
    applySchedulePatches(patches: readonly HelmanSchedulePatch[]): Promise<SetScheduleResponse>;
    setScheduleExecution(enabled: boolean): Promise<SetScheduleExecutionResponse>;
    getControllableEntities(): Promise<ControllableEntitiesPayload>;
    getEntityActualHistory(): Promise<EntityActualHistoryPayload>;
    getAppliances(): Promise<AppliancesPayload>;
    getApplianceProjections(): Promise<ApplianceProjectionsPayload>;
    getDeviceTree(): Promise<TreePayload>;
    getHistory(): Promise<HistoryPayload>;
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
    private readonly _client: HelmanClient;
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
        this._client = new HelmanClient(hass);
    }

    public updateHass(hass: HomeAssistant): void {
        this._client.updateHass(hass);
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
     * Drop the in-flight entries once a mutation settles, so a read issued after it
     * cannot join a request that left before the write and come back pre-mutation.
     * The dropped requests still resolve normally for whoever already awaits them.
     */
    private _afterMutation<T>(mutation: Promise<T>): Promise<T> {
        return mutation.finally(() => this._inFlight.clear());
    }

    public getSchedule(): Promise<SchedulePayload> {
        return this._dedupe("get_schedule", () => this._client.getSchedule());
    }

    public applySchedulePatches(
        patches: readonly HelmanSchedulePatch[],
    ): Promise<SetScheduleResponse> {
        return this._afterMutation(this._client.setSchedule(
            patches.map((patch) => buildScheduleSlotDTO(patch)),
        ));
    }

    public setScheduleExecution(enabled: boolean): Promise<SetScheduleExecutionResponse> {
        return this._afterMutation(this._client.setScheduleExecution(enabled));
    }

    public getControllableEntities(): Promise<ControllableEntitiesPayload> {
        return this._dedupe("get_controllable_entities", () => this._client.getControllableEntities());
    }

    public getEntityActualHistory(): Promise<EntityActualHistoryPayload> {
        return this._dedupe("get_entity_actual_history", () => this._client.getEntityActualHistory());
    }

    public getAppliances(): Promise<AppliancesPayload> {
        return this._dedupe("get_appliances", () => this._client.getAppliances());
    }

    public getApplianceProjections(): Promise<ApplianceProjectionsPayload> {
        return this._dedupe("get_appliance_projections", () => this._client.getApplianceProjections());
    }

    public getDeviceTree(): Promise<TreePayload> {
        return this._dedupe("get_device_tree", () => this._client.getDeviceTree());
    }

    public getHistory(): Promise<HistoryPayload> {
        return this._dedupe("get_history", () => this._client.getHistory());
    }
}
