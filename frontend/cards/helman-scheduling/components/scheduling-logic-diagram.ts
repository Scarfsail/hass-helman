import { LitElement, css, html, svg } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import { helmanColorVars } from "../../color-vars";
import type {
    ExplanationCell,
    ExplanationGate,
    ExplanationGroup,
    ExplanationNodeState,
    ExplanationParamsSource,
} from "../model/schedule-explanation-model";
import { BLOCKED_USER_OWNED_GATE } from "../model/schedule-explanation-model";

const KEY_PREFIX = "scheduling.explanation";

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

const BLOCK_H = 26;
const INPUT_W = 240;
/**
 * The gate blocks, wide enough for a comparison rather than a number.
 *
 * A window gate says `10:00 ∈ 08:00–18:00` — the slot's own time against the
 * configured window — which at 168px left "Okno běhu" about four characters.
 * 214 fits the longest of those beside its longest label; the columns to the
 * right move with it, and the drawing scales to whatever width it is given.
 */
const GATE_W = 214;
const CUSTOM_W = 160;
const OP_W = 44;
const TERM_W = 196;
/** The named plan verdict: wide enough for "Naplánovat" and its glyph. */
const VERDICT_W = 150;
const V_GAP = 8;
const GROUP_GAP = 20;
const PAD_TOP = 30;
/** Room under the two-line note the pre-execution stage carries. */
const RECHECK_HINT_H = 24;
/** The band a group's caption occupies above its own first input. */
const GROUP_LABEL_H = 15;
/** The line under the override block that says what it is. */
const OVERRIDE_HINT_H = 12;

const COL_INPUT_X = 8;
const COL_AND_X = 258;
const COL_OR_X = 314;
/** The gates: everything decided outside the groups. */
const COL_SIDE_X = 370;
/** The AND that closes planning, and the verdict it produces. */
const COL_FINAL_X = 596;
const COL_VERDICT_X = 652;
/**
 * The seam between the two stages: everything left of it was settled when the
 * plan was built, everything right of it is taken again before the action runs.
 */
const DIVIDER_X = 816;
/** The custom conditions: the whole of the pre-execution stage. */
const COL_CUSTOM_X = 832;
const COL_EXEC_X = 1004;
const COL_TERM_X = 1060;

/** Where a `→ final` edge turns: past the side column, so it crosses nothing. */
const FINAL_ELBOW_X = COL_FINAL_X - 12;

/**
 * How each system condition compares, mirrored from the backend masks.
 *
 * Read off `conditions/types.py`, one mask at a time — a guessed operator is a
 * diagram that lies about the record:
 *
 * - `when_price_below` (`_export_price_below_mask`) — a slot qualifies when
 *   *any* of its buckets has `price < threshold`, and the reported actual is the
 *   cheapest of them. So the drawn test is `actual < value`.
 * - `max_run_price` (`_max_run_price_mask`) — *every* pending bucket must have
 *   `price < threshold`, and the actual is the most expensive one. Same
 *   operator, opposite aggregation, and the aggregation is already baked into
 *   the number the record carries.
 * - `min_soc_pct` (`_min_soc_mask`) — every pending bucket needs
 *   `soc_pct >= threshold`; the actual is the worst.
 * - `min_solar_coverage_pct` (`_min_solar_coverage_mask`) — `coverage_pct >=
 *   threshold`.
 *
 * `run_when` is not in here on purpose: `_run_when_mask` tests the day's
 * classification for *membership* of a configured set, and drawing that as `<`
 * or `>` would be a fabrication. It gets `∈` instead.
 *
 * The self-gating pair (`ensure_self_sustainability`, `reserve_floor_soc`) has
 * no numeric form at all — the optimizer resolves them by simulation — so they
 * get no comparison and keep showing whatever the record recorded.
 */
const CONDITION_OPERATORS: Record<string, string> = {
    when_price_below: "<",
    max_run_price: "<",
    min_soc_pct: "≥",
    min_solar_coverage_pct: "≥",
};

/** Conditions whose test is set membership rather than a comparison. */
const SET_MEMBERSHIP_CONDITIONS = new Set<string>(["run_when"]);

/**
 * The one condition whose `actual` is a *reason*, not a reading.
 *
 * It resolves by re-simulating the horizon rather than by comparing a number
 * (`self_sustainability.py:1-17`), so a refusal comes back as an object naming
 * which of three tests failed and with what — see `selfSustainabilityComparison`.
 */
export const SELF_SUSTAINABILITY = "ensure_self_sustainability";

/**
 * The nodes that gate the **slot**, not the group that configured them.
 *
 * Both contribute an all-true mask to `build_eligibility` (`trace.py:572-578`),
 * so group matching never looks at them: the optimizer that consults them
 * resolves the placeholder afterwards, on the slots it actually reached, and
 * *for the group it had already matched*. Two consequences, and the drawing
 * needs both.
 *
 * They are **not terms of their group's AND**. Drawing them there claims the
 * group failed to match on a node matching never read, which is the opposite of
 * what the record says — and it hands the frontend a different matched group
 * from the backend's.
 *
 * They **are terms of the planning AND**. A refusal stops the placement whatever
 * else held: `_optimize_uncapped` drops the slot on the spot
 * (`appliance_runtime.py:539-541`) and never offers it to another group. Left
 * inside the group, that falsehood is swallowed by the `≥1` the moment a second
 * group's own conditions hold — the slot is then not planned with every drawn
 * term true, and the diagram falls back to `unexplained_veto` over a refusal
 * the record names in full.
 */
const SELF_GATING_CONDITIONS = new Set<string>([
    SELF_SUSTAINABILITY,
    "reserve_floor_soc",
]);

/** The tolerances strict allows before a day counts as not paying for itself. */
const STRICT_SOC_TOLERANCE_PCT = 0.5;
const STRICT_IMPORT_TOLERANCE_KWH = 0.05;

