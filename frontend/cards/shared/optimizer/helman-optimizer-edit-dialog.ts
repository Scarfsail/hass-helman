import { LitElement, css, html, nothing } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";

import type { LocalizeFunction } from "../../localize/localize";
import { loadHaForm } from "../load-ha-elements";
import { getSharedDataChangedFeed } from "../../helman/data-changed";
import { asJsonArray, asJsonObject, cloneJson } from "../config/config-document";
import {
    getLocalizeFunction,
    type LocalizeFunction as EditorLocalizeFunction,
} from "../config/localize/localize";
import type {
    ApplianceMetadataResponse,
    HomeAssistantLike,
    JsonObject,
    SaveConfigResponse,
} from "../config/types";
import { fetchOptimizerSchema, type OptimizerSchemaDocument } from "./optimizer-schema";
import type { OptimizerConfigChangedDetail } from "./helman-optimizer-editor";
import "./helman-optimizer-editor";

const KEY_PREFIX = "scheduling.explanation.diagram.edit";

/**
 * What the dialog is doing. The render branches on this and nothing else.
 */
type EditViewState =
    | { kind: "loading" }
    /** The websocket refused, or the config could not be read. */
    | { kind: "failed"; message: string }
    /**
     * The config loaded but holds no optimizer with this id.
     *
     * A live possibility rather than a defensive branch: the explanation comes
     * from a plan that ran earlier, and the optimizer it names may have been
     * renamed or deleted since. Saying so beats a blank card.
     */
    | { kind: "not_found" }
    | {
        kind: "ready";
        /** The whole document. The editor edits it; the save sends it. */
        config: JsonObject;
        index: number;
        schema: OptimizerSchemaDocument | null;
        applianceMetadata: ApplianceMetadataResponse | null;
    };

/** A save's outcome, shown in the dialog rather than swallowed. */
interface SaveMessage {
    kind: "success" | "error";
    text: string;
}

/**
 * One optimizer, editable from wherever it is being explained.
 *
 * Not a second editor: it mounts `<helman-optimizer-editor>` -- the same
 * element the config panel's optimizer list is made of -- and adds only what a
 * dialog has to add, which is loading the document, holding a draft, and
 * saving it. Everything inside the card is the config editor's UI, because it
 * *is* the config editor's UI.
 *
 * The save is `helman/save_config`, which is what the config editor's Save
 * button calls: the backend validates, writes, and reloads the config entry.
 * That reload is the restart, which is why the button says so.
 */
@customElement("helman-optimizer-edit-dialog")
export class HelmanOptimizerEditDialog extends LitElement {
    static styles = css`
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

        .message {
            border: 1px solid var(--divider-color);
            border-radius: 12px;
            padding: 10px 14px;
            font-size: 0.9rem;
        }

        .message.success {
            border-color: var(--success-color, #2e7d32);
            background: color-mix(in srgb, var(--success-color, #2e7d32) 10%, transparent);
        }

        .message.error {
            border-color: var(--error-color, #c62828);
            background: color-mix(in srgb, var(--error-color, #c62828) 10%, transparent);
        }

        .message.stale {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            flex-wrap: wrap;
        }

        .message.stale button {
            border: 1px solid var(--divider-color);
            border-radius: 999px;
            padding: 4px 12px;
            background: var(--card-background-color);
            color: inherit;
            font: inherit;
            font-size: 0.85rem;
            cursor: pointer;
        }
    `;

    @property({ attribute: false }) public hass?: HomeAssistantLike;

    /** The card bundle's localize, for this dialog's own chrome. */
    @property({ attribute: false }) public localize!: LocalizeFunction;

    @property({ type: Boolean }) public open = false;

    /** Which optimizer to edit, by `automation.optimizers[].id`. */
    @property({ type: String }) public optimizerId = "";

    @state() private _view: EditViewState = { kind: "loading" };

    @state() private _dirty = false;

    @state() private _saving = false;

    @state() private _message: SaveMessage | null = null;

    /**
     * The config changed under us, and the draft must not be written over it.
     *
     * Raised by the live `helman_data_changed` feed and, as a backstop, by the
     * re-read at save time -- a page that missed the event still cannot
     * clobber. See `_handleSave`.
     */
    @state() private _stale = false;

    /**
     * The document exactly as it was read, before any edit.
     *
     * Kept apart from the draft the editor mutates, because it is the *only*
     * thing a re-read can be compared against: the draft has diverged on
     * purpose, so comparing the re-read to it would call every own edit a
     * collision.
     */
    private _baseline: string | null = null;

