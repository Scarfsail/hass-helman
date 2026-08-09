import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

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
    buildApplianceSelectionState,
    buildClimateModeFieldState,
    type ApplianceOptimizerOption,
    type ApplianceSelectionState,
    type SurplusClimateModeFieldState,
} from "./appliance-optimizer-ui";
import { renderOptimizerCard } from "./optimizer-card";
import { optimizerCardStyles } from "./optimizer-styles";
import type {
    GroupNameEdit,
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
 * card at `automation.optimizers[index]`, `optimizer-condition-groups.ts` roots
 * the group list at the same place. More than tidiness keeps it that way: the
 * appliance picker reads the document's `appliances` list to name its options,
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
@customElement("helman-optimizer-editor")
export class HelmanOptimizerEditor
    extends LitElement
    implements FormFieldHost, OptimizerEditorHost
{
    static styles = [configFormStyles, optimizerCardStyles];

    /** The whole config document. Not mutated -- edits are reported, not applied. */
    @property({ attribute: false }) config: JsonObject | null = null;

    /** Which entry of `automation.optimizers` this card edits. */
    @property({ type: Number }) index = 0;

    /** How many optimizers there are, for the list actions' bounds. */
    @property({ type: Number }) total = 1;

    @property({ attribute: false }) schema: OptimizerSchemaDocument | null = null;

    @property({ attribute: false })
    applianceMetadata: ApplianceMetadataResponse | null = null;

    @property({ attribute: false }) hass?: HomeAssistantLike;

    @property({ type: Boolean }) narrow = false;

    @property({ attribute: false }) localize: (key: string) => string = (key) => key;

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
            index: this.index,
            total: this.total,
            enabled,
            title: this._cardTitle(schema, optimizer),
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

    /** Appliance-target kinds show which appliance they act on, not their id. */
    private _cardTitle(schema: OptimizerSchema, optimizer: JsonObject): string {
        const fallback =
            stringValue(optimizer.id) ||
            this._tFormat("editor.dynamic.optimizer", { index: this.index + 1 });
        if (!this._hasApplianceTarget(schema)) {
            return fallback;
        }
        const selectionState = this._applianceSelectionState();
        if (selectionState.selectedOption) {
            return selectionState.selectedOption.name;
        }
        if (selectionState.selectedMissingFromDraft && selectionState.selectedId.length > 0) {
            return this._tFormat("editor.dynamic.stale_appliance", {
                id: selectionState.selectedId,
            });
        }
        return fallback;
    }

    private _hasApplianceTarget(schema: OptimizerSchema): boolean {
        return schema.target.some((field) => field.key === "appliance_id");
    }

    private get _basePath(): PathSegment[] {
        return ["automation", "optimizers", this.index];
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
     * The appliance picker and its climate mode.
     *
     * Not schema-driven: the options come from the live appliance registry and
     * the authorable modes of the selected device, neither of which a static
     * schema can carry.
     */
    renderApplianceTargetFields(
        _optimizerIndex: number,
        kind: string,
    ): TemplateResult | typeof nothing {
        const schema = this.schema?.kinds.find((entry) => entry.kind === kind);
        if (!schema || !this._hasApplianceTarget(schema)) {
            return nothing;
        }
        const targetPath: PathSegment[] = [...this._basePath, "target"];
        const selectionState = this._applianceSelectionState();
        const climateModeFieldState = buildClimateModeFieldState(
            selectionState,
            stringValue(this.getValue([...targetPath, "climate_mode"])),
        );
        return html`
            <div class="field">
                <div class="field-label-row">
                    <label>${this.t("editor.fields.appliance_id")}</label>
                    ${this.renderHelpIcon("editor.fields.appliance_id", "editor.help.appliance_id")}
                </div>
                <select
                    @change=${(event: Event) =>
                        this._applyApplianceIdChange(
                            (event.currentTarget as HTMLSelectElement).value,
                        )}
                >
                    <option value="" ?selected=${selectionState.selectedId.length === 0}>
                        ${this.t("editor.values.select_appliance")}
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
                                ${this._applianceOptionLabel(option)}
                            </option>
                        `,
                    )}
                </select>
                <div class="helper">${this._applianceIdHelper(selectionState)}</div>
            </div>
            ${climateModeFieldState.visible
                ? this._renderClimateModeField(targetPath, climateModeFieldState)
                : nothing}
        `;
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

    private _applyApplianceIdChange(rawValue: string): void {
        const applianceId = rawValue.trim();
        // The appliance and its climate mode are `target` — the optimizer's
        // identity — not params, so they are never overridable by a group.
        const targetPath: PathSegment[] = [...this._basePath, "target"];
        this._mutate((draft) => {
            setValueAtPath(draft, [...targetPath, "appliance_id"], applianceId);
            const selectionState = buildApplianceSelectionState(
                draft,
                this.applianceMetadata,
                applianceId,
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

    // --- Appliance target helpers -------------------------------------------

    private _applianceSelectionState(): ApplianceSelectionState {
        return buildApplianceSelectionState(
            this.config,
            this.applianceMetadata,
            stringValue(this.getValue([...this._basePath, "target", "appliance_id"])),
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

    private _applianceIdHelper(selectionState: ApplianceSelectionState): string {
        if (selectionState.selectedMissingFromDraft && selectionState.selectedId.length > 0) {
            return this.t("editor.helpers.appliance_runtime_id_missing_from_draft");
        }
        if (selectionState.options.some((option) => option.selectionDisabled)) {
            return this.t("editor.helpers.appliance_runtime_id_pending_reload");
        }
        return this.t("editor.helpers.appliance_runtime_id");
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

    private _applianceOptionLabel(option: ApplianceOptimizerOption): string {
        const baseLabel =
            option.name === option.id
                ? option.id
                : this._tFormat("editor.dynamic.appliance_option", {
                      name: option.name,
                      id: option.id,
                  });
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

declare global {
    interface HTMLElementTagNameMap {
        "helman-optimizer-editor": HelmanOptimizerEditor;
    }
}
