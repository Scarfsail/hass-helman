import { HistoryEngine } from "./history-engine";
import type { TreeItem } from "./tree-item";

/**
 * The entities that open a config device's detail: its switch, power sensor,
 * meter, climate entity and cover control. Only an item with a `deviceKey` is a
 * config device, the same test that makes its name open the detail.
 */
export function deviceEntityIds(item: TreeItem): string[] {
    if (!item.deviceKey) return [];
    return [item.switchEntityId, item.powerSensorId, item.energyEntityId, item.climateEntityId, item.coverEntityId]
        .filter((id): id is string => !!id);
}

/** The first config device in the tree that `entityId` opens. */
export function findDeviceForEntity(tree: TreeItem[], entityId: string): TreeItem | undefined {
    return HistoryEngine.walkTree(tree).find((item) => deviceEntityIds(item).includes(entityId));
}
