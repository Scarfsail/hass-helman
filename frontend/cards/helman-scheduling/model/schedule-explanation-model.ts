/**
 * The per-slot condition record, as a grid.
 *
 * The backend serves one lane on one date: a single ascending `slotIds` array
 * (the row axis) and one entry per optimizer that touched the lane, already in
 * pipeline order. This module turns that into the level-1 grid the explanation
 * dialog draws -- rows = slots, one column per optimizer, plus a Result column
 * -- and keeps everything level 2 needs (groups, condition nodes, gates, the
 * union condition-column set) hanging off the same cells, so the drill-down is
 * a lookup rather than a second parse.
 *
 * Three encodings have to be undone, and conflating any two of them loses the
 * distinction the record exists to make:
 *
 * - **Run-length encoding.** Every per-slot column arrives as `[[value, count],
 *   ...]`, index-aligned to `slotIds`.
 * - **Sparse maps.** `actual` and `winningOptimizer` arrive as `{rowIndex:
 *   value}` and are present only where they mean something -- a passing node
 *   carries no `actual` at all.
 * - **`null` is structural.** `null` in a per-slot column means *this element
 *   does not exist in that slot*: an absent group, an optimizer that never
 *   looked at the slot. It is not `"not_evaluated"` (the node exists and was
 *   deliberately not consulted) and neither of them is `"false"`. All three
 *   reach the UI as distinct outcomes.
 *
 * **Winner attribution is not the verdict.** `ScheduleWriter.set_inverter` is
 * last-writer-wins among optimizers, so an optimizer can decide `execute`,
 * write, and still lose the slot to a later step. `winningOptimizer` names who
 * actually landed the write; a verdict of `execute` on its own never implies
 * the schedule shows it, and an execute that is not the winner is reported as
 * `overwritten`.
 */

export type ExplanationNodeState =
    | "true"
    | "false"
    | "not_evaluated"
    | "not_applicable";

export type ExplanationNodeScope = "slot" | "day" | "window" | "run";

export type ExplanationVerdict = "execute" | "candidate" | "skip";

export type ExplanationStatus = "ok" | "skipped" | "failed";

export type ExplanationParamsSource =
    | "slot_matched"
    | "day_resolved"
    | "master_fallback";

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
    /** What the slot presented. Recorded only for nodes that did not pass. */
    actual: unknown;
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
    targetKey: string;
    status: ExplanationStatus;
    statusReason: string | null;
    /** True for `skipped`/`failed`: the whole column is greyed. */
    inactive: boolean;
    /**
     * Top-level condition keys this optimizer ever evaluated, in
     * first-appearance order. Level 2's column set for this optimizer.
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
    targetKey: string;
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

const NODE_STATES = new Set<string>([
    "true",
    "false",
    "not_evaluated",
    "not_applicable",
]);
const NODE_SCOPES = new Set<string>(["slot", "day", "window", "run"]);
const VERDICTS = new Set<string>(["execute", "candidate", "skip"]);
const STATUSES = new Set<string>(["ok", "skipped", "failed"]);
const PARAMS_SOURCES = new Set<string>([
    "slot_matched",
    "day_resolved",
    "master_fallback",
]);

/** The writer-level veto: conditions all passed and the user owns the slot. */
export const BLOCKED_USER_OWNED_GATE = "blocked_user_owned";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Expand `[[value, count], ...]` into a `length`-long, index-aligned array.
 *
 * Missing tail entries are `null`, which is the encoding's own meaning for
 * "absent in that slot" -- so a short column and an explicitly-null run read
 * the same, deliberately.
 */
export function decodeExplanationRuns<T>(runs: unknown, length: number): (T | null)[] {
    const values: (T | null)[] = [];
    if (Array.isArray(runs)) {
        for (const run of runs) {
            if (!Array.isArray(run) || run.length !== 2) {
                continue;
            }
            const [value, count] = run as [T, unknown];
            if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
                continue;
            }
            for (let index = 0; index < count; index += 1) {
                values.push(value ?? null);
            }
        }
    }
    if (values.length > length) {
        values.length = length;
        return values;
    }
    while (values.length < length) {
        values.push(null);
    }
    return values;
}

