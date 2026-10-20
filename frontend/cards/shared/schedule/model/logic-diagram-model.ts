import type {
    ExplanationCell, ExplanationConditionNode, ExplanationGate, ExplanationGroup,
} from "./schedule-explanation-model";
import type { ExplanationNodeState, ExplanationParamsSource } from "../../data/helman-commands";
import { BLOCKED_USER_OWNED_GATE } from "./schedule-explanation-model";
import { shortTime } from "./logic-value-format";

/** How a slot ended up, as the diagram's terminal block. */
export type LogicTerminal = "execute" | "candidate" | "not_eligible" | "blocked";

/** A block's own result. `n/a` is a block with nothing to report. */
export type LogicState = ExplanationNodeState | "errored" | "n/a";

export type LogicBlockKind =
    | "input"
    | "and"
    | "or"
    | "custom"
    | "gate"
    /** The one term that *defeats* the conditions instead of joining them. */
    | "override"
    /** The AND that closes the planning stage: conditions, groups, gates. */
    | "final"
    /** What that AND decided, named: plan it, or do not. */
    | "verdict"
    /** The AND that closes the pre-execution stage: the plan and the custom. */
    | "execution"
    | "terminal";

export interface LogicBlock {
    id: string;
    kind: LogicBlockKind;
    /** The backend key this block stands for; "" for the pure gate blocks. */
    key: string;
    state: LogicState;
    /** Did this block change the outcome? */
    decisive: boolean;
    /** Which condition group it belongs to, where that means anything. */
    groupIndex: number | null;
    /** What the block saw, for the inputs that recorded it. */
    actual: unknown;
    /** What the group configured — the threshold the actual was tested against. */
    value: unknown;
    /** `actual <op> value`, where the condition's semantics define one. */
    comparison: LogicComparison | null;
    /**
     * The block's own numbers, in full. Rendered in the tooltip; the one or two
     * that actually decided it are on the face as `detail`.
     */
    params: Record<string, unknown>;
    /**
     * The gate's own decisive numbers, short enough for the block face — the
     * window it tested, the ordinal it placed at, the count it was short of.
     * Never an invented comparison: see `gateDetail`.
     */
    detail: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * A condition's test, as the two sides and the operator between them.
 *
 * `actual` is null for a condition that reports no reading at all -- the
 * self-gating pair, whose result is a simulation rather than a comparison --
 * and the block then shows the threshold alone rather than inventing one.
 */
export interface LogicComparison {
    actual: string | null;
    operator: string;
    value: string;
}

/**
 * A group's caption band, above its own inputs.
 *
 * Two independent things live here. The **label** names the chain and is drawn
 * only where there is more than one to tell apart. The **params source** badge
 * says where the group's numbers came from, and is drawn always — a group whose
 * params were resolved for the *day* (possibly from another group entirely, or
 * from master fallback) shows numbers that would otherwise read as this slot's
 * own. So a single-group cell still gets a band, carrying the badge alone.
 */
export interface LogicGroupHeader {
    index: number;
    label: string;
    /** False for a single group: a caption over one chain is noise. */
    showLabel: boolean;
    paramsSource: ExplanationParamsSource;
    y: number;
}

export interface LogicEdge {
    from: string;
    to: string;
    decisive: boolean;
}

/**
 * Something the record holds that is *not* a term of the final AND.
 *
 * Annotations are the fix for the diagram's one unforgivable failure mode: a
 * `false` block wired into an AND whose terminal says the slot ran. They are
 * drawn beside the chain, never in it.
 */
export interface LogicAnnotation {
    key: string;
    kind: "gate" | "custom" | "groups";
    state: LogicState;
    params: Record<string, unknown>;
}

export interface LogicDiagramModel {
    blocks: LogicBlock[];
    edges: LogicEdge[];
    annotations: LogicAnnotation[];
    /** One per group, or empty for a single group: naming it would be noise. */
    groupHeaders: LogicGroupHeader[];
    terminal: LogicTerminal;
    /** What the planning stage decided, on its own: was the slot planned? */
    planState: LogicState;
    /**
     * What the pre-execution stage found. `n/a` is "none configured" — the
     * stage is still drawn, saying so; only what it decided changes.
     */
    customState: LogicState;
    /**
     * Does a group this slot did *not* run under configure custom conditions?
     *
     * The one fact that makes an empty stage readable. Custom conditions belong
     * to a group, and `Eligibility` settles a slot on the first group that
     * matched *and* whose custom conditions held — so on a lane where one group
     * has a template and another does not, the slots that run are exactly the
     * ones that ran under the group without it. "None configured" then reads as
     * "this automation has no custom conditions", which is false and is the
     * first thing a reader disbelieves.
     */
    otherGroupsHaveCustom: boolean;
    /** The group the OR settled on, mirroring `fully or matching[0]`. */
    matchedGroupIndex: number | null;
    /** False for a single-group cell: an OR over one input decides nothing. */
    showOr: boolean;
    /** True where an override gate is one of the OR's inputs. */
    hasOverride: boolean;
    /** The group the diagram opens on when nothing was pressed in the matrix. */
    defaultGroupIndex: number | null;
    width: number;
    height: number;
}

export const BLOCK_H = 26;
export const INPUT_W = 240;
/**
 * The gate blocks, wide enough for a comparison rather than a number.
 *
 * A window gate says `10:00 ∈ 08:00–18:00` — the slot's own time against the
 * configured window — which at 168px left "Okno běhu" about four characters.
 * 214 fits the longest of those beside its longest label; the columns to the
 * right move with it, and the drawing scales to whatever width it is given.
 */
export const GATE_W = 214;
export const CUSTOM_W = 160;
export const OP_W = 44;
export const TERM_W = 196;
/** The named plan verdict: wide enough for "Naplánovat" and its glyph. */
export const VERDICT_W = 150;
export const V_GAP = 8;
export const GROUP_GAP = 20;
export const PAD_TOP = 30;
/** Room under the two-line note the pre-execution stage carries. */
export const RECHECK_HINT_H = 24;
/** The band a group's caption occupies above its own first input. */
export const GROUP_LABEL_H = 15;
/** The line under the override block that says what it is. */
export const OVERRIDE_HINT_H = 12;

export const COL_INPUT_X = 8;
export const COL_AND_X = 258;
export const COL_OR_X = 314;
/** The gates: everything decided outside the groups. */
export const COL_SIDE_X = 370;
/** The AND that closes planning, and the verdict it produces. */
export const COL_FINAL_X = 596;
export const COL_VERDICT_X = 652;
/**
 * The seam between the two stages: everything left of it was settled when the
 * plan was built, everything right of it is taken again before the action runs.
 */
export const DIVIDER_X = 816;
/** The custom conditions: the whole of the pre-execution stage. */
export const COL_CUSTOM_X = 832;
export const COL_EXEC_X = 1004;
export const COL_TERM_X = 1060;

/** Where a `→ final` edge turns: past the side column, so it crosses nothing. */
export const FINAL_ELBOW_X = COL_FINAL_X - 12;

/**
 * The one condition whose `actual` is a *reason*, not a reading.
 *
 * It resolves by re-simulating the horizon rather than by comparing a number
 * (`self_sustainability.py:1-17`), so a refusal comes back as an object naming
 * which of three tests failed and with what — see `selfSustainabilityComparison`.
 */
export const SELF_SUSTAINABILITY = "ensure_self_sustainability";

/**
 * A self-sustainability refusal, as the comparison that produced it.
 *
 * Three tests, three shapes (`appliance_runtime._accept`), and the block face
 * has room for exactly one line of each:
 *
 * - **`would_break_soc_floor`** — the horizon re-simulated *with* this slot
 *   dips below the floor. `projectedMinSoc < floor`, and `atSlot` says when,
 *   which goes in the tooltip because it will not fit here.
 * - **`soc_floor_already_breached`** — the horizon dips below the floor
 *   *without* the appliance, so nothing more is added. `baselineMinSoc <
 *   floor`. Same shape as the case above and a different cause entirely, which
 *   is the tooltip's job to keep apart.
 * - **`over_battery_budget`** — the day spent more non-solar energy than its
 *   budget allows. `spentKwh > budgetKwh`, both already summed by the backend,
 *   so nothing here re-derives them from the two deltas or has to know the
 *   epsilon the comparison was made with. It carries its unit: unlike the pair
 *   above, these are kWh rather than percent.
 *
 * Returns null for anything else, including an accepted slot -- the record
 * carries no numbers for one, and there is nothing to compare.
 */
export function selfSustainabilityComparison(actual: unknown): LogicComparison | null {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
        return null;
    }

