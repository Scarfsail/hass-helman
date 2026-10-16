/**
 * The per-slot condition record, as a grid.
 *
 * The backend serves one lane on one date: a single ascending `slotIds` array
 * (the row axis) and one entry per optimizer that touched the lane, already in
 * traced-phase order. This module turns that into the level-1 grid the explanation
 * dialog draws -- rows = slots, one column per optimizer, plus a Result column
 * -- and keeps everything level 2 needs (groups, condition nodes, gates, the
 * union condition-column set) hanging off the same cells, so the drill-down is
 * a lookup rather than a second parse.
 *
 * The payload is plain rows: one per slot an optimizer explained, so a slot
 * with no row is one the optimizer never looked at. That absence is
 * structural: it is not `"not_evaluated"` (the node exists and was
 * deliberately not consulted) and neither of them is `"false"`. All three
 * reach the UI as distinct outcomes.
 *
 * What the backend already knows is read, never re-derived: which group the
 * slot matched (`matchedGroupIndex`), and per condition column whether it gates
 * the slot rather than its group (`selfGating`) and how its test compares
 * (`operator`).
 *
 * **Winner attribution is not the verdict.** `ScheduleWriter.set_inverter` is
 * last-writer-wins among optimizers, so an optimizer can decide `execute`,
 * write, and still lose the slot to a later step. `winningOptimizer` names who
 * actually landed the write; a verdict of `execute` on its own never implies
 * the schedule shows it, and an execute that is not the winner is reported as
 * `overwritten`.
 */

import type {
    ExplanationConditionRow,
    ExplanationNodeScope,
    ExplanationNodeState,
    ExplanationOptimizerRows,
    ExplanationParamsSource,
    ExplanationPhase,
    ExplanationStatus,
    ExplanationVerdict,
    ScheduleExplanationPayload,
} from "../../data/helman-commands";

/**
 * What a level-1 cell says. Ordered from "this slot ran because of me" down to
 * "I was never here".
 */
export type ExplanationCellOutcome =
    /** Decided `execute` and kept the slot: this is what the schedule shows. */
    | "wrote"
    /** Decided `execute`, wrote, and a later optimizer overwrote it. */
    | "overwritten"
    /** Placed but `condition_met` is false: displayed, never executed. */
    | "candidate"
    /** Conditions or gates rejected the slot. */
    | "not_eligible"
    /** Conditions passed and the writer vetoed: the user owns the slot. */
    | "blocked"
    /** The optimizer said nothing about this slot. */
    | "absent"
    /** The whole step was skipped or failed; no slot of it means anything. */
    | "step_skipped";

export interface ExplanationConditionNode {
    key: string;
    scope: ExplanationNodeScope;
    state: ExplanationNodeState;
    /** What the condition was configured with (the threshold). */
    value: unknown;
    /** What the slot presented, passing or failing; null where nothing is measured. */
    actual: unknown;
    /** Gates the slot, not its group: group matching never reads it. */
    selfGating: boolean;
    /** How the test compares `actual` with `value`; null where it does not compare. */
    operator: string | null;
}

export interface ExplanationGate {
    key: string;
    state: ExplanationNodeState;
    /**
     * Whatever the gate needs to explain itself, including ordinals such as
     * cheapness `rank`, which have no truth value.
     */
    params: Record<string, unknown>;
}

export interface ExplanationGroup {
    index: number;
    label: string;
    params: Record<string, unknown>;
    /**
     * Which resolution path produced `params`. `day_resolved` can pick a
     * different group than the slot matched, so the numbers are only readable
     * next to this marker.
     */
    paramsSource: ExplanationParamsSource;
    /** One entry per configured custom condition; `null` where it errored. */
    customResults: (boolean | null)[];
    conditions: ExplanationConditionNode[];
}

/** One optimizer's account of one slot. */
export interface ExplanationCell {
    optimizerId: string;
    slotId: string;
    rowIndex: number;
    /** False when the optimizer said nothing at all about this slot. */
    present: boolean;
    verdict: ExplanationVerdict | null;
    /** The run that produced this row. Rows do not all come from one run. */
    runAt: string | null;
    /** Who landed the write on this slot, per this optimizer's record. */
    winningOptimizer: string | null;
    /**
     * The group the backend matched for this slot, or null where none covers
     * it. The slot match only: a day-resolved kind may run under another
     * group's params (see `paramsSource`).
     */
    matchedGroupIndex: number | null;
    groups: ExplanationGroup[];
    gates: ExplanationGate[];
    outcome: ExplanationCellOutcome;
    /**
     * The node that decided a `not_eligible` cell: a `false` node if there is
     * one, otherwise a `not_evaluated` one. Null when nothing named itself.
     */
    decisiveKey: string | null;
    decisiveState: ExplanationNodeState | null;
    decisiveScope: ExplanationNodeScope | null;
}

