import { LitElement, css, html, svg } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import { getLocalizeFunction, type LocalizeFunction } from "../../../localize/localize";
import { helmanColorVars } from "../../../color-vars";
import type { ExplanationCell } from "../model/schedule-explanation-model";
import {
    buildLogicDiagram, SELF_SUSTAINABILITY, UNEXPLAINED_AND_INPUT,
    INPUT_W, CUSTOM_W, OP_W, VERDICT_W, COL_INPUT_X, COL_OR_X,
    COL_SIDE_X, COL_FINAL_X, DIVIDER_X, COL_CUSTOM_X, FINAL_ELBOW_X,
    type LogicAnnotation, type LogicBlock, type LogicDiagramModel,
    type LogicEdge,
} from "../model/logic-diagram-model";
import {
    fitText, summariseLogicValue, fullLogicValue, formatComparison, shortTime,
    stateGlyph,
} from "../model/logic-value-format";

export type {
    LogicTerminal, LogicState, LogicBlockKind, LogicBlock, LogicComparison,
    LogicGroupHeader, LogicEdge, LogicAnnotation, LogicDiagramModel,
} from "../model/logic-diagram-model";
export {
    buildLogicDiagram, selfSustainabilityComparison, conditionComparison,
} from "../model/logic-diagram-model";
export { fitText, summariseLogicValue, fullLogicValue, formatComparison } from "../model/logic-value-format";

const KEY_PREFIX = "scheduling.explanation";

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
 * Which condition group's last evaluation the reader asked to see.
 *
 * The two coordinates `helman/get_condition_trace` is keyed by, and the whole
 * of what the diagram knows about the trace: it reports the press and leaves
 * fetching and drawing to whoever mounted it.
 */
/**
 * Which optimizer the reader asked to edit.
 *
 * The id and nothing else: the diagram is drawing one optimizer's account of
 * one slot, and the pipeline order it sits at is the *config's* to know. The
 * editor resolves the id against the document it loads, which is the only copy
 * that is authoritative at the moment of editing.
 */
export interface OptimizerEditRequestDetail {
    optimizerId: string;
}

