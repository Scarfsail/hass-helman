import type { HomeAssistant } from "../../hass-frontend/src/types";
import type {
    ApplianceProjectionsPayload,
    AppliancesPayload,
    GetApplianceProjectionsRequest,
    GetAppliancesRequest,
    GetScheduleRequest,
    SchedulePayload,
    ScheduleSlotDTO,
    SetScheduleExecutionRequest,
    SetScheduleExecutionResponse,
    SetScheduleRequest,
    SetScheduleResponse,
} from "../helman-api";
import { cloneScheduleSlotDTO } from "./models";

export class HelmanClient {
    private _hass: HomeAssistant;

    constructor(hass: HomeAssistant) {
        this._hass = hass;
    }

    public updateHass(hass: HomeAssistant): void {
        this._hass = hass;
    }

    public getSchedule(): Promise<SchedulePayload> {
        const request: GetScheduleRequest = {
            type: "helman/get_schedule",
        };
        return this._hass.callWS<SchedulePayload>(request);
    }

    public setSchedule(slots: readonly ScheduleSlotDTO[]): Promise<SetScheduleResponse> {
        const request: SetScheduleRequest = {
            type: "helman/set_schedule",
            slots: slots.map((slot) => cloneScheduleSlotDTO(slot)),
        };
        return this._hass.callWS<SetScheduleResponse>(request);
    }

    public setScheduleExecution(enabled: boolean): Promise<SetScheduleExecutionResponse> {
        const request: SetScheduleExecutionRequest = {
            type: "helman/set_schedule_execution",
            enabled,
        };
        return this._hass.callWS<SetScheduleExecutionResponse>(request);
    }

    public getAppliances(): Promise<AppliancesPayload> {
        const request: GetAppliancesRequest = {
            type: "helman/get_appliances",
        };
        return this._hass.callWS<AppliancesPayload>(request);
    }

    public getApplianceProjections(): Promise<ApplianceProjectionsPayload> {
        const request: GetApplianceProjectionsRequest = {
            type: "helman/get_appliance_projections",
        };
        return this._hass.callWS<ApplianceProjectionsPayload>(request);
    }
}