    const detail = actual as Record<string, unknown>;
    const at = (key: string): number | null =>
        typeof detail[key] === "number" ? detail[key] as number : null;
    switch (detail.code) {
        case "would_break_soc_floor":
            return numericComparison(at("projectedMinSoc"), "<", at("floor"));
        case "soc_floor_already_breached":
            return numericComparison(at("baselineMinSoc"), "<", at("floor"));
        case "over_battery_budget":
            return numericComparison(at("spentKwh"), ">", at("budgetKwh"), " kWh");
        default:
            return null;
    }
}

/** Both sides of a numeric test, or null where the record is missing one. */
function numericComparison(
    actual: number | null,
    operator: string,
    value: number | null,
    unit = "",
): LogicComparison | null {
    if (actual === null || value === null) {
        return null;
    }
    return {
        actual: `${comparisonSide(actual)}${unit}`,
        operator,
        value: `${comparisonSide(value)}${unit}`,
    };
}

/**
 * The test a condition node stands for, or null where it has no readable one.
 *
 * Only the sides that are actually in the record are drawn. A condition that
 * measures nothing carries no `actual`, so it renders as the threshold alone
 * rather than as a number nobody measured; everything that does measure
 * carries its reading whether it passed or failed. The operator is the
 * condition column's own, from the backend; a column without one draws no
 * comparison.
 */
export function conditionComparison(node: ExplanationConditionNode): LogicComparison | null {
    if (node.key === SELF_SUSTAINABILITY) {
        return selfSustainabilityComparison(node.actual);
    }
    const rendered = comparisonSide(node.value);
    if (rendered === null || node.operator === null) {
        return null;
    }
    return { actual: comparisonSide(node.actual), operator: node.operator, value: rendered };
}

/** One side of a comparison as a short string; objects have no short form. */
function comparisonSide(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    if (typeof value === "string" || typeof value === "boolean") {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry)).join(", ");
    }
    return null;
}

/**
 * Gates whose `false` is a *report*, never a veto.
 *
 * Both are documented in the optimizers as "false still places, the run is
 * merely short":
 *
 * - `placement_capacity` (`appliance_runtime.py:124`) — "``false`` still places
 *   what the day allows, so it reads as 'the day will under-run', not 'nothing
 *   was placed'".
 * - `cheap_window_capacity` (`charge_from_grid.py:84`) — "False still charges —
 *   as much as the window allows — so this reads as 'the bridge is short'".
 *
 * Every other gate *can* veto, and whether it did is decided by the terminal
 * rather than by this list: see `isPlanInput`.
 */
const ALWAYS_ADVISORY_GATES = new Set<string>([
    "placement_capacity",
    "cheap_window_capacity",
]);