export interface ConditionTraceRequestDetail {
    optimizerId: string;
    groupIndex: number;
    /**
     * What to call the group in the dialog's title.
     *
     * Resolved here rather than there because `_groupLabel` already owns the
     * question, including the "Skupina N" it falls back to when the user never
     * named the group.
     */
    groupLabel: string;
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
 * `3.43`. The operator is the backend's own (the condition column's
 * `operator`, `∈` for `run_when`'s set membership), and conditions that do not
 * compare (`requires_appliance`'s lookup, the self-gating pair) carry none and
 * never get one invented for them. A node whose condition measures
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

            /* Whose logic this is. The tab strip labels by *kind*, and vanishes
               entirely when a slot has one optimizer -- so the id is both the
               disambiguator when there are several of a kind and the only name
               on screen when there is one. It is also what the edit button next
               to it opens, which is reason enough to show it rather than a
               prettier label the config does not use. */
            .optimizer {
                font-weight: 600;
            }

            /* Pushed to the far end of the head: it acts on the diagram rather
               than describing it, so it must not read as one more caption. */
            .edit-automation {
                margin-left: auto;
                border: 1px solid var(--divider-color);
                border-radius: 999px;
                padding: 3px 10px;
                background: var(--card-background-color);
                color: inherit;
                font: inherit;
                font-size: 0.74rem;
                cursor: pointer;
            }

            .edit-automation:hover {
                border-color: color-mix(in srgb, var(--primary-color) 44%, var(--divider-color));
                background: color-mix(in srgb, var(--primary-color) 12%, var(--card-background-color));
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

            /* The one block on the drawing that leads somewhere: its recorded
               evaluation, node by node. Marked on the *label*, as a link is,
               because every property of the rect is already carrying state --
               its stroke colour says true/false, and its dash pattern is the
               only thing separating "threw" from "said no". Borrowing either
               would make the affordance and the reading fight over the same
               pixels. */
            g.block[data-traceable="true"] {
                cursor: pointer;
            }

            g.block[data-traceable="true"] text.label {
                text-decoration: underline;
                text-decoration-style: dotted;
                text-underline-offset: 2px;
            }

            g.block[data-traceable="true"]:focus-visible {
                outline: 2px solid var(--helman-selection, var(--primary-color));
                outline-offset: 2px;
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

    /**
     * Whether to offer editing the optimizer this diagram is drawing.
     *
     * A boolean rather than a `hass`, because the only question the diagram has
     * about the user is "may they save a config?" -- `helman/save_config` is
     * admin-gated, and a button whose save can only fail is worse than no
     * button. Whoever mounts the diagram already holds the `hass` that answers
     * it; see `scheduling-explanation-panel`.
     */
    @property({ type: Boolean }) public canEditAutomation = false;

    /**
     * What to call the optimizer in the head — the config editor's card title.
     *
     * Resolved by whoever mounts this, because the title of an appliance-target
     * optimizer is its *appliance's* name and the diagram holds no config.
     * Falls back to the id, which is always in the cell.
     */
    @property({ type: String }) public optimizerLabel = "";

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
                    ${this.optimizerLabel || cell.optimizerId
                        ? html`<span class="optimizer">
                              ${this.optimizerLabel || cell.optimizerId}
                          </span>`
                        : nothing}
                    <span class="slot">${this.slotLabel || cell.slotId}</span>
                    ${model.matchedGroupIndex === null ? nothing : html`
                        <span class="matched" data-group=${model.matchedGroupIndex}>
                            ${this._text("diagram.matched_group")}
                            ${this._groupLabel(model.matchedGroupIndex)}
                        </span>
                    `}
                    ${this._renderEditAutomation(cell)}
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
     * "Edit automation" — the diagram's one affordance to change what it shows.
     *
     * In the head rather than on the tab strip or on a row, because the head is
     * the one place that names exactly one optimizer: the strip is a chooser
     * and a row is a condition. Whatever diagram is on screen is what this
     * edits, with nothing to misread.
     */
    private _renderEditAutomation(cell: ExplanationCell) {
        if (!this.canEditAutomation || !cell.optimizerId) {
            return nothing;
        }
        return html`
            <button
                type="button"
                class="edit-automation"
                title=${this._text("diagram.edit_automation")}
                @click=${() => this._requestOptimizerEdit(cell.optimizerId)}
            >
                ${this._text("diagram.edit_automation")}
            </button>
        `;
    }

    private _requestOptimizerEdit(optimizerId: string): void {
        this.dispatchEvent(
            new CustomEvent<OptimizerEditRequestDetail>("optimizer-edit-requested", {
                detail: { optimizerId },
            }),
        );
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
        const traceRequest = this._traceCoordinates(block);
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
        // and have no numeric test — the value the group configured. Full
        // params always live in the tooltip.
        const comparison = block.comparison;
        const right = comparison !== null
            ? formatComparison(comparison)
            : block.detail
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
                : `${this._text("matrix.configured")}: ${fullConfigured}`,
            // The reason has already said everything the object holds, in a
            // form a person can read.
            reason !== "" || fullValue === null
                ? ""
                : `${this._text("matrix.actual")}: ${fullValue}`,
            this._paramsText(block.params),
            traceRequest === null ? "" : this._text("diagram.trace.open_hint"),
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
                data-traceable=${traceRequest === null ? nothing : "true"}
                role=${traceRequest === null ? nothing : "button"}
                tabindex=${traceRequest === null ? nothing : "0"}
                @click=${traceRequest === null
                    ? undefined
                    : () => this._requestTrace(traceRequest)}
                @keydown=${traceRequest === null
                    ? undefined
                    : (event: KeyboardEvent) => this._handleTraceKeydown(event, traceRequest)}
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

    /**
     * Which condition group's trace this block can be pressed for, if any.
     *
     * Only the custom-conditions block, and only where an evaluation actually
     * happened: `n/a` is the block saying the matched group configured none, so
     * there is nothing recorded to open and the `custom_none` hint beneath it
     * already explains the empty stage. The state is the diagram's own reading
     * of `customResults`, so this cannot offer a trace the backend does not have.
     */
    private _traceCoordinates(
        block: LogicBlock,
    ): ConditionTraceRequestDetail | null {
        const optimizerId = this.cell?.optimizerId;
        if (
            block.kind !== "custom"
            || block.state === "n/a"
            || block.groupIndex === null
            || optimizerId === undefined
        ) {
            return null;
        }

        return {
            optimizerId,
            groupIndex: block.groupIndex,
            groupLabel: this._groupLabel(block.groupIndex),
        };
    }

    /**
     * The block is a control, so it answers to the keyboard as one.
     *
     * An SVG `<g>` gets no default activation behaviour from `role="button"` --
     * the role is a promise to the reader that the element has to keep itself.
     */
    private _handleTraceKeydown(
        event: KeyboardEvent,
        detail: ConditionTraceRequestDetail,
    ): void {
        if (event.key !== "Enter" && event.key !== " ") {
            return;
        }

        // Space scrolls the panel otherwise, which is the opposite of activating.
        event.preventDefault();
        this._requestTrace(detail);
    }

    private _requestTrace(detail: ConditionTraceRequestDetail): void {
        this.dispatchEvent(new CustomEvent<ConditionTraceRequestDetail>(
            "condition-trace-requested",
            { detail, bubbles: true, composed: true },
        ));
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
        return (this.localize.has?.(full) ?? getLocalizeFunction().has(full)) ? translated : key;
    }

    /**
     * Why a self-gating condition refused this slot, in words and numbers.
     *
     * Its `actual` is a *reason* rather than a reading: which of three tests
     * failed, and what it saw (`appliance_runtime._accept`). The face carries
     * the comparison; this is where the rest goes -- most importantly `atSlot`,
     * the hour the floor would break, which has nowhere else to be, and the
     * difference between "this slot would break the floor" and "the floor
     * breaks anyway, without the appliance", which the two comparisons cannot
     * tell apart on their own.
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
        return (this.localize.has?.(full) ?? getLocalizeFunction().has(full)) ? translated : "";
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "scheduling-logic-diagram": SchedulingLogicDiagram;
    }
}
