import { DeviceNodeDTO } from "../helman-api";
import type { LocalizeFunction } from "../localize/localize";
import { DeviceNode } from "./DeviceNode";

/** An unmeasured remainder carries no name from the backend; the card names every one alike. */
export function hydrateNode(dto: DeviceNodeDTO, historyBuckets: number, localize: LocalizeFunction): DeviceNode {
    const name = dto.isUnmeasured ? localize("house_section.unmeasured") : dto.displayName;
    const node = new DeviceNode(dto.id, name, dto.powerSensorId, dto.switchEntityId, historyBuckets, dto.sourceConfig ?? undefined);
    node.isSource = dto.isSource;
    node.sourceType = dto.sourceType;
    node.isUnmeasured = dto.isUnmeasured;
    node.isEstimated = dto.isEstimated;
    node.deferrable = dto.deferrable;
    node.controllableIds = dto.controllableIds;
    node.valueType = dto.valueType;
    node.labels = dto.labels;
    if (dto.labelBadgeTexts.length > 0) node.customLabelTexts = dto.labelBadgeTexts;
    if (dto.icon) node.icon = dto.icon;
    node.compact = dto.compact;
    node.show_additional_info = dto.showAdditionalInfo;
    node.children_full_width = dto.childrenFullWidth;
    node.hideChildren = dto.hideChildren;
    node.hideChildrenIndicator = dto.hideChildrenIndicator;
    node.sortChildrenByPower = dto.sortChildrenByPower;
    if (dto.ratioSensorId) node.ratioSensorId = dto.ratioSensorId;
    node.children = dto.children.map(child => hydrateNode(child, historyBuckets, localize));
    return node;
}
