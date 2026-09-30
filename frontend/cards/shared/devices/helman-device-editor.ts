import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { fetchDeviceSuggestions, type DeviceSuggestions } from "../../helman-api";
import {
    appendListItem,
    asJsonArray,
    asJsonObject,
    cloneJson,
    createEcoGearEntry,
    createGearKey,
    createModeKey,
    createUseModeEntry,
    createVehicleDraft,
    getValueAtPath,
    moveListItem,
    objectEntries,
    removeListItem,
    renameObjectKey,
    setValueAtPath,
    unsetValueAtPath,
} from "../config/config-document";
import {
    assignGroup,
    canHaveChildren,
    deviceChildren,
    deviceKind,
    hasSwitch,
    isSchedulable,
    iterDevices,
    meterlessChildren,
    ownGroup,
    ownMeter,
    SWITCH_CONTROL_DOMAINS,
} from "../config/devices";
import {
    entityGroupKey,
    renderEntityGroup,
    type EntityGroupOptions,
    type EntityInspectionResult,
} from "../config/entity-group";
import {
    formatError,
    renameObjectKeyError,
    renderHelpDialog,
    renderHelpIcon,
    renderOptionalTextField,
    renderRequiredNumberField,
    renderRequiredTextField,
    renderSimpleSection,
    renderSvgIcon,
    setOptionalString,
    setRequiredString,
    stringValue,
    type FormFieldHost,
} from "../config/form-fields";
import { renderDragHandle, renderRemoveButton, renderSortableList } from "../config/sortable-list";
import type {
    HomeAssistantLike,
    JsonObject,
    JsonValue,
    PathSegment,
    ValidationIssue,
    ValidationReport,
} from "../config/types";
import { defineOnce } from "../define-once";
import type { HaEntityPickerEntityFilterFunc } from "../../../hass-frontend/src/data/entity/entity";
import { haDeviceEntityFilter, sharedHaDevice } from "./device-scope";
import "../config/entity-group";

/** The kinds the device form edits; anything else is shown read-only. */
export const EDITABLE_DEVICE_KINDS = ["generic", "climate", "ev_charger"] as const;

/**
 * The projection a device gets when it becomes schedulable: the strategy the
 * editor displays by default, and the figure the backend requires with it.
 */
export const SEEDED_PROJECTION = { strategy: "fixed", hourly_energy_kwh: 1 } as const;

/** The tolerance a parent gets when it stops handing its children all its own power. */
const SEEDED_CHILDREN_TOLERANCE_PERCENT = 20;

const GENERIC_PROJECTION_STRATEGIES = [
    { value: "fixed", labelKey: "editor.values.fixed" },
    { value: "history_average", labelKey: "editor.values.history_average" },
];

const USE_MODE_BEHAVIORS = [
    { value: "fixed_max_power", labelKey: "editor.values.fixed_max_power" },
    { value: "surplus_aware", labelKey: "editor.values.surplus_aware" },
];

const APPLIANCE_ICON_SELECTOR = {
    icon: {},
} as const;

const CHEVRON = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";

/**
 * A device's learned energy, as the appliance-energy job reports it: the
 * forecast estimate of a `history_average` device, or what any other device's
 * usage record says -- kWh per hour its signal is on, else a mean day.
 */
export type ApplianceEnergyEstimate =
    | { state: "learned"; kwh: number }
    | { state: "failed"; reason: string }
    | { state: "not_trained" }
    | { state: "recorded"; kwh: number; per: "hour" | "day" };

/**
 * What the editor emits when the reader changes something: the value now at
 * `path`, or `undefined` for a path the edit removed.
 *
 * Mirrors `OptimizerConfigChangedDetail`, narrowed to a path: most edits are
 * one field, and a host applying one field to its *own* latest draft cannot
 * lose an edit that landed after this element last rendered. An edit that
 * reaches past the device -- a new parent, a meterless sibling set's
 * Schedulable -- names the list it rewrote.
 */
export interface DeviceConfigChangedDetail {
    path: PathSegment[];
    value: JsonValue | undefined;
}

