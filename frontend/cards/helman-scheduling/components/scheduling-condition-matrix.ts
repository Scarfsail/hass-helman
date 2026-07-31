import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import type {
    ExplanationCell,
    ExplanationConditionNode,
    ExplanationGroup,
    ExplanationNodeState,
} from "../model/schedule-explanation-model";

const KEY_PREFIX = "scheduling.explanation";

/** The column that holds the group's per-entry custom conditions. */
const CUSTOM_COLUMN_KEY = "custom";

/** Which cell of the matrix was pressed: the seam Phase C's diagram opens on. */
export interface ConditionMatrixNodeSelectDetail {
    optimizerId: string;
    slotId: string;
    rowIndex: number;
    groupIndex: number;
    /** The top-level condition, or `"custom"` for the custom-condition column. */
    conditionKey: string;
    /** The sub-column, when the press landed on an expanded one. */
    subKey: string | null;
}

interface MatrixColumn {
    kind: "condition" | "custom";
    key: string;
    /** Inner condition keys, or custom entry indices as strings. */
    subKeys: string[];
}

/** A param value as one short string; objects and lists stay JSON. */
function formatValue(value: unknown): string {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    if (typeof value === "boolean" || typeof value === "string") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * One optimizer's account of one slot: the resolved params it would have run
 * under, and every condition it consulted -- or deliberately did not.
 *
 * Level 2 of the drill. The table is groups down, conditions across, because
 * the question at this level is "which group would have taken this slot, and
 * what stopped it" -- and groups may configure *different* condition sets, so
 * the columns are the union across groups and a group that does not configure a
 * column reports `not_applicable` there, never an unearned `true`.
 *
 * Four node states, four marks, never colour alone:
 *
 * - `true` **✓** -- evaluated and passed.
 * - `false` **✗** -- evaluated and failed. The failing node carries its
 *   `actual`, which passing nodes do not have.
 * - `not_evaluated` **?** -- the node exists and was deliberately never
 *   consulted. Capped `appliance_runtime` produces this for every slot below
 *   its cut, and calling that "false" would invent a rejection that never
 *   happened.
 * - `not_applicable` **–** -- the group does not configure this condition.
 *
 * A node the slot has no entry for at all is a fifth thing again: it renders
 * blank, with no state to read.
 *
 * **Scope.** A node is not always about this slot. `reserve_floor_soc` is
 * window-scoped by construction -- it tests the expensive band while the write
 * lands in the preceding cheap one -- so every non-slot node is badged with its
 * scope, and where its one result is shared across the groups it renders as a
 * single spanning cell instead of N identical checkmarks.
 *
 * **Custom conditions are tri-state.** `true` / `false` / errored. Fail-closed
 * evaluation gives the group `met=false` either way, so the tri-state is the
 * only thing that separates "your template said no" from "your template threw",
 * and they get different marks.
 */
@customElement("scheduling-condition-matrix")
export class SchedulingConditionMatrix extends LitElement {
    static styles = css`
        :host {
            display: block;
        }

        .matrix {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 10px 12px;
            border: 1px solid var(--divider-color);
            border-radius: 10px;
            background: var(--secondary-background-color);
        }

        .matrix-head {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 4px 10px;
        }

        .matrix-title {
            font-weight: 600;
            font-size: 0.85rem;
        }

        .slot,
        .optimizer {
            color: var(--secondary-text-color);
            font-size: 0.78rem;
        }

        .verdict-badge {
            margin-inline-start: auto;
            padding: 1px 8px;
            border-radius: 999px;
            background: var(--card-background-color);
            font-size: 0.74rem;
            font-weight: 600;
        }

        .verdict-badge[data-verdict="execute"] {
            color: var(--success-color, #2e7d32);
        }

        .verdict-badge[data-verdict="candidate"] {
            color: var(--info-color, var(--primary-color));
        }

        .verdict-badge[data-verdict="skip"] {
            color: var(--error-color, #c62828);
        }

        .params {
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 0.74rem;
        }

        .params-row {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 4px 8px;
        }

        .params-group {
            font-weight: 600;
        }

        .param {
            color: var(--secondary-text-color);
        }

        .param b {
            font-weight: 600;
            color: var(--primary-text-color);
        }

        /* The params marker is the point of the params row: day-resolved
           params can come from a different group than the slot matched, so
           without it the numbers silently look like the slot's own. */
        .params-source {
            padding: 0 6px;
            border-radius: 999px;
            border: 1px solid var(--divider-color);
            background: var(--card-background-color);
            font-size: 0.68rem;
        }

        .params-source[data-source="day_resolved"],
        .params-source[data-source="master_fallback"] {
            color: var(--warning-color, #ef6c00);
            border-color: currentColor;
        }

        .table-scroll {
            overflow-x: auto;
        }

        table.nodes {
            border-collapse: separate;
            border-spacing: 0;
            font-size: 0.74rem;
        }

        table.nodes th,
        table.nodes td {
            padding: 3px 8px;
            text-align: start;
            vertical-align: top;
            white-space: nowrap;
            border-bottom: 1px solid var(--divider-color);
        }

        table.nodes thead th {
            font-weight: 600;
            background: var(--card-background-color);
        }

        th.sub-head {
            font-weight: 400;
            font-size: 0.68rem;
            color: var(--secondary-text-color);
        }

        .expander {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 0;
            border: none;
            background: none;
            color: inherit;
            font: inherit;
            cursor: pointer;
        }

        .expander .chevron {
            color: var(--secondary-text-color);
        }

        .node {
            display: inline-flex;
            align-items: baseline;
            gap: 4px;
            padding: 1px 4px;
            border: none;
            border-radius: 5px;
            background: none;
            color: inherit;
            font: inherit;
            text-align: start;
            cursor: pointer;
        }

        .node:hover {
            background: var(--card-background-color);
        }

        .glyph {
            font-variant-numeric: tabular-nums;
        }

        /* Glyph first, colour second: the four states are readable with no
           colour at all, which is the whole accessibility contract here. */
        td[data-state="true"] .glyph {
            color: var(--success-color, #2e7d32);
        }

        td[data-state="false"] .glyph {
            color: var(--error-color, #c62828);
        }

        td[data-state="not_evaluated"] {
            background: repeating-linear-gradient(
                135deg,
                transparent 0 4px,
                color-mix(in srgb, var(--secondary-text-color) 12%, transparent) 4px 8px
            );
        }

        td[data-state="not_evaluated"] .glyph {
            color: var(--secondary-text-color);
        }

        td[data-state="not_applicable"] {
            color: var(--disabled-text-color, var(--secondary-text-color));
            opacity: 0.6;
        }

        /* No node at all: nothing to read, and nothing that looks like a
           result. */
        td.node-absent {
            background: color-mix(in srgb, var(--secondary-text-color) 6%, transparent);
        }

        /* One result shared across the groups, drawn once. */
        td.spanning {
            vertical-align: middle;
            background: color-mix(in srgb, var(--primary-color) 6%, transparent);
        }

        .scope-badge {
            padding: 0 4px;
            border-radius: 4px;
            border: 1px solid var(--divider-color);
            color: var(--secondary-text-color);
            font-size: 0.62rem;
        }

        .actual {
            color: var(--secondary-text-color);
            font-size: 0.68rem;
        }

        /* An errored custom entry is not a failed one: fail-closed evaluation
           reports both as not met, and only this tells them apart. */
        .custom-entry[data-custom="errored"] {
            color: var(--warning-color, #ef6c00);
            font-weight: 600;
        }

        .gates {
            display: flex;
            flex-wrap: wrap;
            gap: 4px 10px;
            font-size: 0.72rem;
        }

        .gates .gate-label {
            font-weight: 600;
            width: 100%;
        }

        .gate {
            display: inline-flex;
            align-items: baseline;
            gap: 4px;
        }

        .gate .gate-params {
            color: var(--secondary-text-color);
            font-size: 0.68rem;
        }

        .empty {
            color: var(--secondary-text-color);
            font-size: 0.76rem;
        }
    `;

    @property({ attribute: false }) public localize!: LocalizeFunction;
    /** The one optimizer, one slot the user drilled into. */
    @property({ attribute: false }) public cell: ExplanationCell | null = null;
    /** The optimizer's union condition-column set, in first-appearance order. */
    @property({ attribute: false }) public conditionKeys: readonly string[] = [];
    @property({ type: String }) public optimizerKind = "";
    /** The slot's time, already formatted by the host that owns the locale. */
    @property({ type: String }) public slotLabel = "";

    /** Condition keys whose sub-columns are showing. */
    @state() private _expanded: string[] = [];

    render() {
        const cell = this.cell;
        if (cell === null || !cell.present) {
            return html`<div class="matrix"><div class="empty">${this._text("matrix.empty")}</div></div>`;
        }

        return html`
            <div class="matrix">
                <div class="matrix-head">
                    <span class="matrix-title">${this._text("matrix.title")}</span>
                    <span class="slot">${this.slotLabel || cell.slotId}</span>
                    <span class="optimizer">${this._labelled("optimizer", this.optimizerKind)}</span>
                    ${cell.verdict === null ? nothing : html`
                        <span class="verdict-badge" data-verdict=${cell.verdict}>
                            ${this._text(`verdict.${cell.verdict}`)}
                        </span>
                    `}
                </div>
                ${this._renderParams(cell.groups)}
                ${this._renderTable(cell)}
                ${this._renderGates(cell)}
            </div>
        `;
    }

    /**
     * The params the optimizer would have run under, each with the marker for
     * how they were resolved.
     *
     * `charge_hold` and capped `appliance_runtime` resolve through
     * `Eligibility.for_day()`, which can pick a different group than the slot
     * matched -- so params without their source are numbers that only look like
     * this slot's.
     */
    private _renderParams(groups: readonly ExplanationGroup[]) {
        if (groups.length === 0) {
            return nothing;
        }
        return html`
            <div class="params">
                ${groups.map((group) => html`
                    <div class="params-row" data-group=${group.index}>
                        <span class="params-group">${this._groupLabel(group)}</span>
                        <span
                            class="params-source"
                            data-source=${group.paramsSource}
                            title=${this._text(`params_source_detail.${group.paramsSource}`)}
                        >${this._text(`params_source.${group.paramsSource}`)}</span>
                        ${Object.entries(group.params).length === 0 ? html`
                            <span class="param none">${this._text("matrix.no_params")}</span>
                        ` : Object.entries(group.params).map(([key, value]) => html`
                            <span class="param" data-param=${key}>
                                ${this._labelled("param", key)}: <b>${formatValue(value)}</b>
                            </span>
                        `)}
                    </div>
                `)}
            </div>
        `;
    }

    private _renderTable(cell: ExplanationCell) {
        const columns = this._columns(cell.groups);
        if (columns.length === 0 || cell.groups.length === 0) {
            return html`<div class="empty">${this._text("matrix.no_conditions")}</div>`;
        }

        const spans = this._spanningKeys(cell.groups);
        return html`
            <div class="table-scroll">
                <table class="nodes">
                    <thead>
                        <tr>
                            <th class="group-head" rowspan="2">${this._text("matrix.group")}</th>
                            ${columns.map((column) => this._renderColumnHead(column))}
                        </tr>
                        <tr>
                            ${columns.map((column) => this._renderSubHeads(column))}
                        </tr>
                    </thead>
                    <tbody>
                        ${cell.groups.map((group, row) => html`
                            <tr data-group=${group.index}>
                                <th class="group-cell">${this._groupLabel(group)}</th>
                                ${columns.map((column) =>
                                    this._renderColumnCells(cell, group, column, row, spans))}
                            </tr>
                        `)}
                    </tbody>
                </table>
            </div>
        `;
    }

    private _renderColumnHead(column: MatrixColumn) {
        const expanded = this._expanded.includes(column.key);
        const span = expanded ? 1 + column.subKeys.length : 1;
        const label = column.kind === "custom"
            ? this._text("matrix.custom")
            : this._labelled("condition", column.key);
        return html`
            <th
                class="condition-head"
                data-condition=${column.key}
                data-expanded=${expanded ? "true" : "false"}
                colspan=${span}
            >
                ${column.subKeys.length === 0 ? label : html`
                    <button
                        class="expander"
                        type="button"
                        aria-expanded=${expanded ? "true" : "false"}
                        title=${this._text(expanded ? "matrix.collapse" : "matrix.expand")}
                        @click=${() => this._toggle(column.key)}
                    >
                        <span class="chevron">${expanded ? "▾" : "▸"}</span>
                        <span>${label}</span>
                    </button>
                `}
            </th>
        `;
    }

    private _renderSubHeads(column: MatrixColumn) {
        if (!this._expanded.includes(column.key) || column.subKeys.length === 0) {
            return html`<th class="sub-head spacer"></th>`;
        }
        return html`
            <th class="sub-head spacer"></th>
            ${column.subKeys.map((subKey) => html`
                <th class="sub-head" data-condition=${column.key} data-sub=${subKey}>
                    ${column.kind === "custom"
                        ? `${this._text("matrix.custom_entry")} ${Number(subKey) + 1}`
                        : this._labelled("condition", subKey)}
                </th>
            `)}
        `;
    }

    private _renderColumnCells(
        cell: ExplanationCell,
        group: ExplanationGroup,
        column: MatrixColumn,
        row: number,
        spans: ReadonlySet<string>,
    ) {
        const expanded = this._expanded.includes(column.key);
        if (column.kind === "custom") {
            return html`
                ${this._renderCustomSummary(cell, group, column)}
                ${expanded ? column.subKeys.map((subKey) =>
                    this._renderCustomEntry(cell, group, column, subKey)) : nothing}
            `;
        }

        // One result shared across every group: drawn once, spanning them,
        // rather than repeated as N identical checkmarks.
        if (spans.has(column.key)) {
            if (row > 0) {
                return nothing;
            }
            const node = group.conditions.find((entry) => entry.key === column.key)!;
            return html`
                ${this._renderNodeCell(cell, group, column.key, node, {
                    rowSpan: cell.groups.length,
                    spanning: true,
                })}
                ${expanded ? column.subKeys.map((subKey) => this._renderNodeCell(
                    cell,
                    group,
                    column.key,
                    node.children.find((child) => child.key === subKey) ?? null,
                    { rowSpan: cell.groups.length, spanning: true, subKey },
                )) : nothing}
            `;
        }

        const node = group.conditions.find((entry) => entry.key === column.key) ?? null;
        return html`
            ${this._renderNodeCell(cell, group, column.key, node, {})}
            ${expanded ? column.subKeys.map((subKey) => this._renderNodeCell(
                cell,
                group,
                column.key,
                node?.children.find((child) => child.key === subKey) ?? null,
                { subKey },
            )) : nothing}
        `;
    }

    private _renderNodeCell(
        cell: ExplanationCell,
        group: ExplanationGroup,
        conditionKey: string,
        node: ExplanationConditionNode | null,
        options: { rowSpan?: number; spanning?: boolean; subKey?: string },
    ) {
        const classes = [
            "node-cell",
            options.subKey === undefined ? "" : "sub-cell",
            options.spanning === true ? "spanning" : "",
            node === null ? "node-absent" : "",
        ].filter((entry) => entry.length > 0).join(" ");

        if (node === null) {
            // Absent is not a state: no glyph, nothing to press.
            return html`
                <td
                    class=${classes}
                    rowspan=${options.rowSpan ?? nothing}
                    data-condition=${conditionKey}
                    data-sub=${options.subKey ?? nothing}
                ></td>
            `;
        }

        return html`
            <td
                class=${classes}
                rowspan=${options.rowSpan ?? nothing}
                data-condition=${conditionKey}
                data-sub=${options.subKey ?? nothing}
                data-state=${node.state}
                data-scope=${node.scope}
            >
                <button
                    class="node"
                    type="button"
                    title=${this._nodeTitle(node)}
                    @click=${() => this._handleNodeClick(
                        cell,
                        group,
                        conditionKey,
                        options.subKey ?? null,
                    )}
                >
                    <span class="glyph">${this._stateGlyph(node.state)}</span>
                    ${node.scope === "slot" ? nothing : html`
                        <span class="scope-badge">${this._text(`scope.${node.scope}`)}</span>
                    `}
                    ${node.actual === null || node.actual === undefined ? nothing : html`
                        <span class="actual">${formatValue(node.actual)}</span>
                    `}
                </button>
            </td>
        `;
    }

    /**
     * The group's custom conditions, collapsed to one mark.
     *
     * An errored entry wins over a false one: fail-closed evaluation reports
     * both as `met=false`, and "your template threw" is the one a person has to
     * act on.
     */
    private _renderCustomSummary(
        cell: ExplanationCell,
        group: ExplanationGroup,
        column: MatrixColumn,
    ) {
        const results = group.customResults;
        if (results.length === 0) {
            return html`<td class="node-cell node-absent" data-condition=${column.key}></td>`;
        }
        const errored = results.some((entry) => entry === null);
        const failed = results.some((entry) => entry === false);
        const state: ExplanationNodeState = failed ? "false" : "true";
        return html`
            <td
                class="node-cell custom-cell"
                data-condition=${column.key}
                data-state=${errored ? "false" : state}
                data-custom=${errored ? "errored" : state}
            >
                <button
                    class="node custom-entry"
                    type="button"
                    data-custom=${errored ? "errored" : state}
                    title=${this._text(`custom_state.${errored ? "errored" : state}`)}
                    @click=${() => this._handleNodeClick(cell, group, column.key, null)}
                >
                    <span class="glyph">${errored ? "!" : this._stateGlyph(state)}</span>
                </button>
            </td>
        `;
    }

    private _renderCustomEntry(
        cell: ExplanationCell,
        group: ExplanationGroup,
        column: MatrixColumn,
        subKey: string,
    ) {
        const result = group.customResults[Number(subKey)];
        if (result === undefined) {
            return html`
                <td
                    class="node-cell sub-cell node-absent"
                    data-condition=${column.key}
                    data-sub=${subKey}
                ></td>
            `;
        }
        // Tri-state: `null` is an entry that *errored*, which fail-closed
        // evaluation would otherwise bury under the same `false` as a template
        // that plainly said no.
        const kind = result === null ? "errored" : result ? "true" : "false";
        return html`
            <td
                class="node-cell sub-cell custom-cell"
                data-condition=${column.key}
                data-sub=${subKey}
                data-state=${kind === "errored" ? "false" : kind}
                data-custom=${kind}
            >
                <button
                    class="node custom-entry"
                    type="button"
                    data-custom=${kind}
                    title=${this._text(`custom_state.${kind}`)}
                    @click=${() => this._handleNodeClick(cell, group, column.key, subKey)}
                >
                    <span class="glyph">${kind === "errored" ? "!" : this._stateGlyph(kind)}</span>
                </button>
            </td>
        `;
    }

    /**
     * The gates that are not conditions: window, deadline, capacity, the
     * writer's veto, and ordinals such as cheapness `rank`, which have no truth
     * value and are shown as the number they are.
     */
    private _renderGates(cell: ExplanationCell) {
        if (cell.gates.length === 0) {
            return nothing;
        }
        return html`
            <div class="gates">
                <span class="gate-label">${this._text("matrix.gates")}</span>
                ${cell.gates.map((gate) => html`
                    <span class="gate" data-gate=${gate.key} data-state=${gate.state}>
                        <span class="glyph">${this._stateGlyph(gate.state)}</span>
                        <span>${this._labelled("condition", gate.key)}</span>
                        ${Object.entries(gate.params).length === 0 ? nothing : html`
                            <span class="gate-params">
                                ${Object.entries(gate.params)
                                    .map(([key, value]) => `${this._labelled("param", key)}: ${formatValue(value)}`)
                                    .join(", ")}
                            </span>
                        `}
                    </span>
                `)}
            </div>
        `;
    }

    /**
     * The union column set for this slot: the optimizer's condition keys where
     * it has them, otherwise whatever the groups themselves carry, plus the
     * custom-condition column.
     *
     * Custom conditions are configured per *group* rather than under any one
     * condition, so they get a column of their own that expands per entry
     * instead of being hidden under an arbitrary neighbour.
     */
    private _columns(groups: readonly ExplanationGroup[]): MatrixColumn[] {
        const keys: string[] = [...this.conditionKeys];
        for (const group of groups) {
            for (const node of group.conditions) {
                if (!keys.includes(node.key)) {
                    keys.push(node.key);
                }
            }
        }

        const columns: MatrixColumn[] = keys.map((key) => {
            const subKeys: string[] = [];
            for (const group of groups) {
                const node = group.conditions.find((entry) => entry.key === key);
                for (const child of node?.children ?? []) {
                    if (!subKeys.includes(child.key)) {
                        subKeys.push(child.key);
                    }
                }
            }
            return { kind: "condition" as const, key, subKeys };
        });

        const customCount = groups.reduce(
            (most, group) => Math.max(most, group.customResults.length),
            0,
        );
        if (customCount > 0) {
            columns.push({
                kind: "custom",
                key: CUSTOM_COLUMN_KEY,
                subKeys: Array.from({ length: customCount }, (_, index) => String(index)),
            });
        }
        return columns;
    }

    /**
     * Condition keys whose result is one result, not one per group row.
     *
     * A window- or day-scoped node is not about this slot alone; where every
     * group reports the same such node, repeating it down the rows would claim
     * N evaluations that never happened. Only identical states span -- groups
     * that genuinely disagree keep their own cells.
     */
    private _spanningKeys(groups: readonly ExplanationGroup[]): ReadonlySet<string> {
        const spanning = new Set<string>();
        if (groups.length < 2) {
            return spanning;
        }
        const first = groups[0];
        for (const node of first.conditions) {
            if (node.scope === "slot") {
                continue;
            }
            const shared = groups.every((group) => {
                const other = group.conditions.find((entry) => entry.key === node.key);
                return other !== undefined
                    && other.scope === node.scope
                    && other.state === node.state;
            });
            if (shared) {
                spanning.add(node.key);
            }
        }
        return spanning;
    }

    private _toggle(key: string): void {
        this._expanded = this._expanded.includes(key)
            ? this._expanded.filter((entry) => entry !== key)
            : [...this._expanded, key];
    }

    /**
     * ---------------------------------------------------------------------
     * LEVEL 3 SEAM.
     *
     * Pressing a node publishes `condition-matrix-node-select`, naming the
     * optimizer, the slot, the group, the top-level condition and -- where the
     * press landed on an expanded sub-column -- the sub-key. Phase C's
     * logic-block diagram mounts on that event: the node it needs is
     * `cell.groups[groupIndex].conditions.find(key)`, with `children` under it
     * and `customResults` for the `"custom"` column, all already parsed.
     *
     * Nothing in this file needs to change to attach it.
     * ---------------------------------------------------------------------
     */
    private _handleNodeClick(
        cell: ExplanationCell,
        group: ExplanationGroup,
        conditionKey: string,
        subKey: string | null,
    ): void {
        this.dispatchEvent(new CustomEvent<ConditionMatrixNodeSelectDetail>(
            "condition-matrix-node-select",
            {
                bubbles: true,
                composed: true,
                detail: {
                    optimizerId: cell.optimizerId,
                    slotId: cell.slotId,
                    rowIndex: cell.rowIndex,
                    groupIndex: group.index,
                    conditionKey,
                    subKey,
                },
            },
        ));
    }

    private _stateGlyph(state: ExplanationNodeState): string {
        switch (state) {
            case "true":
                return "✓";
            case "false":
                return "✗";
            case "not_evaluated":
                return "?";
            default:
                return "–";
        }
    }

    private _nodeTitle(node: ExplanationConditionNode): string {
        const parts = [
            `${this._labelled("condition", node.key)} — ${this._text(`state.${node.state}`)}`,
        ];
        if (node.scope !== "slot") {
            parts.push(this._text(`scope_detail.${node.scope}`));
        }
        if (node.value !== null && node.value !== undefined) {
            parts.push(`${this._text("matrix.configured")}: ${formatValue(node.value)}`);
        }
        if (node.actual !== null && node.actual !== undefined) {
            parts.push(`${this._text("matrix.actual")}: ${formatValue(node.actual)}`);
        }
        return parts.join(" · ");
    }

    private _groupLabel(group: ExplanationGroup): string {
        return group.label.length > 0
            ? group.label
            : `${this._text("matrix.group")} ${group.index + 1}`;
    }

    private _text(suffix: string): string {
        return this.localize(`${KEY_PREFIX}.${suffix}`);
    }

    /** A localized label, falling back to the raw backend key when unknown. */
    private _labelled(group: string, key: string | null): string {
        if (key === null || key.length === 0) {
            return "";
        }
        const full = `${KEY_PREFIX}.${group}.${key}`;
        const translated = this.localize(full);
        return translated === full || translated === undefined ? key : translated;
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "scheduling-condition-matrix": SchedulingConditionMatrix;
    }
}
