import type {
    AutomationRunPayload,
    AutomationTraceDTO,
    TraceDecisionDTO,
    TraceStepDTO,
    TraceStepRailsDTO,
    TraceWriteDTO,
} from "../../helman-api";

/**
 * What the scheduling card needs from one automation run's trace: the mutable
 * system rails an optimizer moved, and which step owns a given (slot, domain)
 * so those movements can be attributed.
 *
 * *Why* a slot looks the way it does is not answered here. The card's "why"
 * popover reads the structured condition record (`schedule-explanation-model`)
 * and names the condition that decided the slot; this module only supplies the
 * rail-delta badges beside it.
 */

/**
 * A mutable system parameter an optimizer can move. The pipeline captures each
 * of these before every step (and after the last), so a cell can show the
 * decision's effect as a before->after delta. `id` keys both the localized
 * label and the color token; `key` is the rail field on the DTO.
 */
export interface RailMetricDef {
    id: "surplus" | "soc" | "import" | "export";
    key: "availableSurplusKwh" | "batterySocPct" | "importedFromGridKwh" | "exportedToGridKwh";
    unit: string;
    precision: number;
    /** Smallest |after-before| worth rendering — filters float noise. */
    epsilon: number;
}

export const RAIL_METRICS: readonly RailMetricDef[] = [
    { id: "surplus", key: "availableSurplusKwh", unit: "kWh", precision: 2, epsilon: 0.05 },
    { id: "soc", key: "batterySocPct", unit: "%", precision: 0, epsilon: 0.5 },
    { id: "import", key: "importedFromGridKwh", unit: "kWh", precision: 2, epsilon: 0.05 },
    { id: "export", key: "exportedToGridKwh", unit: "kWh", precision: 2, epsilon: 0.05 },
];

export interface RailDelta {
    metric: RailMetricDef;
    before: number | null;
    after: number | null;
}

/** The scheduling card's per-action explanation: this run's system impact. */
export interface ActionExplanation {
    /** Rails this run moved for the action; empty when it was left unchanged. */
    deltas: RailDelta[];
    /** How the action was attributed — a diff-write is exact, a decision is a
     * best-effort match for an action left unchanged this run. */
    attribution: "write" | "decision";
}

/** Optimizer kinds that write the inverter action (vs. an appliance action). */
const INVERTER_KINDS = new Set(["charge_hold", "charge_from_grid", "export_price"]);

/** One step of the run, indexed by slot for O(1) lookups. */
export interface RunStepEntry {
    step: TraceStepDTO;
    /** slotId -> the decision covering it (last emission wins). */
    decisionBySlot: Map<string, TraceDecisionDTO>;
    /** slotId -> committed writes for that slot (one per domain). */
    writesBySlot: Map<string, TraceWriteDTO[]>;
}

/**
 * Pure lookups over one run's trace. Kept free of Lit so it can be unit-tested
 * against a fixture.
 */
export class AutomationRunModel {
    readonly trace: AutomationTraceDTO;
    readonly slotIds: string[];
    private readonly _steps: RunStepEntry[];
    /** slotId -> its index, built once so lookups stay O(1). */
    private readonly _slotIndexById: Map<string, number>;

    constructor(trace: AutomationTraceDTO) {
        this.trace = trace;
        this.slotIds = trace.slotIds;
        this._slotIndexById = new Map(this.slotIds.map((id, i) => [id, i]));
        this._steps = trace.steps.map((step) => indexRunStep(step));
    }

    private _slotIndex(slotId: string): number {
        return this._slotIndexById.get(slotId) ?? -1;
    }

    static fromPayload(payload: AutomationRunPayload): AutomationRunModel | null {
        if (!payload.trace) return null;
        return new AutomationRunModel(payload.trace);
    }

    /**
     * Attribute a persisted automation action to the step that produced it, and
     * report the system impact this run had. Attribution prefers the step that
     * actually wrote (slotId, domain) — exact, and carrying the run's rail
     * deltas. When the action was left unchanged this run (no diff-write, common
     * for idempotent slots), an inverter action falls back to the last
     * inverter-kind step that emitted an ``applied`` decision for the slot, so
     * the row is still attributed — with empty deltas, since nothing moved this
     * run. Appliance domains have no reliable write-free attribution (a decision
     * does not name its appliance), so they return null and the card shows a
     * generic "set by automation".
     */
    explainAction(slotId: string, domain: string): ActionExplanation | null {
        const slotIndex = this._slotIndex(slotId);
        if (slotIndex < 0) return null;

        let owningStep = -1;
        for (let stepIndex = 0; stepIndex < this._steps.length; stepIndex++) {
            const writes = this._steps[stepIndex].writesBySlot.get(slotId);
            if (writes && writes.some((w) => w.domain === domain)) {
                owningStep = stepIndex;
            }
        }
        if (owningStep >= 0) {
            return {
                deltas: this.cellDeltas(owningStep, slotIndex),
                attribution: "write",
            };
        }

        if (domain === "inverter") {
            for (let stepIndex = this._steps.length - 1; stepIndex >= 0; stepIndex--) {
                const entry = this._steps[stepIndex];
                if (!INVERTER_KINDS.has(entry.step.kind)) continue;
                const decision = entry.decisionBySlot.get(slotId);
                if (!decision || decision.outcome !== "applied") continue;
                return {
                    deltas: this.cellDeltas(stepIndex, slotIndex),
                    attribution: "decision",
                };
            }
        }
        return null;
    }

    railValue(rail: (number | null)[] | undefined, slotIndex: number): number | null {
        if (!rail || slotIndex < 0 || slotIndex >= rail.length) return null;
        return rail[slotIndex] ?? null;
    }

    /**
     * The mutable rails as they stood *after* step ``stepIndex`` ran — i.e. what
     * the next step received, or the final snapshot for the last step. Pairing
     * this with the step's own ``railsIn`` gives the decision's before/after.
     */
    railsAfterStep(stepIndex: number): TraceStepRailsDTO {
        const next = this.trace.steps[stepIndex + 1];
        return next ? next.railsIn : this.trace.railsFinal;
    }

    /**
     * Per-slot before->after for every parameter this step moved by more than
     * its epsilon. Empty when the step left the slot's rails untouched. A rail
     * can move on a slot the step never wrote (e.g. charging earlier drains a
     * later slot's surplus) — that ripple is a real effect, so it's included.
     */
    cellDeltas(stepIndex: number, slotIndex: number): RailDelta[] {
        const before = this.trace.steps[stepIndex]?.railsIn;
        if (!before) return [];
        const after = this.railsAfterStep(stepIndex);
        const deltas: RailDelta[] = [];
        for (const metric of RAIL_METRICS) {
            const b = this.railValue(before[metric.key], slotIndex);
            const a = this.railValue(after[metric.key], slotIndex);
            if (b === null && a === null) continue;
            if (Math.abs((a ?? 0) - (b ?? 0)) < metric.epsilon) continue;
            deltas.push({ metric, before: b, after: a });
        }
        return deltas;
    }
}

/** Index one step's decisions and writes by slot id. */
export function indexRunStep(step: TraceStepDTO): RunStepEntry {
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
    return { step, decisionBySlot, writesBySlot };
}
