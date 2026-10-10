import {
    css,
    html,
    nothing,
    type ReactiveController,
    type ReactiveControllerHost,
    type TemplateResult,
} from "lit";

import { asJsonObject, canonicalJson, setValueAtPath, unsetValueAtPath } from "../config/config-document";
import { findInverter, INVERTER_PATH, iterDevices, validationPath } from "../config/devices";
import { renderHelpIcon, stringValue, type FormFieldHost } from "../config/form-fields";
import type {
    HomeAssistantLike,
    JsonObject,
    PathSegment,
    VendorProfileInfo,
    VendorsResponse,
} from "../config/types";

/**
 * A device's hardware profile, as the editor shows it: one implementation for
 * the config panel's inverter section, the device card and the device edit
 * dialog.
 *
 * `helman/get_vendors` is the only place the editor learns which paths a
 * profile owns and what they resolve to; {@link VendorsController} asks it
 * again whenever a draft device's `profile` changes. "Custom" is the absence
 * of `profile`, so a device without one keeps every hand-mapped slot.
 */

/** What the hardware profile UI needs of its host, beyond the form primitives. */
export interface HardwareProfileHost extends FormFieldHost {
    /** Apply one edit to the host's draft. */
    mutateDraft(mutator: (draft: JsonObject) => void): void;
}

/** Which profile provides a path, and the entity it resolves to. */
export interface VendorProvision {
    label: string;
    entityId: string | null;
}

/** The profile UI's own rules; a host adopts these next to `configFormStyles`. */
export const hardwareProfileStyles = css`
    /* A slot a hardware profile fills: read-only, where its picker would be. */
    .vendor-provided-entity {
        font-family: var(--code-font-family, monospace);
        overflow-wrap: anywhere;
    }

    .vendor-resolved ul {
        margin: 6px 0 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 4px;
    }

    .vendor-resolved li {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
        justify-content: space-between;
        overflow-wrap: anywhere;
    }

    .vendor-resolved .unresolved,
    .vendor-provided-entity.unresolved {
        color: var(--error-color);
    }
`;

/** Every draft device carrying a `profile`, the inverter first, as the backend walks them. */
function profileDevices(config: JsonObject | null | undefined): { device: JsonObject; path: PathSegment[] }[] {
    const inverter = findInverter(config);
    return [
        ...(inverter ? [{ device: inverter, path: [...INVERTER_PATH] }] : []),
        ...iterDevices(config),
    ].filter(({ device }) => device.profile !== undefined);
}

/** What `helman/get_vendors` answers from: each device's path and `profile`. */
function vendorsKey(config: JsonObject): string {
    return canonicalJson(
        profileDevices(config).map(({ device, path }) => [validationPath(path), device.profile]),
    );
}

/**
 * The hardware profiles, and what each draft device's profile owns, for a
 * host holding a draft.
 *
 * Re-asked on the host's update whenever a device's `profile` changes in the
 * draft. Until the new answer arrives nothing is owned: an answer for another
 * draft would keep hiding the fields of a device just switched back to
 * Custom, or name paths a reorder has given to another device.
 */
export class VendorsController implements ReactiveController {
    /** The last answer; `null` before it and after a failed one, which is the Custom editor. */
    vendors: VendorsResponse | null = null;

    private _key: string | null = null;

    private _sequence = 0;

    constructor(
        private readonly _host: ReactiveControllerHost,
        private readonly _options: {
            hass: () => HomeAssistantLike | undefined;
            config: () => JsonObject | null;
        },
    ) {
        _host.addController(this);
    }

    hostUpdate(): void {
        const config = this._options.config();
        if (config && vendorsKey(config) !== this._key) void this.load(config);
    }

    /** Ask about `config` now; what the answer is, also once a later ask has superseded it. */
    async load(config: JsonObject): Promise<VendorsResponse | null> {
        const hass = this._options.hass();
        if (!hass) return null;
        this._key = vendorsKey(config);
        if (this.vendors) this.vendors = { ...this.vendors, devices: {} };
        const sequence = ++this._sequence;
        let vendors: VendorsResponse | null = null;
        try {
            vendors = await hass.callWS<VendorsResponse>({ type: "helman/get_vendors", config });
        } catch {
            // Without an answer nothing is owned.
        }
        if (sequence === this._sequence) {
            this.vendors = vendors;
            this._host.requestUpdate();
        }
        return vendors;
    }
}

function tFormat(host: FormFieldHost, key: string, values: Record<string, string>): string {
    let text = host.t(key);
    for (const [name, value] of Object.entries(values)) {
        text = text.replaceAll(`{${name}}`, value);
    }
    return text;
}

/** The known profile a device's `profile` names, if any. */
export function deviceProfile(
    vendors: VendorsResponse | null | undefined,
    device: JsonObject,
): VendorProfileInfo | undefined {
    const profileId = stringValue(asJsonObject(device.profile)?.id);
    return profileId ? vendors?.profiles?.find((profile) => profile.id === profileId) : undefined;
}