/**
 * Gates that are neither a requirement nor a report, but an **override**.
 *
 * `consecutive_skip_override` (`appliance_runtime.py:30-35, :125-127`) is the
 * one construct in the pipeline that *defeats the whole OR chain*: after
 * `max_consecutive_skips` consecutive short days the optimizer "runs anyway,
 * past every group's `custom` conditions and past every slot condition, over the
 * full window, carrying its own `consecutive_skip_override` gate so a forced run
 * never reads as an unexplained one."
 *
 * So it does not AND with the conditions — it ORs with them, and the OR is what
 * ANDs with the real vetoes. Drawn as an AND input it would claim the opposite:
 * that a forced run *required* it, and, via `isPlanInput`'s second rule, that the
 * failed conditions it overrode were mere context. That is a run with no visible
 * cause, which is exactly what the gate exists to prevent.
 *
 * The gate is emitted only on a forced day — "absence means 'not forced'" — so
 * there is never a false one to synthesise.
 *
 * **The other gates were checked against their docstrings, not their names:**
 *
 * - `cheapest_rank` (`charge_hold.py`) — a *requirement*. The slot lost the
 *   day's export-price ranking, so it is held; `false` is stamped for the slots
 *   released to charge, which are not held. It vetoes. Note the polarity is the
 *   opposite of `charge_from_grid`'s gate of the same name, where the cut is
 *   what gets written rather than what is left alone — but both are `true` on
 *   the slots their optimizer acts on, which is what rule 2 below needs.
 * - `hold_room` (`charge_hold.py`) — a *requirement*, day-scoped. The day's
 *   remaining solar can still refill the battery at all, and where it is false
 *   "the day's whole remaining surplus falls short of the need, so no slot of
 *   it can be held". Nothing is placed, unlike the two advisory capacity gates
 *   whose `false` still places what it can.
 */
const OVERRIDE_GATES = new Set<string>(["consecutive_skip_override"]);

/**
 * The one or two numbers a gate was actually decided by, for its own face.
 *
 * Every pair here reads **have / need** — `2/2` skips of the allowed maximum,
 * `1.5/4 h` of the daily minimum already delivered, `4.2/3.1 kWh` of surplus
 * against the need — except `cheapest_rank`, whose `1/16` is a *position out of
 * a total* and is universally read as one.
 *
 * Nothing is invented. An ordinal gets no operator, a window gets no threshold,
 * and a gate this does not know about gets no face numbers at all; its params
 * are still whole in the tooltip. Read off the `GATE_*` docstrings in
 * `appliance_runtime.py`, `charge_hold.py` and `charge_from_grid.py`.
 */
export function gateDetail(
    key: string,
    params: Record<string, unknown>,
    slotId = "",
    plannedBeforeHours: number | null = null,
): string | null {
    // The gates that test *the slot's own time* against a configured one, said
    // as the comparison they are. A window on its own is the same half-a-test a
    // bare threshold is: "08:00–18:00" never said which side of it this slot
    // falls on, and the slot's time is the one number the drawing has always
    // had to hand.
    const atMs = shortTime(slotId);
    switch (key) {
        case "run_window":
        case "hold_window": {
            const window = range(shortTime(params.start), shortTime(params.end));
            if (window === null) return null;
            return atMs === null ? window : `${atMs} ∈ ${window}`;
        }
        case "daily_minimum_remaining":
            // The day's quota, counted up to *this* slot. `doneHours` alone is
            // measured history taken once for the whole day, so it reads "0 of
            // 8" on a slot four hours into an eight-hour run — a true number
            // answering a question nobody asked at that moment. Adding what the
            // plan puts before the slot makes the block say how far into the
            // quota the slot sits, which is the unit the gate itself works in:
            // `slots_needed = ceil(remaining_hours / 0.5)`.
            return ratio(
                plannedBeforeHours === null
                    ? params.doneHours
                    : asHours(params.doneHours) + plannedBeforeHours,
                params.minHours,
                "h",
            );
        case "consecutive_skip_override":
            return ratio(params.consecutiveSkips, params.maxConsecutiveSkips);
        case "cheapest_rank":
            return ratio(params.rank, params.rankOf);
        case "hold_room":
            return ratio(params.surplusAtWindowStart, params.neededKwh, "kWh");
        case "cheap_window_capacity":
            return ratio(params.slotsAvailable, params.slotsNeeded);
        case "placement_capacity":
            return ratio(params.slotsPlaceable, params.slotsNeeded);
        default:
            return null;
    }
}

/**
 * One side of a gate's numbers, as short as it can honestly be.
 *
 * Unlike a condition's threshold — where `3.50` beside `3.43` is the point —
 * a gate's counts are read at a glance and `1.50/4 h` of a daily minimum is
 * two characters of noise. Trailing zeros go; nothing else is rounded away.
 */
function detailSide(value: unknown): string | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? String(Number(value.toFixed(2))) : null;
    }
    return comparisonSide(value);
}

