import type { LocalizeFunction } from "../localize/localize";
import type {
    AutomationRunPayload,
    AutomationTraceDTO,
    TraceDecisionDTO,
    TraceStepDTO,
    TraceWriteDTO,
} from "../helman-api";

/** Visual state of one (optimizer, slot) matrix cell. */
export type CellState =
    | "applied"
    | "rejected"
    | "blocked"
    | "out_of_scope"
    | "unexplained"
    | "derived";

export interface FormattedReason {
    /** Localized short label for the cell / popover header. */
    title: string;
    /** Localized detail line, with params substituted. */
    detail: string;
    /** The raw code — always shown for unknown codes so a new backend code
     * never breaks the card. */
    code: string;
    params: Record<string, unknown>;
}

export interface CellView {
    state: CellState;
    outcome: string;
    reason: FormattedReason;
    /** The group's sibling slot indices (for hover-highlight). */
    siblingSlotIndices: number[];
    /** Present when this cell corresponds to a committed write. */
    write?: TraceWriteDTO;
}

const KNOWN_REASON_CODES = new Set([
    "price_below_threshold",
    "price_not_below_threshold",
    "stop_export_unsupported",
    "hold_window_applied",
    "after_release",
    "outside_window",
    "no_room_to_hold",
    "day_not_matched",
    "battery_params_missing",
    "bridge_window",
    "cheaper_slot_chosen",
    "window_covered",
    "band_not_expensive",
    "no_cheap_band",
    "runtime_deficit_placed",
    "ranked_more_expensive",
    "runtime_satisfied",
    "day_skipped",
    "surplus_covers_demand",
    "surplus_insufficient",
    "forecast_unavailable",
    "blocked_user_owned",
    "optimizer_skipped",
    "unexplained",
]);

interface StepIndexEntry {
    step: TraceStepDTO;
    /** slotId -> the decision covering it (last emission wins). */
    decisionBySlot: Map<string, TraceDecisionDTO>;
    /** slotId -> committed writes for that slot (one per domain). */
    writesBySlot: Map<string, TraceWriteDTO[]>;
    /** Derivation inputs pulled from emitted params. */
    exportThreshold: number | null;
    surplusBufferPct: number | null;
}

/**
 * Pure lookups + reason formatting over one run's trace. Kept free of Lit so it
 * can be unit-tested against a fixture.
 */
export class AutomationInspectorModel {
    readonly trace: AutomationTraceDTO;
    readonly slotIds: string[];
    private readonly _steps: StepIndexEntry[];
    /** slotId -> its index, built once so lookups stay O(1). */
    private readonly _slotIndexById: Map<string, number>;

    constructor(trace: AutomationTraceDTO) {
        this.trace = trace;
        this.slotIds = trace.slotIds;
        this._slotIndexById = new Map(this.slotIds.map((id, i) => [id, i]));
        this._steps = trace.steps.map((step) => this._indexStep(step));
    }

    private _slotIndex(slotId: string): number {
        return this._slotIndexById.get(slotId) ?? -1;
    }

    static fromPayload(payload: AutomationRunPayload): AutomationInspectorModel | null {
        if (!payload.trace) return null;
        return new AutomationInspectorModel(payload.trace);
    }

    get steps(): TraceStepDTO[] {
        return this.trace.steps;
    }

    /**
     * Find the reason a persisted automation action was written, for the
     * scheduling card's "why" popover. Scans steps in order so the last step
     * that wrote (slotId, domain) — the one that produced the final action —
     * wins, mirroring how later optimizers override earlier writes.
     */
    findActionReason(
        slotId: string,
        domain: string,
        localize: LocalizeFunction,
    ): FormattedReason | null {
        const slotIndex = this._slotIndex(slotId);
        if (slotIndex < 0) return null;
        let found: FormattedReason | null = null;
        for (let stepIndex = 0; stepIndex < this._steps.length; stepIndex++) {
            const entry = this._steps[stepIndex];
            const writes = entry.writesBySlot.get(slotId);
            if (!writes || !writes.some((w) => w.domain === domain)) continue;
            const decision = entry.decisionBySlot.get(slotId);
            const code = decision?.reason?.code ?? "unexplained";
            found = this._formatReason(
                code,
                decision?.reason?.params ?? {},
                slotIndex,
                localize,
            );
        }
        return found;
    }

    railValue(rail: (number | null)[] | undefined, slotIndex: number): number | null {
        if (!rail || slotIndex < 0 || slotIndex >= rail.length) return null;
        return rail[slotIndex] ?? null;
    }

