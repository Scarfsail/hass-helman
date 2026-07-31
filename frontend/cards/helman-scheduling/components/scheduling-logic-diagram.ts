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
    | "final"
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
    x: number;
    y: number;
    width: number;
    height: number;
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
    terminal: LogicTerminal;
    /** The group the OR settled on, mirroring `fully or matching[0]`. */
    matchedGroupIndex: number | null;
    /** False for a single-group cell: an OR over one input decides nothing. */
    showOr: boolean;
    /** The group the diagram opens on when nothing was pressed in the matrix. */
    defaultGroupIndex: number | null;
    width: number;
    height: number;
}

const BLOCK_H = 26;
const INPUT_W = 210;
const GATE_W = 200;
const OP_W = 44;
const TERM_W = 160;
const V_GAP = 8;
const GROUP_GAP = 20;
const PAD_TOP = 30;

const COL_INPUT_X = 8;
const COL_AND_X = 232;
const COL_OR_X = 306;
const COL_SIDE_X = 376;
const COL_FINAL_X = 598;
const COL_TERM_X = 676;
const DIAGRAM_W = COL_TERM_X + TERM_W + 8;

/** Where a `→ final` edge turns: past the side column, so it crosses nothing. */
const FINAL_ELBOW_X = COL_FINAL_X - 14;

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
 * rather than by this list: see `isAndInput`.
 */
const ALWAYS_ADVISORY_GATES = new Set<string>([
    "placement_capacity",
    "cheap_window_capacity",
]);

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
 * May this term be wired into the final AND?
 *
 * **The diagram must never contradict its own terminal.** Two rules, in order:
 *
 * 1. A gate documented as non-blocking is never a term of the conjunction, in
 *    either state. It reports on the run, it does not gate the slot.
 * 2. If the terminal is `execute` then, by definition, *nothing vetoed* — so
 *    any term that is not `true` cannot have been part of what made the slot
 *    run, and is reported as context instead. This is what stops
 *    `✗ placement_capacity → & → ✓ execute` from ever being drawn again.
 */
function isAndInput(key: string, state: LogicState, terminal: LogicTerminal): boolean {
    if (ALWAYS_ADVISORY_GATES.has(key)) return false;
    if (terminal === "execute" && state !== "true" && state !== "not_applicable") return false;
    return true;
}

/**
 * Build the diagram for one slot of one optimizer.
 *
 * The shape mirrors how eligibility is actually decided: conditions AND within
 * a group, groups OR against each other, and the winner is then ANDed with the
 * group's custom conditions and with the gates that actually vetoed.
 *
 * **The AND chain is built to reproduce the terminal.** `finalAndState` over
 * the drawn inputs equals the final block's state, and that state is `true` if
 * and only if the terminal is `execute`. Terms that cannot have vetoed are
 * moved to `annotations` — drawn beside the chain, never in it. Where a
 * rejected slot names no veto at all, one synthetic `unexplained_veto` input
 * carries the falsehood, because a picture that resolves `true` above the word
 * "nesplněné podmínky" is worse than an admission of ignorance.
 *
 * **A single group gets no OR.** `≥1` over one input decides nothing and reads
 * as a stage the reader has to account for; the group's `&` wires straight on.
 *
 * **Decisiveness walks back from the verdict**, never forward from the inputs:
 *
 * - **AND false** → only its *false* inputs are decisive.
 * - **AND true** → all its inputs are decisive.
 * - **OR true** → only the *first satisfied* group, mirroring
 *   `evaluation.py:90-96` (`fully or matching[0]`). Anything else that also
 *   passed never got looked at, and highlighting it would put the diagram at
 *   odds with the "matched group" the matrix names.
 * - **OR false** → all its inputs are decisive; every group had to fail.
 *
 * A block that is not decisive is dimmed, never removed: "this was checked and
 * did not matter" is a different claim from "this was not checked".
 */
