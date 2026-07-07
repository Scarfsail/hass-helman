import type { HomeAssistant } from "../../hass-frontend/src/types";
import type {
    ApplianceProjectionsPayload,
    AppliancesPayload,
    SchedulePayload,
    SetScheduleExecutionResponse,
    SetScheduleResponse,
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
    getAppliances(): Promise<AppliancesPayload>;
    getApplianceProjections(): Promise<ApplianceProjectionsPayload>;
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

    constructor(hass: HomeAssistant) {
        this._client = new HelmanClient(hass);
    }

    public updateHass(hass: HomeAssistant): void {
        this._client.updateHass(hass);
    }

    public getSchedule(): Promise<SchedulePayload> {
        return this._client.getSchedule();
    }

    public applySchedulePatches(
        patches: readonly HelmanSchedulePatch[],
    ): Promise<SetScheduleResponse> {
        return this._client.setSchedule(
            patches.map((patch) => buildScheduleSlotDTO(patch)),
        );
    }

    public setScheduleExecution(enabled: boolean): Promise<SetScheduleExecutionResponse> {
        return this._client.setScheduleExecution(enabled);
    }

    public getAppliances(): Promise<AppliancesPayload> {
        return this._client.getAppliances();
    }

    public getApplianceProjections(): Promise<ApplianceProjectionsPayload> {
        return this._client.getApplianceProjections();
    }
}
