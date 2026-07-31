import type { LocalizeFunction } from "../localize/localize";
import type {
    AutomationRunPayload,
    AutomationTraceDTO,
    TraceStepDTO,
    TraceWriteDTO,
} from "../helman-api";
import {
    AutomationRunModel,
    type FormattedReason,
    type RunStepEntry,
} from "../helman-scheduling/model/automation-run-model";

/**
 * The inspector card's view of one run, on top of the shared run model.
 *
 * Everything the *scheduling* card needs — the rail metrics, `cellDeltas`,
 * `explainAction` and the reason formatting they lean on — lives in
 * `helman-scheduling/model/automation-run-model`. This file keeps only what is
 * genuinely inspector-only: the matrix cell vocabulary and the frontend
 * derivations that fill the slots `export_price` and `appliance_runtime`
 * declare derivable. Extending rather than copying is deliberate: two copies of
 * the attribution rules would drift, and the inspector exists (until #16) to be
 * cross-checked against the new explanation dialog.
 */

/** Visual state of one (optimizer, slot) matrix cell. */
export type CellState =
    | "applied"
    | "rejected"
    | "blocked"
    | "out_of_scope"
    | "unexplained"
    | "derived";

export interface CellView {
    state: CellState;
    outcome: string;
    reason: FormattedReason;
    /** The group's sibling slot indices (for hover-highlight). */
    siblingSlotIndices: number[];
    /** Present when this cell corresponds to a committed write. */
    write?: TraceWriteDTO;
}

export type {
    ActionExplanation,
    FormattedReason,
    RailDelta,
    RailMetricDef,
} from "../helman-scheduling/model/automation-run-model";
export { RAIL_METRICS } from "../helman-scheduling/model/automation-run-model";

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
interface StepDerivation {
    exportThresholds: number[];
    socThresholds: number[];
}

export class AutomationInspectorModel extends AutomationRunModel {
    /** Index-aligned to the run's steps. */
    private readonly _derivations: StepDerivation[];

    constructor(trace: AutomationTraceDTO) {
        super(trace);
        this._derivations = trace.steps.map((step) => ({
            exportThresholds: groupValues(step, "when_price_below", "threshold", [
                "price_below_threshold",
            ]),
            socThresholds: groupValues(step, "min_soc_pct", "threshold", []),
        }));
    }

    static fromPayload(payload: AutomationRunPayload): AutomationInspectorModel | null {
        if (!payload.trace) return null;
        return new AutomationInspectorModel(payload.trace);
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
        return this._deriveCell(stepIndex, entry, slotIndex, localize, write);
    }

    private _deriveCell(
        stepIndex: number,
        entry: RunStepEntry,
        slotIndex: number,
        localize: LocalizeFunction,
        write?: TraceWriteDTO,
    ): CellView {
        const kind = entry.step.kind;
        const derivation = this._derivations[stepIndex];
        if (kind === "export_price" && derivation.exportThresholds.length) {
            // The loosest group decides: the slot is only rejected if its price
            // clears *every* group's threshold.
            const threshold = Math.max(...derivation.exportThresholds);
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
        if (kind === "appliance_runtime" && derivation.socThresholds.length) {
            // Likewise the lowest floor is the easiest to clear, so it is the
            // one a rejected slot failed.
            const threshold = Math.min(...derivation.socThresholds);
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
}

/**
 * One numeric condition value per group.
 *
 * Prefers the step's declared groups, which cover every group whether or not
 * it placed anything. Falls back to scraping emitted decision params so
 * traces recorded before `conditionGroups` existed still derive.
 */
function groupValues(
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