export function buildLogicDiagram(cell: ExplanationCell): LogicDiagramModel {
    const blocks: LogicBlock[] = [];
    const edges: LogicEdge[] = [];
    const annotations: LogicAnnotation[] = [];
    const terminal = resolveTerminal(cell);

    // ---- geometry + states, groups first -------------------------------
    let cursorY = PAD_TOP;
    const groupAndIds: string[] = [];
    const groupAndStates: LogicState[] = [];
    const groupInputIds: string[][] = [];
    const groupInputStates: LogicState[][] = [];
    const andCenters: number[] = [];

    cell.groups.forEach((group, groupPos) => {
        const inputIds: string[] = [];
        const inputStates: LogicState[] = [];
        const top = cursorY;
        if (group.conditions.length === 0) {
            // A group with nothing configured still gets a row, so the diagram
            // never silently drops a branch that exists in the record.
            const id = `input-${groupPos}-none`;
            blocks.push({
                id,
                kind: "input",
                key: "",
                state: "n/a",
                decisive: false,
                groupIndex: group.index,
                actual: null,
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
                x: COL_INPUT_X,
                y: cursorY,
                width: INPUT_W,
                height: BLOCK_H,
            });
            inputIds.push(id);
            inputStates.push(node.state);
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

    // ---- the OR, only where there is anything to choose between ---------
    const showOr = cell.groups.length > 1;
    const orId = "or";
    const orValue = orState(groupAndStates);
    const orY = andCenters.length === 0
        ? PAD_TOP
        : Math.round((Math.min(...andCenters) + Math.max(...andCenters)) / 2 - BLOCK_H / 2);
    if (showOr) {
        blocks.push({
            id: orId,
            kind: "or",
            key: "",
            state: orValue,
            decisive: false,
            groupIndex: null,
            actual: null,
            x: COL_OR_X,
            y: orY,
            width: OP_W,
            height: BLOCK_H,
        });
        for (const andId of groupAndIds) {
            edges.push({ from: andId, to: orId, decisive: false });
        }
    }

    // The group the OR settled on: the *first* satisfied one, never "all that
    // passed". `build_eligibility` stops there and so does this.
    const matchedPos = groupAndStates.findIndex((state) => state === "true");
    const matchedGroupIndex = matchedPos < 0 ? null : cell.groups[matchedPos].index;

    // The spine: the one term that carries "some group's conditions held".
    const spineId = showOr ? orId : (groupAndIds[0] ?? null);
    const spineState: LogicState = showOr ? orValue : (groupAndStates[0] ?? "n/a");

    // ---- the terms of the final AND, and what is only context -----------
    let sideY = Math.max(cursorY, orY + BLOCK_H + GROUP_GAP);
    const finalInputIds: string[] = [];
    const finalInputStates: LogicState[] = [];

    if (spineId !== null) {
        if (isAndInput("", spineState, terminal)) {
            edges.push({ from: spineId, to: "final", decisive: false });
            finalInputIds.push(spineId);
            finalInputStates.push(spineState);
        } else {
            annotations.push({ key: "groups", kind: "groups", state: spineState, params: {} });
        }
    }

    const custom = customState(matchedPos < 0 ? undefined : cell.groups[matchedPos]);
    if (custom !== "n/a") {
        if (isAndInput("custom", custom, terminal)) {
            blocks.push({
                id: "custom",
                kind: "custom",
                key: "custom",
                state: custom,
                decisive: false,
                groupIndex: matchedGroupIndex,
                actual: null,
                x: COL_SIDE_X,
                y: sideY,
                width: GATE_W,
                height: BLOCK_H,
            });
            edges.push({ from: "custom", to: "final", decisive: false });
            finalInputIds.push("custom");
            finalInputStates.push(custom);
            sideY += BLOCK_H + V_GAP;
        } else {
            annotations.push({ key: "custom", kind: "custom", state: custom, params: {} });
        }
    }

    cell.gates.forEach((gate: ExplanationGate, gatePos) => {
        if (!isAndInput(gate.key, gate.state, terminal)) {
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
            actual: gate.params.rank ?? null,
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

    // A rejected slot whose every drawn term passed would resolve `true` above
    // a terminal that says otherwise. One honest block, rather than a lie.
    if (terminal !== "execute" && finalAndState(finalInputStates) !== "false") {
        const id = `gate-${UNEXPLAINED_AND_INPUT}`;
        blocks.push({
            id,
            kind: "gate",
            key: UNEXPLAINED_AND_INPUT,
            state: "false",
            decisive: false,
            groupIndex: null,
            actual: null,
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

    // ---- the terminal --------------------------------------------------
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
        x: COL_FINAL_X,
        y: finalY,
        width: OP_W,
        height: BLOCK_H,
    });
    blocks.push({
        id: "terminal",
        kind: "terminal",
        key: terminal,
        state: terminal === "execute" ? "true" : terminal === "candidate" ? "not_evaluated" : "false",
        decisive: true,
        groupIndex: null,
        actual: null,
        x: COL_TERM_X,
        y: finalY,
        width: TERM_W,
        height: BLOCK_H,
    });
    edges.push({ from: "final", to: "terminal", decisive: true });

    // ---- decisiveness, walked back from the terminal --------------------
    const byId = new Map(blocks.map((block) => [block.id, block]));
    const mark = (id: string): void => {
        const block = byId.get(id);
        if (block !== undefined) block.decisive = true;
    };

    // The final AND: true means every input mattered; false means only the
    // inputs that failed it did.
    const decisiveFinal = terminal === "execute"
        ? finalInputIds.map((_, index) => index)
        : decisiveInputsOfFalseAnd(finalInputStates);
    for (const index of decisiveFinal) {
        mark(finalInputIds[index]);
    }

    if (spineId !== null && byId.get(spineId)?.decisive === true) {
        if (showOr) {
            if (orValue === "true") {
                // Only the first satisfied group. The rest were never reached.
                if (matchedPos >= 0) mark(groupAndIds[matchedPos]);
            } else {
                for (const andId of groupAndIds) mark(andId);
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

    const height = Math.max(sideY, cursorY, finalY + BLOCK_H) + 10;
    return {
        blocks,
        edges,
        annotations,
        terminal,
        matchedGroupIndex,
        showOr,
        defaultGroupIndex: matchedGroupIndex ?? cell.groups[0]?.index ?? null,
        width: DIAGRAM_W,
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
 * group, then the other decisions, then "nothing blocked it", then the result.
 * The `≥1` stage is omitted entirely for a single-group cell — an OR over one
 * input is a stage the reader has to account for and that decides nothing.
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

            svg {
                display: block;
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

            g.block[data-state="false"] rect.body,
            g.block[data-state="errored"] rect.body {
                stroke: var(--error-color, #c62828);
            }

            g.block[data-state="not_evaluated"] rect.body {
                stroke-dasharray: 4 3;
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

            text.glyph {
                font-size: 12px;
                font-weight: 700;
            }

            g.block[data-state="true"] text.glyph {
                fill: var(--success-color, #2e7d32);
            }

            g.block[data-state="false"] text.glyph,
            g.block[data-state="errored"] text.glyph {
                fill: var(--error-color, #c62828);
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
    /** The condition the user pressed in the matrix, ringed in the diagram. */
    @property({ type: String }) public focusConditionKey: string | null = null;
    @property({ type: Number }) public focusGroupIndex: number | null = null;
    @property({ type: String }) public slotLabel = "";

    render() {
        const cell = this.cell;
        if (cell === null || !cell.present) {
            return html`<div class="diagram"><div class="empty">${this._text("diagram.empty")}</div></div>`;
        }
        const model = buildLogicDiagram(cell);
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
                        role="img"
                        aria-label=${this._text(`diagram.terminal.${model.terminal}`)}
                        data-terminal=${model.terminal}
                    >
                        ${this._renderStages(model)}
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
     * The stage captions.
     *
     * Readers could not name the two halves of the picture, which made every
     * other question unanswerable. Each stage says what it is, in order.
     */
    private _renderStages(model: LogicDiagramModel) {
        const orBlock = model.blocks.find((block) => block.id === "or");
        return svg`
            <text class="stage" data-stage="conditions" x=${COL_INPUT_X} y="14">
                ${this._text("diagram.stage.conditions")}
            </text>
            <text class="stage" data-stage="gates" x=${COL_SIDE_X} y="14">
                ${this._text("diagram.stage.gates")}
            </text>
            <text class="stage" data-stage="final" x=${COL_FINAL_X} y="14">
                ${this._text("diagram.stage.final")}
            </text>
            <text
                class="stage"
                data-stage="result"
                x=${DIAGRAM_W - 8}
                y="14"
                text-anchor="end"
            >${this._text("diagram.stage.result")}</text>
            ${orBlock === undefined ? nothing : svg`
                <text
                    class="hint"
                    data-stage="any_group"
                    x=${orBlock.x + orBlock.width / 2}
                    y=${orBlock.y + orBlock.height + 11}
                    text-anchor="middle"
                >${this._text("diagram.stage.any_group")}</text>
            `}
        `;
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
        const mid = edge.to === "final"
            ? Math.max(x1 + 8, FINAL_ELBOW_X)
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
        const isOperator = block.kind === "and" || block.kind === "or" || block.kind === "final";
        const label = this._blockLabel(block);
        // Objects never reach the block face: a raw `{"code":…,"deltaSocPct":…}`
        // painted over the neighbouring block is the bug this closes. Scalars
        // stay inline, everything else lives in the tooltip.
        const actual = summariseLogicValue(block.actual);
        const labelBudget = block.width - 26 - 8 - (actual === null ? 0 : ACTUAL_MAX_W + 6);
        const fullValue = fullLogicValue(block.actual);
        const title = [
            `${label} — ${this._labelled("state", block.state)}`,
            fullValue === null ? "" : `${this._text("matrix.actual")}: ${fullValue}`,
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
                    ${actual === null ? nothing : svg`
                        <text
                            class="actual"
                            x=${block.x + block.width - 8}
                            y=${block.y + block.height / 2 + 4}
                            text-anchor="end"
                        >${fitText(actual, ACTUAL_MAX_W, ACTUAL_PX_PER_CHAR)}</text>
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
                            <span class="params">
                                ${Object.entries(entry.params)
                                    .map(([key, value]) =>
                                        `${this._labelled("param", key)}: ${fullLogicValue(value) ?? "—"}`)
                                    .join(", ")}
                            </span>
                        `}
                    </div>
                `)}
            </div>
        `;
    }

    private _renderLegend(model: LogicDiagramModel) {
        return html`
            <div class="legend">
                <span class="legend-item" data-legend="decisive">
                    <span class="swatch solid"></span>
                    ${this._text("diagram.legend_decisive")}
                </span>
                <span class="legend-item" data-legend="dimmed">
                    <span class="swatch dimmed"></span>
                    ${this._text("diagram.legend_dimmed")}
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
            </div>
        `;
    }

    private _blockLabel(block: LogicBlock): string {
        switch (block.kind) {
            case "terminal":
                return this._text(`diagram.terminal.${block.key}`);
            case "custom":
                return this._text("matrix.custom");
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
const LABEL_PX_PER_CHAR = 5.9;
const ACTUAL_PX_PER_CHAR = 5.4;

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