/** A number as a depth-table cell, or a dash while it is unknown. */
export function trainingDepthCell(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

/** A device's document path as validation reports it: `devices.consumers[1].children[0]`. */
function validationPath(path: readonly PathSegment[]): string {
    return path
        .map((segment, index) =>
            typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
        )
        .join("");
}

/**
 * The validation issues that point at this device itself.
 *
 * The backend reports a device's issues under its document path --
 * `devices[1].children[2].controls` -- so a card owns every issue under its
 * own path except those under one of its children, which their own cards
 * show. `devices[1].children` itself (a rule about the children as a set) is
 * the parent's.
 */
export function deviceIssues(
    validation: ValidationReport | null,
    path: PathSegment[],
): ValidationIssue[] {
    if (!validation) return [];
    const own = validationPath(path);
    return [...validation.errors, ...validation.warnings].filter(
        (issue) =>
            (issue.path === own || issue.path.startsWith(`${own}.`)) &&
            !issue.path.startsWith(`${own}.children[`),
    );
}

export function renderDeviceIssues(
    validation: ValidationReport | null,
    issues: ValidationIssue[],
): TemplateResult | typeof nothing {
    if (issues.length === 0) return nothing;
    const errors = validation?.errors ?? [];
    return html`
        <ul class="device-issues">
            ${issues.map(
                (issue) => html`
                    <li class="message ${errors.includes(issue) ? "error" : "info"}">
                        <div class="issue-path">${issue.path}</div>
                        <div>${issue.message}</div>
                    </li>
                `,
            )}
        </ul>
    `;
}

export function renderIssueCountBadge(
    host: FormFieldHost,
    validation: ValidationReport | null,
    issues: ValidationIssue[],
): TemplateResult | typeof nothing {
    if (issues.length === 0) return nothing;
    const hasError = issues.some((issue) => validation?.errors.includes(issue));
    return html`
        <span class="device-badge ${hasError ? "error" : "warning"}" data-badge="issues">
            ${host.t("editor.device_badges.issues").replaceAll("{count}", String(issues.length))}
        </span>
    `;
}

/**
 * What the device's `name` or `icon` resolves to when left unset.
 *
 * Answered by the backend through the entity inspection poll -- the host asks
 * about every device's name and icon path -- so the cleaner regex and the
 * fallback order live in one place, `resolve_device_name`. Empty until the
 * first answer.
 */
export function devicePlaceholder(
    inspections: Readonly<Record<string, EntityInspectionResult>>,
    path: PathSegment[],
    field: "name" | "icon",
): string {
    return stringValue(inspections[entityGroupKey([...path, field])]?.draft?.placeholder);
}

/** The override when there is one, else the backend's resolved name, else the id. */
export function deviceName(
    host: Pick<FormFieldHost, "t">,
    inspections: Readonly<Record<string, EntityInspectionResult>>,
    device: JsonObject,
    path: PathSegment[],
): string {
    return (
        stringValue(device.name) ||
        devicePlaceholder(inspections, path, "name") ||
        stringValue(device.id) ||
        host.t("editor.values.missing_id")
    );
}

/** The inspection targets that resolve one device's name and icon. */
export function deviceIdentityTargets(
    path: PathSegment[],
): { key: string; path: PathSegment[]; always: boolean }[] {
    return (["name", "icon"] as const).map((field) => {
        const fieldPath = [...path, field];
        return { key: entityGroupKey(fieldPath), path: fieldPath, always: true };
    });
}

/** Persist the projection default shown for a newly schedulable device. */
function seedDeviceProjection(draft: JsonObject, path: PathSegment[]): void {
    const device = asJsonObject(getValueAtPath(draft, path));
    if (!device || !isSchedulable(device) || deviceKind(device) === "ev_charger") return;
    const projectionPath = [...path, "consumption", "projection"];
    // Configured fields stay; only missing ones are seeded. The backend needs
    // `hourly_energy_kwh` for every strategy (a learner's fallback), so a
    // partial projection gains it too.
    for (const [key, value] of Object.entries(SEEDED_PROJECTION)) {
        if (getValueAtPath(draft, [...projectionPath, key]) === undefined) {
            setValueAtPath(draft, [...projectionPath, key], value);
        }
    }
}

function suggestionPath(path: PathSegment[], field: keyof DeviceSuggestions): PathSegment[] {
    return field === "switch"
        ? [...path, "controls", "switch", "entity_id"]
        : [...path, "consumption", `${field}_entity_id`];
}

/**
 * The entities suggestions may come from, most telling first; empty when
 * the device names none.
 *
 * The backend uses the first one with an HA device, so a helper meter never
 * blocks them. Only the meters and the control the device switches by
 * qualify: a mode or gear select may belong to another integration's device
 * (evcc, the car, the inverter's battery), whose sensors would then be
 * offered, or auto-filled, as this device's meter.
 */
function suggestionAnchors(device: JsonObject): string[] {
    const controls = asJsonObject(device.controls) ?? {};
    const entity = (value: unknown) => stringValue(asJsonObject(value)?.entity_id).trim();
    const anchors = [
        ownMeter(device),
        stringValue(asJsonObject(device.consumption)?.power_entity_id).trim(),
        ...["switch", "charge", "climate"].map((key) => entity(controls[key])),
    ].filter(Boolean);
    return [...new Set(anchors)];
}

/**
 * The device form's own rules. The element renders into its host's tree
 * rather than a shadow root of its own, so a host adopts these next to
 * `configFormStyles`.
 */
export const deviceEditorStyles = css`
    .device-icon {
        flex-shrink: 0;
        --mdc-icon-size: 20px;
        color: var(--secondary-text-color);
    }

    .device-badges {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 6px;
        margin-left: auto;
    }

    .device-badge {
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 0.78rem;
        border: 1px solid var(--divider-color);
        color: var(--secondary-text-color);
        white-space: nowrap;
    }

    .device-badge[data-badge="schedulable"] {
        border-color: var(--primary-color);
        color: var(--primary-color);
    }

    .device-badge.error {
        border-color: var(--error-color);
        color: var(--error-color);
    }

    .device-badge.warning {
        border-color: var(--warning-color, #ef6c00);
        color: var(--warning-color, #ef6c00);
    }

    .device-issues {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 8px;
    }

    .device-id {
        font-family: var(--code-font-family, monospace);
    }
`;

/**
 * One device's card, as an element: the config panel's Devices tab is a tree
 * of these, and the device edit dialog mounts exactly one.
 *
 * The same move `helman-optimizer-editor` made for automations. The form used
 * to be private methods of the config panel, which the card bundle cannot
 * reach; as an element it is one implementation in both places rather than a
 * second, trimmed copy that would drift.
 *
 * ### Why it renders into its host's tree
 *
 * No shadow root: the card is part of the panel's document the way it always
 * was. The panel's entities-only view hides and shows fields with `:has()`
 * rules that have to see into the card, the entity inspection collector finds
 * groups by walking its host's tree, and a card's children are cards of the
 * same kind nested inside it. A shadow root per card would cut all three.
 *
 * ### What it leaves to the host
 *
 * Like the optimizer editor, it edits a clone and reports it, and it owns no
 * part of the document outside what it is editing. The summary's drag handle,
 * YAML toggle and remove (`listActions`), the children list (`renderChildren`)
 * and the YAML editor that replaces the form (`renderYaml`) are the host's:
 * they are list- and document-level state the panel already keeps, and the
 * dialog passes none of them.
 */
export class HelmanDeviceEditor extends LitElement implements FormFieldHost {
    /** The whole config document. Not mutated -- edits are reported, not applied. */
    @property({ attribute: false }) config: JsonObject | null = null;

    /** Where this device sits in the document: `["devices", "consumers", 1, ...]`. */
    @property({ attribute: false }) path: PathSegment[] = [];

    /** The device this one is a child of, or `null` at the top level. */
    @property({ attribute: false }) parent: JsonObject | null = null;

    @property({ attribute: false }) hass?: HomeAssistantLike;

    @property({ type: Boolean }) narrow = false;

    /** Start with the card open. */
    @property({ type: Boolean }) expanded = false;

    @property({ attribute: false }) localize: (key: string) => string = (key) => key;

    /** The last validation report; the card shows the issues under its own path. */
    @property({ attribute: false }) validation: ValidationReport | null = null;

    /** The host's entity readings, keyed by group -- see `EntityInspectionController`. */
    @property({ attribute: false })
    inspections: Readonly<Record<string, EntityInspectionResult>> = {};

    /**
     * What the appliance-energy job learned for this device, or nothing.
     *
     * Only the config panel polls training status, so only it can say; the
     * learned-value line is left out where nobody has asked.
     */
    @property({ attribute: false }) energyEstimate?: ApplianceEnergyEstimate;

    /** The summary row's list controls: drag, YAML toggle, remove. */
    @property({ attribute: false })
    listActions?: (path: PathSegment[]) => TemplateResult;

    /** The children section, below the form. */
    @property({ attribute: false })
    renderChildren?: (device: JsonObject, path: PathSegment[]) => TemplateResult | typeof nothing;

    /** The YAML editor while the host has this device in YAML mode, else `null`. */
    @property({ attribute: false })
    renderYaml?: (path: PathSegment[]) => TemplateResult | null;

    @state() private _help: { labelKey: string; contentKey: string } | null = null;

    /**
     * The suggestions last fetched, bound to the draft they were fetched for.
     *
     * Any other draft -- a field edit, a YAML paste, a reload -- makes them
     * stale, so they are shown only while `draft` is still `config`. `"next"`
     * is this card's own edit on its way through the host: the draft that
     * comes back is the one they now belong to.
     */
    @state() private _suggestions: {
        draft: JsonObject | null | "next";
        value: DeviceSuggestions;
    } | null = null;

    @state() private _suggestionError = "";

    /** A use mode or eco gear rename the document refused. */
    @state() private _renameError = "";

    private _suggestionRequest = 0;

    /**
     * The helman device whose pickers show entities from every HA device.
     *
     * Held as the device's id rather than a flag: the panel's device lists are
     * unkeyed, so after a remove or a reorder this element may be handed a
     * different device, which must not inherit the switch. UI only, never saved.
     */
    @state() private _showAllDevicesFor: string | null = null;

    protected createRenderRoot(): HTMLElement {
        return this;
    }

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("config") && this._suggestions?.draft === "next") {
            this._suggestions = { ...this._suggestions, draft: this.config };
        }
    }

    render(): TemplateResult | typeof nothing {
        const device = asJsonObject(this.getValue(this.path));
        if (!device) return nothing;
        const path = this.path;
        const parent = this.parent;
        const kind = deviceKind(device);
        const id = stringValue(device.id);
        const schedulable = isSchedulable(device);
        const meterless = parent !== null && !ownMeter(device);
        const icon = stringValue(device.icon) || devicePlaceholder(this.inspections, path, "icon");
        const issues = deviceIssues(this.validation, path);
        const yaml = this.renderYaml?.(path) ?? null;
        // The HA device the device's own meters and controls sit under; unless
        // the reader lifted it, its anchor pickers are narrowed to it.
        const anchors = suggestionAnchors(device);
        const haDevice = sharedHaDevice(this.hass, anchors);
        const showAll = this._showAllDevicesFor === id;
        const scope = haDevice && !showAll ? anchors : null;

        return html`
            <details
                class="list-card device-card ${yaml ? "scope-yaml" : ""}"
                data-device-id=${id}
                ?open=${this.expanded}
            >
                <summary>
                    <div class="appliance-summary-row">
                        <div class="appliance-summary-left">
                            ${renderSvgIcon(CHEVRON, "appliance-chevron")}
                            ${icon ? html`<ha-icon class="device-icon" .icon=${icon}></ha-icon>` : nothing}
                            <div class="card-title">
                                <strong>${deviceName(this, this.inspections, device, path)}</strong>
                                <span class="card-subtitle">${id || this.t("editor.values.missing_id")}</span>
                            </div>
                        </div>
                        <div class="device-badges">
                            ${this._renderDeviceBadges(device)}${renderIssueCountBadge(this, this.validation, issues)}
                        </div>
                        ${this.listActions?.(path) ?? nothing}
                    </div>
                </summary>
                <div class="appliance-body">
                    ${renderDeviceIssues(this.validation, issues)}
                    ${yaml ?? html`
                        ${this._renderSuggestions(device, path)}
                        ${this._renameError
                            ? html`<div class="message error">${this._renameError}</div>`
                            : nothing}
                        ${renderSimpleSection(
                            this.t("editor.sections.identity"),
                            html`<div class="field-grid">
                                ${renderOptionalTextField(
                                    this,
                                    [...path, "name"],
                                    "editor.fields.device_name",
                                    "editor.helpers.device_name",
                                    undefined,
                                    devicePlaceholder(this.inspections, path, "name") || id,
                                )}
                                ${this._renderIconField(
                                    [...path, "icon"],
                                    "editor.fields.device_icon",
                                    "editor.helpers.device_icon",
                                    devicePlaceholder(this.inspections, path, "icon"),
                                )}
                                <div class="field">
                                    <div class="field-label-row">
                                        <label>${this.t("editor.fields.device_id")}</label>
                                        ${renderHelpIcon(this, "editor.fields.device_id", "editor.help.device_id")}
                                    </div>
                                    <input class="device-id" .value=${id} readonly />
                                </div>
                                ${this._renderDeviceKindField(kind)}
                                ${this._renderDeviceParentField()}
                                ${haDevice || showAll ? this._renderHaDeviceField(haDevice, id) : nothing}
                            </div>`,
                        )}
                        ${this._renderGroupsSection(device)}
                        ${renderSimpleSection(
                            this.t("editor.sections.measurements"),
                            html`<div class="field-grid">
                                ${this._renderEntityGroup(
                                    [...path, "consumption", "energy_entity_id"],
                                    "editor.fields.consumption_energy_entity",
                                    {
                                        includeDomains: ["sensor"],
                                        sensorKind: "energy",
                                        entityFilter: this._scopeFilter(scope, [...path, "consumption", "energy_entity_id"]),
                                        helperKey: meterless
                                            ? "editor.helpers.consumption_energy_entity_child"
                                            : "editor.helpers.consumption_energy_entity",
                                        helpKey: "editor.help.consumption_energy_entity",
                                        // Only a child may draw from its parent's meter.
                                        required: parent === null,
                                    },
                                )}
                                ${this._renderEntityGroup(
                                    [...path, "consumption", "power_entity_id"],
                                    "editor.fields.consumption_power_entity",
                                    {
                                        includeDomains: ["sensor"],
                                        sensorKind: "power",
                                        entityFilter: this._scopeFilter(scope, [...path, "consumption", "power_entity_id"]),
                                        helperKey: "editor.helpers.consumption_power_entity",
                                    },
                                )}
                                ${this._renderChildrenToleranceField(device)}
                            </div>
                            ${this.energyEstimate?.state === "recorded"
                                ? this._renderEnergyEstimateLine(undefined)
                                : nothing}`,
                        )}
                        ${renderSimpleSection(
                            this.t("editor.sections.controls"),
                            html`<div class="field-grid">
                                ${this._renderSchedulableField(device)}
                                ${this._renderDeviceControls(kind, schedulable || meterless, scope)}
                            </div>`,
                        )}
                        ${schedulable && kind !== "ev_charger"
                            ? this._renderProjectionSection(kind)
                            : nothing}
                        ${kind === "ev_charger" ? this._renderEvChargerSections() : nothing}
                        ${this.renderChildren?.(device, path) ?? nothing}
                    `}
                </div>
            </details>
            ${renderHelpDialog(this, this._help, () => {
                this._help = null;
            })}
        `;
    }

    /** The derived badges of a device's overview row. */
    private _renderDeviceBadges(device: JsonObject): TemplateResult[] {
        const consumption = asJsonObject(device.consumption) ?? {};
        const badges: [boolean, string][] = [
            [!!ownMeter(device), "energy"],
            [stringValue(consumption.power_entity_id) !== "", "power"],
            [hasSwitch(device), "switch"],
            [isSchedulable(device), "schedulable"],
        ];
        return badges
            .filter(([shown]) => shown)
            .map(
                ([, key]) => html`
                    <span class="device-badge" data-badge=${key}>${this.t(`editor.device_badges.${key}`)}</span>
                `,
            );
    }

    private _renderEntityGroup(
        path: PathSegment[],
        labelKey: string,
        options: EntityGroupOptions = {},
    ): TemplateResult {
        return renderEntityGroup(this, this.inspections, path, labelKey, options);
    }

    /**
     * The filter narrowing an anchor picker, or none while unscoped. The HA
     * device comes from the *other* anchors, so a picker's own value never
     * locks it to the device of the entity it is there to replace.
     */
    private _scopeFilter(
        scope: string[] | null,
        path: PathSegment[],
    ): HaEntityPickerEntityFilterFunc | undefined {
        if (!scope) return undefined;
        const own = stringValue(this.getValue(path)).trim();
        const haDevice = sharedHaDevice(this.hass, scope.filter((anchor) => anchor !== own));
        return haDevice ? haDeviceEntityFilter(this.hass, haDevice, own) : undefined;
    }

    /**
     * Which HA device the device's entities belong to, read-only, and the
     * switch that lifts the narrowing. Shown whenever one resolved, and while
     * the switch is on -- an entity picked from another device unresolves it,
     * and the switch must stay reachable to turn narrowing back on.
     */
    private _renderHaDeviceField(haDevice: string | null, id: string): TemplateResult {
        const entry = haDevice ? this.hass?.devices?.[haDevice] : undefined;
        const name = entry?.name_by_user || entry?.name || haDevice || "";
        return html`
            <div class="field toggle-field ha-device-field">
                <label>${this.t("editor.fields.ha_device")}</label>
                <input class="ha-device-name" .value=${name} readonly />
                <ha-formfield .label=${this.t("editor.fields.ha_device_show_all")}>
                    <ha-switch
                        class="ha-device-show-all"
                        .checked=${this._showAllDevicesFor === id}
                        @change=${(event: Event) => {
                            const checked = (event.currentTarget as HTMLElement & { checked: boolean }).checked;
                            this._showAllDevicesFor = checked ? id : null;
                        }}
                    ></ha-switch>
                </ha-formfield>
                <div class="helper">${this.t("editor.helpers.ha_device")}</div>
            </div>
        `;
    }

    private _renderIconField(
        path: PathSegment[],
        labelKey: string,
        helperKey?: string,
        placeholder?: string,
    ): TemplateResult {
        return html`
            <div class="field">
                <ha-selector
                    .hass=${this.hass}
                    .narrow=${this.narrow}
                    .selector=${placeholder ? { icon: { placeholder } } : APPLIANCE_ICON_SELECTOR}
                    .label=${this.t(labelKey)}
                    .helper=${helperKey ? this.t(helperKey) : undefined}
                    .required=${false}
                    .value=${stringValue(this.getValue(path))}
                    @value-changed=${(event: Event) => {
                        const nextValue = (event as CustomEvent<{ value?: string }>).detail?.value ?? "";
                        setOptionalString(this, path, nextValue);
                    }}
                ></ha-selector>
            </div>
        `;
    }

    private async _applySuggestions(device: JsonObject): Promise<void> {
        if (!this.hass || !this.config) return;
        const id = stringValue(device.id);
        const anchors = suggestionAnchors(device);
        if (!anchors.length) return;
        this._suggestionError = "";
        const draft = this.config;
        const hass = this.hass;
        const request = ++this._suggestionRequest;
        try {
            const suggestions = await fetchDeviceSuggestions(hass, anchors, draft);
            if (this.config !== draft || request !== this._suggestionRequest) return;
            const current = iterDevices(draft).find((entry) => entry.device.id === id);
            if (!current) return;
            // A selected meter already belongs to one device.
            suggestions.energy = suggestions.energy.filter(
                (candidate) =>
                    !iterDevices(draft).some(
                        (entry) =>
                            entry.device.id !== id && ownMeter(entry.device) === candidate.entityId,
                    ),
            );
            const energyNeedsPower =
                current.parent !== null &&
                deviceChildren(current.parent).some((child) => child.id !== id && !ownMeter(child)) &&
                !getValueAtPath(draft, suggestionPath(current.path, "power")) &&
                suggestions.power.length !== 1;
            const fills = (["energy", "power", "switch"] as const).flatMap((field) => {
                const fieldPath = suggestionPath(current.path, field);
                if (
                    (field === "switch" && deviceKind(current.device) !== "generic") ||
                    (field === "energy" && energyNeedsPower) ||
                    getValueAtPath(draft, fieldPath) ||
                    suggestions[field].length !== 1
                ) return [];
                return [{ path: fieldPath, entityId: suggestions[field][0].entityId }];
            });
            if (fills.length) {
                this._mutate(current.path, (next) => {
                    for (const fill of fills) setValueAtPath(next, fill.path, fill.entityId);
                });
            }
            this._suggestions = { draft: fills.length ? "next" : draft, value: suggestions };
        } catch (error) {
            if (this.config === draft && request === this._suggestionRequest)
                this._suggestionError = formatError(error, this.t("editor.messages.suggestions_failed"));
        }
    }

    private _renderSuggestions(device: JsonObject, path: PathSegment[]): TemplateResult {
        const suggestions =
            this._suggestions?.draft === this.config ? this._suggestions.value : undefined;
        return html`<div class="device-suggestions">
            <button
                class="add-button apply-suggestions"
                type="button"
                ?disabled=${!suggestionAnchors(device).length}
                @click=${() => this._applySuggestions(device)}
            >
                ${this.t("editor.actions.apply_suggestions")}
            </button>
            ${this._suggestionError
                ? html`<div class="message error">${this._suggestionError}</div>`
                : nothing}
            ${suggestions
                ? (["energy", "power", "switch"] as const).map((field) => {
                      if (field === "switch" && deviceKind(device) !== "generic") return nothing;
                      const fieldPath = suggestionPath(path, field);
                      if (this.getValue(fieldPath) || suggestions[field].length === 0) return nothing;
                      return html`<div class="field">
                          <label>${this.t(`editor.suggestions.${field}`)}</label>
                          <select
                              class="suggestion-candidates"
                              data-field=${field}
                              @change=${(event: Event) => {
                                  const value = (event.currentTarget as HTMLSelectElement).value;
                                  if (
                                      value &&
                                      !this.getValue(fieldPath) &&
                                      suggestions[field].some((candidate) => candidate.entityId === value)
                                  ) {
                                      setRequiredString(this, fieldPath, value);
                                      this._suggestions = { draft: "next", value: suggestions };
                                  }
                              }}
                          >
                              <option value="">${this.t("editor.suggestions.choose")}</option>
                              ${suggestions[field].map((candidate) => html`<option value=${candidate.entityId}>${candidate.name} (${candidate.entityId}) — ${candidate.reasons.map((reason) => this._tFormat(`editor.suggestions.reasons.${reason.code}`, { value: reason.value ?? "" })).join(", ")}</option>`)}
                          </select>
                      </div>`;
                  })
                : nothing}
        </div>`;
    }

    /**
     * The device's own group in each grouping: a badge per assigned group, and
     * one picker per grouping to add, change or remove it. Only for consumers
     * (a system device is never grouped), and only once a grouping exists.
     */
    private _renderGroupsSection(device: JsonObject): TemplateResult | typeof nothing {
        const path = this.path;
        const groupings = (asJsonArray(asJsonObject(this.config?.devices)?.groupings) ?? []).flatMap((value) => {
            const grouping = asJsonObject(value);
            return grouping ? [grouping] : [];
        });
        if (path[1] !== "consumers" || groupings.length === 0) return nothing;
        const rows = groupings.map((grouping) => {
            const groupingId = stringValue(grouping.id);
            const groups = (asJsonArray(grouping.groups) ?? []).flatMap((value) => {
                const group = asJsonObject(value);
                return group ? [group] : [];
            });
            const current = ownGroup(device, groupingId) ?? "";
            return { grouping, groupingId, groups, current, group: groups.find((group) => group.id === current) };
        });
        const assigned = rows.filter((row) => row.current);
        const badge = assigned.length
            ? html`<div class="device-badges">
                  ${assigned.map(
                      (row) => html`<span class="device-badge" data-badge="group">
                          ${stringValue(row.group?.name) || row.current}
                      </span>`,
                  )}
              </div>`
            : undefined;
        return renderSimpleSection(
            this.t("editor.sections.groups"),
            html`<div class="field-grid">
                ${rows.map(
                    ({ grouping, groupingId, groups, current, group }) => html`
                        <div class="field">
                            <label>${stringValue(grouping.name) || groupingId}</label>
                            <select
                                class="device-group"
                                data-grouping-id=${groupingId}
                                .value=${live(current)}
                                @change=${(event: Event) => {
                                    const value = (event.currentTarget as HTMLSelectElement).value;
                                    this._mutate(path, (draft) => assignGroup(draft, path, groupingId, value || null));
                                }}
                            >
                                <option value="" ?selected=${current === ""}>
                                    ${this.t("editor.device_groups.none")}
                                </option>
                                ${groups.map((option) => {
                                    const optionId = stringValue(option.id);
                                    return html`
                                        <option value=${optionId} ?selected=${optionId === current}>
                                            ${stringValue(option.name) || optionId}
                                        </option>
                                    `;
                                })}
                                ${current && !group
                                    ? html`<option value=${current} selected>${current}</option>`
                                    : nothing}
                            </select>
                        </div>
                    `,
                )}
            </div>`,
            { open: false, badge },
        );
    }

    private _renderDeviceKindField(kind: string): TemplateResult {
        const path = this.path;
        return html`
            <div class="field">
                <label>${this.t("editor.fields.kind")}</label>
                <select
                    class="device-kind"
                    @change=${(event: Event) =>
                        this._mutate(path, (draft) => {
                            const nextKind = (event.currentTarget as HTMLSelectElement).value;
                            if (nextKind !== kind) unsetValueAtPath(draft, [...path, "controls"]);
                            setValueAtPath(draft, [...path, "kind"], nextKind);
                            seedDeviceProjection(draft, path);
                        })}
                >
                    ${EDITABLE_DEVICE_KINDS.map(
                        (option) => html`
                            <option value=${option} ?selected=${option === kind}>
                                ${this.t(`editor.values.kind_${option}`)}
                            </option>
                        `,
                    )}
                </select>
            </div>
        `;
    }

    /**
     * Where the device sits: at the top level or under a device.
     *
     * Offers only consumers that can hold children (they own a meter and are not
     * schedulable), never the device itself or anything under it, plus the
     * current parent whatever it is, so the select never misstates it.
     */
    private _renderDeviceParentField(): TemplateResult {
        const path = this.path;
        const key = entityGroupKey(path);
        const parentKey = this.parent ? entityGroupKey(path.slice(0, -2)) : "";
        const candidates = iterDevices(this.config).filter((entry) => {
            // A system device never nests or holds children.
            if (entry.path[1] !== "consumers") return false;
            const candidateKey = entityGroupKey(entry.path);
            if (candidateKey === key || candidateKey.startsWith(`${key}.`)) return false;
            return candidateKey === parentKey || canHaveChildren(entry.device);
        });
        return html`
            <div class="field">
                <label>${this.t("editor.fields.parent")}</label>
                <select
                    class="device-parent"
                    @change=${(event: Event) =>
                        this._moveDeviceUnder((event.currentTarget as HTMLSelectElement).value)}
                >
                    <option value="" ?selected=${parentKey === ""}>
                        ${this.t("editor.values.top_level")}
                    </option>
                    ${candidates.map((entry) => {
                        const candidateKey = entityGroupKey(entry.path);
                        return html`
                            <option value=${candidateKey} ?selected=${candidateKey === parentKey}>
                                ${deviceName(this, this.inspections, entry.device, entry.path)}
                            </option>
                        `;
                    })}
                </select>
                <div class="helper">${this.t("editor.helpers.parent")}</div>
            </div>
        `;
    }

    /**
     * Move the device, with everything under it, to the end of another
     * parent's children.
     *
     * The one edit that rewrites the consumer tree rather than this device, so
     * it is reported as the whole `devices.consumers` list.
     */
    private _moveDeviceUnder(parentKey: string): void {
        const path = this.path;
        const currentParentKey = path.length > 3 ? entityGroupKey(path.slice(0, -2)) : "";
        if (parentKey === currentParentKey) return;
        const target = parentKey
            ? iterDevices(this.config).find((entry) => entityGroupKey(entry.path) === parentKey)
            : undefined;
        const device = this.getValue(path);
        if ((parentKey && !target) || device === undefined) return;
        this._mutate(["devices", "consumers"], (draft) => {
            // Appended first: appending never shifts an existing index, so `path`
            // still names the device when it is removed.
            appendListItem(
                draft,
                target ? [...target.path, "children"] : ["devices", "consumers"],
                cloneJson(device as JsonValue),
            );
            removeListItem(draft, path.slice(0, -1), path[path.length - 1] as number);
        });
    }

    /**
     * The one flag a device carries: may Helman plan and run it.
     *
     * A meterless child's siblings are all schedulable or all passive, so on one
     * of them the toggle sets the whole set. A device with children cannot be
     * schedulable (a schedulable device is a leaf), so there it is disabled --
     * unless it is on, which only a hand edit can do, and then it may be turned off.
     */
    private _renderSchedulableField(device: JsonObject): TemplateResult {
        const parent = this.parent;
        const checked = isSchedulable(device);
        const hasChildren = deviceChildren(device).length > 0;
        const meterless = parent !== null && !ownMeter(device);
        const siblings = meterless && parent ? meterlessChildren(parent).length : 0;
        const note = hasChildren
            ? this.t("editor.helpers.schedulable_has_children")
            : siblings > 1
              ? this._tFormat("editor.helpers.schedulable_siblings", { count: siblings })
              : "";
        return html`
            <div class="field toggle-field schedulable-field">
                <div class="field-label-row">
                    <ha-formfield .label=${this.t("editor.fields.schedulable")}>
                        <ha-switch
                            .checked=${checked}
                            ?disabled=${hasChildren && !checked}
                            @change=${(event: Event) =>
                                this._setSchedulable(
                                    meterless,
                                    (event.currentTarget as HTMLElement & { checked: boolean }).checked,
                                )}
                        ></ha-switch>
                    </ha-formfield>
                    ${renderHelpIcon(this, "editor.fields.schedulable", "editor.help.schedulable")}
                </div>
                <div class="helper">${this.t("editor.helpers.schedulable")}</div>
                ${note ? html`<div class="helper schedulable-note">${note}</div>` : nothing}
            </div>
        `;
    }

    /**
     * Whether a parent hands its meterless children all of its own power, in
     * the ratio of their learned power, or caps each at that plus a tolerance.
     *
     * Only on a parent with meterless children and a power sensor: without the
     * sensor there is no unmeasured row, so a capped excess would have nowhere
     * to show. Turning the switch off writes the tolerance, which the field
     * below it then edits; turning it on removes the key.
     */
    private _renderChildrenToleranceField(device: JsonObject): TemplateResult | typeof nothing {
        const consumption = asJsonObject(device.consumption) ?? {};
        if (!meterlessChildren(device).length || !stringValue(consumption.power_entity_id).trim()) {
            return nothing;
        }
        const path: PathSegment[] = [...this.path, "consumption", "children_tolerance_percent"];
        const distributeAll = consumption.children_tolerance_percent === undefined;
        return html`
            <div class="field toggle-field children-distribute-field">
                <div class="field-label-row">
                    <ha-formfield .label=${this.t("editor.fields.children_distribute_all")}>
                        <ha-switch
                            .checked=${distributeAll}
                            @change=${(event: Event) =>
                                this.setValue(
                                    path,
                                    (event.currentTarget as HTMLElement & { checked: boolean }).checked
                                        ? undefined
                                        : SEEDED_CHILDREN_TOLERANCE_PERCENT,
                                )}
                        ></ha-switch>
                    </ha-formfield>
                    ${renderHelpIcon(this, "editor.fields.children_distribute_all", "editor.help.children_distribute_all")}
                </div>
                <div class="helper">${this.t("editor.helpers.children_distribute_all")}</div>
            </div>
            ${distributeAll
                ? nothing
                : renderRequiredNumberField(
                      this,
                      path,
                      "editor.fields.children_tolerance_percent",
                      undefined,
                      "any",
                      "editor.help.children_tolerance_percent",
                  )}
        `;
    }

    private _setSchedulable(meterless: boolean, value: boolean): void {
        const path = this.path;
        const listPath = path.slice(0, -1);
        const targets = meterless
            ? (asJsonArray(this.getValue(listPath)) ?? []).flatMap((sibling, index) => {
                  const object = asJsonObject(sibling);
                  return object && !ownMeter(object) ? [[...listPath, index]] : [];
              })
            : [path];
        this._mutate(meterless ? listPath : path, (draft) => {
            for (const target of targets) {
                if (value) {
                    setValueAtPath(draft, [...target, "schedulable"], true);
                    seedDeviceProjection(draft, target);
                } else {
                    unsetValueAtPath(draft, [...target, "schedulable"]);
                }
            }
        });
    }

    /**
     * The kind's controls, always editable: a passive device may still have a
     * switch, and a meterless child needs its switch or climate entity as the
     * running signal its share of the parent's meter follows.
     */
    private _renderDeviceControls(kind: string, required: boolean, scope: string[] | null): TemplateResult {
        const path = this.path;
        const controlsPath: PathSegment[] = [...path, "controls"];
        // Only the control the device switches by is narrowed: a mode or gear
        // select may belong to another integration's device.
        const anchor = (key: string): PathSegment[] => [...controlsPath, key, "entity_id"];
        if (kind === "climate") {
            return this._renderEntityGroup(
                anchor("climate"),
                "editor.fields.climate_entity",
                { includeDomains: ["climate"], entityFilter: this._scopeFilter(scope, anchor("climate")), helpKey: "editor.help.appliance_climate_entity", required },
            );
        }
        if (kind === "ev_charger") {
            return html`
                ${this._renderEntityGroup(
                    anchor("charge"),
                    "editor.fields.charge_switch_entity",
                    { includeDomains: ["switch"], entityFilter: this._scopeFilter(scope, anchor("charge")), helpKey: "editor.help.ev_charge_switch_entity", required },
                )}
                ${this._renderEntityGroup(
                    [...controlsPath, "use_mode", "entity_id"],
                    "editor.fields.use_mode_entity",
                    { includeDomains: ["input_select", "select"], helpKey: "editor.help.ev_use_mode_entity", required },
                )}
                ${this._renderEntityGroup(
                    [...controlsPath, "eco_gear", "entity_id"],
                    "editor.fields.eco_gear_entity",
                    { includeDomains: ["input_select", "select"], helpKey: "editor.help.ev_eco_gear_entity", required },
                )}
                ${renderRequiredNumberField(this, [...path, "limits", "max_charging_power_kw"], "editor.fields.max_charging_power_kw", undefined, "any", "editor.help.ev_max_charging_power_kw")}
            `;
        }
        return this._renderEntityGroup(
            anchor("switch"),
            "editor.fields.switch_entity",
            { includeDomains: [...SWITCH_CONTROL_DOMAINS], entityFilter: this._scopeFilter(scope, anchor("switch")), helpKey: "editor.help.appliance_switch_entity", required },
        );
    }

    /** The EV charger's own lists: use modes, eco gears and vehicles. */
    private _renderEvChargerSections(): TemplateResult {
        const path = this.path;
        const useModes = objectEntries(this.getValue([...path, "controls", "use_mode", "values"]));
        const ecoGears = objectEntries(this.getValue([...path, "controls", "eco_gear", "values"]));
        const vehicles = asJsonArray(this.getValue([...path, "vehicles"])) ?? [];
        return html`
            ${renderSimpleSection(
                this.t("editor.sections.use_modes"),
                html`<div class="list-stack">
                    ${useModes.map(([modeKey, modeConfig]) => this._renderUseMode(modeKey, modeConfig))}
                </div>
                <div class="section-footer">
                    <button type="button" class="add-button" @click=${() => this._addUseMode()}>${this.t("editor.actions.add_use_mode")}</button>
                </div>`,
            )}
            ${renderSimpleSection(
                this.t("editor.sections.eco_gears"),
                html`<div class="list-stack">
                    ${ecoGears.map(([gearKey, gearConfig]) => this._renderEcoGear(gearKey, gearConfig))}
                </div>
                <div class="section-footer">
                    <button type="button" class="add-button" @click=${() => this._addEcoGear()}>${this.t("editor.actions.add_eco_gear")}</button>
                </div>`,
            )}
            ${renderSimpleSection(
                this.t("editor.sections.vehicles"),
                html`${renderSortableList({
                    items: vehicles,
                    containerClass: "list-stack",
                    renderItem: (vehicle, vehicleIndex) => this._renderVehicle(vehicle, vehicleIndex),
                    onMove: (oldIndex, newIndex) =>
                        this._mutate(path, (draft) =>
                            moveListItem(draft, [...path, "vehicles"], oldIndex, newIndex),
                        ),
                })}
                <div class="section-footer">
                    <button type="button" class="add-button" @click=${() => this._addVehicle()}>${this.t("editor.actions.add_vehicle")}</button>
                </div>`,
            )}
        `;
    }

    /**
     * A schedulable device's demand projection. Whether its meter is carved out
     * of the house baseline is not a setting here: it follows `schedulable`.
     */
    private _renderProjectionSection(kind: string): TemplateResult {
        const path = this.path;
        const projectionPath: PathSegment[] = [...path, "consumption", "projection"];
        const strategy = stringValue(this.getValue([...projectionPath, "strategy"])) || "fixed";
        return renderSimpleSection(
            this.t("editor.sections.projection"),
            html`
                <p class="inline-note">
                    ${this.t(
                        kind === "climate"
                            ? "editor.notes.climate_appliance_projection"
                            : "editor.notes.generic_appliance_projection",
                    )}
                </p>
                <div class="field-grid">
                    <div class="field">
                        <div class="field-label-row">
                            <label>${this.t("editor.fields.projection_strategy")}</label>
                            ${renderHelpIcon(this, "editor.fields.projection_strategy", "editor.help.appliance_projection_strategy")}
                        </div>
                        <select
                            class="projection-strategy"
                            @change=${(event: Event) =>
                                this._setProjectionStrategy((event.currentTarget as HTMLSelectElement).value)}
                        >
                            ${GENERIC_PROJECTION_STRATEGIES.map(
                                (option) => html`
                                    <option value=${option.value} ?selected=${option.value === strategy}>
                                        ${this.t(option.labelKey)}
                                    </option>
                                `,
                            )}
                        </select>
                    </div>
                    ${renderRequiredNumberField(
                        this,
                        [...projectionPath, "hourly_energy_kwh"],
                        strategy === "history_average"
                            ? "editor.fields.fallback_hourly_energy_kwh"
                            : "editor.fields.hourly_energy_kwh",
                        undefined,
                        "any",
                        "editor.help.appliance_hourly_energy_kwh",
                    )}
                    ${strategy === "history_average"
                        ? renderRequiredNumberField(
                              this,
                              [...projectionPath, "lookback_days"],
                              "editor.fields.history_lookback_days",
                              undefined,
                              "1",
                              "editor.help.appliance_history_lookback_days",
                          )
                        : nothing}
                </div>
                ${strategy === "history_average"
                    ? this._renderEnergyEstimateLine(this.getValue([...projectionPath, "hourly_energy_kwh"]))
                    : nothing}
            `,
        );
    }

    private _setProjectionStrategy(strategy: string): void {
        if (!["fixed", "history_average"].includes(strategy)) {
            return;
        }
        const path = this.path;
        this._mutate(path, (draft) => {
            const basePath: PathSegment[] = [...path, "consumption", "projection"];
            setValueAtPath(draft, [...basePath, "strategy"], strategy);
            if (strategy !== "history_average") {
                return;
            }

            // Only the window is seeded. The meter lives on the consumption block
            // now, where it may already have been picked for the baseline split
            // alone — writing it from here would either clobber that or invent an
            // empty one.
            const existingLookbackDays = getValueAtPath(draft, [...basePath, "lookback_days"]);
            if (typeof existingLookbackDays !== "number" || !Number.isFinite(existingLookbackDays)) {
                setValueAtPath(draft, [...basePath, "lookback_days"], 30);
            }
        });
    }

    /**
     * The learned figure, read-only: the one a `history_average` device
     * projects with, under its Projection settings, or any other device's
     * recorded average, under its Measurements.
     *
     * Same source as the Training tab's appliance table, so the two agree. The
     * fallback is the draft's `hourly_energy_kwh`, the figure the backend uses
     * until an estimate exists.
     */
    private _renderEnergyEstimateLine(fallbackKwh: unknown): TemplateResult | typeof nothing {
        const estimate = this.energyEstimate;
        if (!estimate) return nothing;
        const kwh = trainingDepthCell(fallbackKwh);
        const text =
            estimate.state === "recorded"
                ? this._tFormat(`editor.appliance_estimate.recorded_${estimate.per}`, {
                      kwh: estimate.kwh.toFixed(2),
                  })
                : estimate.state === "learned"
                ? this._tFormat("editor.appliance_estimate.learned", { kwh: estimate.kwh.toFixed(2) })
                : estimate.state === "failed"
                  ? this._tFormat("editor.appliance_estimate.failed", { reason: estimate.reason, kwh })
                  : this._tFormat("editor.appliance_estimate.not_trained", { kwh });
        return html`<p class="inline-note appliance-energy-estimate">${text}</p>`;
    }

    private _renderUseMode(modeKey: string, modeConfig: unknown): TemplateResult {
        const modeObject = asJsonObject(modeConfig) ?? {};
        const valuesPath: PathSegment[] = [...this.path, "controls", "use_mode", "values"];
        return html`
            <div class="nested-card">
                <div class="card-header">
                    <div class="card-title">
                        <strong>${modeKey}</strong>
                        <span class="card-subtitle">${this.t("editor.card.use_mode_mapping")}</span>
                    </div>
                    <div class="inline-actions">
                        <button
                            type="button"
                            class="danger"
                            @click=${() => this.setValue([...valuesPath, modeKey], undefined)}
                        >
                            ${this.t("editor.actions.remove")}
                        </button>
                    </div>
                </div>
                <div class="field-grid">
                    <div class="field">
                        <label>${this.t("editor.fields.mode_id")}</label>
                        <input
                            .value=${modeKey}
                            @change=${(event: Event) =>
                                this._renameKey(
                                    valuesPath,
                                    modeKey,
                                    (event.currentTarget as HTMLInputElement).value,
                                )}
                        />
                    </div>
                    <div class="field">
                        <label>${this.t("editor.fields.behavior")}</label>
                        <select
                            @change=${(event: Event) =>
                                setRequiredString(
                                    this,
                                    [...valuesPath, modeKey, "behavior"],
                                    (event.currentTarget as HTMLSelectElement).value,
                                )}
                        >
                            ${USE_MODE_BEHAVIORS.map(
                                (option) => html`
                                    <option
                                        value=${option.value}
                                        ?selected=${option.value ===
                                        (stringValue(modeObject.behavior) || "fixed_max_power")}
                                    >${this.t(option.labelKey)}</option>
                                `,
                            )}
                        </select>
                    </div>
                </div>
            </div>
        `;
    }

    private _renderEcoGear(gearKey: string, gearConfig: unknown): TemplateResult {
        const gearObject = asJsonObject(gearConfig) ?? {};
        const valuesPath: PathSegment[] = [...this.path, "controls", "eco_gear", "values"];
        return html`
            <div class="nested-card">
                <div class="card-header">
                    <div class="card-title">
                        <strong>${gearKey}</strong>
                        <span class="card-subtitle">${this.t("editor.card.eco_gear_mapping")}</span>
                    </div>
                    <div class="inline-actions">
                        <button
                            type="button"
                            class="danger"
                            @click=${() => this.setValue([...valuesPath, gearKey], undefined)}
                        >
                            ${this.t("editor.actions.remove")}
                        </button>
                    </div>
                </div>
                <div class="field-grid">
                    <div class="field">
                        <label>${this.t("editor.fields.gear_id")}</label>
                        <input
                            .value=${gearKey}
                            @change=${(event: Event) =>
                                this._renameKey(
                                    valuesPath,
                                    gearKey,
                                    (event.currentTarget as HTMLInputElement).value,
                                )}
                        />
                    </div>
                    ${renderRequiredNumberField(
                        this,
                        [...valuesPath, gearKey, "min_power_kw"],
                        "editor.fields.min_power_kw",
                        gearObject.min_power_kw,
                    )}
                </div>
            </div>
        `;
    }

    private _renderVehicle(vehicle: unknown, index: number): TemplateResult {
        const vehicleObject = asJsonObject(vehicle) ?? {};
        const listPath: PathSegment[] = [...this.path, "vehicles"];
        const basePath: PathSegment[] = [...listPath, index];
        return html`
            <div class="nested-card">
                <div class="card-header">
                    <div class="appliance-summary-left">
                        ${renderDragHandle(this)}
                        <div class="card-title">
                            <strong>${stringValue(vehicleObject.name) || this._tFormat("editor.dynamic.vehicle", { index: index + 1 })}</strong>
                            <span class="card-subtitle">${stringValue(vehicleObject.id) || this.t("editor.values.missing_id")}</span>
                        </div>
                    </div>
                    <div class="list-actions">
                        ${renderRemoveButton(this, {
                            onRemove: () =>
                                this._mutate(this.path, (draft) => removeListItem(draft, listPath, index)),
                        })}
                    </div>
                </div>
                <div class="field-grid">
                    ${renderRequiredTextField(this, [...basePath, "id"], "editor.fields.vehicle_id", undefined, "editor.help.vehicle_id")}
                    ${renderRequiredTextField(this, [...basePath, "name"], "editor.fields.vehicle_name")}
                    ${this._renderEntityGroup(
                        [...basePath, "telemetry", "soc_entity_id"],
                        "editor.fields.soc_entity",
                        {
                            includeDomains: ["sensor"],
                            sensorKind: "soc",
                            helpKey: "editor.help.vehicle_soc_entity",
                            required: true,
                        },
                    )}
                    ${this._renderEntityGroup(
                        [...basePath, "telemetry", "charge_limit_entity_id"],
                        "editor.fields.charge_limit_entity",
                        {
                            includeDomains: ["number"],
                            helpKey: "editor.help.vehicle_charge_limit_entity",
                        },
                    )}
                    ${renderRequiredNumberField(
                        this,
                        [...basePath, "limits", "battery_capacity_kwh"],
                        "editor.fields.battery_capacity_kwh",
                        undefined,
                        "any",
                        "editor.help.vehicle_battery_capacity_kwh",
                    )}
                    ${renderRequiredNumberField(
                        this,
                        [...basePath, "limits", "max_charging_power_kw"],
                        "editor.fields.max_charging_power_kw",
                        undefined,
                        "any",
                        "editor.help.vehicle_max_charging_power_kw",
                    )}
                </div>
            </div>
        `;
    }

    private _addVehicle(): void {
        const vehiclePath: PathSegment[] = [...this.path, "vehicles"];
        const existingIds = (asJsonArray(this.getValue(vehiclePath)) ?? [])
            .map((vehicle) => stringValue(asJsonObject(vehicle)?.id))
            .filter((value) => value.length > 0);
        this._mutate(this.path, (draft) => {
            appendListItem(
                draft,
                vehiclePath,
                createVehicleDraft(
                    existingIds,
                    this._tFormat("editor.dynamic.vehicle", { index: existingIds.length + 1 }),
                ),
            );
        });
    }

    private _addUseMode(): void {
        const path: PathSegment[] = [...this.path, "controls", "use_mode", "values"];
        const modeKey = createModeKey(objectEntries(this.getValue(path)).map(([key]) => key));
        this.setValue([...path, modeKey], createUseModeEntry());
    }

    private _addEcoGear(): void {
        const path: PathSegment[] = [...this.path, "controls", "eco_gear", "values"];
        const gearKey = createGearKey(objectEntries(this.getValue(path)).map(([key]) => key));
        this.setValue([...path, gearKey], createEcoGearEntry());
    }

    /** Rename a use mode or eco gear, keeping its place; a refusal is shown on the card. */
    private _renameKey(path: PathSegment[], currentKey: string, nextKeyRaw: string): void {
        const nextKey = nextKeyRaw.trim();
        if (!nextKey || nextKey === currentKey || !this.config) {
            return;
        }
        const draft = cloneJson(this.config);
        const result = renameObjectKey(draft, path, currentKey, nextKey);
        if (!result.ok) {
            this._renameError = renameObjectKeyError(this, result);
            return;
        }
        this._emit(path, getValueAtPath(draft, path) as JsonValue | undefined);
    }

    /**
     * Apply `mutator` to a clone of the document and report what is now at
     * `scope` -- the device itself, or the list an edit reaching past it rewrote.
     */
    /** A mutator returning `false` changed nothing, so no edit is reported. */
    private _mutate(scope: PathSegment[], mutator: (draft: JsonObject) => void | boolean): void {
        const draft = cloneJson(this.config ?? {});
        if (mutator(draft) === false) return;
        this._emit(scope, getValueAtPath(draft, scope) as JsonValue | undefined);
    }

    /**
     * Report an edit to whoever mounted the card. Any edit clears a refused
     * rename's message, as the panel's shared message used to be cleared.
     *
     * Not bubbling: a child card sits inside its parent's, and the parent's
     * host listener must not hear the child's edit a second time.
     */
    private _emit(path: PathSegment[], value: JsonValue | undefined): void {
        this._renameError = "";
        this.dispatchEvent(
            new CustomEvent<DeviceConfigChangedDetail>("device-config-changed", {
                detail: { path, value: value === undefined ? undefined : cloneJson(value) },
            }),
        );
    }

    // --- FormFieldHost -------------------------------------------------------

    t(key: string): string {
        return this.localize(key);
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
        this._emit(path, value);
    }

    openHelp(labelKey: string, contentKey: string): void {
        this._help = { labelKey, contentKey };
    }
}

defineOnce("helman-device-editor", HelmanDeviceEditor);

declare global {
    interface HTMLElementTagNameMap {
        "helman-device-editor": HelmanDeviceEditor;
    }
}
