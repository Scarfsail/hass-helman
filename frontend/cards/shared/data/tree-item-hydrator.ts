import { TreeItemDTO, TreePayload } from "../../helman-api";
import type { LocalizeFunction } from "../../localize/localize";
import { TreeItem } from "./tree-item";

/** An unmeasured remainder carries no name from the backend; the card names every one alike. */
export function hydrateItem(dto: TreeItemDTO, historyBuckets: number, localize: LocalizeFunction): TreeItem {
    const name = dto.isUnmeasured ? localize("house_section.unmeasured") : dto.displayName;
    const item = new TreeItem(dto.id, name, dto.powerSensorId, dto.switchEntityId, historyBuckets);
    item.isSource = dto.isSource;
    item.sourceType = dto.sourceType;
    item.isUnmeasured = dto.isUnmeasured;
    item.isEstimated = dto.isEstimated;
    item.deferrable = dto.deferrable;
    item.controllableIds = dto.controllableIds;
    item.ownControllableIds = dto.ownControllableIds;
    item.applianceKind = dto.applianceKind;
    item.climateEntityId = dto.climateEntityId;
    item.energyEntityId = dto.energyEntityId ?? undefined;
    item.deviceKey = dto.energyEntityId ?? (dto.isEstimated ? dto.id : undefined);
    item.deviceKeyIsMeter = !!dto.energyEntityId;
    item.valueType = dto.valueType;
    item.power = dto.power;
    item.maxPowerW = dto.maxPowerW;
    item.socEntityId = dto.socEntityId;
    item.minSocEntityId = dto.minSocEntityId;
    item.maxSocEntityId = dto.maxSocEntityId;
    item.remainingEnergyEntityId = dto.remainingEnergyEntityId;
    item.todayEnergyEntityId = dto.todayEnergyEntityId;
    item.todayImportEntityId = dto.todayImportEntityId;
    item.todayExportEntityId = dto.todayExportEntityId;
    item.groups = dto.groups;
    item.phase = dto.phase ?? null;
    if (dto.groupBadgeTexts?.length) item.groupBadgeTexts = dto.groupBadgeTexts;
    if (dto.icon) item.icon = dto.icon;
    item.compact = dto.compact;
    item.show_additional_info = dto.showAdditionalInfo;
    item.children_full_width = dto.childrenFullWidth;
    item.hideChildren = dto.hideChildren;
    item.hideChildrenIndicator = dto.hideChildrenIndicator;
    item.sortChildrenByPower = dto.sortChildrenByPower;
    if (dto.ratioSensorId) item.ratioSensorId = dto.ratioSensorId;
    item.children = (dto.children ?? []).map(child => hydrateItem(child, historyBuckets, localize));
    return item;
}

export function hydrateDeviceTree(payload: TreePayload, localize: LocalizeFunction): TreeItem[] {
    const { sources, consumers, consumptionTotalSensorId, productionTotalSensorId, uiConfig } = payload;
    const historyBuckets = uiConfig.history_buckets;
    const roots: TreeItem[] = [];

    const sourceTypeByDeviceId = new Map<string, string>();
    for (const dto of sources) {
        if (dto.sourceType) sourceTypeByDeviceId.set(dto.id, dto.sourceType);
    }

    if (sources.length > 0) {
        const sourcesNode = new TreeItem("sources", localize("card.sources_title"), null, null, historyBuckets);
        sourcesNode.childrenCollapsed = false;
        sourcesNode.icon = "mdi:lightning-bolt-outline";
        sourcesNode.powerSensorId = productionTotalSensorId;
        sourcesNode.children = sources.map((dto) => hydrateItem(dto, historyBuckets, localize));
        roots.push(sourcesNode);
    }

    if (consumers.length > 0) {
        const consumersNode = new TreeItem("consumers", localize("card.consumers_title"), null, null, historyBuckets);
        consumersNode.hideChildren = true;
        consumersNode.hideChildrenIndicator = true;
        consumersNode.icon = "mdi:lightning-bolt-outline";
        consumersNode.powerSensorId = consumptionTotalSensorId;
        consumersNode.children = consumers.map((dto) => hydrateItem(dto, historyBuckets, localize));
        const propagateSourceType = (items: TreeItem[]) => {
            for (const item of items) {
                if (!item.sourceType) {
                    item.sourceType = sourceTypeByDeviceId.get(item.id)
                        ?? (item.id === "house" ? "house" : null);
                }
                propagateSourceType(item.children);
            }
        };
        propagateSourceType(consumersNode.children);
        roots.push(consumersNode);
    }

    return roots;
}
