import type { ScheduleApplianceAction } from "../schedule-types";

export interface ScheduleApplianceActionChangeDetail {
    applianceId: string;
    action: ScheduleApplianceAction | null;
    valid: boolean;
}
