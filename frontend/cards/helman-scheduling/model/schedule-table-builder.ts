import type { SlotForecastMap } from "./slot-forecast-model";
import type { ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import type { ScheduleApplianceProjectionIndex } from "./schedule-appliance-projection";
import type { LocalizeFunction } from "../../localize/localize";
import { buildScheduleTableRows } from "./schedule-hour-bucket-builder";
import { aggregateScheduleDayForecast, buildScheduleTableForecastMeta } from "./schedule-table-forecast";
import { formatScheduleDayLabel } from "./schedule-time";
import {
    SCHEDULE_TABLE_COLUMNS,
    type ScheduleTableModel,
    type ScheduleTableSectionModel,
} from "../schedule-table-types";
import type { ScheduleDisplaySlot } from "../schedule-types";

export function buildScheduleTableModel({
    slots,
    appliances,
    applianceProjectionIndex,
    slotForecastMap,
    expandedHourKeys,
    locale,
    timeZone,
    currentDayKey,
    todayLabel,
    tomorrowLabel,
    executionEnabled,
    localize,
}: {
    slots: readonly ScheduleDisplaySlot[];
    appliances: readonly ScheduleApplianceMetadata[];
    applianceProjectionIndex: ScheduleApplianceProjectionIndex;
    slotForecastMap: SlotForecastMap;
    expandedHourKeys: readonly string[];
    locale: string;
    timeZone: string;
    currentDayKey: string | null;
    todayLabel: string;
    tomorrowLabel: string;
    executionEnabled: boolean;
    localize: LocalizeFunction;
}): ScheduleTableModel {
    const daySections: Array<{
        dayKey: string;
        dayLabel: string;
        slots: ScheduleDisplaySlot[];
    }> = [];
    let currentSection: (typeof daySections)[number] | null = null;
    const expandedHourKeySet = new Set(expandedHourKeys);

    for (const slot of slots) {
        if (currentSection === null || currentSection.dayKey !== slot.dayKey) {
            currentSection = {
                dayKey: slot.dayKey,
                dayLabel: formatScheduleDayLabel({
                    dayKey: slot.dayKey,
                    currentDayKey,
                    locale,
                    todayLabel,
                    tomorrowLabel,
                }),
                slots: [],
            };
            daySections.push(currentSection);
        }

        currentSection.slots.push(slot);
    }

    const sections: ScheduleTableSectionModel[] = daySections.map((section) => ({
        dayKey: section.dayKey,
        dayLabel: section.dayLabel,
        dayAggregate: aggregateScheduleDayForecast({
            slots: section.slots,
            slotForecastMap,
        }),
        rows: buildScheduleTableRows({
            slots: section.slots,
            appliances,
            applianceProjectionIndex,
            slotForecastMap,
            expandedHourKeys: expandedHourKeySet,
            locale,
            timeZone,
            executionEnabled,
            localize,
        }),
    }));

    return {
        columns: SCHEDULE_TABLE_COLUMNS,
        sections,
        forecast: buildScheduleTableForecastMeta({
            slotForecastMap,
            sections,
            slots,
            timeZone,
        }),
    };
}
