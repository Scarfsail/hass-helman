import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";

import type { LocalizeFunction } from "../../localize/localize";
import { defineOnce } from "../define-once";
import { loadHaForm, loadHaSortable } from "../load-ha-elements";
import { getSharedDataChangedFeed } from "../../helman/data-changed";
import {
    asJsonObject,
    canonicalJson,
    cloneJson,
    setValueAtPath,
    unsetValueAtPath,
} from "../config/config-document";
import { findDeviceByKey } from "../config/devices";
import { EntityInspectionController } from "../config/entity-inspection-controller";
import { formatError, stringValue } from "../config/form-fields";
import { configFormStyles } from "../config/form-styles";
import { resolvedDraft } from "../config/resolved-draft";
import {
    getLocalizeFunction,
    type LocalizeFunction as EditorLocalizeFunction,
} from "../config/localize/localize";
import type {
    HomeAssistantLike,
    JsonObject,
    SaveConfigResponse,
    ValidationReport,
} from "../config/types";
import {
    deviceEditorStyles,
    deviceIdentityTargets,
    type DeviceConfigChangedDetail,
} from "./helman-device-editor";
import { hardwareProfileStyles, VendorsController } from "./hardware-profile";
import "./helman-device-editor";

const KEY_PREFIX = "node_detail.device.edit";

/**
 * What the dialog is doing. The render branches on this and nothing else --
 * the same states as `helman-optimizer-edit-dialog`.
 */
type EditViewState =
    | { kind: "loading" }
    /** The websocket refused, or the config could not be read. */
    | { kind: "failed"; message: string }
    /**
     * The config loaded but holds no device by that key: the card row was
     * drawn from a device tree the config has since moved on from.
     */
    | { kind: "not_found" }
    | {
        kind: "ready";
        /** The whole document. The editor edits it; the save sends it. */
        config: JsonObject;
        /**
         * The device's id, which the form never edits. What the card is found
         * by after an edit that moves it -- a new parent -- or changes the
         * meter the dialog was opened by.
         */
        deviceId: string;
    };

/** A save's outcome, shown in the dialog rather than swallowed. */
interface SaveMessage {
    kind: "success" | "error";
    text: string;
}

/**
 * One device's config, edited from the card that shows it.
 *
 * Not a second form: it mounts `<helman-device-editor>` -- the element the
 * config panel's Devices tab is made of -- and adds only what a dialog has to
 * add: loading the document, holding a draft, reading its entities, and saving
 * it. Modelled on `helman-optimizer-edit-dialog`, whose load, save, collision
 * and close behaviour it repeats.
 */
export class HelmanDeviceEditDialog extends LitElement {
    static styles = [
        configFormStyles,
        deviceEditorStyles,
        hardwareProfileStyles,
        css`
            .dialog-content {
                display: flex;
                flex-direction: column;
                gap: 12px;
                min-width: min(760px, 80vw);
            }

            .placeholder {
                padding: 16px 2px;
                color: var(--secondary-text-color);
            }

            .placeholder.error {
                color: var(--error-color, #c62828);
            }

            .message.stale {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                flex-wrap: wrap;
            }
        `,
    ];

    @property({ attribute: false }) public hass?: HomeAssistantLike;

    /** The card bundle's localize, for this dialog's own chrome. */
    @property({ attribute: false }) public localize!: LocalizeFunction;

    @property({ type: Boolean }) public open = false;

    /** The device to edit: `TreeItem.deviceKey`, its id or its own meter. */
    @property({ attribute: false }) public deviceKey = "";

    /** Whether `deviceKey` is the device's own meter rather than its id. */
    @property({ attribute: false }) public keyIsMeter = false;

    @state() private _view: EditViewState = { kind: "loading" };

    @state() private _dirty = false;

    @state() private _saving = false;

    @state() private _message: SaveMessage | null = null;

    /** The last save's report, handed to the card so it can show its issues. */
    @state() private _validation: ValidationReport | null = null;

    /** The config changed under us -- see `helman-optimizer-edit-dialog`. */
    @state() private _stale = false;

    /** The document exactly as it was read: what a re-read is compared to. */
    private _baseline: string | null = null;

    /** The stored document itself, for the entity groups' saved readings and reverts. */
    private _saved: JsonObject | null = null;