/** Expand `{rowIndex: value}` into a `length`-long, index-aligned array. */
export function decodeExplanationSparse<T>(mapping: unknown, length: number): (T | null)[] {
    const values: (T | null)[] = new Array(length).fill(null);
    if (isRecord(mapping)) {
        for (const [key, value] of Object.entries(mapping)) {
            const index = Number.parseInt(key, 10);
            if (Number.isInteger(index) && index >= 0 && index < length) {
                values[index] = (value ?? null) as T | null;
            }
        }
    }
    return values;
}

function decodeNodeColumns(
    columns: unknown,
    length: number,
): ExplanationConditionNode[][] {
    const perSlot: ExplanationConditionNode[][] = Array.from(
        { length },
        () => [],
    );
    if (!Array.isArray(columns)) {
        return perSlot;
    }

    for (const column of columns) {
        if (!isRecord(column)) {
            continue;
        }
        const states = decodeExplanationRuns<string>(column.state, length);
        const values = decodeExplanationRuns<unknown>(column.value, length);
        const actuals = decodeExplanationSparse<unknown>(column.actual, length);
        const key = typeof column.key === "string" ? column.key : "";
        const rawScope = typeof column.scope === "string" ? column.scope : "slot";
        const scope = (NODE_SCOPES.has(rawScope) ? rawScope : "slot") as ExplanationNodeScope;

        for (let index = 0; index < length; index += 1) {
            const state = states[index];
            // null here means the node does not exist in this slot at all --
            // structurally different from `not_evaluated`, so it produces no
            // node rather than a node in some "unknown" state.
            if (state === null || !NODE_STATES.has(state)) {
                continue;
            }
            perSlot[index].push({
                key,
                scope,
                state: state as ExplanationNodeState,
                value: values[index],
                actual: actuals[index],
            });
        }
    }
    return perSlot;
}

function decodeGateColumns(columns: unknown, length: number): ExplanationGate[][] {
    const perSlot: ExplanationGate[][] = Array.from({ length }, () => []);
    if (!Array.isArray(columns)) {
        return perSlot;
    }

    for (const column of columns) {
        if (!isRecord(column)) {
            continue;
        }
        const states = decodeExplanationRuns<string>(column.state, length);
        const params = decodeExplanationRuns<Record<string, unknown>>(column.params, length);
        const key = typeof column.key === "string" ? column.key : "";
        for (let index = 0; index < length; index += 1) {
            const state = states[index];
            // A gate is emitted only for the slots that reached it: an
            // unreached gate is absent, never `false`.
            if (state === null || !NODE_STATES.has(state)) {
                continue;
            }
            perSlot[index].push({
                key,
                state: state as ExplanationNodeState,
                params: isRecord(params[index]) ? { ...params[index] } : {},
            });
        }
    }
    return perSlot;
}

function decodeGroupColumns(columns: unknown, length: number): ExplanationGroup[][] {
    const perSlot: ExplanationGroup[][] = Array.from({ length }, () => []);
    if (!Array.isArray(columns)) {
        return perSlot;
    }

    for (const column of columns) {
        if (!isRecord(column)) {
            continue;
        }
        // `paramsSource` is the presence column: null == this group does not
        // exist for that slot.
        const sources = decodeExplanationRuns<string>(column.paramsSource, length);
        const params = decodeExplanationRuns<Record<string, unknown>>(column.params, length);
        const custom = decodeExplanationRuns<unknown[]>(column.customResults, length);
        const conditions = decodeNodeColumns(column.conditions, length);
        const index = typeof column.index === "number" ? column.index : 0;
        const label = typeof column.label === "string" ? column.label : "";

        for (let row = 0; row < length; row += 1) {
            const source = sources[row];
            if (source === null) {
                continue;
            }
            const customResults = Array.isArray(custom[row])
                ? (custom[row] as unknown[]).map((entry) =>
                    typeof entry === "boolean" ? entry : null)
                : [];
            perSlot[row].push({
                index,
                label,
                params: isRecord(params[row]) ? { ...params[row] } : {},
                paramsSource: (PARAMS_SOURCES.has(source)
                    ? source
                    : "slot_matched") as ExplanationParamsSource,
                customResults,
                conditions: conditions[row],
            });
        }
    }
    return perSlot;
}

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

