import type { HomeAssistant } from "../../hass-frontend/src/types";
import { HistoryPayload, applyValueType } from "../helman-api";
import { DeviceNode } from "./DeviceNode";
import { nodeAccentColor } from "../color-utils";

export class HistoryEngine {
    private _interval?: number;
    private _rafHandle?: number;

    constructor(
        private _getHass: () => HomeAssistant | undefined,
        private _maxBuckets: number,
        private _onTick: () => void,
    ) {}

    /** Flatten a node tree into depth-first order (parent before children). */
    static walkTree(nodes: DeviceNode[]): DeviceNode[] {
        const result: DeviceNode[] = [];
        const walk = (list: DeviceNode[]) => {
            for (const node of list) {
                result.push(node);
                walk(node.children);
            }
        };
        walk(nodes);
        return result;
    }

    /** Fill powerHistory and sourcePowerHistory from a backend history payload. */
    applyHistory(history: HistoryPayload, nodes: DeviceNode[], sourceNodes: DeviceNode[]): void {
        const { entity_history, buckets } = history;
        for (const node of nodes) {
            if (!node.powerSensorId) continue;
            const rawHistory = entity_history[node.powerSensorId];
            if (rawHistory) {
                let h = [...rawHistory];
                if (node.valueType === 'positive') h = h.map(v => Math.max(0, v));
                else if (node.valueType === 'negative') h = h.map(v => Math.abs(Math.min(0, v)));
                node.powerHistory = h;
                node.historyBuckets = buckets;
            }
            if (node.isSource) continue;
            // One source bucket per *actual* power bucket, never per configured
            // capacity: the backend returns the live deque contents, which are
            // shorter than `buckets` until the buffers have filled (startup, or a
            // subscription rebuild). Sized by `buckets` the two series started out
            // different lengths, and since `_advanceTree` appends to both, that
            // offset survived every push and trim — attribution ended up describing
            // a different bucket than the one it was painted on (#227).
            node.sourcePowerHistory = [];
            // The buffers are all appended in lockstep and share one maxlen, so the
            // newest sample of every series is its last one. Align from the end, so
            // a series that started later still lines its samples up in time.
            const ratioOffsets = new Map<string, number>();
            for (const src of sourceNodes) {
                if (!src.ratioSensorId) continue;
                const ratioHistory = entity_history[src.ratioSensorId];
                if (ratioHistory) ratioOffsets.set(src.ratioSensorId, ratioHistory.length - node.powerHistory.length);
            }
            for (let i = 0; i < node.powerHistory.length; i++) {
                const bucket: { [sourceId: string]: { power: number; color: string } } = {};
                const consumerPower = node.powerHistory[i] ?? 0;
                for (const src of sourceNodes) {
                    if (!src.ratioSensorId) continue;
                    const ratioHistory = entity_history[src.ratioSensorId];
                    const ratio = (ratioHistory?.[i + (ratioOffsets.get(src.ratioSensorId) ?? 0)] ?? 0) / 100;
                    if (ratio > 0 && consumerPower > 0) {
                        bucket[src.id] = { power: consumerPower * ratio, color: nodeAccentColor(src.sourceType) };
                    }
                }
                node.sourcePowerHistory.push(bucket);
            }
        }
    }

    /** Push one live bucket per node and notify the card to re-render (coalesced to next animation frame). */
    advanceBuckets(nodes: DeviceNode[], sourceNodes: DeviceNode[]): void {
        if (!this._getHass()) return;
        this._advanceTree(nodes, sourceNodes);
        this._scheduleTick();
    }

    /** Start the periodic bucket advance. Stops any existing timer first. */
    start(bucketDuration: number, getNodes: () => DeviceNode[], getSourceNodes: () => DeviceNode[]): void {
        this.stop();
        this._interval = window.setInterval(() => {
            this.advanceBuckets(getNodes(), getSourceNodes());
        }, bucketDuration * 1000);
    }

    /** Stop the periodic timer and cancel any pending render frame. */
    stop(): void {
        if (this._interval !== undefined) {
            clearInterval(this._interval);
            this._interval = undefined;
        }
        if (this._rafHandle !== undefined) {
            cancelAnimationFrame(this._rafHandle);
            this._rafHandle = undefined;
        }
    }

    private _scheduleTick(): void {
        if (this._rafHandle !== undefined) return;
        this._rafHandle = requestAnimationFrame(() => {
            this._rafHandle = undefined;
            this._onTick();
        });
    }

    private _advanceTree(nodes: DeviceNode[], sourceNodes: DeviceNode[]): void {
        const hass = this._getHass()!;
        const maxBuckets = this._maxBuckets;
        for (const node of nodes) {
            if (node.powerHistory.length > 0) {
                node.powerHistory.push(node.powerHistory[node.powerHistory.length - 1]);
                if (node.sourcePowerHistory && node.sourcePowerHistory.length > 0) {
                    node.sourcePowerHistory.push(node.sourcePowerHistory[node.sourcePowerHistory.length - 1]);
                }
            }
            if (node.powerHistory.length > maxBuckets) {
                node.powerHistory.shift();
            }
            if (node.powerSensorId) {
                const rawPower = parseFloat(hass.states[node.powerSensorId]?.state ?? '0') || 0;
                const power = applyValueType(rawPower, node.valueType);
                if (node.powerHistory.length === 0) node.powerHistory.push(0);
                node.powerHistory[node.powerHistory.length - 1] = power;
                node.powerValue = power;
            }
            this._advanceTree(node.children, sourceNodes);
            if (!node.isSource && node.powerSensorId) {
                // The two series are re-squared to the same length on every tick, so
                // bucket i of one always describes bucket i of the other. This is also
                // what gives a consumer that the history payload omitted its first
                // attribution: without it the source series stayed empty forever and
                // every one of that consumer's bars fell back to its own colour.
                const sourceHistory = node.sourcePowerHistory ?? (node.sourcePowerHistory = []);
                while (sourceHistory.length > node.powerHistory.length) sourceHistory.shift();
                while (sourceHistory.length < node.powerHistory.length) sourceHistory.unshift({});
                if (sourceHistory.length > 0) {
                    const bucket: { [sourceId: string]: { power: number; color: string } } = {};
                    const powerVal = node.powerValue || 0;
                    if (powerVal > 0) {
                        for (const src of sourceNodes) {
                            if (!src.ratioSensorId) continue;
                            const ratio = parseFloat(hass.states[src.ratioSensorId]?.state ?? '0') / 100;
                            if (ratio > 0) bucket[src.id] = { power: powerVal * ratio, color: nodeAccentColor(src.sourceType) };
                        }
                    }
                    sourceHistory[sourceHistory.length - 1] = bucket;
                }
            }
        }
    }
}