    private _unsubscribeDataChanged?: () => void;

    /** The key the current view was loaded for; a new key reloads. */
    private _loadedKey: string | null = null;

    /** A staleness check in flight, so a burst does not fan out into reads. */
    private _stalenessCheck: Promise<void> | null = null;

    /** The close is settled -- see `_close`. */
    private _closing = false;

    /** The `editor.*` strings, from the config editor's own table. */
    private _editorLocalize: EditorLocalizeFunction | null = null;

    private _inspections = new EntityInspectionController(this, {
        hass: () => this.hass,
        config: () => (this._view.kind === "ready" ? this._view.config : null),
        saved: () => this._saved,
        // The card's name and icon placeholders are the backend's answer too.
        extraTargets: () => {
            const path = this._devicePath();
            return path ? deviceIdentityTargets(path) : [];
        },
        mutate: (mutator) => this._applyToDraft(mutator),
    });

    /** The hardware profiles, and what the draft's profile devices own. */
    private _vendors = new VendorsController(this, {
        hass: () => this.hass,
        config: () => (this._view.kind === "ready" ? this._view.config : null),
    });

    connectedCallback(): void {
        super.connectedCallback();
        void loadHaForm().then(() => this.requestUpdate());
        void loadHaSortable().then(() => this.requestUpdate());
        void this._load();
        const hass = this.hass;
        if (hass) {
            this._unsubscribeDataChanged = getSharedDataChangedFeed(hass).subscribe(() => {
                void this._refreshStale();
            });
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._unsubscribeDataChanged?.();
        this._unsubscribeDataChanged = undefined;
    }

    protected willUpdate(): void {
        if (this._loadedKey !== null && this._loadedKey !== this.deviceKey) {
            void this._load();
        }
    }

    render() {
        const heading = this._text("title");
        return html`
            <ha-dialog
                .open=${this.open}
                width="full"
                .heading=${heading}
                .headerTitle=${heading}
                @wa-hide=${this._handleHideRequest}
                @closed=${this._handleClosed}
            >
                <div class="dialog-content">
                    ${this._stale
                        ? html`
                              <div class="message error stale">
                                  <span>${this._editorText("editor.status.changed_elsewhere")}</span>
                                  <button type="button" class="add-button" @click=${this._handleReload}>
                                      ${this._editorText("editor.actions.reload_config")}
                                  </button>
                              </div>
                          `
                        : nothing}
                    ${this._message
                        ? html`<div class="message ${this._message.kind}">${this._message.text}</div>`
                        : nothing}
                    ${this._renderView()}
                </div>
                <ha-dialog-footer slot="footer">
                    ${this._view.kind === "ready"
                        ? html`
                              <ha-button
                                  slot="primaryAction"
                                  .disabled=${this._stale || this._saving}
                                  @click=${this._handleSave}
                              >
                                  ${this._editorText(
                                      this._saving
                                          ? "editor.actions.saving"
                                          : "editor.actions.save_and_reload",
                                  )}
                              </ha-button>
                          `
                        : nothing}
                    <ha-button slot="secondaryAction" .disabled=${this._saving} @click=${this._handleCloseRequest}>
                        ${this._view.kind === "ready" ? this._text("cancel") : this._text("close")}
                    </ha-button>
                </ha-dialog-footer>
            </ha-dialog>
        `;
    }

    private _renderView() {
        const view = this._view;
        switch (view.kind) {
            case "loading":
                return html`<div class="placeholder">${this._text("loading")}</div>`;
            case "failed":
                return html`
                    <div class="placeholder error">
                        ${this._text("load_failed")}: ${view.message}
                    </div>
                `;
            case "not_found":
                return html`
                    <div class="placeholder error">
                        ${this._text("not_found").replaceAll("{key}", this.deviceKey)}
                    </div>
                `;
            case "ready": {
                const entry = findDeviceByKey(view.config, view.deviceId, "id");
                if (!entry) return nothing;
                return html`
                    <helman-device-editor
                        .config=${view.config}
                        .path=${entry.path}
                        .parent=${entry.parent}
                        .expanded=${true}
                        ?inert=${this._saving}
                        .hass=${this.hass}
                        .localize=${(key: string) => this._editorText(key)}
                        .validation=${this._validation}
                        .vendors=${this._vendors.vendors}
                        .inspections=${this._inspections.results}
                        @device-config-changed=${this._handleConfigChanged}
                    ></helman-device-editor>
                `;
            }
        }
    }

    private _devicePath() {
        const view = this._view;
        return view.kind === "ready" ? findDeviceByKey(view.config, view.deviceId, "id")?.path ?? null : null;
    }

    private async _load(): Promise<void> {
        const hass = this.hass;
        if (!hass) {
            return;
        }
        this._view = { kind: "loading" };
        this._dirty = false;
        this._stale = false;
        this._validation = null;
        this._loadedKey = this.deviceKey;
        this._editorLocalize = getLocalizeFunction(hass);
        try {
            const document = asJsonObject(await hass.callWS<unknown>({ type: "helman/get_config" }));
            if (!document) {
                this._view = { kind: "not_found" };
                return;
            }
            this._baseline = canonicalJson(document);
            this._saved = cloneJson(document);
            // The tree keys a device by the meter it runs on, which a hardware
            // profile fills in: a meter key no stored device has is looked up
            // in the resolved document.
            const entry = this.keyIsMeter
                ? (findDeviceByKey(document, this.deviceKey, "meter") ??
                  findDeviceByKey(resolvedDraft(document, await this._vendors.load(document)), this.deviceKey, "meter"))
                : findDeviceByKey(document, this.deviceKey, "id");
            const deviceId = stringValue(entry?.device.id);
            this._view = entry && deviceId
                ? { kind: "ready", config: cloneJson(document), deviceId }
                : { kind: "not_found" };
            this._inspections.request();
        } catch (error) {
            this._view = { kind: "failed", message: formatError(error, String(error)) };
        }
    }

    /** Every edit, from the card or a revert, lands on the one draft here. */
    private _applyToDraft(mutator: (draft: JsonObject) => void): void {
        const view = this._view;
        if (view.kind !== "ready") {
            return;
        }
        const draft = cloneJson(view.config);
        mutator(draft);
        this._view = { ...view, config: draft };
        this._dirty = true;
        this._message = null;
        this._validation = null;
        this._inspections.request();
    }

    /** Frozen while saving: the save has already taken its snapshot of the draft. */
    private _handleConfigChanged = (event: Event): void => {
        if (this._saving) return;
        const { path, value } = (event as CustomEvent<DeviceConfigChangedDetail>).detail;
        this._applyToDraft((draft) => {
            if (value === undefined) unsetValueAtPath(draft, path);
            else setValueAtPath(draft, path, value);
        });
    };

    /**
     * Save the whole document, as the config editor does: `helman/save_config`
     * takes a document and replaces the stored one. A refused save keeps the
     * dialog open, says so, and hands the report to the card.
     */
    private _handleSave = async (): Promise<void> => {
        const view = this._view;
        if (view.kind !== "ready" || !this.hass || this._saving) {
            return;
        }
        this._saving = true;
        this._message = null;
        try {
            if (await this._configChangedElsewhere()) {
                this._stale = true;
                this._message = {
                    kind: "error",
                    text: this._editorText("editor.status.changed_elsewhere"),
                };
                return;
            }
            const response = await this.hass.callWS<SaveConfigResponse>({
                type: "helman/save_config",
                config: view.config,
            });
            this._validation = response.validation ?? null;
            if (response.validation?.valid !== false) {
                // The write landed, so the stored document is the new baseline
                // -- see `helman-optimizer-edit-dialog._handleSave`.
                await this._rebaseline();
                this._stale = false;
                this._dirty = false;
            }
            if (response.success) {
                this._notify(this._editorText(
                    response.reloadStarted
                        ? "editor.messages.config_saved_reload_started"
                        : "editor.messages.config_saved",
                ));
                this._close();
                return;
            }
            this._message = {
                kind: "error",
                text:
                    response.reloadError ??
                    this._editorText(
                        response.validation?.valid
                            ? "editor.messages.config_saved_reload_failed"
                            : "editor.messages.save_rejected",
                    ),
            };
        } catch (error) {
            this._message = {
                kind: "error",
                text: `${this._editorText("editor.messages.save_failed")} ${formatError(error, String(error))}`,
            };
        } finally {
            this._saving = false;
        }
    };

    /** Whether the stored config moved since this dialog read it; see the optimizer dialog. */
    private async _compareToBaseline(): Promise<"same" | "changed" | "unknown"> {
        if (!this.hass || this._baseline === null) {
            return "same";
        }
        try {
            const current = asJsonObject(await this.hass.callWS<unknown>({ type: "helman/get_config" }));
            if (current === null) {
                return "unknown";
            }
            return canonicalJson(current) === this._baseline ? "same" : "changed";
        } catch {
            return "unknown";
        }
    }

    private async _configChangedElsewhere(): Promise<boolean> {
        return (await this._compareToBaseline()) !== "same";
    }

    private async _refreshStale(): Promise<void> {
        if (this._saving || this._stalenessCheck !== null) {
            return this._stalenessCheck ?? undefined;
        }
        this._stalenessCheck = (async () => {
            try {
                const verdict = await this._compareToBaseline();
                if (verdict !== "unknown") {
                    this._stale = verdict === "changed";
                }
            } finally {
                this._stalenessCheck = null;
            }
        })();
        return this._stalenessCheck;
    }

    /** Adopt the stored config as the baseline, without touching the draft. */
    private async _rebaseline(): Promise<void> {
        if (!this.hass) {
            return;
        }
        try {
            const current = asJsonObject(await this.hass.callWS<unknown>({ type: "helman/get_config" }));
            if (current !== null) {
                this._baseline = canonicalJson(current);
                this._saved = cloneJson(current);
            }
        } catch {
            // The next save re-reads anyway and will refuse rather than clobber.
        }
    }

    /** Home Assistant's own toast, for something the dialog closed before it could show. */
    private _notify(message: string): void {
        this.dispatchEvent(new CustomEvent("hass-notification", {
            bubbles: true,
            composed: true,
            detail: { message },
        }));
    }

    /** Throw the draft away and read the config again. */
    private _handleReload = (): void => {
        if (this._dirty && !window.confirm(this._editorText("editor.confirm.discard_changes"))) {
            return;
        }
        this._message = null;
        void this._load();
    };

    /** Closing on an unsaved draft asks first; the draft is the user's work. */
    /**
     * Close as Cancel does, asking first when the draft is dirty. Also what the
     * device detail calls when Back is pressed with this dialog on top of it.
     * Refused while a save is in flight, which would still land after a discard.
     */
    public requestClose(): void {
        this._handleCloseRequest();
    }

    private _handleCloseRequest = (): void => {
        if (this._saving) {
            return;
        }
        if (this._dirty && !window.confirm(this._text("discard"))) {
            return;
        }
        this._close();
    };

    /**
     * Every other way out: the scrim, Escape, the header's ×. Only this
     * dialog's own hide is answered, and it stops here so the device detail
     * behind it stays open.
     */
    private _handleHideRequest = (event: Event): void => {
        if (event.target !== this.renderRoot.querySelector("ha-dialog")) {
            return;
        }
        event.stopPropagation();
        if (this._closing) {
            return;
        }
        if (this._saving) {
            event.preventDefault();
            return;
        }
        if (!this._dirty) {
            return;
        }
        event.preventDefault();
        if (window.confirm(this._text("discard"))) {
            this._close();
        }
    };

    private _close(): void {
        this._closing = true;
        this.open = false;
        this._notifyClosed();
    }

    /**
     * Mounted inside the device detail's own `ha-dialog`, and `closed` is the
     * event name both use -- so an unstopped `closed` would shut the detail too.
     */
    private _handleClosed = (event?: Event): void => {
        event?.stopPropagation();
        this._notifyClosed();
    };

    private _notifyClosed(): void {
        this.dispatchEvent(new CustomEvent("closed"));
    }

    private _text(suffix: string): string {
        return this.localize(`${KEY_PREFIX}.${suffix}`);
    }

    private _editorText(key: string): string {
        return this._editorLocalize?.(key) ?? key;
    }
}

defineOnce("helman-device-edit-dialog", HelmanDeviceEditDialog);

declare global {
    interface HTMLElementTagNameMap {
        "helman-device-edit-dialog": HelmanDeviceEditDialog;
    }
}