    private _indexStep(step: TraceStepDTO): StepIndexEntry {
        const decisionBySlot = new Map<string, TraceDecisionDTO>();
        for (const decision of step.decisions) {
            for (const slotId of decision.slotIds) {
                decisionBySlot.set(slotId, decision);
            }
        }
        const writesBySlot = new Map<string, TraceWriteDTO[]>();
        for (const write of step.writes) {
            const existing = writesBySlot.get(write.slotId);
            if (existing) existing.push(write);
            else writesBySlot.set(write.slotId, [write]);
        }
        let exportThreshold: number | null = null;
        let surplusBufferPct: number | null = null;
        for (const decision of step.decisions) {
            const p = decision.reason?.params ?? {};
            if (decision.reason?.code === "price_below_threshold" && typeof p.threshold === "number") {
                exportThreshold = p.threshold;
            }
            if (decision.reason?.code === "surplus_covers_demand" && typeof p.bufferPct === "number") {
                surplusBufferPct = p.bufferPct;
            }
        }
        return { step, decisionBySlot, writesBySlot, exportThreshold, surplusBufferPct };
    }

    /** Resolve the cell at (stepIndex, slotIndex) to a rendered view. */
    resolveCell(
        stepIndex: number,
        slotIndex: number,
        localize: LocalizeFunction,
    ): CellView {
        const entry = this._steps[stepIndex];
        const slotId = this.slotIds[slotIndex];
        const write = entry.writesBySlot.get(slotId)?.[0];
        const decision = entry.decisionBySlot.get(slotId);

        if (decision) {
            const code = decision.reason?.code ?? "unexplained";
            const state: CellState =
                code === "unexplained"
                    ? "unexplained"
                    : (decision.outcome as CellState);
            const siblings: number[] = [];
            for (const sid of decision.slotIds) {
                const idx = this._slotIndex(sid);
                if (idx >= 0) siblings.push(idx);
            }
            return {
                state,
                outcome: decision.outcome,
                reason: this._formatReason(
                    code,
                    decision.reason?.params ?? {},
                    slotIndex,
                    localize,
                ),
                siblingSlotIndices: siblings,
                write,
            };
        }

        // No emitted decision -> a frontend derivation (the D rows) or generic
        // out-of-scope. Never leave a cell unexplained for the user.
        return this._deriveCell(entry, slotIndex, localize, write);
    }

    private _deriveCell(
        entry: StepIndexEntry,
        slotIndex: number,
        localize: LocalizeFunction,
        write?: TraceWriteDTO,
    ): CellView {
        const kind = entry.step.kind;
        if (kind === "export_price") {
            const price = this.railValue(this.trace.staticRails.exportPrice, slotIndex);
            if (price !== null && entry.exportThreshold !== null && price >= entry.exportThreshold) {
                return this._derivedView(
                    "price_not_below_threshold",
                    { threshold: entry.exportThreshold, price },
                    slotIndex,
                    localize,
                    write,
                );
            }
        }
        if (kind === "surplus_appliance") {
            const surplus = this.railValue(
                entry.step.railsIn.availableSurplusKwh,
                slotIndex,
            );
            return this._derivedView(
                "surplus_insufficient",
                { surplus, bufferPct: entry.surplusBufferPct },
                slotIndex,
                localize,
                write,
            );
        }
        // Generic "not considered" default for kinds without a slot-local rule.
        return this._derivedView("out_of_scope_default", {}, slotIndex, localize, write);
    }

    private _derivedView(
        code: string,
        params: Record<string, unknown>,
        slotIndex: number,
        localize: LocalizeFunction,
        write?: TraceWriteDTO,
    ): CellView {
        return {
            state: "derived",
            outcome: "out_of_scope",
            reason: this._formatReason(code, params, slotIndex, localize),
            siblingSlotIndices: [slotIndex],
            write,
        };
    }

    private _formatReason(
        code: string,
        params: Record<string, unknown>,
        slotIndex: number,
        localize: LocalizeFunction,
    ): FormattedReason {
        const known =
            KNOWN_REASON_CODES.has(code) || code === "out_of_scope_default";
        const titleKey = `automation.inspector.reason.${code}.title`;
        const detailKey = `automation.inspector.reason.${code}.detail`;
        const title = known ? localize(titleKey) : code;
        const detailTemplate = known ? localize(detailKey) : "";
        const detail = known
            ? substitute(detailTemplate, params)
            : JSON.stringify(params);
        return { title: title || code, detail, code, params };
    }
}

/** Replace {name} placeholders in a template with values from params. */
function substitute(template: string, params: Record<string, unknown>): string {
    if (!template) return "";
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
        const value = params[key];
        if (value === undefined || value === null) return "—";
        if (Array.isArray(value)) {
            return value.length ? value.map(formatScalar).join(", ") : "—";
        }
        return formatScalar(value);
    });
}

/** ISO slot id, e.g. "2026-07-12T18:00" — rendered as its HH:MM time. */
const SLOT_ID_RE = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/;

function formatScalar(value: unknown): string {
    if (value === undefined || value === null) return "—";
    if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    if (typeof value === "string") {
        const slot = SLOT_ID_RE.exec(value);
        return slot ? slot[1] : value;
    }
    return String(value);
}
