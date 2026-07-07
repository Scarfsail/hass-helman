import type { SlotForecastMap, SlotForecastPoint } from "./slot-forecast-model";
import type { ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import type { LocalizeFunction } from "../../localize/localize";
import {
    aggregateScheduleApplianceEnergyProjectionBadges,
    getScheduleApplianceProjectionBadge,
    mergeScheduleApplianceProjectionBadges,
    type ScheduleApplianceProjectionIndex,
} from "./schedule-appliance-projection";
import {
    mergeScheduleAuthorshipSummaries,
    summarizeScheduleAuthorship,
} from "./schedule-authorship";
import { getScheduleApplianceById } from "./schedule-appliance-metadata";
import {
    buildScheduleRuntimeComplianceModel,
    type ScheduleRuntimeComplianceModel,
} from "./schedule-runtime-compliance";
import { aggregateScheduleHourForecast } from "./schedule-table-forecast";
import {
    buildScheduleCompactExpandedRangeLabel,
    getScheduleLocalTimeParts,
    getScheduleTimeRangeLabels,
    type ScheduleLocalTimeParts,
} from "./schedule-time";
import type {
    ScheduleTableActionCellModel,
    ScheduleTableActionItemModel,
    ScheduleTableApplianceActionItemModel,
    ScheduleTableApplianceSummaryActionItemModel,
    ScheduleTableDetailRowModel,
    ScheduleTableHourRowModel,
    ScheduleTableRowModel,
    ScheduleTableSlotRowModel,
} from "../schedule-table-types";
import {
    getScheduleActionIdentityKey,
    getScheduleApplianceActionIdentityKey,
    isScheduleClimateApplianceAction,
    isScheduleBackedDisplaySlot,
    isScheduleEvChargerAction,
    isScheduleGenericApplianceAction,
    type ScheduleApplianceAction,
    type ScheduleDisplaySlot,
    type ScheduleSlot,
} from "../schedule-types";

interface ScheduleHourBucket {
    hourKey: string;
    dayKey: string;
    slots: ScheduleDisplaySlot[];
}

export function buildScheduleTableRows({
    slots,
    appliances,
    applianceProjectionIndex,
    slotForecastMap,
    expandedHourKeys,
    locale,
    timeZone,
    executionEnabled,
    localize,
}: {
    slots: readonly ScheduleDisplaySlot[];
    appliances: readonly ScheduleApplianceMetadata[];
    applianceProjectionIndex: ScheduleApplianceProjectionIndex;
    slotForecastMap: SlotForecastMap;
    expandedHourKeys: ReadonlySet<string>;
    locale: string;
    timeZone: string;
    executionEnabled: boolean;
    localize: LocalizeFunction;
}): ScheduleTableRowModel[] {
    const rows: ScheduleTableRowModel[] = [];

    for (const bucket of _buildHourBuckets(slots, timeZone)) {
        if (_isCollapsibleHourBucket(bucket, timeZone)) {
            const hourRow = _buildHourRow({
                bucket,
                appliances,
                applianceProjectionIndex,
                slotForecastMap,
                expanded: expandedHourKeys.has(bucket.hourKey),
                locale,
                timeZone,
                runtimeCompliance: !expandedHourKeys.has(bucket.hourKey)
                    ? _buildCurrentRuntimeCompliance({
                        slots: bucket.slots,
                        appliances,
                        executionEnabled,
                        localize,
                    })
                    : null,
            });
            rows.push(hourRow);

            if (hourRow.expanded) {
                for (const slot of bucket.slots) {
                    const runtimeCompliance = slot.isCurrent && isScheduleBackedDisplaySlot(slot)
                        ? _buildRuntimeCompliance({
                            slot: slot.scheduleSlot,
                            appliances,
                            executionEnabled,
                            localize,
                        })
                        : null;
                    const childRow = _buildSlotRow({
                        slot,
                        appliances,
                        applianceProjectionIndex,
                        slotForecastMap,
                        locale,
                        timeZone,
                        variant: "hour-child",
                        parentHourKey: bucket.hourKey,
                        runtimeCompliance,
                    });
                    rows.push(childRow);
                    if (
                        slot.isCurrent
                        && isScheduleBackedDisplaySlot(slot)
                        && runtimeCompliance !== null
                        && runtimeCompliance.state !== "on_plan"
                    ) {
                        rows.push(_buildDetailRow({
                            ownerRowId: childRow.rowId,
                            slot: slot.scheduleSlot,
                            runtimeCompliance,
                            variant: "hour-child",
                        }));
                    }
                }
            } else {
                const currentSlot = bucket.slots.find((slot) => slot.isCurrent && isScheduleBackedDisplaySlot(slot));
                if (
                    currentSlot
                    && isScheduleBackedDisplaySlot(currentSlot)
                    && hourRow.runtimeCompliance !== null
                    && hourRow.runtimeCompliance.state !== "on_plan"
                ) {
                    rows.push(_buildDetailRow({
                        ownerRowId: hourRow.rowId,
                        slot: currentSlot.scheduleSlot,
                        runtimeCompliance: hourRow.runtimeCompliance,
                        variant: "hour",
                    }));
                }
            }
            continue;
        }

        for (const slot of bucket.slots) {
            const runtimeCompliance = slot.isCurrent && isScheduleBackedDisplaySlot(slot)
                ? _buildRuntimeCompliance({
                    slot: slot.scheduleSlot,
                    appliances,
                    executionEnabled,
                    localize,
                })
                : null;
            const slotRow = _buildSlotRow({
                slot,
                appliances,
                applianceProjectionIndex,
                slotForecastMap,
                locale,
                timeZone,
                variant: "raw",
                parentHourKey: null,
                runtimeCompliance,
            });
            rows.push(slotRow);
            if (
                slot.isCurrent
                && isScheduleBackedDisplaySlot(slot)
                && runtimeCompliance !== null
                && runtimeCompliance.state !== "on_plan"
            ) {
                rows.push(_buildDetailRow({
                    ownerRowId: slotRow.rowId,
                    slot: slot.scheduleSlot,
                    runtimeCompliance,
                    variant: "raw",
                }));
            }
        }
    }

    return _disambiguateRepeatedHourRows(rows);
}

export function collectScheduleHourForecasts({
    slots,
    slotForecastMap,
    timeZone,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
    timeZone: string;
}): SlotForecastPoint[] {
    return _buildHourBuckets(slots, timeZone)
        .filter((bucket) => _isCollapsibleHourBucket(bucket, timeZone))
        .flatMap((bucket) => {
            const point = aggregateScheduleHourForecast({
                slots: bucket.slots,
                slotForecastMap,
            });
            return point ? [point] : [];
        });
}

function _buildHourBuckets(
    slots: readonly ScheduleDisplaySlot[],
    timeZone: string,
): ScheduleHourBucket[] {
    const buckets: ScheduleHourBucket[] = [];
    let currentBucket: ScheduleHourBucket | null = null;

    for (const slot of slots) {
        const hourKey = _buildHourKey(slot.startMs, timeZone);
        if (hourKey === null) {
            buckets.push({
                hourKey: `invalid:${slot.id}`,
                dayKey: slot.dayKey,
                slots: [slot],
            });
            currentBucket = null;
            continue;
        }

        if (currentBucket === null || currentBucket.hourKey !== hourKey) {
            currentBucket = {
                hourKey,
                dayKey: slot.dayKey,
                slots: [slot],
            };
            buckets.push(currentBucket);
            continue;
        }

        currentBucket.slots.push(slot);
    }

    return buckets;
}

function _buildHourKey(startMs: number, timeZone: string): string | null {
    const parts = getScheduleLocalTimeParts(startMs, timeZone);
    if (parts === null) {
        return null;
    }

    return `${parts.dayKey}:${String(parts.hour).padStart(2, "0")}:${parts.offset}`;
}

function _isCollapsibleHourBucket(
    bucket: ScheduleHourBucket,
    timeZone: string,
): boolean {
    if (bucket.slots.length <= 1) {
        return false;
    }

    if (!_hasContiguousCoverage(bucket.slots)) {
        return false;
    }

    if (!bucket.slots.every((slot) => slot.source === bucket.slots[0].source)) {
        return false;
    }

    const firstSlot = bucket.slots[0];
    const lastSlot = bucket.slots[bucket.slots.length - 1];
    if (lastSlot.endMs === null) {
        return false;
    }

    const firstParts = getScheduleLocalTimeParts(firstSlot.startMs, timeZone);
    const lastEndParts = getScheduleLocalTimeParts(lastSlot.endMs, timeZone);
    if (firstParts === null || lastEndParts === null) {
        return false;
    }

    if (firstParts.minute !== 0 || lastEndParts.minute !== 0) {
        return false;
    }

    if (!_hasStableLocalOffset(bucket.slots, timeZone, firstParts.offset)) {
        return false;
    }

    return _isImmediateNextLocalHour(firstParts, lastEndParts);
}

function _hasContiguousCoverage(slots: readonly ScheduleDisplaySlot[]): boolean {
    for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        if (slot.endMs === null) {
            return false;
        }

        const nextSlot = slots[index + 1];
        if (nextSlot && slot.endMs !== nextSlot.startMs) {
            return false;
        }
    }

    return true;
}

