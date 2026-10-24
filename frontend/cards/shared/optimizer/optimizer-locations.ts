import { asJsonArray, asJsonObject } from "../config/config-document";
import type { JsonObject } from "../config/types";
import type { OptimizerConfigBucket } from "./optimizer-schema";

const OPTIMIZER_BUCKETS: readonly OptimizerConfigBucket[] = [
    "appliance_optimizers",
    "system_optimizers",
];

/** Where one named optimizer sits: its bucket and its index inside it. */
export interface OptimizerLocation {
    bucket: OptimizerConfigBucket;
    index: number;
}

/**
 * Where the named optimizers sit in the pipeline, in *config* order.
 *
 * Config order rather than the order the ids were asked for: the cards are read
 * top to bottom as the pipeline that produced the lane, and the pipeline's
 * order is the document's, not the caller's. Ids that no longer resolve are
 * dropped -- an empty result is what raises `not_found`. Both buckets are
 * searched -- the caller only has ids, not which bucket owns them, and a lane
 * badge names whatever actually drives that lane regardless of bucket.
 */
export function findOptimizerLocations(
    config: JsonObject,
    optimizerIds: readonly string[],
): OptimizerLocation[] {
    const wanted = new Set(optimizerIds.filter((id) => id.length > 0));
    if (wanted.size === 0) {
        return [];
    }
    return OPTIMIZER_BUCKETS.flatMap((bucket) =>
        readOptimizers(config, bucket)
            .map((entry, index): [number, string | undefined] => [
                index,
                asJsonObject(entry)?.id as string | undefined,
            ])
            .filter(([, id]) => id !== undefined && wanted.has(id))
            .map(([index]): OptimizerLocation => ({ bucket, index })),
    );
}

function readOptimizers(config: JsonObject, bucket: OptimizerConfigBucket) {
    return asJsonArray(asJsonObject(config.automation)?.[bucket]) ?? [];
}
