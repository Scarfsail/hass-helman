import type { TreeItem } from "../shared/data/tree-item";

export type FlowSource = "solar" | "grid" | "battery";

export function getFlowColor(source: FlowSource): string {
    return `var(--helman-${source})`;
}

/** Keep the history bucket's highest-power source; use its type for theme-aware paint. */
export function dominantFlowColor(node: TreeItem | null | undefined, sources: readonly TreeItem[]): string | undefined {
    const history = node?.sourcePowerHistory;
    const bucket = history?.[history.length - 1];
    if (!bucket) return undefined;
    const entries = Object.entries(bucket).filter(([, entry]) => entry.power > 0);
    if (!entries.length) return undefined;
    const [id, dominant] = entries.reduce((max, entry) => entry[1].power > max[1].power ? entry : max);
    const sourceType = sources.find(source => source.id === id)?.sourceType;
    return sourceType === "solar" || sourceType === "grid" || sourceType === "battery"
        ? getFlowColor(sourceType) : dominant.color;
}
