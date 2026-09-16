import { LitElement, html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

import {
    asJsonArray,
    asJsonObject,
    appendListItem,
    cloneJson,
    getValueAtPath,
    moveListItem,
    removeListItem,
    setValueAtPath,
    unsetValueAtPath,
} from "../config/config-document";
import { defineOnce } from "../define-once";
import { configFormStyles } from "../config/form-styles";
import {
    booleanValue,
    renderDayClassificationField,
    renderHelpDialog,
    renderHelpIcon,
    renderOptionalNumberField,
    renderOptionalSelectField,
    renderRequiredNumberField,
    renderRequiredTextField,
    renderSvgIcon,
    setRequiredString,
    stringValue,
    type FormFieldHost,
} from "../config/form-fields";
import type {
    HomeAssistantLike,
    JsonObject,
    JsonValue,
    PathSegment,
} from "../config/types";
import type { ApplianceMetadataResponse } from "../config/types";
import {
    buildControllableSelectionState,
    buildClimateModeFieldState,
    type ControllableSelectionState,
    type ControllableTargetOption,
    type SurplusClimateModeFieldState,
} from "./controllable-target-ui";
import { renderOptimizerCard } from "./optimizer-card";
import { optimizerCardStyles } from "./optimizer-styles";
import type {
    GroupNameEdit,
    OptimizerConfigBucket,
    OptimizerEditorHost,
    OptimizerSchema,
    OptimizerSchemaDocument,
} from "./optimizer-schema";

// DUMMY: reuse Home Assistant's visual condition builder.
const OPTIMIZER_CONDITION_SELECTOR = {
    condition: {},
} as const;

const CHEVRON = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";

/** What the editor emits when the reader changes something. */
export interface OptimizerConfigChangedDetail {
    /** The whole document, with this optimizer's subtree rewritten. */
    config: JsonObject;
}

/**
 * One optimizer's editing surface, as an element.
 *
 * The schema-driven renderers next door have always been plain functions over
 * an `OptimizerEditorHost`; what was missing was an implementation of that host
 * outside the 5000-line config panel. This is it, and it is what makes editing
 * an optimizer from the solar inspector the *same* code as editing it from the
 * config editor rather than a second one that looks similar for a while.
 *
 * ### Why it takes the whole document
 *
 * Every path the renderers build is absolute -- `optimizer-card.ts` roots its
 * card at `automation.<bucket>[index]`, `optimizer-condition-groups.ts` roots
 * the group list at the same place. More than tidiness keeps it that way: the
 * target picker reads the document's `controllables` list to name its options,
 * and a group's param override renders the *master* params as its placeholders.
 * An element handed one optimizer in isolation would have to be handed those
 * too, under different names, and every path in the renderers would have to be
 * rewritten relative. So the element takes the document and an index, and the
 * renderers are untouched.
 *
 * ### Why it does not own the document
 *
 * It edits a clone and reports it. Whoever mounted it decides what that means:
 * the panel marks itself dirty and drops its validation report, the inspector's
 * dialog holds the draft until "Save and restart". Neither belongs here, and an
 * element that saved would be unusable in the other place.
 */
export class HelmanOptimizerEditor
    extends LitElement
    implements FormFieldHost, OptimizerEditorHost
{
    static styles = [configFormStyles, optimizerCardStyles];

    /** The whole config document. Not mutated -- edits are reported, not applied. */
    @property({ attribute: false }) config: JsonObject | null = null;

    /**
     * Which bucket this card's optimizer lives in -- `automation.appliance_optimizers`
     * or `automation.system_optimizers`. Rooting `_basePath`, so every path this
     * element and the renderers it drives build follows from it.
     */
    @property({ type: String }) bucket: OptimizerConfigBucket = "appliance_optimizers";

    /** Which entry of that bucket this card edits. */
    @property({ type: Number }) index = 0;

    /** How many optimizers there are, for the list actions' bounds. */
    @property({ type: Number }) total = 1;

    @property({ attribute: false }) schema: OptimizerSchemaDocument | null = null;

    @property({ attribute: false })
    applianceMetadata: ApplianceMetadataResponse | null = null;

    @property({ attribute: false }) hass?: HomeAssistantLike;

    @property({ type: Boolean }) narrow = false;

    /** Start with the card open. See `OptimizerCardOptions.open`. */
    @property({ type: Boolean }) expanded = false;

    @property({ attribute: false }) localize: (key: string) => string = (key) => key;

    /**
     * A validation warning against this optimizer, or none.
     *
     * Only `required_appliance_planned_later` reaches here today -- reordering
     * within the appliance section is the fix for it, so the card the warning
     * is *about* is where a reader can act on it, not only the validation panel.
     * A message rather than a code: the panel already has the backend's wording
     * and there is no second copy to keep in step with it here.
     */
    @property({ attribute: false }) warning: string | null = null;

    /**
     * The up/down/remove/enabled row in the card's summary, or nothing.
     *
     * Supplied by the mounter rather than rendered here, because reordering and
     * deleting are *pipeline* operations: they change which optimizers exist,
     * which is the document's business and not one card's. The inspector's
     * dialog passes nothing and gets a card with no way to disturb the list it
     * came from.
     */
    @property({ attribute: false })
    listActions?: (basePath: PathSegment[], enabled: boolean) => TemplateResult;

    @state() private _help: { labelKey: string; contentKey: string } | null = null;

    @state() private _editingGroupName: GroupNameEdit | null = null;

    render(): TemplateResult | typeof nothing {
        const optimizer = asJsonObject(this.getValue(this._basePath));
        if (!optimizer) {
            return nothing;
        }
        const kind = stringValue(optimizer.kind);
        const schema = this.schema?.kinds.find((entry) => entry.kind === kind);
        return html`
            ${schema
                ? this._renderCard(schema, optimizer)
                : this._renderUnsupported(optimizer, kind)}
            ${renderHelpDialog(this, this._help, () => {
                this._help = null;
            })}
        `;
    }

    private _renderCard(schema: OptimizerSchema, optimizer: JsonObject): TemplateResult {
        const enabled = booleanValue(this.getValue([...this._basePath, "enabled"]), true);
        return renderOptimizerCard({
            host: this,
            schema,
            optimizer,
            bucket: this.bucket,
            index: this.index,
            total: this.total,
            enabled,
            title: this._cardTitle(schema, optimizer),
            warning: this.warning,
            open: this.expanded,
            renderSvgIcon,
            renderListActions: (basePath) =>
                this.listActions?.(basePath, enabled) ?? html``,
            conditionGroups: {
                addGroup: () => this._addConditionGroup(schema),
                removeGroup: (groupIndex) => this._removeConditionGroup(groupIndex),
                moveGroup: (groupIndex, targetIndex) =>
                    this._mutate((draft) =>
                        moveListItem(
                            draft,
                            [...this._basePath, "conditions"],
                            groupIndex,
                            targetIndex,
                        ),
                    ),
            },
        });
    }

    /**
     * A kind the served schema does not describe.
     *
     * Shown raw rather than hidden: the optimizer is running, and a card that
     * silently omitted it would read as "this automation has fewer rules than
     * it has".
     */
    private _renderUnsupported(optimizer: JsonObject, kind: string): TemplateResult {
        const enabled = booleanValue(this.getValue([...this._basePath, "enabled"]), true);
        const title =
            stringValue(optimizer.id) ||
            this._tFormat("editor.dynamic.optimizer", { index: this.index + 1 });
        const subtitle = this._tFormat("editor.dynamic.unsupported_optimizer_kind", {
            kind: kind || this.t("editor.values.unknown"),
        });
        return html`
            <details
                class=${`list-card optimizer-card optimizer-card--${enabled ? "enabled" : "disabled"}`}
            >
                <summary>
                    <div class="appliance-summary-row">
                        <div class="appliance-summary-left">
                            ${renderSvgIcon(CHEVRON, "appliance-chevron")}
                            <div class="card-title">
                                <strong>${title}</strong>
                                <span class="card-subtitle">${subtitle}</span>
                            </div>
                        </div>
                        ${this.listActions?.(this._basePath, enabled) ?? nothing}
                    </div>
                </summary>
                <div class="appliance-body">
                    <pre class="raw-preview">${JSON.stringify(optimizer, null, 2)}</pre>
                </div>
            </details>
        `;
    }

    /**
     * An appliance-driving card is titled by the appliance it drives, plus its
     * own id.
     *
     * Every kind carries a `controllable_id` now, so "has a target" no longer
     * separates them — the inverter does. Its three optimizers share one lane
     * and one name, so titling them "Inverter" three times would tell the
     * reader nothing and lose the ids that tell them apart; they keep their id,
     * exactly as before. An appliance can just as legitimately carry two
     * optimizers in the same bucket (P2, #272) -- composing in order rather
     * than one replacing the other -- so two cards sharing an appliance's name
     * is expected, not a bug, and the id is what tells them apart. Reuses
     * `appliance_option`'s "{name} ({id})" shape rather than inventing a
     * second one for the same pairing.
     */
    private _cardTitle(schema: OptimizerSchema, optimizer: JsonObject): string {
        const fallback =
            stringValue(optimizer.id) ||
            this._tFormat("editor.dynamic.optimizer", { index: this.index + 1 });
        if (!this._targetsControllable(schema)) {
            return fallback;
        }
        const states = this._targetPaths(schema).map((targetPath) =>
            this._selectionState(schema, targetPath),
        );
        const selected = states.flatMap((state) =>
            state.selectedOption ? [state.selectedOption] : [],
        );
        if (selected.some((option) => option.kind === "inverter")) {
            return fallback;
        }
        if (selected.length > 0) {
            // A group is titled by every member it names, in priority order.
            return this._tFormat("editor.dynamic.appliance_option", {
                name: selected.map((option) => option.name).join(", "),
                id: fallback,
            });
        }
        const stale = states.find(
            (state) => state.selectedMissingFromDraft && state.selectedId.length > 0,
        );
        if (stale) {
            return this._tFormat("editor.dynamic.stale_appliance", { id: stale.selectedId });
        }
        return fallback;
    }

    /**
     * Whether the schema declares a target at all, in either of its two shapes:
     * a flat `controllable_id` (the inverter kinds) or an ordered
     * `controllables` group (`appliance_runtime`).
     */
    private _targetsControllable(schema: OptimizerSchema): boolean {
        return (
            this._targetsControllableGroup(schema) ||
            schema.target.some((field) => field.key === "controllable_id")
        );
    }

    private _targetsControllableGroup(schema: OptimizerSchema): boolean {
        return schema.target.some(
            (field) => field.key === "controllables" && field.type === "object_list",
        );
    }

    private get _targetListPath(): PathSegment[] {
        return [...this._basePath, "target", "controllables"];
    }

    /**
     * Where each target lives: one path per group member, in priority order, or
     * the flat `target` itself. Every per-target helper takes one of these.
     */
    private _targetPaths(schema: OptimizerSchema): PathSegment[][] {
        if (!this._targetsControllableGroup(schema)) {
            return [[...this._basePath, "target"]];
        }
        const members = asJsonArray(this.getValue(this._targetListPath)) ?? [];
        return members.map((_member, memberIndex) => [...this._targetListPath, memberIndex]);
    }

    private get _basePath(): PathSegment[] {
        return ["automation", this.bucket, this.index];
    }

    // --- FormFieldHost / OptimizerEditorHost --------------------------------

    t(key: string): string {
        return this.localize(key);
    }

    tFormat(key: string, values: Record<string, string | number>): string {
        return this._tFormat(key, values);
    }

    private _tFormat(key: string, values: Record<string, string | number>): string {
        let text = this.t(key);
        for (const [name, value] of Object.entries(values)) {
            text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
    }

    getValue(path: PathSegment[]): unknown {
        return this.config ? getValueAtPath(this.config, path) : undefined;
    }

    setValue(path: PathSegment[], value: JsonValue | undefined): void {
        this._mutate((draft) => {
            if (value === undefined) {
                unsetValueAtPath(draft, path);
            } else {
                setValueAtPath(draft, path, value);
            }
        });
    }

    openHelp(labelKey: string, contentKey: string): void {
        this._help = { labelKey, contentKey };
    }

    renderRequiredTextField(
        path: PathSegment[],
        labelKey: string,
        explicitValue?: unknown,
        helpKey?: string,
    ): TemplateResult {
        return renderRequiredTextField(this, path, labelKey, explicitValue, helpKey);
    }

    renderRequiredNumberField(
        path: PathSegment[],
        labelKey: string,
        explicitValue?: unknown,
        step = "any",
        helpKey?: string,
    ): TemplateResult {
        return renderRequiredNumberField(this, path, labelKey, explicitValue, step, helpKey);
    }

    renderOptionalNumberField(
        path: PathSegment[],
        labelKey: string,
        helperKey?: string,
        helpKey?: string,
        options: { min?: number; max?: number; suffix?: string } = {},
    ): TemplateResult {
        return renderOptionalNumberField(this, path, labelKey, helperKey, helpKey, options);
    }

    renderOptionalSelectField(
        path: PathSegment[],
        labelKey: string,
        options: { value: string; label: string }[],
        helpKey?: string,
    ): TemplateResult {
        return renderOptionalSelectField(this, path, labelKey, options, helpKey);
    }

    renderHelpIcon(labelKey: string, contentKey: string): TemplateResult {
        return renderHelpIcon(this, labelKey, contentKey);
    }

    renderSvgIcon(path: string, className: string): TemplateResult {
        return renderSvgIcon(path, className);
    }

    renderDayClassificationField(
        path: PathSegment[],
        labelKey: string,
        helpKey: string,
    ): TemplateResult {
        return renderDayClassificationField(this, path, labelKey, helpKey);
    }

    get editingGroupName(): GroupNameEdit | null {
        return this._editingGroupName;
    }

    setEditingGroupName(target: GroupNameEdit | null): void {
        this._editingGroupName = target;
    }

    /**
     * Home Assistant's own condition builder, backed by a group's `custom` list.
     *
     * The list is ANDed at execution time; groups are ORed around it.
     */
    renderCustomConditions(path: PathSegment[]): TemplateResult {
        const conditions = asJsonArray(this.getValue(path)) ?? [];
        return html`
            <ha-selector
                .hass=${this.hass}
                .narrow=${this.narrow}
                .selector=${OPTIMIZER_CONDITION_SELECTOR}
                .value=${conditions}
                @value-changed=${(event: Event) => {
                    const value = (event as CustomEvent<{ value?: unknown }>).detail?.value;
                    this.setValue(
                        path,
                        Array.isArray(value) && value.length ? (value as JsonValue) : undefined,
                    );
                }}
            ></ha-selector>
        `;
    }

    /**
     * The target picker and, for a climate target, its mode.
     *
     * Half schema-driven: which controllable *kinds* may be offered comes from
     * the schema, but which instances exist, and the authorable modes of the
     * selected one, come from the draft document and the live registry, neither
     * of which a static schema can carry.
     *
     * A group target renders one row per member. The list *is* the priority
     * order -- the first member takes the surplus first -- so the rows are
     * numbered and reordered in place, with the same up/down idiom as the
     * condition groups.
     */
    renderControllableTargetFields(
        _optimizerIndex: number,
        kind: string,
    ): TemplateResult | typeof nothing {
        const schema = this.schema?.kinds.find((entry) => entry.kind === kind);
        if (!schema || !this._targetsControllable(schema)) {
            return nothing;
        }
        if (!this._targetsControllableGroup(schema)) {
            const targetPath: PathSegment[] = [...this._basePath, "target"];
            return html`
                <div class="field">
                    <div class="field-label-row">
                        <label>${this.t("editor.fields.optimizer_target")}</label>
                        ${this.renderHelpIcon("editor.fields.optimizer_target", "editor.help.optimizer_target")}
                    </div>
                    ${this._renderTargetPicker(schema, targetPath)}
                </div>
                ${this._renderTargetClimateMode(schema, targetPath)}
            `;
        }
        const targetPaths = this._targetPaths(schema);
        const total = targetPaths.length;
        return html`
            <div class="field controllable-targets">
                <div class="field-label-row">
                    <label>${this.t("editor.fields.optimizer_targets")}</label>
                    ${this.renderHelpIcon("editor.fields.optimizer_targets", "editor.help.optimizer_targets")}
                </div>
                <div class="helper">${this.t("editor.helpers.optimizer_targets")}</div>
                ${targetPaths.map(
                    (targetPath, memberIndex) => html`
                        <div class="controllable-target-row">
                            <div class="appliance-summary-row">
                                <strong class="controllable-target-position">
                                    ${this._tFormat("editor.dynamic.priority_position", {
                                        position: memberIndex + 1,
                                    })}
                                </strong>
                                <div class="list-actions">
                                    <button
                                        type="button"
                                        ?disabled=${memberIndex === 0}
                                        @click=${() => this._moveTarget(memberIndex, memberIndex - 1)}
                                    >${this.t("editor.actions.up")}</button>
                                    <button
                                        type="button"
                                        ?disabled=${memberIndex === total - 1}
                                        @click=${() => this._moveTarget(memberIndex, memberIndex + 1)}
                                    >${this.t("editor.actions.down")}</button>
                                    <button
                                        type="button"
                                        class="danger remove-controllable-target"
                                        ?disabled=${total <= 1}
                                        @click=${() => this._removeTarget(memberIndex)}
                                    >${this.t("editor.actions.remove")}</button>
                                </div>
                            </div>
                            <div class="field-grid">
                                <div class="field">${this._renderTargetPicker(schema, targetPath)}</div>
                                ${this._renderTargetClimateMode(schema, targetPath)}
                            </div>
                        </div>
                    `,
                )}
                <button
                    type="button"
                    class="add-button add-controllable-target"
                    @click=${() => this._addTarget()}
                >
                    ${this.t("editor.actions.add_controllable_target")}
                </button>
            </div>
        `;
    }

    private _renderTargetPicker(schema: OptimizerSchema, targetPath: PathSegment[]): TemplateResult {
        const selectionState = this._selectionState(schema, targetPath);
        return html`
            <select
                class="controllable-target-picker"
                @change=${(event: Event) =>
                    this._applyControllableIdChange(
                        schema,
                        targetPath,
                        (event.currentTarget as HTMLSelectElement).value,
                    )}
            >
                <option value="" ?selected=${selectionState.selectedId.length === 0}>
                    ${this.t("editor.values.select_controllable")}
                </option>
                ${selectionState.selectedMissingFromDraft && selectionState.selectedId.length > 0
                    ? html`
                          <option value=${selectionState.selectedId} ?selected=${true}>
                              ${this._tFormat("editor.dynamic.stale_appliance", {
                                  id: selectionState.selectedId,
                              })}
                          </option>
                      `
                    : nothing}
                ${selectionState.options.map(
                    (option) => html`
                        <option
                            value=${option.id}
                            ?disabled=${option.selectionDisabled}
                            ?selected=${option.id === selectionState.selectedId}
                        >
                            ${this._targetOptionLabel(option)}
                        </option>
                    `,
                )}
            </select>
            <div class="helper">${this._targetHelper(selectionState)}</div>
        `;
    }

    private _renderTargetClimateMode(
        schema: OptimizerSchema,
        targetPath: PathSegment[],
    ): TemplateResult | typeof nothing {
        const climateModeFieldState = buildClimateModeFieldState(
            this._selectionState(schema, targetPath),
            stringValue(this.getValue([...targetPath, "climate_mode"])),
        );
        return climateModeFieldState.visible
            ? this._renderClimateModeField(targetPath, climateModeFieldState)
            : nothing;
    }

    /**
     * The `requires_appliance` picker: the draft's *other* appliances.
     *
     * Built from ``buildControllableSelectionState`` — the target picker's own
     * helper — so the two read one list and cannot disagree about what exists.
     * Three differences from the target picker, all deliberate:
     *
     * Filtered by ``applianceKinds`` from the schema document rather than by
     * this optimizer kind's ``controllableKinds``. A provider is anything with
     * a schedule action that can read as "running", which is every appliance
     * kind; ``controllableKinds`` answers a narrower question — what this
     * optimizer may *drive* — and would hide a charger the backend accepts.
     *
     * The optimizer's own targets -- every member of a group, not just the
     * first -- are removed, and a stored value equal to one is surfaced as an
     * explicit entry rather than dropped. An appliance depending on itself
     * plans against a lane that is stripped every run, so validation rejects
     * it — and a picker that rendered blank would show no value to clear while
     * the draft still carried one.
     *
     * ``selectionDisabled`` is not honoured. It means "cannot be a *target*
     * until the live climate modes load", which has no bearing on being a
     * provider, so these options carry the plain label and stay selectable.
     */
    renderApplianceDependencyPicker(
        path: PathSegment[],
        labelKey: string,
        helpKey: string,
    ): TemplateResult {
        const stored = stringValue(this.getValue(path));
        const kind = stringValue(this.getValue([...this._basePath, "kind"]));
        const schema = this.schema?.kinds.find((entry) => entry.kind === kind);
        const ownTargetIds = new Set(
            schema
                ? this._targetPaths(schema).map((targetPath) =>
                      stringValue(this.getValue([...targetPath, "controllable_id"])),
                  )
                : [],
        );
        const selectionState = buildControllableSelectionState(
            this.config,
            this.applianceMetadata,
            stored,
            this.schema?.applianceKinds ?? [],
        );
        const options = selectionState.options
            .filter((option) => !ownTargetIds.has(option.id))
            .map((option) => ({
                value: option.id,
                label: this._controllableOptionLabel(option),
            }));
        // Whether the stored id survived the *filtered* list, not the raw one:
        // an id the draft no longer has and an id that is this optimizer's own
        // target are both values the select could otherwise not render, and
        // silently blanking either hides a dependency the config still carries.
        if (stored.length > 0 && !options.some((option) => option.value === stored)) {
            options.unshift({
                value: stored,
                label: this._tFormat(
                    ownTargetIds.has(stored)
                        ? "editor.dynamic.self_dependency"
                        : "editor.dynamic.stale_appliance",
                    { id: stored },
                ),
            });
        }
        return renderOptionalSelectField(this, path, labelKey, options, helpKey);
    }

    // --- Mutation ------------------------------------------------------------

    /**
     * Edit a clone and report it.
     *
     * `config` is left exactly as it was handed over, so a mounter that ignores
     * the event -- or rejects the edit -- is not silently already mutated.
     */
    private _mutate(mutator: (draft: JsonObject) => void): void {
        const draft = cloneJson(this.config ?? {});
        mutator(draft);
        this.dispatchEvent(
            new CustomEvent<OptimizerConfigChangedDetail>("optimizer-config-changed", {
                detail: { config: draft },
                bubbles: true,
                composed: true,
            }),
        );
    }

    /** A new group starts from the kind's seed, so it is valid the moment it appears. */
    private _addConditionGroup(schema: OptimizerSchema): void {
        const seed = asJsonArray(schema.newDraft.conditions)?.[0];
        this._mutate((draft) => {
            appendListItem(
                draft,
                [...this._basePath, "conditions"],
                (asJsonObject(seed) ?? {}) as JsonObject,
            );
        });
    }

    /**
     * Remove a group — never the last one.
     *
     * Zero groups is an unsavable automation, so the UI must not be able to
     * reach that state. The button is disabled too; this is the second lock.
     */
    private _removeConditionGroup(groupIndex: number): void {
        const path: PathSegment[] = [...this._basePath, "conditions"];
        if ((asJsonArray(this.getValue(path)) ?? []).length <= 1) {
            return;
        }
        this._mutate((draft) => removeListItem(draft, path, groupIndex));
    }

    /** A new member joins at the bottom: lowest priority until moved. */
    private _addTarget(): void {
        this._mutate((draft) =>
            appendListItem(draft, this._targetListPath, { controllable_id: "" }),
        );
    }

    private _moveTarget(memberIndex: number, targetIndex: number): void {
        this._mutate((draft) =>
            moveListItem(draft, this._targetListPath, memberIndex, targetIndex),
        );
    }

    /** Never the last member: an empty group is unsavable. The button is disabled too. */
    private _removeTarget(memberIndex: number): void {
        if ((asJsonArray(this.getValue(this._targetListPath)) ?? []).length <= 1) {
            return;
        }
        this._mutate((draft) => removeListItem(draft, this._targetListPath, memberIndex));
    }

    private _applyControllableIdChange(
        schema: OptimizerSchema,
        targetPath: PathSegment[],
        rawValue: string,
    ): void {
        const controllableId = rawValue.trim();
        // The controllable and its climate mode are `target` — the optimizer's
        // identity — not params, so they are never overridable by a group.
        this._mutate((draft) => {
            setValueAtPath(draft, [...targetPath, "controllable_id"], controllableId);
            const selectionState = buildControllableSelectionState(
                draft,
                this.applianceMetadata,
                controllableId,
                schema.controllableKinds ?? [],
            );
            const climateModeFieldState = buildClimateModeFieldState(
                selectionState,
                stringValue(getValueAtPath(draft, [...targetPath, "climate_mode"])),
            );
            if (!climateModeFieldState.visible || climateModeFieldState.unavailable) {
                unsetValueAtPath(draft, [...targetPath, "climate_mode"]);
                return;
            }
            setValueAtPath(draft, [...targetPath, "climate_mode"], climateModeFieldState.value);
        });
    }

    // --- Controllable target helpers ----------------------------------------

    /**
     * Falls back to the schema field's default when the document is silent.
     *
     * The three inverter kinds default `controllable_id` to the reserved
     * `inverter` id, and a config written before the field existed simply omits
     * it — the reader fills it in, and the picker has to show the same answer
     * rather than an empty "select…".
     */
    private _selectionState(
        schema: OptimizerSchema,
        targetPath: PathSegment[],
    ): ControllableSelectionState {
        const field = schema.target.find((entry) => entry.key === "controllable_id");
        const stored = stringValue(this.getValue([...targetPath, "controllable_id"]));
        return buildControllableSelectionState(
            this.config,
            this.applianceMetadata,
            stored || stringValue(field?.default),
            schema.controllableKinds ?? [],
        );
    }

    private _renderClimateModeField(
        targetPath: PathSegment[],
        climateModeFieldState: SurplusClimateModeFieldState,
    ): TemplateResult {
        const selectedValue =
            climateModeFieldState.value.length > 0
                ? climateModeFieldState.value
                : "__live_modes_unavailable__";
        return html`
            <div class="field">
                <div class="field-label-row">
                    <label>${this.t("editor.fields.climate_mode")}</label>
                    ${this.renderHelpIcon(
                        "editor.fields.climate_mode",
                        "editor.help.appliance_runtime_climate_mode",
                    )}
                </div>
                <select
                    ?disabled=${climateModeFieldState.disabled}
                    @change=${(event: Event) =>
                        setRequiredString(
                            this,
                            [...targetPath, "climate_mode"],
                            (event.currentTarget as HTMLSelectElement).value,
                        )}
                >
                    ${climateModeFieldState.options.length > 0
                        ? climateModeFieldState.options.map(
                              (option) => html`
                                  <option
                                      value=${option.value}
                                      ?selected=${option.value === selectedValue}
                                  >
                                      ${this._climateModeLabel(option.value, option.isUnknown)}
                                  </option>
                              `,
                          )
                        : html`
                              <option value="__live_modes_unavailable__" ?selected=${true}>
                                  ${this.t("editor.values.live_modes_unavailable")}
                              </option>
                          `}
                </select>
                <div class="helper">${this._climateModeHelper(climateModeFieldState)}</div>
            </div>
        `;
    }

    private _targetHelper(selectionState: ControllableSelectionState): string {
        if (selectionState.selectedMissingFromDraft && selectionState.selectedId.length > 0) {
            return this.t("editor.helpers.optimizer_target_missing_from_draft");
        }
        if (selectionState.options.some((option) => option.selectionDisabled)) {
            return this.t("editor.helpers.optimizer_target_pending_reload");
        }
        return this.t("editor.helpers.optimizer_target");
    }

    private _climateModeHelper(state: SurplusClimateModeFieldState): string {
        if (state.unavailable) {
            return this.t("editor.helpers.appliance_runtime_climate_mode_unavailable");
        }
        if (state.options.some((option) => option.isUnknown)) {
            return this.t("editor.helpers.appliance_runtime_climate_mode_unknown");
        }
        if (state.disabled) {
            return this.t("editor.helpers.appliance_runtime_climate_mode_single");
        }
        return this.t("editor.helpers.appliance_runtime_climate_mode");
    }

    /** "Name (id)", or the bare id when the two are the same. */
    private _controllableOptionLabel(option: ControllableTargetOption): string {
        return option.name === option.id
            ? option.id
            : this._tFormat("editor.dynamic.appliance_option", {
                  name: option.name,
                  id: option.id,
              });
    }

    private _targetOptionLabel(option: ControllableTargetOption): string {
        const baseLabel = this._controllableOptionLabel(option);
        if (!option.selectionDisabled) {
            return baseLabel;
        }
        return this._tFormat("editor.dynamic.appliance_option_pending_reload", {
            label: baseLabel,
        });
    }

    private _climateModeLabel(mode: string, isUnknown: boolean): string {
        if (isUnknown) {
            return this._tFormat("editor.dynamic.stale_climate_mode", { mode });
        }
        return this.t(`editor.values.${mode}`);
    }
}

defineOnce("helman-optimizer-editor", HelmanOptimizerEditor);

declare global {
    interface HTMLElementTagNameMap {
        "helman-optimizer-editor": HelmanOptimizerEditor;
    }
}