/**
 * Which profile provides a path, and the entity it resolves to.
 *
 * A path under one of a device's owned paths counts too, such as the
 * inverter's `controls.mode.entity_id`. `null` when no draft device's profile
 * owns the path, which is every path under "Custom".
 */
export function vendorProvision(
    vendors: VendorsResponse | null | undefined,
    path: PathSegment[],
): VendorProvision | null {
    const dotted = validationPath(path);
    for (const [devicePath, device] of Object.entries(vendors?.devices ?? {})) {
        const owned =
            device.ownedConfigPaths?.includes(dotted) ||
            device.ownedDevicePaths?.some((relative) => {
                const ownedPath = `${devicePath}.${relative}`;
                return dotted === ownedPath || dotted.startsWith(`${ownedPath}.`);
            });
        if (!owned) continue;
        const profile = vendors?.profiles?.find((option) => option.id === device.profile);
        return {
            label: profile?.label ?? device.profile,
            entityId: device.resolved?.[dotted] ?? null,
        };
    }
    return null;
}

/**
 * `vendorProvision` for a path of `device`, also while `get_vendors` answers
 * again: a path the device's stored profile owns stays owned, its entity not
 * yet known, rather than turning into an editable picker for a moment.
 */
export function deviceProvision(
    vendors: VendorsResponse | null | undefined,
    device: JsonObject,
    devicePath: PathSegment[],
    path: PathSegment[],
): VendorProvision | null {
    const provision = vendorProvision(vendors, path);
    if (provision) return provision;
    const profile = deviceProfile(vendors, device);
    const dotted = validationPath(path);
    const owned = profile?.ownedDevicePaths.some((relative) => {
        const ownedPath = `${validationPath(devicePath)}.${relative}`;
        return dotted === ownedPath || dotted.startsWith(`${ownedPath}.`);
    });
    return profile && owned ? { label: profile.label, entityId: null } : null;
}

/** An owned entity slot, where its picker would be: read-only, flagged if unresolved. */
export function renderProvidedField(
    host: FormFieldHost,
    path: PathSegment[],
    labelKey: string,
    provision: VendorProvision,
    slotted: TemplateResult | typeof nothing = nothing,
): TemplateResult {
    return html`
        <div class="field vendor-provided" data-path=${validationPath(path)}>
            <label>${host.t(labelKey)}</label>
            <div class="inline-note">${tFormat(host, "editor.dynamic.provided_by", { profile: provision.label })}</div>
            <div class=${provision.entityId ? "vendor-provided-entity" : "vendor-provided-entity unresolved"}>
                ${provision.entityId ?? host.t("editor.dynamic.vendor_entity_unresolved")}
            </div>
            ${slotted}
        </div>
    `;
}

/**
 * A device's hardware profile: the picker, what the profile binds to, and
 * every entity it fills in, read-only.
 *
 * Only the profiles of the device's `kind` are offered besides Custom. An
 * entry-bound profile binds to a config entry of its integration, a
 * device-bound one to an HA device, picked in the same place.
 */
export function renderHardwareProfile(
    host: HardwareProfileHost,
    vendors: VendorsResponse | null | undefined,
    path: PathSegment[],
    kind: string,
): TemplateResult {
    const device = asJsonObject(host.getValue(path)) ?? {};
    const profiles = (vendors?.profiles ?? []).filter((profile) => profile.deviceKind === kind);
    const profileId = stringValue(asJsonObject(device.profile)?.id);
    const profile = deviceProfile(vendors, device);
    const info = vendors?.devices?.[validationPath(path)];
    return html`
        <p class="inline-note">${host.t("editor.notes.hardware_profile")}</p>
        <div class="field-grid">
            <div class="field">
                <div class="field-label-row">
                    <label>${host.t("editor.fields.hardware_profile")}</label>
                    ${renderHelpIcon(host, "editor.fields.hardware_profile", "editor.help.hardware_profile")}
                </div>
                <select
                    data-field="hardware-profile"
                    @change=${(event: Event) =>
                        setDeviceProfile(host, vendors, path, (event.currentTarget as HTMLSelectElement).value)}
                >
                    <option value="" ?selected=${profileId === ""}>${host.t("editor.values.profile_custom")}</option>
                    ${profileId && !profiles.some((option) => option.id === profileId)
                        ? html`<option value=${profileId} selected>${profileId}</option>`
                        : nothing}
                    ${profiles.map(
                        (option) => html`
                            <option value=${option.id} ?selected=${option.id === profileId}>${option.label}</option>
                        `,
                    )}
                </select>
            </div>
            ${profile ? renderBinding(host, profile, device, path) : nothing}
        </div>
        ${profile && info
            ? html`
                  <div class="vendor-resolved">
                      <div class="inline-note">${tFormat(host, "editor.dynamic.provided_by", { profile: profile.label })}</div>
                      <ul>
                          ${Object.entries(info.resolved).map(
                              ([configPath, entityId]) => html`
                                  <li class=${entityId ? "" : "unresolved"} data-path=${configPath}>
                                      <code>${configPath}</code>
                                      <span>${entityId ?? host.t("editor.dynamic.vendor_entity_unresolved")}</span>
                                  </li>
                              `,
                          )}
                      </ul>
                  </div>
              `
            : nothing}
    `;
}

