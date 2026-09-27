import { TreeItemDTO } from "../helman-api";
import type { LocalizeFunction } from "../localize/localize";
import { TreeItem } from "./tree-item";

/** An unmeasured remainder carries no name from the backend; the card names every one alike. */
export function hydrateItem(dto: TreeItemDTO, historyBuckets: number, localize: LocalizeFunction): TreeItem {
    const name = dto.isUnmeasured ? localize("house_section.unmeasured") : dto.displayName;
    const item = new TreeItem(dto.id, name, dto.powerSensorId, dto.switchEntityId, historyBuckets, dto.sourceConfig ?? undefined);
    item.isSource = dto.isSource;
    item.sourceType = dto.sourceType;
    item.isUnmeasured = dto.isUnmeasured;
    item.isEstimated = dto.isEstimated;
    item.deferrable = dto.deferrable;
    item.controllableIds = dto.controllableIds;
    item.valueType = dto.valueType;
    item.labels = dto.labels;
    if (dto.labelBadgeTexts.length > 0) item.customLabelTexts = dto.labelBadgeTexts;
    if (dto.icon) item.icon = dto.icon;
    item.compact = dto.compact;
    item.show_additional_info = dto.showAdditionalInfo;
    item.children_full_width = dto.childrenFullWidth;
    item.hideChildren = dto.hideChildren;
    item.hideChildrenIndicator = dto.hideChildrenIndicator;
    item.sortChildrenByPower = dto.sortChildrenByPower;
    if (dto.ratioSensorId) item.ratioSensorId = dto.ratioSensorId;
    item.children = dto.children.map(child => hydrateItem(child, historyBuckets, localize));
    return item;
}
