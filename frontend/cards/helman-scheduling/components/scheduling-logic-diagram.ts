import { LitElement, css, html, svg } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import { helmanColorVars } from "../../color-vars";
import type {
    ExplanationCell,
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

export interface LogicDiagramModel {
    blocks: LogicBlock[];
    edges: LogicEdge[];
    terminal: LogicTerminal;
    /** The group the OR settled on, mirroring `fully or matching[0]`. */
    matchedGroupIndex: number | null;
    width: number;
    height: number;
}

const BLOCK_H = 26;
const INPUT_W = 172;
const GATE_W = 172;
const OP_W = 58;
const TERM_W = 150;
const V_GAP = 8;
const GROUP_GAP = 20;
const PAD_TOP = 14;

const COL_INPUT_X = 8;
const COL_AND_X = 200;
const COL_OR_X = 288;
const COL_SIDE_X = 288;
const COL_FINAL_X = 490;
const COL_TERM_X = 578;
const DIAGRAM_W = COL_TERM_X + TERM_W + 8;

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
 * Build the diagram for one slot of one optimizer.
 *
 * The shape mirrors how eligibility is actually decided: conditions AND within
 * a group, groups OR against each other, and the winner is then ANDed with the
 * group's custom conditions and with the gates that are not conditions at all
 * (window, capacity, the writer's veto).
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

    const orId = "or";
    const orValue = orState(groupAndStates);
    const orY = andCenters.length === 0
        ? PAD_TOP
        : Math.round((Math.min(...andCenters) + Math.max(...andCenters)) / 2 - BLOCK_H / 2);
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

    // The group the OR settled on: the *first* satisfied one, never "all that
    // passed". `build_eligibility` stops there and so does this.
    const matchedPos = groupAndStates.findIndex((state) => state === "true");
    const matchedGroupIndex = matchedPos < 0 ? null : cell.groups[matchedPos].index;

    // ---- the side inputs of the final AND ------------------------------
    let sideY = Math.max(cursorY, orY + BLOCK_H + GROUP_GAP);
    const finalInputIds: string[] = [orId];
    const finalInputStates: LogicState[] = [orValue];

    const custom = customState(matchedPos < 0 ? undefined : cell.groups[matchedPos]);
    if (custom !== "n/a") {
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
    }

    cell.gates.forEach((gate, gatePos) => {
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

    // ---- the terminal --------------------------------------------------
    const blockedGate = cell.gates.find((gate) => gate.key === BLOCKED_USER_OWNED_GATE);
    const terminal: LogicTerminal =
        blockedGate !== undefined && blockedGate.state === "false"
            ? "blocked"
            : cell.verdict === "execute"
                ? "execute"
                : cell.verdict === "candidate"
                    ? "candidate"
                    : "not_eligible";

    const finalY = Math.round(
        (orY + Math.max(orY + BLOCK_H, sideY - V_GAP)) / 2 - BLOCK_H / 2,
    );
    blocks.push({
        id: "final",
        kind: "final",
        key: "",
        state: terminal === "execute" ? "true" : "false",
        decisive: true,
        groupIndex: null,
        actual: null,
        x: COL_FINAL_X,
        y: finalY,
        width: OP_W,
        height: BLOCK_H,
    });
    edges.push({ from: orId, to: "final", decisive: false });
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

    if (byId.get(orId)?.decisive === true) {
        if (orValue === "true") {
            // Only the first satisfied group. The rest were never reached.
            if (matchedPos >= 0) mark(groupAndIds[matchedPos]);
        } else {
            for (const andId of groupAndIds) mark(andId);
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
        terminal,
        matchedGroupIndex,
        width: DIAGRAM_W,
        height,
    };
}

/**
 * Level 3: the logic that produced one slot, drawn as PLC-style blocks.
 *
 * Two layers are shown at once and must not be confused. **State** is what each
 * block evaluated to. **Decisiveness** is whether it changed the outcome — a
 * condition can pass and still be beside the point, because a sibling group had
 * already lost or a gate had already vetoed. The decisive subgraph draws at
 * full opacity with thick solid edges; everything else drops to ~35% with thin
 * dashed ones. Dimmed, never hidden: removing the branches that did not matter
 * would leave the reader unable to tell "checked and irrelevant" from "never
 * checked", which is the distinction the whole record exists to keep.
 *
 * There are **four** terminals, not two. `execute` and `not eligible` are the
 * obvious pair; `candidate` (a group's system mask matched but its custom
 * conditions did not, so the action is displayed and never run) and `blocked`
 * (every condition passed and the writer refused because the user owns the
 * slot) are outcomes a two-state diagram would misfile as one of the others.
 *
 * Never colour alone: every block carries a ✓ / ✗ / ? / – glyph, and the edges
 * carry the same information again as solid-vs-dashed.
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
                gap: 6px;
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
                opacity: 0.35;
            }

            g.block[data-decisive="true"],
            path.edge[data-decisive="true"] {
                opacity: 1;
            }

            path.edge {
                fill: none;
                stroke: var(--helman-neutral, #888);
                stroke-width: 1;
                stroke-dasharray: 3 3;
            }

            path.edge[data-decisive="true"] {
                stroke: var(--primary-text-color);
                stroke-width: 2.5;
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

            g.block[data-focus="true"] rect.body {
                stroke-width: 2.5;
                stroke: var(--helman-selection, var(--primary-color));
            }

            text {
                font-size: 11px;
                fill: var(--primary-text-color);
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

            .legend {
                display: flex;
                flex-wrap: wrap;
                gap: 4px 12px;
                color: var(--secondary-text-color);
                font-size: 0.68rem;
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
                        ${model.edges.map((edge) => this._renderEdge(model, edge))}
                        ${model.blocks.map((block) => this._renderBlock(block))}
                    </svg>
                </div>
                <div class="legend">
                    <span>${this._text("diagram.legend_decisive")}</span>
                    <span>${this._text("diagram.legend_dimmed")}</span>
                </div>
            </div>
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
        const mid = x1 + Math.max(8, (x2 - x1) / 2);
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

    private _renderBlock(block: LogicBlock) {
        const focus = block.kind === "input"
            && block.key === this.focusConditionKey
            && (this.focusGroupIndex === null || block.groupIndex === this.focusGroupIndex);
        const isOperator = block.kind === "and" || block.kind === "or" || block.kind === "final";
        const actual = block.actual === null || block.actual === undefined
            ? null
            : formatLogicValue(block.actual);

        return svg`
            <g
                class="block"
                data-id=${block.id}
                data-kind=${block.kind}
                data-key=${block.key}
                data-state=${block.state}
                data-decisive=${block.decisive ? "true" : "false"}
                data-focus=${focus ? "true" : "false"}
                data-group=${block.groupIndex ?? nothing}
            >
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
                    <text x=${block.x + 24} y=${block.y + block.height / 2 + 4}>
                        ${this._blockLabel(block)}
                    </text>
                    ${actual === null ? nothing : svg`
                        <text
                            class="actual"
                            x=${block.x + block.width - 6}
                            y=${block.y + block.height / 2 + 4}
                            text-anchor="end"
                        >${actual}</text>
                    `}
                `}
            </g>
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
            default:
                return this._labelled("condition", block.key);
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

function formatLogicValue(value: unknown): string {
    if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : value.toFixed(2);
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