/**
 * A self-sustainability refusal, as the comparison that produced it.
 *
 * Three tests, three shapes (`appliance_runtime.py:817, 827, 885`), and the
 * block face has room for exactly one line of each:
 *
 * - **`would_break_soc_floor`** — the horizon re-simulated *with* this slot
 *   dips below the floor. `projectedMinSoc < floor`, and `atSlot` says when,
 *   which goes in the tooltip because it will not fit here.
 * - **`soc_floor_already_breached`** — the horizon dips below the floor
 *   *without* the appliance, so nothing more is added. `baselineMinSoc <
 *   floor`. Same shape as the case above and a different cause entirely, which
 *   is the tooltip's job to keep apart.
 * - **`not_solar_neutral`** — strict's extra test: the day must end no worse
 *   off. Two one-sided comparisons against fixed tolerances, of which the face
 *   shows whichever actually failed, and the SoC side when both did. It
 *   carries its unit: unlike the pair above, the two numbers are not in the
 *   same one.
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
        case "not_solar_neutral": {
            const deltaSoc = at("deltaSocPct");
            const deltaImport = at("deltaImportKwh");
            // The SoC side reads as "the battery ended the day this much
            // lower", so the tolerance it broke is a negative bound.
            if (deltaSoc !== null && -deltaSoc > STRICT_SOC_TOLERANCE_PCT) {
                return numericComparison(deltaSoc, "<", -STRICT_SOC_TOLERANCE_PCT, " %");
            }
            if (deltaImport !== null && deltaImport > STRICT_IMPORT_TOLERANCE_KWH) {
                return numericComparison(deltaImport, ">", STRICT_IMPORT_TOLERANCE_KWH, " kWh");
            }
            return null;
        }
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
 * carries its reading whether it passed or failed.
 */
