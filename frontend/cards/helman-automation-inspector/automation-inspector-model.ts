import type { LocalizeFunction } from "../localize/localize";
import type {
    AutomationRunPayload,
    AutomationTraceDTO,
    TraceDecisionDTO,
    TraceStepDTO,
    TraceStepRailsDTO,
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
    /**
     * Derivation inputs, one entry per condition group.
     *
     * With ORed groups there is no single threshold: a slot is eligible when
     * *any* group accepts it, so it is only rejected when it fails them all.
     * Scraping a single value off an emitted decision — as this did before
     * groups — makes derived cells contradict emitted ones, and the coverage
     * validator cannot catch it because these slots are explicitly declared
     * derivable.
     */
    exportThresholds: number[];
    socThresholds: number[];
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
        return this.explainAction(slotId, domain, localize)?.reason ?? null;
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

    private _reasonForStepSlot(
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
    private _decorateForConditionUnmet(
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
        return {
            step,
            decisionBySlot,
            writesBySlot,
            exportThresholds: this._groupValues(step, "when_price_below", "threshold", [
                "price_below_threshold",
            ]),
            socThresholds: this._groupValues(step, "min_soc_pct", "threshold", []),
        };
    }

    /**
     * One numeric condition value per group.
     *
     * Prefers the step's declared groups, which cover every group whether or not
     * it placed anything. Falls back to scraping emitted decision params so
     * traces recorded before `conditionGroups` existed still derive.
     */
    private _groupValues(
        step: TraceStepDTO,
        valueKey: string,
        paramKey: string,
        emittingCodes: string[],
    ): number[] {
        const fromGroups = (step.conditionGroups ?? [])
            .map((group) => group.values[valueKey])
            .filter((value): value is number => typeof value === "number");
        if (fromGroups.length) return fromGroups;
        const scraped: number[] = [];
        for (const decision of step.decisions) {
            const value = decision.reason?.params?.[paramKey];
            if (
                decision.reason &&
                emittingCodes.includes(decision.reason.code) &&
                typeof value === "number"
            ) {
                scraped.push(value);
            }
        }
        return scraped;
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
            // A placement made while the optimizer's execution condition is unmet
            // is a candidate that won't run — show it as blocked, not green
            // "applied", so the glyph matches the "won't execute" explanation.
            const conditionUnmet =
                entry.step.conditionMet === false && decision.outcome === "applied";
            const state: CellState =
                code === "unexplained"
                    ? "unexplained"
                    : conditionUnmet
                        ? "blocked"
                        : (decision.outcome as CellState);
            const siblings: number[] = [];
            for (const sid of decision.slotIds) {
                const idx = this._slotIndex(sid);
                if (idx >= 0) siblings.push(idx);
            }
            return {
                state,
                outcome: decision.outcome,
                reason: this._decorateForConditionUnmet(
                    this._formatReason(
                        code,
                        decision.reason?.params ?? {},
                        slotIndex,
                        localize,
                    ),
                    entry.step,
                    decision.outcome,
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
        if (kind === "export_price" && entry.exportThresholds.length) {
            // The loosest group decides: the slot is only rejected if its price
            // clears *every* group's threshold.
            const threshold = Math.max(...entry.exportThresholds);
            const price = this.railValue(this.trace.staticRails.exportPrice, slotIndex);
            if (price !== null && price >= threshold) {
                return this._derivedView(
                    "price_not_below_threshold",
                    { threshold, price },
                    slotIndex,
                    localize,
                    write,
                );
            }
        }
        if (kind === "appliance_runtime" && entry.socThresholds.length) {
            // Likewise the lowest floor is the easiest to clear, so it is the
            // one a rejected slot failed.
            const threshold = Math.min(...entry.socThresholds);
            const soc = this.railValue(entry.step.railsIn.batterySocPct, slotIndex);
            // The rail carries the slot's *last* bucket while the condition
            // rejects on any bucket, so a slot rejected on its first bucket is
            // explained with a number that passes. Accepted: the verdict is
            // still right, only the quoted figure is unhelpful.
            if (soc !== null && soc < threshold) {
                return this._derivedView(
                    "soc_below_threshold",
                    { soc, threshold },
                    slotIndex,
                    localize,
                    write,
                );
            }
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
