import type { LocalizeFunction } from "../../localize/localize";
import type {
    AutomationRunPayload,
    AutomationTraceDTO,
    TraceDecisionDTO,
    TraceStepDTO,
    TraceStepRailsDTO,
    TraceWriteDTO,
} from "../../helman-api";

/**
 * What the scheduling card needs from one automation run's trace.
 *
 * This is the half of the old `automation-inspector-model.ts` the *scheduling*
 * card depends on: the mutable system rails an optimizer moved, and which step
 * owns a given (slot, domain) so those movements can be attributed. It lives
 * under the scheduling card because that is its only consumer of consequence —
 * `helman-automation-inspector` extends this class rather than keeping a second
 * copy, so the two cannot drift, and deleting the inspector (#16) leaves this
 * module standing.
 *
 * The *reason* half — the `{code, params}` catalogue and its localized prose —
 * is deliberately not what the scheduling card renders any more. Its "why"
 * popover reads the structured condition record (`schedule-explanation-model`)
 * and names the condition that decided the slot. `FormattedReason` survives
 * here only because `explainAction` still computes it for the inspector's
 * cross-check; it goes with the catalogue in #16.
 */

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

/** The scheduling card's per-action explanation: why + this run's impact. */
export interface ActionExplanation {
    reason: FormattedReason | null;
    /** Rails this run moved for the action; empty when it was left unchanged. */
    deltas: RailDelta[];
    /** How the reason was attributed — a diff-write is exact, a decision is a
     * best-effort match for an action left unchanged this run. */
    attribution: "write" | "decision";
}

/** Optimizer kinds that write the inverter action (vs. an appliance action). */
const INVERTER_KINDS = new Set(["charge_hold", "charge_from_grid", "export_price"]);

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
    "price_above_run_threshold",
    "runtime_satisfied",
    "forced_after_consecutive_skips",
    "conditions_matched",
    "soc_below_threshold",
    "insufficient_solar_coverage",
    "would_break_soc_floor",
    "soc_floor_already_breached",
    "not_solar_neutral",
    "forecast_unavailable",
    "blocked_user_owned",
    "optimizer_skipped",
    "unexplained",
]);

/** One step of the run, indexed by slot for O(1) lookups. */
export interface RunStepEntry {
    step: TraceStepDTO;
    /** slotId -> the decision covering it (last emission wins). */
    decisionBySlot: Map<string, TraceDecisionDTO>;
    /** slotId -> committed writes for that slot (one per domain). */
    writesBySlot: Map<string, TraceWriteDTO[]>;
}

/**
 * Pure lookups + reason formatting over one run's trace. Kept free of Lit so it
 * can be unit-tested against a fixture.
 */
export class AutomationRunModel {
    readonly trace: AutomationTraceDTO;
    readonly slotIds: string[];
    protected readonly _steps: RunStepEntry[];
    /** slotId -> its index, built once so lookups stay O(1). */
    private readonly _slotIndexById: Map<string, number>;

    constructor(trace: AutomationTraceDTO) {
        this.trace = trace;
        this.slotIds = trace.slotIds;
        this._slotIndexById = new Map(this.slotIds.map((id, i) => [id, i]));
        this._steps = trace.steps.map((step) => indexRunStep(step));
    }

    protected _slotIndex(slotId: string): number {
        return this._slotIndexById.get(slotId) ?? -1;
    }

    static fromPayload(payload: AutomationRunPayload): AutomationRunModel | null {
        if (!payload.trace) return null;
        return new AutomationRunModel(payload.trace);
    }

    get steps(): TraceStepDTO[] {
        return this.trace.steps;
    }

    /**
     * Explain a persisted automation action for the scheduling card: the reason
     * plus the system impact this run had. Attribution prefers the step that
     * actually wrote (slotId, domain) — exact, and carrying the run's rail
     * deltas. When the action was left unchanged this run (no diff-write, common
     * for idempotent slots), an inverter action falls back to the last
     * inverter-kind step that emitted an ``applied`` decision for the slot, so
     * the row still explains *why the schedule looks this way* — with empty
     * deltas, since nothing moved this run. Appliance domains have no reliable
     * write-free attribution (a decision does not name its appliance), so they
     * return null and the card shows a generic "set by automation".
     */
    explainAction(
        slotId: string,
        domain: string,
        localize: LocalizeFunction,
    ): ActionExplanation | null {
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
                reason: this._reasonForStepSlot(owningStep, slotId, slotIndex, localize),
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
                    reason: this._reasonForStepSlot(stepIndex, slotId, slotIndex, localize),
                    deltas: this.cellDeltas(stepIndex, slotIndex),
                    attribution: "decision",
                };
            }
        }
        return null;
    }

    protected _reasonForStepSlot(
        stepIndex: number,
        slotId: string,
        slotIndex: number,
        localize: LocalizeFunction,
    ): FormattedReason {
        const entry = this._steps[stepIndex];
        const decision = entry.decisionBySlot.get(slotId);
        const reason = this._formatReason(
            decision?.reason?.code ?? "unexplained",
            decision?.reason?.params ?? {},
            slotIndex,
            localize,
        );
        return this._decorateForConditionUnmet(
            reason,
            entry.step,
            decision?.outcome,
            localize,
        );
    }

    /**
     * When an optimizer's execution condition is not met, every action it placed
     * is a candidate — kept for display but never executed. The raw placement
     * reason ("placed to meet daily runtime") reads as planned-for-execution, so
     * lead the explanation with the condition caveat, keeping the original reason
     * after it. Only ``applied`` placements need it; rejections/out-of-scope
     * decisions describe why nothing was placed and stay as-is.
     */
    protected _decorateForConditionUnmet(
        reason: FormattedReason,
        step: TraceStepDTO,
        outcome: string | undefined,
        localize: LocalizeFunction,
    ): FormattedReason {
        if (step.conditionMet !== false || outcome !== "applied") {
            return reason;
        }
        const title = localize("automation.inspector.reason.condition_unmet.title");
        const caveat = localize("automation.inspector.reason.condition_unmet.detail");
        return {
            ...reason,
            title: title || reason.title,
            detail: reason.detail ? `${caveat} ${reason.detail}` : caveat,
        };
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

    protected _formatReason(
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

/** Replace {name} placeholders in a template with values from params. */
export function substitute(template: string, params: Record<string, unknown>): string {
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

export function formatScalar(value: unknown): string {
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