/**
 * What the profile binds to: the "Config entry" select of an entry-bound
 * profile, the "Device" select of a device-bound one. With nothing to offer,
 * it says so instead of showing an empty select.
 */
function renderBinding(
    host: HardwareProfileHost,
    profile: VendorProfileInfo,
    device: JsonObject,
    path: PathSegment[],
): TemplateResult {
    const byDevice = profile.binding === "device";
    const key = byDevice ? "device_id" : "entry_id";
    const field = byDevice ? "vendor_device" : "vendor_entry";
    const current = stringValue(asJsonObject(device.profile)?.[key]);
    const options = byDevice
        ? freeCandidates(host, profile, path).map((candidate) => ({
              value: candidate.deviceId,
              label: `${candidate.name} (${candidate.entryTitle})`,
          }))
        : (profile.entries ?? []).map((entry) => ({ value: entry.entryId, label: entry.title }));
    return html`
        <div class="field">
            <div class="field-label-row">
                <label>${host.t(`editor.fields.${field}`)}</label>
                ${renderHelpIcon(host, `editor.fields.${field}`, `editor.help.${field}`)}
            </div>
            ${options.length === 0
                ? html`
                      <div
                          class="vendor-provided-entity unresolved"
                          data-field=${byDevice ? "vendor-no-devices" : "vendor-no-entries"}
                      >
                          ${tFormat(host, byDevice ? "editor.dynamic.vendor_no_devices" : "editor.dynamic.vendor_no_entries", {
                              profile: profile.label,
                          })}
                      </div>
                  `
                : nothing}
            <select
                ?hidden=${options.length === 0}
                data-field=${byDevice ? "vendor-device" : "vendor-entry"}
                @change=${(event: Event) => {
                    const value = (event.currentTarget as HTMLSelectElement).value;
                    host.setValue([...path, "profile", key], value || undefined);
                }}
            >
                <option value="" ?selected=${current === ""}></option>
                ${options.map(
                    (option) => html`
                        <option value=${option.value} ?selected=${option.value === current}>${option.label}</option>
                    `,
                )}
                ${current && !options.some((option) => option.value === current)
                    ? html`<option value=${current} selected>${current}</option>`
                    : nothing}
            </select>
        </div>
    `;
}

/** A device-bound profile's candidates, minus the HA devices another draft device binds under it. */
function freeCandidates(
    host: FormFieldHost,
    profile: VendorProfileInfo,
    path: PathSegment[],
): NonNullable<VendorProfileInfo["candidates"]> {
    const own = validationPath(path);
    const taken = new Set(
        profileDevices(asJsonObject(host.getValue([])))
            .filter(({ path: other }) => validationPath(other) !== own)
            .map(({ device }) => asJsonObject(device.profile))
            .filter((stored) => stored?.id === profile.id)
            .map((stored) => stringValue(stored?.device_id)),
    );
    return (profile.candidates ?? []).filter((candidate) => !taken.has(candidate.deviceId));
}

/**
 * Pick a device's hardware profile, or "Custom" for none.
 *
 * Picking one deletes the paths it owns from the draft: they are its now, and
 * a stored copy would be refused on save. The first config entry, or the
 * first HA device no other device binds, is preselected.
 */
function setDeviceProfile(
    host: HardwareProfileHost,
    vendors: VendorsResponse | null | undefined,
    path: PathSegment[],
    profileId: string,
): void {
    const profile = vendors?.profiles?.find((option) => option.id === profileId);
    const [key, first] =
        profile?.binding === "device"
            ? ["device_id", freeCandidates(host, profile, path)[0]?.deviceId]
            : ["entry_id", profile?.entries?.[0]?.entryId];
    host.mutateDraft((draft) => {
        if (!profile) {
            unsetValueAtPath(draft, [...path, "profile"]);
            return;
        }
        for (const owned of profile.ownedConfigPaths) {
            unsetValueAtPath(draft, owned.split("."));
        }
        for (const owned of profile.ownedDevicePaths) {
            unsetValueAtPath(draft, [...path, ...owned.split(".")]);
        }
        setValueAtPath(draft, [...path, "profile"], { id: profile.id, ...(first ? { [key]: first } : {}) });
    });
}