export function conditionComparison(
    key: string,
    value: unknown,
    actual: unknown,
): LogicComparison | null {
    if (key === SELF_SUSTAINABILITY) {
        return selfSustainabilityComparison(actual);
    }
    const rendered = comparisonSide(value);
    if (rendered === null) {
        return null;
    }
    if (SET_MEMBERSHIP_CONDITIONS.has(key)) {
        return { actual: comparisonSide(actual), operator: "∈", value: rendered };
    }
    const operator = CONDITION_OPERATORS[key];
    if (operator === undefined) {
        return null;
    }
    return { actual: comparisonSide(actual), operator, value: rendered };
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

/** The comparison as one line, e.g. `3.43 < 3.50`. */
export function formatComparison(comparison: LogicComparison): string {
    return comparison.actual === null
        ? `${comparison.operator} ${comparison.value}`
        : `${comparison.actual} ${comparison.operator} ${comparison.value}`;
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
 * - `before_release` (`charge_hold.py:69-71`) — a *requirement*. "The slot
 *   precedes the day's release"; `false` is stamped for `after_release_by_day`,
 *   whose slots are not held. It vetoes.
 * - `hold_room` (`charge_hold.py:66-68`) — a *requirement*, day-scoped. "The
 *   day's remaining solar can still refill the battery from *somewhere* in the
 *   window", and where it is false "even releasing at the window start leaves
 *   the day's remaining solar short of the need, so no slot of it can be held"
 *   (`charge_hold.py:438-445`). Nothing is placed, unlike the two advisory
 *   capacity gates whose `false` still places what it can.
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
        case "before_release": {
            const release = shortTime(params.releaseSlot);
            if (release === null) return null;
            return atMs === null ? release : `${atMs} < ${release}`;
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

/**
 * `HH:MM` from either shape the backend records.
 *
 * `appliance_runtime` writes the configured `"08:00"` straight through;
 * `charge_hold` writes a whole slot id. Both mean a time of day.
 */
function shortTime(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const inSlotId = /T(\d{2}:\d{2})/.exec(value);
    if (inSlotId !== null) return inSlotId[1];
    return /^\d{1,2}:\d{2}$/.test(value) ? value : null;
}

/** The synthetic input that keeps a rejected slot's AND honestly false. */
const UNEXPLAINED_AND_INPUT = "unexplained_veto";

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
 * straight into the planning AND. See `SELF_GATING_CONDITIONS` for what goes
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
    // The self-gating nodes, hoisted out of the groups they are configured in:
    // drawn in their group's column, wired past its `&` and past the `≥1`
    // straight into the planning AND. See `SELF_GATING_CONDITIONS`.
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
        if (group.conditions.every((node) => SELF_GATING_CONDITIONS.has(node.key))) {
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
                comparison: conditionComparison(node.key, node.value, node.actual),
                params: {},
                detail: null,
                x: COL_INPUT_X,
                y: cursorY,
                width: INPUT_W,
                height: BLOCK_H,
            });
            if (SELF_GATING_CONDITIONS.has(node.key)) {
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

    // The group the OR settled on, mirroring `Eligibility.__init__`:
    //
    //     fully = next(g for g in matching if g.custom_met)
    //     self._matched[slot_id] = fully or matching[0]
    //
    // The *first satisfied* group, never "all that passed" — but a group whose
    // custom conditions also held wins over an earlier one whose did not. Take
    // the mask alone and a slot that ran under group 2 gets read against group
    // 1's failed template, which is a false custom stage over a `spustit`
    // terminal: the whole re-check then reads as a contradiction and drops out
    // of the picture, on exactly the slots that ran.
    const groupCustomStates = cell.groups.map((group) => customState(group));
    const systemMatched = groupAndStates.flatMap(
        (state, groupPos) => state === "true" ? [groupPos] : [],
    );
    const matchedPos = systemMatched.find(
        (groupPos) => groupCustomStates[groupPos] !== "false"
            && groupCustomStates[groupPos] !== "errored",
    ) ?? systemMatched[0] ?? -1;
    const matchedGroupIndex = matchedPos < 0 ? null : cell.groups[matchedPos].index;

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
    // ran cannot have failed the stage that would have stopped it. Picking the
    // matched group the way the backend does is what keeps this from firing on
    // ordinary multi-group records; what is left is a record that disagrees
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

/**
 * Level 3: the logic that produced one slot, drawn as PLC-style blocks.
 *
 * Three claims are on screen at once and must not be confused.
 *
 * **State** is what each block evaluated to. **Decisiveness** is whether it
 * changed the outcome — a condition can pass and still be beside the point,
 * because a sibling group had already lost or a gate had already vetoed. The
 * decisive subgraph draws at full opacity with thick solid edges; everything
 * else drops to ~40% with thin dashed ones, and the legend says so with a
 * swatch of each rather than in prose alone. Dimmed, never hidden: removing the
 * branches that did not matter would leave the reader unable to tell "checked
 * and irrelevant" from "never checked".
 *
 * **Membership** is the third: whether a thing is a *term of the conjunction*
 * at all. Gates like `placement_capacity` report on the run without gating the
 * slot, and a `false` one wired into an AND whose terminal reads "spustit" is a
 * picture that contradicts itself. Those live in the annotations panel under
 * the chain, captioned as context. `buildLogicDiagram` guarantees the drawn
 * AND reproduces the terminal; `logic-diagram.spec.ts` pins it.
 *
 * The stages are captioned in the drawing itself, because "which column is
 * which" was the first thing readers could not answer: conditions of each
 * group, then the other decisions, then the custom conditions that are re-checked
 * just before the action would start, then "nothing blocked it", then the
 * result. The `≥1` stage is omitted entirely for a single-group cell — an OR
 * over one input is a stage the reader has to account for and that decides
 * nothing — and the custom stage is omitted where the matched group configured
 * none.
 *
 * Each chain is captioned with its group's name where there is more than one.
 * "Záporná cena" and "Studený bazén" are the two chains of a real record, and
 * an uncaptioned pair of them is a picture nobody can navigate.
 *
 * A condition block shows the *test*, not only the reading: `3.43 < 3.50`, not
 * `3.43`. The operator is the backend's own — see `CONDITION_OPERATORS` — and
 * conditions that do not compare (`run_when`'s set membership, the self-gating
 * pair) never get one invented for them. A node whose condition measures
 * nothing has no `actual` in the record at all, so it shows the threshold
 * alone; every other node shows the reading it was tested with, passing or
 * failing -- 41 % and 95 % clear `≥ 40` and do not mean the same thing.
 *
 * A block also shows **its own numbers**, not only its result. A gate carries
 * the window it tested, the ordinal it placed at or the count it fell short of,
 * on its face, in `have/need` form; the whole param set is one hover away. The
 * self-gating conditions, which record no `actual` and have no numeric test,
 * show the level the group configured. Nothing is invented for a block that has
 * no such number, and nothing is allowed to overflow its block — `fitText`
 * truncates, and the tooltip is where the full string lives.
 *
 * Each group's caption band also carries **where its params came from**.
 * `day_resolved` and `master_fallback` params can be a *different* group's, so
 * without the badge the numbers silently read as this slot's own. The two loud
 * sources say so twice: a leading `!` and the warning colour. A single group
 * gets the badge without a caption — the marker matters more than the label.
 *
 * A condition a group **does not configure** is drawn too, dotted and greyed
 * with a `–`. Leaving it out made a group look like it checked fewer things than
 * it did. It takes no part in the AND (`andState` skips it) and is never marked
 * decisive.
 *
 * There are **four** terminals, not two. `execute` and `not eligible` are the
 * obvious pair; `candidate` (a group's system mask matched but its custom
 * conditions did not, so the action is displayed and never run) and `blocked`
 * (every condition passed and the writer refused because the user owns the
 * slot) are outcomes a two-state diagram would misfile as one of the others.
 *
 * Never colour alone: every block carries a ✓ / ✗ / ? / ! / – glyph, and the
 * edges carry the same information again as solid-vs-dashed.
 */
@customElement("scheduling-logic-diagram")
export class SchedulingLogicDiagram extends LitElement {
    static styles = [
        helmanColorVars,
        css`
            :host {
                display: block;
            }

            .diagram {
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding: 10px 12px;
                border: 1px solid var(--divider-color);
                border-radius: 10px;
                background: var(--secondary-background-color);
            }

            .head {
                display: flex;
                flex-wrap: wrap;
                align-items: baseline;
                gap: 4px 10px;
                font-size: 0.78rem;
            }

            .title {
                font-weight: 600;
                font-size: 0.85rem;
            }

            .slot,
            .matched {
                color: var(--secondary-text-color);
            }

            .scroll {
                overflow-x: auto;
            }

            /* Five stages do not fit a dialog at natural size, and the stage a
               reader wants most is the last one. So the drawing scales down to
               whatever width it is given rather than pushing the terminal off
               the right edge -- down to a floor, below which it goes back to
               scrolling instead of becoming unreadable. */
            svg {
                display: block;
                width: 100%;
                height: auto;
                min-width: 760px;
            }

            /* Dimmed, never hidden: a branch that was evaluated and did not
               matter still has to be readable, or the diagram cannot be told
               apart from one where it was never evaluated at all. */
            g.block,
            path.edge {
                opacity: 0.4;
            }

            g.block[data-decisive="true"],
            path.edge[data-decisive="true"] {
                opacity: 1;
            }

            path.edge {
                fill: none;
                stroke: var(--secondary-text-color, #888);
                stroke-width: 1.5;
                stroke-dasharray: 3 3;
            }

            /* The edge into the final AND was invisible to readers at 1px.
               Solid edges are the spine of the picture and are drawn like it. */
            path.edge[data-decisive="true"] {
                stroke: var(--primary-text-color);
                stroke-width: 3;
                stroke-dasharray: none;
            }

            rect.body {
                fill: var(--card-background-color);
                stroke: var(--divider-color);
                stroke-width: 1;
                rx: 5;
            }

            g.block[data-state="true"] rect.body {
                stroke: var(--success-color, #2e7d32);
            }

            g.block[data-state="false"] rect.body {
                stroke: var(--error-color, #c62828);
            }

            /* An entry that *threw* is not an entry that said no. Fail-closed
               evaluation reports both as "not met", so the diagram has to keep
               them apart by itself: its own colour, its own glyph, and its own
               dash pattern. Three states, three readings, none of them
               colour-only. (No backticks in here: this is a tagged template,
               and one would end it mid-comment.) */
            g.block[data-state="errored"] rect.body {
                stroke: var(--warning-color, #ef6c00);
                stroke-dasharray: 2 2;
            }

            g.block[data-state="not_evaluated"] rect.body {
                stroke-dasharray: 4 3;
            }

            /* A condition the group does not configure. It is drawn -- leaving
               it out made a group look like it checked fewer things than it
               did -- and it must be tellable apart at a glance from a condition
               that failed and from one that was deliberately never consulted.
               Its own dash (fine dots, against 4 3 and 2 2), its own muted
               stroke, and the same greyed treatment on its text. It takes no
               part in the AND: see andState. */
            g.block[data-state="not_applicable"] rect.body {
                stroke: var(--disabled-text-color, var(--secondary-text-color));
                stroke-dasharray: 1 3;
                fill: none;
            }

            g.block[data-state="not_applicable"] text.label,
            g.block[data-state="not_applicable"] text.actual {
                fill: var(--disabled-text-color, var(--secondary-text-color));
            }

            /* The override is the OR's other input, so it is drawn as its own
               kind of thing rather than as one more condition. */
            g.block[data-kind="override"] rect.body {
                stroke: var(--warning-color, #ef6c00);
                stroke-width: 2;
                fill: color-mix(in srgb, var(--warning-color, #ef6c00) 8%, var(--card-background-color));
            }

            text.override-hint {
                font-size: 9px;
                font-weight: 600;
                fill: var(--warning-color, #ef6c00);
            }

            /* Where the group's numbers came from. Day-resolved and
               master-fallback params can be another group's entirely, so they
               are the loud ones -- and they say so with a leading mark as well
               as with colour. (No backticks in here: this is a tagged template
               and one would end it mid-comment.) */
            text.params-source {
                font-size: 9px;
                fill: var(--secondary-text-color);
            }

            text.params-source[data-source="day_resolved"],
            text.params-source[data-source="master_fallback"] {
                font-weight: 700;
                fill: var(--warning-color, #ef6c00);
            }

            /* The group the diagram opened on, so a diagram nobody clicked
               into still says which branch it is about. */
            g.block[data-focus-group="true"] rect.body {
                fill: color-mix(in srgb, var(--primary-color) 8%, var(--card-background-color));
            }

            g.block[data-focus="true"] rect.body {
                stroke-width: 2.5;
                stroke: var(--helman-selection, var(--primary-color));
            }

            text {
                font-size: 11px;
                fill: var(--primary-text-color);
            }

            text.stage {
                font-size: 9.5px;
                font-weight: 600;
                fill: var(--secondary-text-color);
                letter-spacing: 0.02em;
            }

            text.hint {
                font-size: 9px;
                fill: var(--secondary-text-color);
            }

            /* The seam between what is settled and what is taken again. It is
               drawn as a rule rather than said in prose because the reader has
               to be able to see, at a glance, which side of it a block is on. */
            line.stage-divider {
                stroke: var(--divider-color, #888);
                stroke-width: 1;
                stroke-dasharray: 3 4;
            }

            /* The one note on the drawing that is about the future rather than
               about what happened. */
            text.hint.recheck {
                font-style: italic;
            }

            /* What the planning stage decided, as a thing with a name. It is
               the answer to "will this run at all", so it is drawn heavier than
               a condition and lighter than the terminal -- a stage's result,
               not the result. */
            g.block[data-kind="verdict"] rect.body {
                stroke-width: 2;
            }

            g.block[data-kind="verdict"] text.label {
                font-weight: 600;
            }

            text.glyph {
                font-size: 12px;
                font-weight: 700;
            }

            g.block[data-state="true"] text.glyph {
                fill: var(--success-color, #2e7d32);
            }

            g.block[data-state="false"] text.glyph {
                fill: var(--error-color, #c62828);
            }

            g.block[data-state="errored"] text.glyph {
                fill: var(--warning-color, #ef6c00);
            }

            g.block[data-state="not_evaluated"] text.glyph,
            g.block[data-state="not_applicable"] text.glyph,
            g.block[data-state="n/a"] text.glyph {
                fill: var(--secondary-text-color);
            }

            text.actual {
                font-size: 10px;
                fill: var(--secondary-text-color);
            }

            /* The comparison is the block's result stated in numbers, so it
               reads with the same colour the glyph already carries. The glyph
               is still the accessible copy of it. */
            g.block[data-state="true"] text.comparison {
                fill: var(--success-color, #2e7d32);
            }

            g.block[data-state="false"] text.comparison {
                fill: var(--error-color, #c62828);
            }

            text.group-label {
                font-size: 10px;
                font-weight: 600;
                fill: var(--primary-text-color);
            }

            text.op {
                font-size: 12px;
                font-weight: 700;
            }

            /* Context, not conjunction. Set apart from the chain deliberately:
               these were recorded and did not decide anything, and drawing them
               as AND inputs is what made the old diagram contradict itself. */
            .annotations {
                display: flex;
                flex-direction: column;
                gap: 3px;
                padding: 6px 8px;
                border: 1px dashed var(--divider-color);
                border-radius: 8px;
                background: var(--card-background-color);
            }

            .annotations-head {
                font-size: 0.7rem;
                font-weight: 600;
                color: var(--secondary-text-color);
            }

            .annotation {
                display: flex;
                flex-wrap: wrap;
                align-items: baseline;
                gap: 4px 8px;
                font-size: 0.72rem;
            }

            .annotation .glyph {
                font-weight: 700;
                font-variant-numeric: tabular-nums;
            }

            .annotation[data-state="true"] .glyph {
                color: var(--success-color, #2e7d32);
            }

            .annotation[data-state="false"] .glyph,
            .annotation[data-state="errored"] .glyph {
                color: var(--error-color, #c62828);
            }

            .annotation .params {
                color: var(--secondary-text-color);
                font-size: 0.68rem;
            }

            .legend {
                display: flex;
                flex-wrap: wrap;
                gap: 6px 16px;
                font-size: 0.7rem;
                color: var(--secondary-text-color);
            }

            .legend-item {
                display: inline-flex;
                align-items: center;
                gap: 6px;
            }

            /* The legend is keyed to what is actually on screen: a solid swatch
               and a dimmed one, each captioned. Prose alone did not connect. */
            .swatch {
                flex: 0 0 auto;
                display: inline-block;
                width: 26px;
                height: 12px;
                border-radius: 3px;
                border: 1px solid var(--primary-text-color);
                background: var(--card-background-color);
            }

            .swatch.dimmed {
                opacity: 0.4;
                border-style: dashed;
            }

            .legend .op {
                display: inline-block;
                min-width: 20px;
                padding: 0 4px;
                border: 1px solid var(--divider-color);
                border-radius: 4px;
                background: var(--card-background-color);
                color: var(--primary-text-color);
                font-weight: 700;
                text-align: center;
            }

            .empty {
                color: var(--secondary-text-color);
                font-size: 0.76rem;
            }
        `,
    ];

    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public cell: ExplanationCell | null = null;
    /**
     * The condition the user pressed in the matrix, ringed in the diagram.
     *
     * Nothing sets it today: the level-2 matrix that used to is no longer
     * mounted in the dialog (it said nothing the diagram does not). The focus
     * ring stays because it is the seam the matrix returns through, and
     * `focusGroupIndex` alone still decides which chain the diagram opens on.
     */
    @property({ type: String }) public focusConditionKey: string | null = null;
    @property({ type: Number }) public focusGroupIndex: number | null = null;
    @property({ type: String }) public slotLabel = "";
    /**
     * When the plan this record came from was built.
     *
     * The left half of the diagram is only readable with it: every state on
     * that side was taken at this moment, and the custom conditions on the
     * right are taken again later. Empty where the record carries no run time,
     * in which case the notes say *that* it is re-taken without saying when.
     */
    @property({ type: String }) public planLabel = "";
    /**
     * How many hours the plan places earlier in the day than this slot.
     *
     * The daily-minimum gate counts in hours and is stamped once per day from
     * measured history; this is what the plan adds to it by the time the slot
     * arrives, so the block can say how far into the day's quota the slot sits
     * rather than repeating the morning's zero all evening. Null leaves the
     * block on the recorded figure alone.
     */
    @property({ type: Number }) public plannedBeforeHours: number | null = null;

    render() {
        const cell = this.cell;
        if (cell === null || !cell.present) {
            return html`<div class="diagram"><div class="empty">${this._text("diagram.empty")}</div></div>`;
        }
        const model = buildLogicDiagram(cell, this.plannedBeforeHours);
        // Nothing pressed in the matrix still opens on the branch the decision
        // turned on, rather than on nothing at all.
        const focusGroup = this.focusGroupIndex ?? model.defaultGroupIndex;

        return html`
            <div class="diagram">
                <div class="head">
                    <span class="title">${this._text("diagram.title")}</span>
                    <span class="slot">${this.slotLabel || cell.slotId}</span>
                    ${model.matchedGroupIndex === null ? nothing : html`
                        <span class="matched" data-group=${model.matchedGroupIndex}>
                            ${this._text("diagram.matched_group")}
                            ${this._groupLabel(model.matchedGroupIndex)}
                        </span>
                    `}
                </div>
                <div class="scroll">
                    <svg
                        class="logic"
                        viewBox=${`0 0 ${model.width} ${model.height}`}
                        width=${model.width}
                        height=${model.height}
                        style=${`max-width:${model.width}px`}
                        role="img"
                        aria-label=${this._text(`diagram.terminal.${model.terminal}`)}
                        data-terminal=${model.terminal}
                    >
                        ${this._renderStages(model)}
                        ${this._renderGroupHeaders(model)}
                        ${model.edges.map((edge) => this._renderEdge(model, edge))}
                        ${model.blocks.map((block) => this._renderBlock(block, focusGroup))}
                    </svg>
                </div>
                ${this._renderAnnotations(model)}
                ${this._renderLegend(model)}
            </div>
        `;
    }

    /**
     * The stage captions, and the seam between the two stages.
     *
     * Readers could not name the halves of the picture, which made every other
     * question unanswerable. Each stage says what it is, in order — and the
     * rule down the middle says which of them is already settled and which one
     * is taken again before the action starts. That seam is the whole reason a
     * `candidate` is readable: everything left of it is history, everything
     * right of it can still change.
     */
    private _renderStages(model: LogicDiagramModel) {
        const orBlock = model.blocks.find((block) => block.id === "or");
        const customBlock = model.blocks.find((block) => block.id === "custom");
        const verdictBlock = model.blocks.find((block) => block.id === "verdict");
        const overrideBlock = model.blocks.find((block) => block.id === "override");
        return svg`
            <text class="stage" data-stage="conditions" x=${COL_INPUT_X} y="14">
                ${this._text("diagram.stage.conditions")}
            </text>
            <text class="stage" data-stage="gates" x=${COL_SIDE_X} y="14">
                ${this._text("diagram.stage.gates")}
            </text>
            <text class="stage" data-stage="plan" x=${COL_FINAL_X} y="14">
                ${fitText(this._text("diagram.stage.plan"), VERDICT_W + OP_W, STAGE_PX_PER_CHAR)}
            </text>
            ${customBlock === undefined ? nothing : svg`
                <line
                    class="stage-divider"
                    x1=${DIVIDER_X}
                    y1="4"
                    x2=${DIVIDER_X}
                    y2=${model.height - 4}
                ></line>
                <text class="stage" data-stage="recheck" x=${COL_CUSTOM_X} y="14">
                    ${fitText(
                        this._text("diagram.stage.recheck"),
                        CUSTOM_W + OP_W,
                        STAGE_PX_PER_CHAR,
                    )}
                </text>
            `}
            <text
                class="stage"
                data-stage="result"
                x=${model.width - 8}
                y="14"
                text-anchor="end"
            >${this._text("diagram.stage.result")}</text>
            ${orBlock === undefined ? nothing : svg`
                <text
                    class="hint"
                    data-stage=${model.hasOverride ? "any_group_or_forced" : "any_group"}
                    x=${orBlock.x + orBlock.width / 2}
                    y=${orBlock.y + orBlock.height + 11}
                    text-anchor="middle"
                >${fitText(
                    this._text(model.hasOverride
                        ? "diagram.stage.any_group_or_forced"
                        : "diagram.stage.any_group"),
                    OP_W + 80,
                    ACTUAL_PX_PER_CHAR,
                )}</text>
            `}
            ${overrideBlock === undefined ? nothing : svg`
                <text
                    class="override-hint"
                    data-stage="forced_run"
                    x=${overrideBlock.x}
                    y=${overrideBlock.y + overrideBlock.height + 10}
                >${fitText(
                    this._text("diagram.override_hint"),
                    INPUT_W + 40,
                    ACTUAL_PX_PER_CHAR,
                )}</text>
            `}
            ${verdictBlock === undefined ? nothing : svg`
                <text
                    class="hint"
                    data-stage="plan_when"
                    x=${verdictBlock.x}
                    y=${verdictBlock.y + verdictBlock.height + 11}
                >${fitText(
                    this._when("diagram.plan_decided_when", this.planLabel),
                    VERDICT_W + 40,
                    ACTUAL_PX_PER_CHAR,
                )}</text>
            `}
            <!--
                Both lines, whatever the custom conditions came out as. When
                they held, the reader has to know the answer has a timestamp on
                it and can still turn; when they did not, the same two facts are
                what says a candidate is waiting rather than refused. Saying it
                only in one of the two cases is what made "kandidát" read as a
                verdict instead of as a pending question.

                With none configured there is nothing to time and nothing to
                retake, so the one honest line says that instead.
            -->
            ${customBlock === undefined ? nothing : (customBlock.state === "n/a" ? svg`
                <text
                    class="hint"
                    data-stage="custom_none"
                    x=${customBlock.x}
                    y=${customBlock.y + customBlock.height + 11}
                >${fitText(
                    this._customNone(model),
                    CUSTOM_W + 200,
                    ACTUAL_PX_PER_CHAR,
                )}</text>
                ${model.otherGroupsHaveCustom ? svg`
                    <text
                        class="hint"
                        data-stage="custom_other_group"
                        x=${customBlock.x}
                        y=${customBlock.y + customBlock.height + 22}
                    >${fitText(
                        this._text("diagram.stage.custom_other_group"),
                        CUSTOM_W + 200,
                        ACTUAL_PX_PER_CHAR,
                    )}</text>
                ` : nothing}
            ` : svg`
                <text
                    class="hint"
                    data-stage="custom_evaluated"
                    x=${customBlock.x}
                    y=${customBlock.y + customBlock.height + 11}
                >${fitText(
                    this._when("diagram.plan_when", this.planLabel),
                    CUSTOM_W + 200,
                    ACTUAL_PX_PER_CHAR,
                )}</text>
                <text
                    class="hint recheck"
                    data-stage="custom_when"
                    x=${customBlock.x}
                    y=${customBlock.y + customBlock.height + 22}
                >${fitText(
                    this._when("diagram.stage.custom_when", this.slotLabel),
                    CUSTOM_W + 200,
                    ACTUAL_PX_PER_CHAR,
                )}</text>
            `)}
        `;
    }

    /**
     * "None configured" — said of the group it is true of.
     *
     * Custom conditions are a group's, so an unqualified "none" is read as the
     * automation's and disbelieved on the spot by anybody who wrote one.
     */
    private _customNone(model: LogicDiagramModel): string {
        const text = this._text("diagram.stage.custom_none");
        return model.matchedGroupIndex === null
            ? text
            : `${this._groupLabel(model.matchedGroupIndex)}: ${text}`;
    }

    /**
     * A note about *when*, with its clock time where there is one.
     *
     * The label alone is still the whole claim — "it is taken again before the
     * action starts" is true with or without a time on it — so a record that
     * carries no run time drops the time rather than the note.
     */
    private _when(key: string, at: string): string {
        const text = this._text(key);
        return at === "" ? text : `${text} · ${at}`;
    }

    /**
     * Which chain is which, where there is more than one.
     *
     * Real groups have names — "Záporná cena", "Studený bazén" — and without
     * them a reader with three chains cannot say which one the diagram is even
     * about. A group that was never named falls back to its index.
     */
    private _renderGroupHeaders(model: LogicDiagramModel) {
        return model.groupHeaders.map((header) => svg`
            ${header.showLabel ? svg`
                <text
                    class="group-label"
                    data-group=${header.index}
                    x=${COL_INPUT_X}
                    y=${header.y}
                >${fitText(
                    header.label.length > 0
                        ? header.label
                        : `${this._text("matrix.group")} ${header.index + 1}`,
                    INPUT_W - SOURCE_MAX_W - 8,
                    LABEL_PX_PER_CHAR,
                )}</text>
            ` : nothing}
            <text
                class="params-source"
                data-group=${header.index}
                data-source=${header.paramsSource}
                x=${header.showLabel ? COL_INPUT_X + INPUT_W : COL_INPUT_X}
                y=${header.y}
                text-anchor=${header.showLabel ? "end" : "start"}
            ><title>${
                this._text(`params_source_detail.${header.paramsSource}`)
            }</title><tspan class="badge">${fitText(
                `${header.paramsSource === "slot_matched" ? "" : "! "}${
                    this._text(`params_source.${header.paramsSource}`)}`,
                SOURCE_MAX_W,
                SOURCE_PX_PER_CHAR,
            )}</tspan></text>
        `);
    }

    private _renderEdge(model: LogicDiagramModel, edge: LogicEdge) {
        const from = model.blocks.find((block) => block.id === edge.from);
        const to = model.blocks.find((block) => block.id === edge.to);
        if (from === undefined || to === undefined) {
            return nothing;
        }
        const x1 = from.x + from.width;
        const y1 = from.y + from.height / 2;
        const x2 = to.x;
        const y2 = to.y + to.height / 2;
        // Everything entering the final AND turns past the side column, so the
        // spine never runs through a gate block on its way there.
        // Everything entering the OR turns in the gap *after* the AND column,
        // so the override's long edge up from below the groups never runs
        // through a group's own `&` block on its way there.
        const mid = edge.to === "final"
            ? Math.max(x1 + 8, FINAL_ELBOW_X)
            : edge.to === "or"
                ? Math.max(x1 + 6, COL_OR_X - 6)
                : x1 + Math.max(8, (x2 - x1) / 2);
        return svg`
            <path
                class="edge"
                data-from=${edge.from}
                data-to=${edge.to}
                data-decisive=${edge.decisive ? "true" : "false"}
                d=${`M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`}
            ></path>
        `;
    }

    private _renderBlock(block: LogicBlock, focusGroup: number | null) {
        const focus = block.kind === "input"
            && block.key === this.focusConditionKey
            && (this.focusGroupIndex === null || block.groupIndex === this.focusGroupIndex);
        const isOperator = block.kind === "and"
            || block.kind === "or"
            || block.kind === "final"
            || block.kind === "execution";
        const label = this._blockLabel(block);
        // What the block was *compared against*, not just what it saw: "3.43"
        // alone never told the reader whether 3.43 was the good side or the bad
        // one. Where the condition has no comparison to draw — the self-gating
        // pair, the gates — the recorded value stays on its own.
        //
        // Objects never reach the block face either way: a raw
        // `{"code":…,"deltaSocPct":…}` painted over the neighbouring block is
        // the bug this closes. Scalars stay inline, everything else lives in
        // the tooltip.
        //
        // Where nothing was compared, the block still owns numbers worth
        // showing: a gate's own `detail` (the window it tested, the ordinal it
        // placed at, the count it fell short of), the `actual` the node
        // recorded, or — for the self-gating conditions, which record no actual
        // and have no numeric test — the level the group configured. Full
        // params always live in the tooltip.
        const comparison = block.comparison;
        const right = comparison !== null
            ? formatComparison(comparison)
            : block.detail
                ?? this._configuredLevel(block)
                ?? summariseLogicValue(block.actual)
                ?? summariseLogicValue(block.value);
        // The right-hand text gets a *cap*, and the label gets back whatever it
        // did not use: reserving the full cap for `1/16` cost the label six
        // characters it had no reason to lose.
        const rightCap = comparison !== null
            ? COMPARE_MAX_W
            : block.detail !== null ? DETAIL_MAX_W : ACTUAL_MAX_W;
        const rightText = right === null ? null : fitText(right, rightCap, ACTUAL_PX_PER_CHAR);
        const labelBudget = block.width - 26 - 8
            - (rightText === null ? 0 : rightText.length * ACTUAL_PX_PER_CHAR + 6);
        const fullValue = fullLogicValue(block.actual);
        const fullConfigured = fullLogicValue(block.value);
        // A refusal that came back as a reason rather than a reading says which
        // test it failed, in words, with its own numbers named -- the raw
        // `{"code":…}` it replaces was on screen and unreadable.
        const reason = this._reasonText(block);
        const title = [
            `${label} — ${this._labelled("state", block.state)}`,
            this._conditionDetail(block.key),
            reason,
            block.kind === "override" ? this._text("diagram.override_detail") : "",
            fullConfigured === null
                ? ""
                : `${this._text("matrix.configured")}: ${
                    this._configuredLevel(block) ?? fullConfigured}`,
            // The reason has already said everything the object holds, in a
            // form a person can read.
            reason !== "" || fullValue === null
                ? ""
                : `${this._text("matrix.actual")}: ${fullValue}`,
            this._paramsText(block.params),
        ].filter((part) => part.length > 0).join(" · ");

        return svg`
            <g
                class="block"
                data-id=${block.id}
                data-kind=${block.kind}
                data-key=${block.key}
                data-state=${block.state}
                data-decisive=${block.decisive ? "true" : "false"}
                data-focus=${focus ? "true" : "false"}
                data-focus-group=${block.groupIndex !== null && block.groupIndex === focusGroup
                    ? "true"
                    : "false"}
                data-group=${block.groupIndex ?? nothing}
            >
                <title>${title}</title>
                <rect
                    class="body"
                    x=${block.x}
                    y=${block.y}
                    width=${block.width}
                    height=${block.height}
                ></rect>
                ${isOperator ? svg`
                    <text
                        class="op"
                        x=${block.x + block.width / 2}
                        y=${block.y + block.height / 2 + 4}
                        text-anchor="middle"
                    >${block.kind === "or" ? "≥1" : "&"}</text>
                ` : svg`
                    <text class="glyph" x=${block.x + 8} y=${block.y + block.height / 2 + 4}>
                        ${stateGlyph(block.state)}
                    </text>
                    <text class="label" x=${block.x + 26} y=${block.y + block.height / 2 + 4}>
                        ${fitText(label, labelBudget, LABEL_PX_PER_CHAR)}
                    </text>
                    ${rightText === null ? nothing : svg`
                        <text
                            class=${comparison !== null
                                ? "actual comparison"
                                : block.detail !== null ? "actual detail" : "actual"}
                            x=${block.x + block.width - 8}
                            y=${block.y + block.height / 2 + 4}
                            text-anchor="end"
                        >${rightText}</text>
                    `}
                `}
            </g>
        `;
    }

    /** Everything recorded that did not gate the slot, said so plainly. */
    private _renderAnnotations(model: LogicDiagramModel) {
        if (model.annotations.length === 0) {
            return nothing;
        }
        return html`
            <div class="annotations">
                <div class="annotations-head">${this._text("diagram.context")}</div>
                ${model.annotations.map((entry) => html`
                    <div class="annotation" data-key=${entry.key} data-state=${entry.state}>
                        <span class="glyph">${stateGlyph(entry.state)}</span>
                        <span class="label">${this._annotationLabel(entry)}</span>
                        ${Object.entries(entry.params).length === 0 ? nothing : html`
                            <span class="params">${this._paramsText(entry.params)}</span>
                        `}
                    </div>
                `)}
            </div>
        `;
    }

    /** Every number the block or gate carries, named, for the tooltip. */
    private _paramsText(params: Record<string, unknown>): string {
        return Object.entries(params)
            .map(([key, value]) =>
                `${this._labelled("param", key)}: ${fullLogicValue(value) ?? "—"}`)
            .join(", ");
    }

    private _renderLegend(model: LogicDiagramModel) {
        const hasNotApplicable = model.blocks.some(
            (block) => block.state === "not_applicable",
        );
        const hasDetail = model.blocks.some((block) => block.detail !== null);
        return html`
            <div class="legend">
                <span class="legend-item" data-legend="stages">
                    ${this._text("diagram.legend_stages")}
                </span>
                ${model.customState === "n/a" ? html`
                    <span class="legend-item" data-legend="no_custom">
                        ${this._text("diagram.legend_no_custom")}
                    </span>
                ` : nothing}
                <span class="legend-item" data-legend="decisive">
                    <span class="swatch solid"></span>
                    ${this._text("diagram.legend_decisive")}
                </span>
                <span class="legend-item" data-legend="dimmed">
                    <span class="swatch dimmed"></span>
                    ${this._text("diagram.legend_dimmed")}
                </span>
                <span class="legend-item" data-legend="comparison">
                    ${this._text("diagram.legend_comparison")}
                </span>
                <span class="legend-item" data-legend="and">
                    <span class="op">&amp;</span>
                    ${this._text("diagram.legend_and")}
                </span>
                ${model.showOr ? html`
                    <span class="legend-item" data-legend="or">
                        <span class="op">≥1</span>
                        ${this._text("diagram.legend_or")}
                    </span>
                ` : nothing}
                ${model.hasOverride ? html`
                    <span class="legend-item" data-legend="override">
                        ${this._text("diagram.legend_override")}
                    </span>
                ` : nothing}
                ${hasNotApplicable ? html`
                    <span class="legend-item" data-legend="not_applicable">
                        ${this._text("diagram.legend_not_applicable")}
                    </span>
                ` : nothing}
                ${hasDetail ? html`
                    <span class="legend-item" data-legend="params">
                        ${this._text("diagram.legend_params")}
                    </span>
                ` : nothing}
                <span class="legend-item" data-legend="params_source">
                    ${this._text("diagram.legend_params_source")}
                </span>
            </div>
        `;
    }

    private _blockLabel(block: LogicBlock): string {
        switch (block.kind) {
            case "terminal":
                return this._text(`diagram.terminal.${block.key}`);
            case "verdict":
                return this._text(`diagram.verdict.${block.key}`);
            case "custom":
                // A candidate whose record does not name the failing condition
                // says so, rather than blaming a template it cannot show.
                return block.key === UNEXPLAINED_AND_INPUT
                    ? `${this._text("matrix.custom")} — ${this._text("diagram.unexplained")}`
                    : this._text("matrix.custom");
            case "override":
                return this._text("diagram.override");
            case "input":
                return block.key === ""
                    ? this._text("matrix.no_conditions")
                    : this._labelled("condition", block.key);
            case "gate":
                return block.key === `${UNEXPLAINED_AND_INPUT}`
                    ? this._text("diagram.unexplained")
                    : this._labelled("condition", block.key);
            default:
                return this._labelled("condition", block.key);
        }
    }

    private _annotationLabel(entry: LogicAnnotation): string {
        switch (entry.kind) {
            case "custom":
                return this._text("matrix.custom");
            case "groups":
                return this._text("diagram.stage.conditions");
            default:
                return this._labelled("condition", entry.key);
        }
    }

    private _groupLabel(groupIndex: number): string {
        const group = this.cell?.groups.find((entry) => entry.index === groupIndex);
        return group !== undefined && group.label.length > 0
            ? group.label
            : `${this._text("matrix.group")} ${groupIndex + 1}`;
    }

    private _text(suffix: string): string {
        return this.localize(`${KEY_PREFIX}.${suffix}`);
    }

    /** A localized label, falling back to the raw backend key when unknown. */
    private _labelled(group: string, key: string): string {
        if (key.length === 0) return "";
        const full = `${KEY_PREFIX}.${group}.${key}`;
        const translated = this.localize(full);
        return translated === full || translated === undefined ? key : translated;
    }

    /**
     * A configured level said in words, where the config token is not one.
     *
     * `strict` and `soft` are the two settings self-sustainability takes, and
     * the raw token is what the block has always shown. It is the only value on
     * this drawing that is a *mode* rather than a number, so it is the only one
     * with anything to translate.
     */
    private _configuredLevel(block: LogicBlock): string | null {
        if (block.key !== SELF_SUSTAINABILITY || typeof block.value !== "string") {
            return null;
        }
        const full = `${KEY_PREFIX}.self_sustainability.level.${block.value}`;
        const translated = this.localize(full);
        return translated === full || translated === undefined ? block.value : translated;
    }

    /**
     * Why a self-gating condition refused this slot, in words and numbers.
     *
     * Its `actual` is a *reason* rather than a reading: which of three tests
     * failed, and what it saw (`appliance_runtime.py:817, 827, 885`). The face
     * carries the comparison; this is where the rest goes -- most importantly
     * `atSlot`, the hour the floor would break, which has nowhere else to be,
     * and the difference between "this slot would break the floor" and "the
     * floor breaks anyway, without the appliance", which the two comparisons
     * cannot tell apart on their own.
     */
    private _reasonText(block: LogicBlock): string {
        const actual = block.actual;
        if (
            block.key !== SELF_SUSTAINABILITY
            || typeof actual !== "object"
            || actual === null
            || Array.isArray(actual)
        ) {
            return "";
        }

        const detail = actual as Record<string, unknown>;
        if (typeof detail.code !== "string") {
            return "";
        }

        const sentence = this._text(`self_sustainability.${detail.code}`);
        const numbers = Object.entries(detail)
            .filter(([key]) => key !== "code")
            .map(([key, value]) => `${this._labelled("param", key)}: ${
                key === "atSlot" ? shortTime(value) ?? fullLogicValue(value) : fullLogicValue(value)
            }`)
            .join(", ");
        return [sentence, numbers].filter((part) => part.length > 0).join(" — ");
    }

    /**
     * What a condition or gate *means*, for the hover, where saying it is worth
     * the words.
     *
     * A block's face has room for a name and a number, which is enough for a
     * threshold and not enough for a requirement whose direction is not obvious
     * from its name — `blocked_user_owned` is `true` when the user does *not*
     * own the slot, and a reader has no way to know that from a tick. Only the
     * keys that have an entry get one; the rest return nothing and the tooltip
     * is what it was.
     */
    private _conditionDetail(key: string): string {
        if (key.length === 0) return "";
        const full = `${KEY_PREFIX}.condition_detail.${key}`;
        const translated = this.localize(full);
        return translated === full || translated === undefined ? "" : translated;
    }
}

/** Never colour alone: every block states its result as a mark too. */
function stateGlyph(state: LogicState): string {
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

/** Room reserved for a block's `actual`, and the widths text is fitted to. */
const ACTUAL_MAX_W = 46;
/**
 * Room for `actual <op> value`, which is three things rather than one.
 *
 * Sized for the longest honest case rather than the average: `surplus ∈
 * surplus, tight` is a set membership with two words either side, and it is the
 * comparison a reader is least able to reconstruct from the label. What is left
 * still holds "Kdy spustit"; anything longer truncates and lives in full in the
 * tooltip, as it always has.
 */
const COMPARE_MAX_W = 130;
/** Room for a gate's own numbers: `10:00 ∈ 08:00–18:00` is the widest. */
const DETAIL_MAX_W = 106;
/** Room for the params-source badge, right-aligned in the group's caption. */
const SOURCE_MAX_W = 86;
const SOURCE_PX_PER_CHAR = 4.7;
const LABEL_PX_PER_CHAR = 5.9;
const ACTUAL_PX_PER_CHAR = 5.4;
const STAGE_PX_PER_CHAR = 5.0;

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

declare global {
    interface HTMLElementTagNameMap {
        "scheduling-logic-diagram": SchedulingLogicDiagram;
    }
}