function collectConditionKeys(cells: readonly ExplanationCell[]): string[] {
    const keys: string[] = [];
    for (const cell of cells) {
        for (const group of cell.groups) {
            for (const node of group.conditions) {
                if (!keys.includes(node.key)) {
                    keys.push(node.key);
                }
            }
        }
    }
    return keys;
}

function parseColumn(
    payload: Record<string, unknown>,
    slotIds: readonly string[],
): ExplanationColumn {
    const length = slotIds.length;
    const optimizerId = typeof payload.optimizerId === "string" ? payload.optimizerId : "";
    const rawStatus = typeof payload.status === "string" ? payload.status : "ok";
    const status = (STATUSES.has(rawStatus) ? rawStatus : "ok") as ExplanationStatus;
    const verdicts = decodeExplanationRuns<string>(payload.verdict, length);
    const runAts = decodeExplanationRuns<string>(payload.runAt, length);
    const winners = decodeExplanationSparse<string>(payload.winningOptimizer, length);
    const groups = decodeGroupColumns(payload.groups, length);
    const gates = decodeGateColumns(payload.gates, length);
    const inactive = status !== "ok";

    const cells: ExplanationCell[] = slotIds.map((slotId, rowIndex) => {
        const verdict = verdicts[rowIndex];
        // `verdict` is the presence column: null == this optimizer said
        // nothing about the slot.
        const base = {
            optimizerId,
            slotId,
            rowIndex,
            present: verdict !== null,
            verdict: (verdict !== null && VERDICTS.has(verdict)
                ? verdict
                : null) as ExplanationVerdict | null,
            runAt: runAts[rowIndex],
            winningOptimizer: winners[rowIndex],
            groups: groups[rowIndex],
            gates: gates[rowIndex],
        };
        return {
            ...base,
            outcome: resolveOutcome(base, inactive),
            ...resolveDecisive(base.groups, base.gates),
        };
    });

    return {
        optimizerId,
        kind: typeof payload.kind === "string" ? payload.kind : "",
        targetKey: typeof payload.targetKey === "string" ? payload.targetKey : "",
        status,
        statusReason: typeof payload.statusReason === "string" ? payload.statusReason : null,
        inactive,
        conditionKeys: collectConditionKeys(cells),
        cells,
    };
}

/**
 * Parse one `helman/get_schedule_explanation` payload.
 *
 * Returns `null` for the backend's own `null` (nothing recorded for this lane
 * and date) and for anything that is not a payload at all -- the dialog treats
 * both as "no record", which is the truth in either case.
 */
export function parseScheduleExplanation(payload: unknown): ScheduleExplanationModel | null {
    if (!isRecord(payload)) {
        return null;
    }
    const slotIds = Array.isArray(payload.slotIds)
        ? payload.slotIds.filter((slotId): slotId is string => typeof slotId === "string")
        : [];

    // Pipeline order is the payload's order. Re-sorting would break winner
    // attribution, which is last-writer-wins *in that order*.
    const columns = (Array.isArray(payload.optimizers) ? payload.optimizers : [])
        .filter(isRecord)
        .map((entry) => parseColumn(entry, slotIds));

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
        targetKey: typeof payload.targetKey === "string" ? payload.targetKey : "",
        date: typeof payload.date === "string" ? payload.date : "",
        runAt: typeof payload.runAt === "string" ? payload.runAt : null,
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

/**
 * One condition node of a cell by key, across its groups.
 *
 * Nodes are flat: the backend emits one per configured condition and nothing
 * below it, so the first group carrying the key owns the answer.
 */
export function findExplanationNode(
    cell: ExplanationCell,
    key: string,
): ExplanationConditionNode | null {
    for (const group of cell.groups) {
        const node = group.conditions.find((candidate) => candidate.key === key);
        if (node !== undefined) {
            return node;
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