    private _unsubscribeDataChanged?: () => void;

    /**
     * Our own save is about to fire `helman_data_changed`. Ignore that one.
     *
     * Same flag, and the same reason, as `helman-config-editor`'s
     * `_expectOwnDataChange`: the announcement of a write we performed is not
     * news that someone else wrote.
     */
    private _expectOwnDataChange = false;

    /**
     * The `editor.*` strings, which live in the config editor's own table.
     *
     * Built from `hass` rather than taken as a property: those keys are not in
     * the card bundle's translations, and the field labels inside the card are
     * all of them. Loudly missing rather than silently raw -- see
     * `MISSING_TRANSLATION_PREFIX`.
     */
    private _editorLocalize: EditorLocalizeFunction | null = null;

    connectedCallback(): void {
        super.connectedCallback();
        void loadHaForm().then(() => this.requestUpdate());
        void this._load();
        const hass = this.hass;
        if (hass) {
            this._unsubscribeDataChanged = getSharedDataChangedFeed(hass).subscribe(() => {
                if (this._expectOwnDataChange) {
                    this._expectOwnDataChange = false;
                    return;
                }
                this._stale = true;
            });
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._unsubscribeDataChanged?.();
        this._unsubscribeDataChanged = undefined;
    }

    render() {
        const heading = this._text("title");
        return html`
            <ha-dialog
                .open=${this.open}
                width="full"
                .heading=${heading}
                .headerTitle=${heading}
                .preventScrimClose=${true}
                @closed=${this._handleClosed}
            >
                <div class="dialog-content">
                    ${this._stale
                        ? html`
                              <div class="message error stale">
                                  <span>${this._editorText("editor.status.changed_elsewhere")}</span>
                                  <button type="button" @click=${this._handleReload}>
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
                    <ha-button slot="secondaryAction" @click=${this._handleCloseRequest}>
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
                        ${this._format("not_found", { id: this.optimizerId })}
                    </div>
                `;
            case "ready":
                return html`
                    <helman-optimizer-editor
                        .config=${view.config}
                        .index=${view.index}
                        .total=${1}
                        .schema=${view.schema}
                        .applianceMetadata=${view.applianceMetadata}
                        .hass=${this.hass}
                        .localize=${(key: string) => this._editorText(key)}
                        @optimizer-config-changed=${this._handleConfigChanged}
                    ></helman-optimizer-editor>
                `;
        }
    }

    /**
     * Everything the card needs, in one round trip.
     *
     * The schema and the appliance registry are what turn a JSON blob into the
     * form: without the schema there are no fields, without the registry the
     * appliance picker has no names. `fetchOptimizerSchema` already answers
     * `null` on failure, and a missing registry only costs the picker its
     * labels, so only the config itself is fatal.
     */
    private async _load(): Promise<void> {
        const hass = this.hass;
        if (!hass) {
            return;
        }
        this._view = { kind: "loading" };
        this._dirty = false;
        this._stale = false;
        this._editorLocalize = getLocalizeFunction(hass);
        try {
            const [config, schema, appliances] = await Promise.all([
                hass.callWS<unknown>({ type: "helman/get_config" }),
                fetchOptimizerSchema(hass),
                hass
                    .callWS<ApplianceMetadataResponse>({ type: "helman/get_appliances" })
                    .catch(() => null),
            ]);
            const document = asJsonObject(config);
            if (!document) {
                this._view = { kind: "not_found" };
                return;
            }
            this._baseline = canonicalJson(document);
            const index = findOptimizerIndex(document, this.optimizerId);
            this._view =
                index === null
                    ? { kind: "not_found" }
                    : {
                          kind: "ready",
                          config: cloneJson(document),
                          index,
                          schema,
                          applianceMetadata: appliances,
                      };
        } catch (error) {
            this._view = { kind: "failed", message: describeError(error) };
        }
    }

    private _handleConfigChanged = (event: Event): void => {
        const detail = (event as CustomEvent<OptimizerConfigChangedDetail>).detail;
        if (!detail?.config || this._view.kind !== "ready") {
            return;
        }
        this._view = { ...this._view, config: detail.config };
        this._dirty = true;
        this._message = null;
    };

    /**
     * Save the whole document, as the config editor does.
     *
     * `helman/save_config` takes a document and replaces the stored one; there
     * is no partial write. The draft carries the edited optimizer and nothing
     * else changed, so sending it whole is sending exactly the edit -- provided
     * nobody wrote the config in between, which is the next phase's problem and
     * is called out as an accepted gap until then.
     */
    private _handleSave = async (): Promise<void> => {
        const view = this._view;
        if (view.kind !== "ready" || !this.hass || this._saving) {
            return;
        }
        this._saving = true;
        this._message = null;
        try {
            // Re-read and compare before writing. The event feed above catches
            // this in the common case, but a page that was backgrounded, or a
            // connection that dropped and came back, may never have seen it --
            // and the cost of missing it is one silent whole-document clobber.
            if (await this._configChangedElsewhere()) {
                this._stale = true;
                this._message = {
                    kind: "error",
                    text: this._editorText("editor.status.changed_elsewhere"),
                };
                return;
            }
            this._expectOwnDataChange = true;
            const response = await this.hass.callWS<SaveConfigResponse>({
                type: "helman/save_config",
                config: view.config,
            });
            if (response.success) {
                // The document we just wrote is the new baseline. Without this
                // a second save would compare against the pre-save read, find
                // our own write, and refuse. Re-read rather than reuse the
                // draft: the backend stamps `config_version` on write, and the
                // baseline has to be what a later read will actually return.
                await this._rebaseline();
                this._dirty = false;
                this._message = {
                    kind: "success",
                    text: this._editorText(
                        response.reloadStarted
                            ? "editor.messages.config_saved_reload_started"
                            : "editor.messages.config_saved",
                    ),
                };
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
            this._expectOwnDataChange = false;
            this._message = {
                kind: "error",
                text: `${this._editorText("editor.messages.save_failed")} ${describeError(error)}`,
            };
        } finally {
            this._saving = false;
        }
    };

    /**
     * Whether the stored config moved since this dialog read it.
     *
     * Compares the *whole* document, not just the edited optimizer: a
     * whole-document save is exactly what destroys an unrelated change, so an
     * unrelated change is exactly what has to stop it. Both sides are reads of
     * the same endpoint, so `save_config`'s `config_version` stamping cannot
     * show up here as a difference on its own.
     *
     * A failed re-read is treated as "changed": refusing to save costs the user
     * a retry, and saving anyway could cost them someone else's work.
     */
    private async _configChangedElsewhere(): Promise<boolean> {
        if (!this.hass || this._baseline === null) {
            return false;
        }
        try {
            const current = asJsonObject(await this.hass.callWS<unknown>({ type: "helman/get_config" }));
            return current === null || canonicalJson(current) !== this._baseline;
        } catch {
            return true;
        }
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
            }
        } catch {
            // Leaving the old baseline in place is the safe failure: the next
            // save re-reads anyway and will refuse rather than clobber.
        }
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
    private _handleCloseRequest = (): void => {
        if (this._dirty && !window.confirm(this._text("discard"))) {
            return;
        }
        this.open = false;
        this._notifyClosed();
    };

    /**
     * Closing this dialog must not close the day editor behind it.
     *
     * Mounted inside the day editor's own `ha-dialog`, and `closed` is the
     * event name both use -- so an unstopped `closed` shuts both. The condition
     * trace dialog next door had to learn the same thing; see its
     * `_handleClosed`.
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

    private _format(suffix: string, values: Record<string, string>): string {
        let text = this._text(suffix);
        for (const [name, value] of Object.entries(values)) {
            text = text.replaceAll(`{${name}}`, value);
        }
        return text;
    }

    private _editorText(key: string): string {
        return this._editorLocalize?.(key) ?? key;
    }
}

/** Where the named optimizer sits in the pipeline, or null if it is gone. */
function findOptimizerIndex(config: JsonObject, optimizerId: string): number | null {
    if (!optimizerId) {
        return null;
    }
    const automation = asJsonObject(config.automation);
    const optimizers = asJsonArray(automation?.optimizers) ?? [];
    const index = optimizers.findIndex(
        (entry) => asJsonObject(entry)?.id === optimizerId,
    );
    return index === -1 ? null : index;
}

/**
 * A document as one string, with object keys in a stable order.
 *
 * `JSON.stringify` preserves insertion order, and two reads of the same stored
 * config need not agree on it -- the backend rebuilds the dict on every load
 * and a migration may reinsert a key. Sorting makes the comparison about the
 * content, which is the only thing a collision check should be about.
 */
function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, nested) => {
        if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
            return nested;
        }
        const entry = nested as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(entry).sort()) {
            sorted[key] = entry[key];
        }
        return sorted;
    });
}

function describeError(error: unknown): string {
    if (typeof error === "object" && error !== null && "message" in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-optimizer-edit-dialog": HelmanOptimizerEditDialog;
    }
}