function _hasStableLocalOffset(
    slots: readonly ScheduleDisplaySlot[],
    timeZone: string,
    expectedOffset: string,
): boolean {
    for (const slot of slots) {
        const startParts = getScheduleLocalTimeParts(slot.startMs, timeZone);
        if (startParts === null || startParts.offset !== expectedOffset) {
            return false;
        }

        if (slot.endMs === null) {
            return false;
        }

        const endParts = getScheduleLocalTimeParts(slot.endMs, timeZone);
        if (endParts === null || endParts.offset !== expectedOffset) {
            return false;
        }
    }

    return true;
}

function _isImmediateNextLocalHour(
    startParts: ScheduleLocalTimeParts,
    endParts: ScheduleLocalTimeParts,
): boolean {
    if (startParts.offset !== endParts.offset) {
        return false;
    }

    if (startParts.dayKey === endParts.dayKey) {
        return endParts.hour === startParts.hour + 1;
    }

    return startParts.hour === 23
        && endParts.hour === 0
        && endParts.dayKey === _addDayKey(startParts.dayKey, 1);
}

function _addDayKey(dayKey: string, days: number): string {
    const date = new Date(`${dayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function _buildHourRow({
    bucket,
    appliances,
    applianceProjectionIndex,
    slotForecastMap,
    expanded,
    locale,
    timeZone,
    runtimeCompliance,
}: {
    bucket: ScheduleHourBucket;
    appliances: readonly ScheduleApplianceMetadata[];
    applianceProjectionIndex: ScheduleApplianceProjectionIndex;
    slotForecastMap: SlotForecastMap;
    expanded: boolean;
    locale: string;
    timeZone: string;
    runtimeCompliance: ScheduleRuntimeComplianceModel | null;
}): ScheduleTableHourRowModel {
    const firstSlot = bucket.slots[0];
    const lastSlot = bucket.slots[bucket.slots.length - 1];
    const rangeLabel = getScheduleTimeRangeLabels({
        startMs: firstSlot.startMs,
        endMs: lastSlot.endMs,
        locale,
        timeZone,
    }).rangeLabel;

    return {
        kind: "hour",
        rowId: `hour:${bucket.hourKey}`,
        hourKey: bucket.hourKey,
        dayKey: bucket.dayKey,
        displayTimeLabel: {
            leading: null,
            primary: firstSlot.timeLabel,
            trailing: null,
            hideLeading: false,
            hideTrailing: false,
        },
        rangeLabel,
        slotIds: bucket.slots
            .filter(isScheduleBackedDisplaySlot)
            .map((slot) => slot.scheduleSlot.id),
        actionCell: _buildActionCell(bucket.slots, appliances, applianceProjectionIndex),
        forecast: aggregateScheduleHourForecast({
            slots: bucket.slots,
            slotForecastMap,
        }),
        isCurrent: !expanded && bucket.slots.some((slot) => slot.isCurrent),
        runtimeCompliance,
        expanded,
    };
}

function _buildDistinctInverterItems(
    slots: readonly ScheduleDisplaySlot[],
): ScheduleTableActionItemModel[] {
    const actionItems: ScheduleTableActionItemModel[] = [];
    const itemsByKey = new Map<string, ScheduleTableActionItemModel>();

    for (const slot of slots) {
        if (!isScheduleBackedDisplaySlot(slot)) {
            continue;
        }

        const key = getScheduleActionIdentityKey(slot.scheduleSlot.assignments.inverter.action);
        const existing = itemsByKey.get(key);
        if (existing) {
            existing.authorship = mergeScheduleAuthorshipSummaries([
                existing.authorship,
                summarizeScheduleAuthorship([slot.scheduleSlot.assignments.inverter.setBy]),
            ]);
            continue;
        }

        const item = {
            kind: "inverter",
            key,
            action: slot.scheduleSlot.assignments.inverter.action,
            firstSlotId: slot.scheduleSlot.id,
            authorship: summarizeScheduleAuthorship([slot.scheduleSlot.assignments.inverter.setBy]),
        } satisfies ScheduleTableActionItemModel;
        itemsByKey.set(key, item);
        actionItems.push(item);
    }

    return actionItems;
}

function _buildDistinctApplianceItems(
    slots: readonly ScheduleDisplaySlot[],
    appliances: readonly ScheduleApplianceMetadata[],
    applianceProjectionIndex: ScheduleApplianceProjectionIndex,
): ScheduleTableApplianceActionItemModel[] {
    const applianceOrder = new Map(
        appliances.map((appliance) => [appliance.id, appliance.order] as const),
    );
    const actions = slots.flatMap((slot) => {
        if (!isScheduleBackedDisplaySlot(slot)) {
            return [];
        }

        return Object.entries(slot.scheduleSlot.assignments.appliances).flatMap(([applianceId, assignment]) => {
            const appliance = getScheduleApplianceById(appliances, applianceId);
            const applianceKind = _resolveApplianceKind(appliance, assignment.action);
            return [{
                slotId: slot.scheduleSlot.id,
                applianceId,
                action: assignment.action,
                authorship: assignment.setBy,
                appliance,
                applianceKind,
                order: applianceOrder.get(applianceId) ?? Number.MAX_SAFE_INTEGER,
            }];
        });
    }).sort((left, right) => {
        if (left.order !== right.order) {
            return left.order - right.order;
        }
        if (left.applianceId !== right.applianceId) {
            return left.applianceId.localeCompare(right.applianceId);
        }
        return left.slotId.localeCompare(right.slotId);
    });

    const items: ScheduleTableApplianceActionItemModel[] = [];
    const itemsByKey = new Map<string, ScheduleTableApplianceActionItemModel>();
    for (const entry of actions) {
        const key = `${entry.applianceId}:${getScheduleApplianceActionIdentityKey(entry.action)}`;
        const projectionBadge = getScheduleApplianceProjectionBadge({
            projectionIndex: applianceProjectionIndex,
            applianceKind: entry.applianceKind,
            applianceId: entry.applianceId,
            action: entry.action,
            slotId: entry.slotId,
        });
        const existing = itemsByKey.get(key);
        if (existing) {
            existing.projectionBadge = mergeScheduleApplianceProjectionBadges(
                existing.projectionBadge,
                projectionBadge,
            );
            existing.authorship = mergeScheduleAuthorshipSummaries([
                existing.authorship,
                summarizeScheduleAuthorship([entry.authorship]),
            ]);
            continue;
        }

        const item = {
            kind: "appliance",
            key,
            appliance: {
                id: entry.applianceId,
                name: entry.appliance?.name ?? entry.applianceId,
                kind: entry.applianceKind,
                icon: entry.appliance?.icon ?? "mdi:flash-outline",
            },
            action: entry.action,
            firstSlotId: entry.slotId,
            projectionBadge,
            authorship: summarizeScheduleAuthorship([entry.authorship]),
        } satisfies ScheduleTableApplianceActionItemModel;
        itemsByKey.set(key, item);
        items.push(item);
    }

    return items;
}

function _buildApplianceSummaryItem(
    items: ScheduleTableApplianceActionItemModel[],
): ScheduleTableApplianceSummaryActionItemModel | null {
    if (items.length === 0) {
        return null;
    }

    return {
        kind: "appliance_summary",
        key: "appliance_summary",
        firstSlotId: items[0].firstSlotId,
        items,
        projectionBadge: aggregateScheduleApplianceEnergyProjectionBadges(
            items.map((item) => item.projectionBadge),
        ),
        authorship: mergeScheduleAuthorshipSummaries(items.map((item) => item.authorship)),
    };
}

function _resolveApplianceKind(
    appliance: ScheduleApplianceMetadata | undefined,
    action: ScheduleApplianceAction,
): string {
    if (appliance?.kind) {
        return appliance.kind;
    }

    if (isScheduleEvChargerAction(action)) {
        return "ev_charger";
    }

    if (isScheduleGenericApplianceAction(action)) {
        return "generic";
    }

    if (isScheduleClimateApplianceAction(action)) {
        return "climate";
    }

    return "unknown";
}

function _buildActionCell(
    slots: readonly ScheduleDisplaySlot[],
    appliances: readonly ScheduleApplianceMetadata[],
    applianceProjectionIndex: ScheduleApplianceProjectionIndex,
): ScheduleTableActionCellModel {
    const scheduleBackedSlots = slots.filter(isScheduleBackedDisplaySlot);
    const applianceItems = _buildDistinctApplianceItems(scheduleBackedSlots, appliances, applianceProjectionIndex);
    const firstClassApplianceItems = applianceItems.filter((item) => item.appliance.kind === "ev_charger");
    const applianceSummaryItem = _buildApplianceSummaryItem(
        applianceItems.filter((item) => item.appliance.kind !== "ev_charger"),
    );
    return {
        items: [
            ..._buildDistinctInverterItems(scheduleBackedSlots),
            ...firstClassApplianceItems,
            ...(applianceSummaryItem === null ? [] : [applianceSummaryItem]),
        ],
        interactive: scheduleBackedSlots.length > 0,
    };
}

function _buildSlotRow({
    slot,
    appliances,
    applianceProjectionIndex,
    slotForecastMap,
    locale,
    timeZone,
    variant,
    parentHourKey,
    runtimeCompliance,
}: {
    slot: ScheduleDisplaySlot;
    appliances: readonly ScheduleApplianceMetadata[];
    applianceProjectionIndex: ScheduleApplianceProjectionIndex;
    slotForecastMap: SlotForecastMap;
    locale: string;
    timeZone: string;
    variant: "raw" | "hour-child";
    parentHourKey: string | null;
    runtimeCompliance: ScheduleRuntimeComplianceModel | null;
}): ScheduleTableSlotRowModel {
    return {
        kind: "slot",
        rowId: variant === "raw" ? `slot:${slot.id}` : `hour-child:${slot.id}`,
        slot,
        actionCell: _buildActionCell([slot], appliances, applianceProjectionIndex),
        interactiveSlotId: isScheduleBackedDisplaySlot(slot) ? slot.scheduleSlot.id : null,
        displayTimeLabel: variant === "raw"
            ? {
                leading: null,
                primary: slot.timeLabel,
                trailing: null,
                hideLeading: false,
                hideTrailing: false,
            }
            : buildScheduleCompactExpandedRangeLabel({
                startMs: slot.startMs,
                endMs: slot.endMs,
                locale,
                timeZone,
            }),
        rangeLabel: slot.rangeLabel,
        forecast: slotForecastMap.points.get(slot.id) ?? null,
        isCurrent: slot.isCurrent,
        runtimeCompliance,
        variant,
        parentHourKey,
    };
}
function _buildDetailRow({
    ownerRowId,
    slot,
    runtimeCompliance,
    variant,
}: {
    ownerRowId: string;
    slot: ScheduleSlot;
    runtimeCompliance: ScheduleRuntimeComplianceModel;
    variant: ScheduleTableDetailRowModel["variant"];
}): ScheduleTableDetailRowModel {
    return {
        kind: "detail",
        rowId: `detail:${ownerRowId}`,
        ownerRowId,
        slot,
        runtimeCompliance,
        variant,
    };
}

function _buildCurrentRuntimeCompliance({
    slots,
    appliances,
    executionEnabled,
    localize,
}: {
    slots: readonly ScheduleDisplaySlot[];
    appliances: readonly ScheduleApplianceMetadata[];
    executionEnabled: boolean;
    localize: LocalizeFunction;
}): ScheduleRuntimeComplianceModel | null {
    const currentSlot = slots.find((slot) => slot.isCurrent && isScheduleBackedDisplaySlot(slot));
    if (!currentSlot || !isScheduleBackedDisplaySlot(currentSlot)) {
        return null;
    }

    return _buildRuntimeCompliance({
        slot: currentSlot.scheduleSlot,
        appliances,
        executionEnabled,
        localize,
    });
}

function _buildRuntimeCompliance({
    slot,
    appliances,
    executionEnabled,
    localize,
}: {
    slot: ScheduleSlot;
    appliances: readonly ScheduleApplianceMetadata[];
    executionEnabled: boolean;
    localize: LocalizeFunction;
}): ScheduleRuntimeComplianceModel {
    return buildScheduleRuntimeComplianceModel({
        slot,
        appliances,
        executionEnabled,
        localize,
    });
}

function _disambiguateRepeatedHourRows(
    rows: readonly ScheduleTableRowModel[],
): ScheduleTableRowModel[] {
    const repeatedRangeLabels = new Set<string>();
    const repeatedHourKeys = new Set<string>();
    const rangeLabelCounts = new Map<string, number>();

    for (const row of rows) {
        if (row.kind !== "hour") {
            continue;
        }

        rangeLabelCounts.set(row.rangeLabel, (rangeLabelCounts.get(row.rangeLabel) ?? 0) + 1);
    }

    for (const [rangeLabel, count] of rangeLabelCounts) {
        if (count > 1) {
            repeatedRangeLabels.add(rangeLabel);
        }
    }

    for (const row of rows) {
        if (row.kind === "hour" && repeatedRangeLabels.has(row.rangeLabel)) {
            repeatedHourKeys.add(row.hourKey);
        }
    }

    if (repeatedRangeLabels.size === 0) {
        return [...rows];
    }

    return rows.map((row) => {
        if (row.kind === "hour" && repeatedRangeLabels.has(row.rangeLabel)) {
            const offsetLabel = _extractHourOffsetLabel(row.hourKey);
            return {
                ...row,
                displayTimeLabel: {
                    ...row.displayTimeLabel,
                    trailing: `${row.displayTimeLabel.trailing ?? ""} (${offsetLabel})`,
                    hideTrailing: false,
                },
                rangeLabel: `${row.rangeLabel} (${offsetLabel})`,
            };
        }

        if (
            row.kind === "slot"
            && row.variant === "hour-child"
            && row.parentHourKey !== null
            && repeatedHourKeys.has(row.parentHourKey)
        ) {
            const offsetLabel = _extractHourOffsetLabel(row.parentHourKey);
            return {
                ...row,
                displayTimeLabel: {
                    ...row.displayTimeLabel,
                    trailing: `${row.displayTimeLabel.trailing ?? ""} (${offsetLabel})`,
                    hideTrailing: true,
                },
                rangeLabel: `${row.rangeLabel} (${offsetLabel})`,
            };
        }

        return row;
    });
}

function _extractHourOffsetLabel(hourKey: string): string {
    const match = /([+-]\d{2}:\d{2})$/.exec(hourKey);
    return match ? `UTC${match[1]}` : hourKey;
}
