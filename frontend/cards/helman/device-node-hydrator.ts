import { DeviceNodeDTO } from "../helman-api";
import { DeviceNode } from "./DeviceNode";

export function hydrateNode(dto: DeviceNodeDTO, historyBuckets: number): DeviceNode {
    const node = new DeviceNode(dto.id, dto.displayName, dto.powerSensorId, dto.switchEntityId, historyBuckets, dto.sourceConfig ?? undefined);
    node.isSource = dto.isSource;
    node.sourceType = dto.sourceType;
    node.isUnmeasured = dto.isUnmeasured;
    node.valueType = dto.valueType;
    node.labels = dto.labels;
    if (dto.labelBadgeTexts.length > 0) node.customLabelTexts = dto.labelBadgeTexts;
    if (dto.color) node.color = dto.color;
    if (dto.icon) node.icon = dto.icon;
    node.compact = dto.compact;
    node.show_additional_info = dto.showAdditionalInfo;
    node.children_full_width = dto.childrenFullWidth;
    node.hideChildren = dto.hideChildren;
    node.hideChildrenIndicator = dto.hideChildrenIndicator;
    node.sortChildrenByPower = dto.sortChildrenByPower;
    if (dto.ratioSensorId) node.ratioSensorId = dto.ratioSensorId;
    node.children = dto.children.map(child => hydrateNode(child, historyBuckets));
    return node;
}