/** A recorded hour count as a number, or 0 where the record carries none. */
function asHours(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `have/need`, or one side alone where the record only carries one. */
function ratio(have: unknown, need: unknown, unit = ""): string | null {
    const left = detailSide(have);
    const right = detailSide(need);
    const suffix = unit === "" ? "" : ` ${unit}`;
    if (left === null && right === null) return null;
    if (left === null) return `${right}${suffix}`;
    if (right === null) return `${left}${suffix}`;
    return `${left}/${right}${suffix}`;
}

function range(start: string | null, end: string | null): string | null {
    if (start === null && end === null) return null;
    if (start === null || end === null) return start ?? end;
    return `${start}–${end}`;
}

/** The synthetic input that keeps a rejected slot's AND honestly false. */
export const UNEXPLAINED_AND_INPUT = "unexplained_veto";

/**
 * The state of an AND over `states`.
 *
 * A `false` input beats everything: the AND is false because of it. Failing
 * that, an input the optimizer never consulted leaves the AND unevaluated
 * rather than quietly true — calling it true would invent a pass that never
 * happened. `not_applicable` inputs are conditions the group does not
 * configure and take no part.
 */
function andState(states: readonly LogicState[]): LogicState {
    const considered = states.filter((state) => state !== "not_applicable");
    if (considered.length === 0) return "n/a";
    if (considered.includes("false") || considered.includes("errored")) return "false";
    if (considered.includes("not_evaluated")) return "not_evaluated";
    return "true";
}

/**
 * The final AND, whose empty case is vacuous truth rather than `n/a`.
 *
 * The group ANDs can honestly report "nothing to say"; the final one cannot —
 * it is the block the terminal hangs off, and it must carry a truth value the
 * terminal can be checked against.
 */
function finalAndState(states: readonly LogicState[]): LogicState {
    const considered = states.filter((state) => state !== "not_applicable" && state !== "n/a");
    if (considered.length === 0) return "true";
    if (considered.includes("false") || considered.includes("errored")) return "false";
    if (considered.includes("not_evaluated")) return "not_evaluated";
    return "true";
}

/** The state of an OR over `states`: any true wins, any unevaluated defers. */
function orState(states: readonly LogicState[]): LogicState {
    const considered = states.filter((state) => state !== "n/a" && state !== "not_applicable");
    if (considered.length === 0) return "n/a";
    if (considered.includes("true")) return "true";
    if (considered.includes("not_evaluated")) return "not_evaluated";
    return "false";
}

/** A group's custom conditions as one state; an error is not a plain false. */
function customState(group: ExplanationGroup | undefined): LogicState {
    if (group === undefined || group.customResults.length === 0) return "n/a";
    if (group.customResults.some((entry) => entry === null)) return "errored";
    return group.customResults.some((entry) => entry === false) ? "false" : "true";
}

/**
 * The inputs of a false AND that are the reason it is false.
 *
 * Only the false ones — a passing input of a failed AND changed nothing. Where
 * nothing is outright false the unevaluated inputs are the next best answer,
 * because that is what stopped the AND from resolving.
 */
function decisiveInputsOfFalseAnd(states: readonly LogicState[]): number[] {
    const failing: number[] = [];
    states.forEach((state, index) => {
        if (state === "false" || state === "errored") failing.push(index);
    });
    if (failing.length > 0) return failing;
    const unevaluated: number[] = [];
    states.forEach((state, index) => {
        if (state === "not_evaluated") unevaluated.push(index);
    });
    return unevaluated;
}

/**
 * The terminal, read from the record alone.
 *
 * Computed before the AND chain is assembled, because the chain is built *to
 * agree with it*: a gate can only be drawn as a veto if the terminal admits
 * that something vetoed.
 */
function resolveTerminal(cell: ExplanationCell): LogicTerminal {
    const blockedGate = cell.gates.find((gate) => gate.key === BLOCKED_USER_OWNED_GATE);
    if (blockedGate !== undefined && blockedGate.state === "false") return "blocked";
    if (cell.verdict === "execute") return "execute";
    if (cell.verdict === "candidate") return "candidate";
    return "not_eligible";
}

/**
 * Did the planning stage decide to plan the slot?
 *
 * Both terminals that got *past* planning say so: `execute` ran, and
 * `candidate` is a slot that was planned and placed and is waiting on its
 * custom conditions (`conditions/evaluation.py:1-17`). `not_eligible` and
 * `blocked` never got that far.
 */
function planHeld(terminal: LogicTerminal): boolean {
    return terminal === "execute" || terminal === "candidate";
}

/**
 * May this term be wired into the planning AND?
 *
 * **The diagram must never contradict its own terminal.** Two rules, in order:
 *
 * 1. A gate documented as non-blocking is never a term of the conjunction, in
 *    either state. It reports on the run, it does not gate the slot.
 * 2. If the terminal says planning held, then, by definition, *nothing vetoed
 *    it* — so any term that is not `true` cannot have been part of what got the
 *    slot planned, and is reported as context instead. This is what stops
 *    `✗ placement_capacity → & → ✓ execute` from ever being drawn again. It
 *    covers `candidate` as well as `execute`: a candidate's own falsehood is
 *    the custom stage, which is not a term of this AND at all.
 */
function isPlanInput(key: string, state: LogicState, terminal: LogicTerminal): boolean {
    if (ALWAYS_ADVISORY_GATES.has(key)) return false;
    if (planHeld(terminal) && state !== "true" && state !== "not_applicable") return false;
    return true;
}

/**
 * Build the diagram for one slot of one optimizer.
 *
 * The shape mirrors how eligibility is actually decided: conditions AND within
 * a group, groups OR against each other, and the winner is then ANDed with the
 * group's custom conditions and with the gates that actually vetoed.
 *
 * **Two stages, not one.** The record is decided in two passes and the picture
 * says so:
 *
 * ```
 * planned[s]   = any(g.system_mask[s] and g.custom_met)
 * candidate[s] = (not planned[s]) and any(g.system_mask[s])
 * ```
 *
 * (`conditions/evaluation.py:1-17`.) So the groups, the OR and the gates settle
 * *whether the slot is planned at all*, and that answer gets a block of its own
 * — `Naplánovat` / `Nespouštět` — rather than being an unlabelled `&`. The
 * custom conditions are then a second stage against that verdict, and their
 * falsehood is the whole of what makes a `candidate`.
 *
 * Splitting them is not decoration. It is what lets a slot that *is* planned
 * read as planned even when its custom conditions are false, and what lets a
 * slot that will run say that its custom conditions held **when the plan was
 * built** and are taken again before the action starts
 * (`coordinator.py:3575-3620`) — a claim a single conjunction cannot make.
 *
 * **Each AND chain is built to reproduce its own answer.** `finalAndState` over
 * the planning inputs equals the verdict block's state, which is `true` if and
 * only if the terminal is `execute` or `candidate`; the execution AND over
 * [verdict, custom] is `true` if and only if the terminal is `execute`. Terms
 * that cannot have vetoed are moved to `annotations` — drawn beside the chain,
 * never in it. Where a rejected slot names no veto at all, one synthetic
 * `unexplained_veto` input carries the falsehood — in the stage that is
 * missing it — because a picture that resolves `true` above the word
 * "nesplněné podmínky" is worse than an admission of ignorance.
 *
 * **The self-gating nodes gate the slot, not their group.** Group matching
 * never reads them — they contribute an all-true mask and the optimizer
 * resolves them afterwards, for the group it had already matched — so they are
 * drawn in their group's column and wired past its `&` and past the `≥1`,
 * straight into the planning AND. See the note at `selfGating` in the build for what goes
 * wrong when they sit inside the group: a second group's conditions hold, the
 * `≥1` swallows the refusal, and a slot the record explains in full comes out
 * as `unexplained_veto`.
 *
 * **A single group gets no OR.** `≥1` over one input decides nothing and reads
 * as a stage the reader has to account for; the group's `&` wires straight on.
 * It gets no caption either, for the same reason: with one chain there is
 * nothing to tell it apart from.
 *
 * **An override is the OR's other input, never an AND's.**
 * `consecutive_skip_override` defeats the conditions rather than joining them
 * (`appliance_runtime.py:30-35`), so the drawn shape is
 * `(conditions ∨ override) ∧ vetoes`. That is what keeps a forced day readable:
 * the conditions spine stays on screen, failed, with the block that overrode it
 * wired alongside — rather than the whole spine being demoted to context by
 * `isPlanInput`'s second rule and the run reading as uncaused. It also keeps the
 * invariant: on a forced day the OR is `true`, so the final AND is `true`, so
 * the terminal is `execute`.
 *
 * **Decisiveness walks back from each stage's own answer**, never forward from
 * the inputs, and never across the seam:
 *
 * - **AND false** → only its *false* inputs are decisive.
 * - **AND true** → all its inputs are decisive.
 * - **OR true** → only the *first satisfied* group, mirroring
 *   `evaluation.py:90-96` (`fully or matching[0]`). Anything else that also
 *   passed never got looked at, and highlighting it would put the diagram at
 *   odds with the "matched group" the matrix names.
 * - **OR false** → all its inputs are decisive; every group had to fail.
 *
 * The planning stage is walked back from the **verdict**, not from the
 * terminal. That is the difference between "these conditions are why it is
 * planned" and the old reading, where a false custom condition greyed out the
 * entire conditions spine — the answer to "why is this planned" went dim
 * exactly on the slots where it was most worth reading.
 *
 * The execution stage names one input, because only one of them can be the
 * reason: `execute` → both held; `candidate` → the custom conditions;
 * anything else → the verdict, since the re-check is not what stopped it.
 *
 * A block that is not decisive is dimmed, never removed: "this was checked and
 * did not matter" is a different claim from "this was not checked".
 */
export function buildLogicDiagram(
    cell: ExplanationCell,
    plannedBeforeHours: number | null = null,
): LogicDiagramModel {
    const blocks: LogicBlock[] = [];
    const edges: LogicEdge[] = [];
    const annotations: LogicAnnotation[] = [];
    const groupHeaders: LogicGroupHeader[] = [];
    const terminal = resolveTerminal(cell);
    // With one group there is nothing to tell apart, and a caption over a
    // single chain is noise. With two or more, "which chain is which" is the
    // first thing a reader cannot answer. The header band itself is drawn
    // either way: it carries the params-source badge, which a single group
    // needs just as much.
    const showGroupLabels = cell.groups.length > 1;
    // The override, pulled out before the gate loop: it is not a term of the
    // conjunction at all, it is the *other input of the OR*.
    const overrideGate = cell.gates.find((gate) => OVERRIDE_GATES.has(gate.key)) ?? null;

    // ---- geometry + states, groups first -------------------------------
    let cursorY = PAD_TOP;
    const groupAndIds: string[] = [];
    const groupAndStates: LogicState[] = [];
    const groupInputIds: string[][] = [];
    const groupInputStates: LogicState[][] = [];
    const andCenters: number[] = [];
    // The self-gating nodes (`selfGating` on their condition column), hoisted
    // out of the groups they are configured in: drawn in their group's column,
    // wired past its `&` and past the `≥1` straight into the planning AND.
    // They gate the **slot**, not the group that configured them. Group
    // matching never reads them (they contribute an all-true mask to
    // `build_eligibility`, `trace.py:572-578`); the optimizer that consults them
    // resolves the placeholder afterwards, for the group it had already matched.
    // So they are **not terms of their group's AND**: drawing them there claims
    // the group failed to match on a node matching never read. They **are terms
    // of the planning AND**: a refusal stops the placement whatever else held
    // (`_optimize_uncapped` drops the slot on the spot,
    // `appliance_runtime.py:539-541`, and never offers it to another group).
    // Left inside the group, that falsehood is swallowed by the `≥1` the moment
    // a second group's own conditions hold, and the diagram falls back to
    // `unexplained_veto` over a refusal the record names in full.
    const selfGating: { id: string; key: string; state: LogicState }[] = [];

    cell.groups.forEach((group, groupPos) => {
        const inputIds: string[] = [];
        const inputStates: LogicState[] = [];
        groupHeaders.push({
            index: group.index,
            label: group.label,
            showLabel: showGroupLabels,
            paramsSource: group.paramsSource,
            y: cursorY + 10,
        });
        cursorY += GROUP_LABEL_H;
        const top = cursorY;
        if (group.conditions.every((node) => node.selfGating)) {
            // A group with nothing configured still gets a row, so the diagram
            // never silently drops a branch that exists in the record. A group
            // that configured *only* self-gating nodes is the same case: none of
            // them is a term of this AND, so without the row the `&` would be
            // drawn with nothing feeding it.
            const id = `input-${groupPos}-none`;
            blocks.push({
                id,
                kind: "input",
                key: "",
                state: "n/a",
                decisive: false,
                groupIndex: group.index,
                actual: null,
                value: null,
                comparison: null,
                params: {},
                detail: null,
                x: COL_INPUT_X,
                y: cursorY,
                width: INPUT_W,
                height: BLOCK_H,
            });
            inputIds.push(id);
            inputStates.push("n/a");
            cursorY += BLOCK_H + V_GAP;
        }
        group.conditions.forEach((node, nodePos) => {
            const id = `input-${groupPos}-${nodePos}`;
            blocks.push({
                id,
                kind: "input",
                key: node.key,
                state: node.state,
                decisive: false,
                groupIndex: group.index,
                actual: node.actual,
                value: node.value,
                comparison: conditionComparison(node),
                params: {},
                detail: null,
                x: COL_INPUT_X,
                y: cursorY,
                width: INPUT_W,
                height: BLOCK_H,
            });
            if (node.selfGating) {
                selfGating.push({ id, key: node.key, state: node.state });
            } else {
                inputIds.push(id);
                inputStates.push(node.state);
            }
            cursorY += BLOCK_H + V_GAP;
        });
        const bottom = cursorY - V_GAP;
        const andId = `and-${groupPos}`;
        const andY = Math.round((top + bottom) / 2 - BLOCK_H / 2);
        const state = andState(inputStates);
        blocks.push({
            id: andId,
            kind: "and",
            key: "",
            state,
            decisive: false,
            groupIndex: group.index,
            actual: null,
            value: null,
            comparison: null,
            params: {},
            detail: null,
            x: COL_AND_X,
            y: andY,
            width: OP_W,
            height: BLOCK_H,
        });
        for (const inputId of inputIds) {
            edges.push({ from: inputId, to: andId, decisive: false });
        }
        groupAndIds.push(andId);
        groupAndStates.push(state);
        groupInputIds.push(inputIds);
        groupInputStates.push(inputStates);
        andCenters.push(andY + BLOCK_H / 2);
        cursorY += GROUP_GAP;
    });

    // ---- the override: the other input of the OR, never a requirement ---
    //
    // Drawn only when the record carries it, because the gate is emitted only
    // on a forced day and its absence *is* "not forced". Synthesising a false
    // one would put a veto on screen that the optimizer never applied.
    const overrideId = "override";
    const overrideCenters: number[] = [];
    if (overrideGate !== null) {
        blocks.push({
            id: overrideId,
            kind: "override",
            key: overrideGate.key,
            state: overrideGate.state,
            decisive: false,
            groupIndex: null,
            actual: null,
            value: null,
            comparison: null,
            params: overrideGate.params,
            detail: gateDetail(overrideGate.key, overrideGate.params, cell.slotId, plannedBeforeHours),
            x: COL_INPUT_X,
            y: cursorY,
            width: INPUT_W,
            height: BLOCK_H,
        });
        overrideCenters.push(cursorY + BLOCK_H / 2);
        cursorY += BLOCK_H + V_GAP + OVERRIDE_HINT_H;
    }

    // ---- the OR, only where there is anything to choose between ---------
    //
    // An override makes there be something to choose between even for a single
    // group: "the conditions held, *or* the run was forced". That is the whole
    // shape `max_consecutive_skips` has in the optimizer.
    const showOr = cell.groups.length > 1 || overrideGate !== null;
    const orId = "or";
    const orInputIds = overrideGate === null ? groupAndIds : [...groupAndIds, overrideId];
    const orInputStates: LogicState[] = overrideGate === null
        ? groupAndStates
        : [...groupAndStates, overrideGate.state];
    const orValue = orState(orInputStates);
    const orCenters = [...andCenters, ...overrideCenters];
    const orY = orCenters.length === 0
        ? PAD_TOP
        : Math.round((Math.min(...orCenters) + Math.max(...orCenters)) / 2 - BLOCK_H / 2);
    if (showOr) {
        blocks.push({
            id: orId,
            kind: "or",
            key: "",
            state: orValue,
            decisive: false,
            groupIndex: null,
            actual: null,
            value: null,
            comparison: null,
            params: {},
            detail: null,
            x: COL_OR_X,
            y: orY,
            width: OP_W,
            height: BLOCK_H,
        });
        for (const inputId of orInputIds) {
            edges.push({ from: inputId, to: orId, decisive: false });
        }
    }

    // The group the backend matched for this slot (`Eligibility.at`), read
    // off the record rather than re-derived: the first group whose system
    // conditions and custom conditions both held, else the first whose system
    // conditions did. Take the mask alone and a slot that ran under group 2
    // gets read against group 1's failed template, which is a false custom
    // stage over a `spustit` terminal.
    const groupCustomStates = cell.groups.map((group) => customState(group));
    const matchedPos = cell.groups.findIndex((group) => group.index === cell.matchedGroupIndex);
    const matchedGroupIndex = matchedPos < 0 ? null : cell.matchedGroupIndex;

    // The spine: the one term that carries "some group's conditions held".
    const spineId = showOr ? orId : (groupAndIds[0] ?? null);
    const spineState: LogicState = showOr ? orValue : (groupAndStates[0] ?? "n/a");

    // ---- the terms of the planning AND, and what is only context --------
    let sideY = Math.max(cursorY, orY + BLOCK_H + GROUP_GAP);
    const finalInputIds: string[] = [];
    const finalInputStates: LogicState[] = [];

    if (spineId !== null) {
        if (isPlanInput("", spineState, terminal)) {
            edges.push({ from: spineId, to: "final", decisive: false });
            finalInputIds.push(spineId);
            finalInputStates.push(spineState);
        } else {
            annotations.push({ key: "groups", kind: "groups", state: spineState, params: {} });
        }
    }

    // The self-gating nodes, already drawn in their group's column: only their
    // wiring is settled here. `isPlanInput` applies to them exactly as it does
    // to a gate — a slot that ran cannot have been refused by the node that
    // would have stopped it, and a record that says otherwise is reported
    // beside the chain rather than drawn as a veto the terminal contradicts.
    for (const node of selfGating) {
        if (!isPlanInput(node.key, node.state, terminal)) {
            annotations.push({ key: node.key, kind: "gate", state: node.state, params: {} });
            continue;
        }
        edges.push({ from: node.id, to: "final", decisive: false });
        finalInputIds.push(node.id);
        finalInputStates.push(node.state);
    }

    cell.gates.forEach((gate: ExplanationGate, gatePos) => {
        // Already drawn, as the OR's other input.
        if (OVERRIDE_GATES.has(gate.key)) {
            return;
        }
        if (!isPlanInput(gate.key, gate.state, terminal)) {
            annotations.push({
                key: gate.key,
                kind: "gate",
                state: gate.state,
                params: gate.params,
            });
            return;
        }
        const id = `gate-${gatePos}`;
        blocks.push({
            id,
            kind: "gate",
            key: gate.key,
            state: gate.state,
            decisive: false,
            groupIndex: null,
            actual: null,
            value: null,
            comparison: null,
            params: gate.params,
            detail: gateDetail(gate.key, gate.params, cell.slotId, plannedBeforeHours),
            x: COL_SIDE_X,
            y: sideY,
            width: GATE_W,
            height: BLOCK_H,
        });
        edges.push({ from: id, to: "final", decisive: false });
        finalInputIds.push(id);
        finalInputStates.push(gate.state);
        sideY += BLOCK_H + V_GAP;
    });

    // A slot that was never planned, whose every drawn term passed, would
    // resolve `true` above a terminal that says otherwise. One honest block,
    // rather than a lie. A `candidate` is not such a slot: it *was* planned,
    // and the falsehood it needs lives in the stage after this one.
    if (!planHeld(terminal) && finalAndState(finalInputStates) !== "false") {
        const id = `gate-${UNEXPLAINED_AND_INPUT}`;
        blocks.push({
            id,
            kind: "gate",
            key: UNEXPLAINED_AND_INPUT,
            state: "false",
            decisive: false,
            groupIndex: null,
            actual: null,
            value: null,
            comparison: null,
            params: {},
            detail: null,
            x: COL_SIDE_X,
            y: sideY,
            width: GATE_W,
            height: BLOCK_H,
        });
        edges.push({ from: id, to: "final", decisive: false });
        finalInputIds.push(id);
        finalInputStates.push("false");
        sideY += BLOCK_H + V_GAP;
    }

    // ---- the plan verdict: what the first stage decided ------------------
    const finalState = finalAndState(finalInputStates);
    const finalY = Math.round(
        (orY + Math.max(orY + BLOCK_H, sideY - V_GAP)) / 2 - BLOCK_H / 2,
    );
    blocks.push({
        id: "final",
        kind: "final",
        key: "",
        state: finalState,
        decisive: true,
        groupIndex: null,
        actual: null,
        value: null,
        comparison: null,
        params: {},
        detail: null,
        x: COL_FINAL_X,
        y: finalY,
        width: OP_W,
        height: BLOCK_H,
    });
    blocks.push({
        id: "verdict",
        kind: "verdict",
        key: finalState === "true" ? "planned" : "not_planned",
        state: finalState,
        decisive: true,
        groupIndex: null,
        actual: null,
        value: null,
        comparison: null,
        params: {},
        detail: null,
        x: COL_VERDICT_X,
        y: finalY,
        width: VERDICT_W,
        height: BLOCK_H,
    });
    edges.push({ from: "final", to: "verdict", decisive: true });

    // ---- the second stage: the custom conditions, re-taken later ---------
    //
    // A stage rather than a gate. They are group-level and constant per run
    // (`evaluation.py:1-17`), they are the whole difference between a run and a
    // `candidate`, and the executor takes them again before the action starts
    // (`coordinator.py:3575-3620`) — none of which a term sitting in the gate
    // pile can say.
    //
    // **Always drawn, whatever it found.** A stage that appears only when it
    // has something to complain about is a stage nobody can read: two slots of
    // one automation, one with a re-check column and one without, look like two
    // different pipelines rather than two answers from the same one. Where the
    // group configures no custom conditions the block says exactly that, and
    // takes no part in the AND — which is what `n/a` already means everywhere
    // else on this drawing.
    const recorded = matchedPos < 0 ? "n/a" : groupCustomStates[matchedPos];
    // A candidate is a candidate *because* its custom conditions failed. Where
    // the matched group's record does not carry that falsehood, the stage says
    // so rather than resolving true above the word "kandidát".
    const unexplainedCustom = terminal === "candidate" && recorded !== "false" && recorded !== "errored";
    // The mirror of `isPlanInput`'s second rule, and a last resort: a slot that
    // ran cannot have failed the stage that would have stopped it. Reading the
    // backend's matched group is what keeps this from firing on ordinary
    // multi-group records; what is left is a record that disagrees
    // with itself, and the honest place for that is beside the chain.
    const contradictsRun = terminal === "execute" && (recorded === "false" || recorded === "errored");
    if (contradictsRun) {
        annotations.push({ key: "custom", kind: "custom", state: recorded, params: {} });
    }
    const custom: LogicState = unexplainedCustom
        ? "false"
        : contradictsRun ? "n/a" : recorded;

    const customY = finalY + BLOCK_H + V_GAP + 6;
    blocks.push({
        id: "custom",
        kind: "custom",
        key: unexplainedCustom ? UNEXPLAINED_AND_INPUT : "custom",
        state: custom,
        decisive: false,
        groupIndex: matchedGroupIndex,
        actual: null,
        value: null,
        comparison: null,
        params: {},
        detail: null,
        x: COL_CUSTOM_X,
        y: customY,
        width: CUSTOM_W,
        height: BLOCK_H,
    });

    // ---- the terminal --------------------------------------------------
    const execInputIds = ["verdict", "custom"];
    const execY = Math.round((finalY + customY) / 2);
    blocks.push({
        id: "exec",
        kind: "execution",
        key: "",
        state: finalAndState([finalState, custom]),
        decisive: true,
        groupIndex: null,
        actual: null,
        value: null,
        comparison: null,
        params: {},
        detail: null,
        x: COL_EXEC_X,
        y: execY,
        width: OP_W,
        height: BLOCK_H,
    });
    edges.push({ from: "verdict", to: "exec", decisive: false });
    edges.push({ from: "custom", to: "exec", decisive: false });
    blocks.push({
        id: "terminal",
        kind: "terminal",
        key: terminal,
        state: terminal === "execute" ? "true" : terminal === "candidate" ? "not_evaluated" : "false",
        decisive: true,
        groupIndex: null,
        actual: null,
        value: null,
        comparison: null,
        params: {},
        detail: null,
        x: COL_TERM_X,
        y: execY,
        width: TERM_W,
        height: BLOCK_H,
    });
    edges.push({ from: "exec", to: "terminal", decisive: true });

    // ---- decisiveness, per stage ----------------------------------------
    const byId = new Map(blocks.map((block) => [block.id, block]));
    const mark = (id: string): void => {
        const block = byId.get(id);
        if (block !== undefined) block.decisive = true;
    };

    // The execution stage names exactly one reason, because only one of them
    // can be it: a run needed both, a candidate is its custom conditions, and
    // anything else never reached the re-check at all. A stage with nothing
    // configured decided nothing either way, so the verdict carries the run.
    if (terminal === "execute") {
        for (const id of custom === "n/a" ? ["verdict"] : execInputIds) mark(id);
    } else {
        mark(terminal === "candidate" ? "custom" : "verdict");
    }

    // The planning AND, walked back from *its own* answer rather than from the
    // terminal: "why is this planned" has to stay lit on a slot whose custom
    // conditions then held it back.
    const decisiveFinal = finalState === "true"
        ? finalInputIds.map((_, index) => index)
        : decisiveInputsOfFalseAnd(finalInputStates);
    for (const index of decisiveFinal) {
        mark(finalInputIds[index]);
    }

    if (spineId !== null && byId.get(spineId)?.decisive === true) {
        if (showOr) {
            if (orValue === "true") {
                // Only the first satisfied input. The rest were never reached.
                // The group ANDs come first, so this is still "the first
                // satisfied group" wherever one satisfied it; where none did
                // and the run was forced, the override is the input that
                // carries the truth, and it is the one that gets marked.
                const firstTrue = orInputStates.findIndex((state) => state === "true");
                if (firstTrue >= 0) mark(orInputIds[firstTrue]);
            } else {
                for (const inputId of orInputIds) mark(inputId);
            }
        }
    }

    groupAndIds.forEach((andId, groupPos) => {
        if (byId.get(andId)?.decisive !== true) return;
        const states = groupInputStates[groupPos];
        const ids = groupInputIds[groupPos];
        if (groupAndStates[groupPos] === "true") {
            ids.forEach((id, index) => {
                // A `not_applicable` input is not part of the conjunction.
                if (states[index] !== "not_applicable") mark(id);
            });
            return;
        }
        for (const index of decisiveInputsOfFalseAnd(states)) {
            mark(ids[index]);
        }
    });

    for (const edge of edges) {
        edge.decisive = byId.get(edge.from)?.decisive === true
            && byId.get(edge.to)?.decisive === true;
    }

    const height = Math.max(
        sideY,
        cursorY,
        finalY + BLOCK_H,
        customY + BLOCK_H + RECHECK_HINT_H,
    ) + 10;
    return {
        blocks,
        edges,
        annotations,
        groupHeaders,
        terminal,
        planState: finalState,
        customState: custom,
        // "Another group has them" needs another group to exist. Without the
        // count, a lone group trips it whenever no group matched at all
        // (`matchedPos` is -1, so every group counts as "not the matched one")
        // and the note points at a group that is not there.
        otherGroupsHaveCustom: cell.groups.length > 1
            && groupCustomStates.some(
                (state, groupPos) => state !== "n/a" && groupPos !== matchedPos,
            ),
        matchedGroupIndex,
        showOr,
        hasOverride: overrideGate !== null,
        defaultGroupIndex: matchedGroupIndex ?? cell.groups[0]?.index ?? null,
        width: COL_TERM_X + TERM_W + 8,
        height,
    };
}

