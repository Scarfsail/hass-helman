import type { ScheduleControllableActionsDTO } from "../helman-api";

export interface HelmanSchedulePatch {
    id: string;
    controllables: ScheduleControllableActionsDTO;
}