export interface ExplanationColumn {
    optimizerId: string;
    kind: string;
    /** Runtime phase carried by the payload; never inferred from kind or lane. */
    phase: ExplanationPhase;
    /** The lane this optimizer writes: the controllable's own id. */
    controllableId: string;
    status: ExplanationStatus;
    statusReason: string | null;
    /** True for `skipped`/`failed`: the whole column is greyed. */
    inactive: boolean;
    /**
     * Condition keys this optimizer ever evaluated, in first-appearance
     * order, as the backend lists them.
     */
    conditionKeys: string[];
    /** Index-aligned to `rows`. */
    cells: ExplanationCell[];
}

export interface ExplanationRow {
    slotId: string;
    index: number;
    /** Slot start, or NaN for an unparsable id. */
    startMs: number;
    /** Who landed the write on this slot, across every optimizer. */
    winnerOptimizerId: string | null;
    /** The winner's kind, when the winner is one of this lane's columns. */
    winnerKind: string | null;
    /** The newest run that produced any cell of this row. */
    runAt: string | null;
}

export interface ScheduleExplanationModel {
    /** The lane this record is about: the controllable's own id. */
    controllableId: string;
    date: string;
    /** The newest run touching this lane and date. */
    runAt: string | null;
    rows: ExplanationRow[];
    columns: ExplanationColumn[];
    /**
     * The union of every top-level condition key across every group of every
     * optimizer, in first-appearance order. Groups may configure different
     * condition sets, so a cell for a condition its group does not configure is
     * *not applicable*, never `true`.
     */
    conditionKeys: string[];
}

/** The writer-level veto: conditions all passed and the user owns the slot. */
export const BLOCKED_USER_OWNED_GATE = "blocked_user_owned";

/**
 * The node that decided a rejected slot.
 *
 * A `false` node always wins over a `not_evaluated` one: the false node is why
 * the slot was rejected, whereas an unevaluated one is a consequence of the
 * rejection (the optimizer stopped consulting it).
 */
function findDecisiveNode(
    nodes: readonly ExplanationConditionNode[],
    state: ExplanationNodeState,
): ExplanationConditionNode | null {
    return nodes.find((node) => node.state === state) ?? null;
}

function resolveDecisive(
    groups: readonly ExplanationGroup[],
    gates: readonly ExplanationGate[],
): Pick<ExplanationCell, "decisiveKey" | "decisiveState" | "decisiveScope"> {
    for (const state of ["false", "not_evaluated"] as const) {
        for (const group of groups) {
            const node = findDecisiveNode(group.conditions, state);
            if (node !== null) {
                return {
                    decisiveKey: node.key,
                    decisiveState: node.state,
                    decisiveScope: node.scope,
                };
            }
        }
        const gate = gates.find((entry) => entry.state === state);
        if (gate !== undefined) {
            return {
                decisiveKey: gate.key,
                decisiveState: gate.state,
                decisiveScope: "slot",
            };
        }
    }
    return { decisiveKey: null, decisiveState: null, decisiveScope: null };
}

function resolveOutcome(
    cell: Omit<ExplanationCell, "outcome" | "decisiveKey" | "decisiveState" | "decisiveScope">,
    inactive: boolean,
): ExplanationCellOutcome {
    if (inactive) {
        return "step_skipped";
    }
    if (!cell.present) {
        return "absent";
    }
    const blocked = cell.gates.find((gate) => gate.key === BLOCKED_USER_OWNED_GATE);
    if (blocked !== undefined && blocked.state === "false") {
        return "blocked";
    }
    if (cell.verdict === "execute") {
        // Deciding `execute` is not landing the write: a later optimizer in
        // pipeline order overwrites without asking.
        return cell.winningOptimizer !== null
            && cell.winningOptimizer !== cell.optimizerId
            ? "overwritten"
            : "wrote";
    }
    if (cell.verdict === "candidate") {
        return "candidate";
    }
    return "not_eligible";
}

