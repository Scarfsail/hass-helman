import type { LogicComparison } from "./logic-diagram-model";
import type { LogicState } from "./logic-diagram-model";

/** Never colour alone: every block states its result as a mark too. */
export function stateGlyph(state: LogicState): string {
    switch (state) {
        case "true":
            return "✓";
        case "false":
            return "✗";
        case "errored":
            return "!";
        case "not_evaluated":
            return "?";
        default:
            return "–";
    }
}

/**
 * `HH:MM` from either shape the backend records.
 *
 * `appliance_runtime` writes the configured `"08:00"` straight through;
 * `charge_hold` writes a whole slot id. Both mean a time of day.
 */
export function shortTime(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const inSlotId = /T(\d{2}:\d{2})/.exec(value);
    if (inSlotId !== null) return inSlotId[1];
    return /^\d{1,2}:\d{2}$/.test(value) ? value : null;
}

/** The comparison as one line, e.g. `3.43 < 3.50`. */
export function formatComparison(comparison: LogicComparison): string {
    return comparison.actual === null
        ? `${comparison.operator} ${comparison.value}`
        : `${comparison.actual} ${comparison.operator} ${comparison.value}`;
}

/**
 * Fit `text` inside `maxPx`, with an ellipsis when it does not.
 *
 * SVG text does not wrap and does not clip: an over-long string paints straight
 * over its neighbour, which is exactly how a raw JSON `actual` ended up
 * unreadable across two blocks. The estimate is deliberately pessimistic —
 * Czech diacritics and capitals run wide, and a slightly short label with a
 * tooltip beats a long one over the top of the next block.
 */
export function fitText(text: string, maxPx: number, pxPerChar: number): string {
    const budget = Math.max(1, Math.floor(maxPx / pxPerChar));
    if (text.length <= budget) return text;
    return `${text.slice(0, Math.max(1, budget - 1))}…`;
}

/**
 * What a value may show *on the block face*: scalars only.
 *
 * An object is summarised by its `code` where it has one — the rejection codes
 * are the readable part — and otherwise dropped from the face entirely. The
 * whole value is still one hover away in the block's `<title>`.
 */
export function summariseLogicValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    if (typeof value === "string" || typeof value === "boolean") {
        return String(value);
    }
    if (typeof value === "object" && !Array.isArray(value)) {
        const code = (value as Record<string, unknown>).code;
        return typeof code === "string" ? code : null;
    }
    return null;
}

/** The whole value, for the tooltip that the block face cannot carry. */
export function fullLogicValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : String(value);
    }
    if (typeof value === "string" || typeof value === "boolean") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

