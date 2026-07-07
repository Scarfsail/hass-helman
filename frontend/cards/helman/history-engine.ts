import type { HomeAssistant } from "../../hass-frontend/src/types";
import { HistoryPayload, applyValueType } from "../helman-api";
import { DeviceNode } from "./DeviceNode";
import { canonicalSourceColor } from "../color-utils";

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
            node.sourcePowerHistory = [];
            if (!rawHistory) continue;
            for (let i = 0; i < buckets; i++) {
                const bucket: { [sourceId: string]: { power: number; color: string } } = {};
                const consumerPower = node.powerHistory[i] ?? 0;
                for (const src of sourceNodes) {
                    if (!src.ratioSensorId) continue;
                    const ratioHistory = entity_history[src.ratioSensorId];
                    const ratio = (ratioHistory?.[i] ?? 0) / 100;
                    if (ratio > 0 && consumerPower > 0) {
                        bucket[src.id] = { power: consumerPower * ratio, color: src.color || canonicalSourceColor(src.sourceType) };
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
                if (node.sourcePowerHistory) {
                    node.sourcePowerHistory.push(node.sourcePowerHistory[node.sourcePowerHistory.length - 1]);
                }
            }
            if (node.powerHistory.length > maxBuckets) {
                node.powerHistory.shift();
                node.sourcePowerHistory?.shift();
            }
            if (node.powerSensorId) {
                const rawPower = parseFloat(hass.states[node.powerSensorId]?.state ?? '0') || 0;
                const power = applyValueType(rawPower, node.valueType);
                if (node.powerHistory.length === 0) node.powerHistory.push(0);
                node.powerHistory[node.powerHistory.length - 1] = power;
                node.powerValue = power;
            }
            this._advanceTree(node.children, sourceNodes);
            if (!node.isSource && node.powerSensorId && node.sourcePowerHistory && node.sourcePowerHistory.length > 0) {
                const bucket: { [sourceId: string]: { power: number; color: string } } = {};
                const powerVal = node.powerValue || 0;
                if (powerVal > 0) {
                    for (const src of sourceNodes) {
                        if (!src.ratioSensorId) continue;
                        const ratio = parseFloat(hass.states[src.ratioSensorId]?.state ?? '0') / 100;
                        if (ratio > 0) bucket[src.id] = { power: powerVal * ratio, color: src.color || canonicalSourceColor(src.sourceType) };
                    }
                }
                node.sourcePowerHistory[node.sourcePowerHistory.length - 1] = bucket;
            }
        }
    }
}