function parseColumn(
    payload: ExplanationOptimizerRows,
    slotIds: readonly string[],
): ExplanationColumn {
    const { optimizerId, status } = payload;
    const inactive = status !== "ok";
    const columns = new Map(payload.conditions.map((column) => [column.key, column]));
    const parseNode = (node: ExplanationConditionRow): ExplanationConditionNode => ({
        key: node.key,
        scope: node.scope,
        state: node.state,
        value: node.value ?? null,
        actual: node.actual ?? null,
        selfGating: columns.get(node.key)?.selfGating === true,
        operator: columns.get(node.key)?.operator ?? null,
    });
    const rows = new Map(payload.slots.map((row) => [row.slotId, row]));

    const cells: ExplanationCell[] = slotIds.map((slotId, rowIndex) => {
        // No row == this optimizer said nothing about the slot.
        const row = rows.get(slotId);
        const base = {
            optimizerId,
            slotId,
            rowIndex,
            present: row !== undefined,
            verdict: row?.verdict ?? null,
            runAt: row?.runAt ?? null,
            winningOptimizer: row?.winningOptimizer ?? null,
            matchedGroupIndex: row?.matchedGroupIndex ?? null,
            groups: (row?.groups ?? []).map((group) => ({
                ...group,
                conditions: group.conditions.map(parseNode),
            })),
            gates: row?.gates ?? [],
        };
        return {
            ...base,
            outcome: resolveOutcome(base, inactive),
            ...resolveDecisive(base.groups, base.gates),
        };
    });

    return {
        optimizerId,
        kind: payload.kind,
        phase: payload.phase,
        controllableId: payload.controllableId ?? "",
        status,
        statusReason: payload.statusReason ?? null,
        inactive,
        conditionKeys: payload.conditions.map((column) => column.key),
        cells,
    };
}

/**
 * Parse one `helman/get_schedule_explanation` payload.
 *
 * Returns `null` for the backend's own `null`: nothing recorded for this lane
 * and date, which the dialog treats as "no record".
 */
export function parseScheduleExplanation(
    payload: ScheduleExplanationPayload | null,
): ScheduleExplanationModel | null {
    if (payload === null) {
        return null;
    }
    const { slotIds } = payload;

    // Traced-phase order is the payload's order. Re-sorting would break winner
    // attribution, which is last-writer-wins within that order.
    const columns = payload.optimizers.map((entry) => parseColumn(entry, slotIds));

    const rows: ExplanationRow[] = slotIds.map((slotId, index) => {
        let winnerOptimizerId: string | null = null;
        let runAt: string | null = null;
        for (const column of columns) {
            const cell = column.cells[index];
            if (cell === undefined) {
                continue;
            }
            if (winnerOptimizerId === null && cell.winningOptimizer !== null) {
                winnerOptimizerId = cell.winningOptimizer;
            }
            if (cell.runAt !== null && (runAt === null || cell.runAt > runAt)) {
                runAt = cell.runAt;
            }
        }
        const winnerColumn = winnerOptimizerId === null
            ? undefined
            : columns.find((column) => column.optimizerId === winnerOptimizerId);
        return {
            slotId,
            index,
            startMs: Date.parse(slotId),
            winnerOptimizerId,
            winnerKind: winnerColumn?.kind ?? null,
            runAt,
        };
    });

    const conditionKeys: string[] = [];
    for (const column of columns) {
        for (const key of column.conditionKeys) {
            if (!conditionKeys.includes(key)) {
                conditionKeys.push(key);
            }
        }
    }

    return {
        controllableId: payload.controllableId,
        date: payload.date,
        runAt: payload.runAt,
        rows,
        columns,
        conditionKeys,
    };
}

/**
 * The cell that accounts for what the schedule actually shows in one slot.
 *
 * Writing is last-writer-wins, so the account that matches the schedule is the
 * *winner's*, not the first column that decided `execute`. Where nothing landed
 * (no winner recorded) the first cell that placed anything is the next best
 * answer -- a candidate placement is still what put the action on screen.
 */
export function getWinningExplanationCell(
    model: ScheduleExplanationModel,
    slotId: string,
): ExplanationCell | null {
    const row = model.rows.find((entry) => entry.slotId === slotId);
    if (row === undefined) {
        return null;
    }
    if (row.winnerOptimizerId !== null) {
        const cell = getExplanationCell(model, row.winnerOptimizerId, row.index);
        if (cell !== null) {
            return cell;
        }
    }
    // Nothing landed. A candidate placement is still what put an action on
    // screen, so it answers before anything else; failing that, the last
    // optimizer in pipeline order that had any opinion at all is the closest
    // thing to an account of the slot -- including "nobody would take it".
    for (const column of model.columns) {
        const cell = column.cells[row.index];
        if (cell !== undefined && cell.outcome === "candidate") {
            return cell;
        }
    }
    for (let index = model.columns.length - 1; index >= 0; index -= 1) {
        const cell = model.columns[index].cells[row.index];
        if (cell !== undefined && cell.present) {
            return cell;
        }
    }
    return null;
}

/** The cell at one row of one column, or null when the grid has no such cell. */
export function getExplanationCell(
    model: ScheduleExplanationModel,
    optimizerId: string,
    rowIndex: number,
): ExplanationCell | null {
    const column = model.columns.find((entry) => entry.optimizerId === optimizerId);
    return column?.cells[rowIndex] ?? null;
}
