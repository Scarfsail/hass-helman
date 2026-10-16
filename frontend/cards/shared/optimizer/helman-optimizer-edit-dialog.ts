import { callHelman } from "../data/helman-commands";
import type { HomeAssistant } from "../../../types/ha";
import { LitElement, css, html, nothing } from "lit-element";
import { property, state } from "lit/decorators.js";

import { getLocalizeFunction, type LocalizeFunction } from "../../localize/localize";
import { defineOnce } from "../define-once";
import { loadHaForm, loadHaSortable } from "../load-ha-elements";
import { DataChangedController } from "../../helman/data-changed";
import {
    asJsonArray,
    asJsonObject,
    cloneJson,
    setValueAtPath,
} from "../config/config-document";
import { ConfigSession } from "../config/config-session";
import { describeError } from "../describe-error";
import type {
    ApplianceMetadataResponse,
    JsonObject,
    PathSegment,
} from "../config/types";
import {
    fetchOptimizerSchema,
    type OptimizerConfigBucket,
    type OptimizerSchemaDocument,
} from "./optimizer-schema";
import type { OptimizerConfigChangedDetail } from "./helman-optimizer-editor";
import "./helman-optimizer-editor";

const KEY_PREFIX = "scheduling.explanation.diagram.edit";

type OptimizerBucket = OptimizerConfigBucket;

const OPTIMIZER_BUCKETS: readonly OptimizerBucket[] = [
    "appliance_optimizers",
    "system_optimizers",
];

/** Where one named optimizer sits: its bucket and its index inside it. */
interface OptimizerLocation {
    bucket: OptimizerBucket;
    index: number;
}

/**
 * What the dialog is doing. The render branches on this and nothing else.
 */
type EditViewState =
    | { kind: "loading" }
    /** The websocket refused, or the config could not be read. */
    | { kind: "failed"; message: string }
    /**
     * The config loaded but holds none of the named optimizers.
     *
     * A live possibility rather than a defensive branch: the explanation comes
     * from a plan that ran earlier, and the optimizer it names may have been
     * renamed or deleted since. Saying so beats a blank card.
     */
    | { kind: "not_found" }
    | {
        kind: "ready";
        /** The whole document. The editors edit it; the save sends it. */
        config: JsonObject;
        /**
         * Where each named optimizer sits in the pipeline, in config order.
         *
         * A lane can be driven by several optimizers -- the inverter routinely
         * is -- and the badge that opens this dialog names all of them at once.
         * They share one draft and one Save, because they share one document.
         *
         * Each carries its own bucket: a lane's optimizers all share one bucket
         * in practice (the inverter is system-only, an appliance is
         * appliance-only), but nothing here assumes that -- the card renders
         * from whichever bucket its own location names.
         */
        indices: readonly OptimizerLocation[];
        schema: OptimizerSchemaDocument | null;
        applianceMetadata: ApplianceMetadataResponse | null;
    };

/** A save's outcome, shown in the dialog rather than swallowed. */
interface SaveMessage {
    kind: "success" | "error";
    text: string;
}

/**
 * The automations behind one lane, editable from wherever they are named.
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

    @property({ attribute: false }) public hass?: HomeAssistant;

    /** The card bundle's localize, for this dialog's own chrome. */
    @property({ attribute: false }) public localize!: LocalizeFunction;

    @property({ type: Boolean }) public open = false;

    /**
     * Which optimizers to edit, by id -- looked up across both buckets.
     *
     * A list rather than one id because a lane is not a single automation: the
     * inverter has three, and the coverage badge that opens this dialog means
     * "show me what drives this lane", not "show me one of the things that do".
     */
    @property({ attribute: false }) public optimizerIds: readonly string[] = [];

    @state() private _view: EditViewState = { kind: "loading" };

    @state() private _dirty = false;

    @state() private _saving = false;

    private _configRevisionDuringSave: string | undefined;

    @state() private _message: SaveMessage | null = null;

    /** A config event or compare-and-set conflict found a newer document. */
    @state() private _stale = false;

    /**
     * The document exactly as it was read, before any edit.
     *
     * Kept apart from the draft the editor mutates, because it is the *only*
     * thing a re-read can be compared against: the draft has diverged on
     * purpose, so comparing the re-read to it would call every own edit a
     * collision.
     */
    private _session = new ConfigSession(() => this.hass);

    /**
     * The ids the current view was loaded for.
     *
     * Compared by content, not by identity: a caller that builds the array
     * inline hands over a new one on every render, and reloading on that would
     * throw the draft away for nothing. Compared at all because `_load` runs
     * once on connect, so an element reused for a different lane would
     * otherwise keep showing the lane before it.
     */
    private _loadedIds: string | null = null;

    /**
     * A staleness check in flight, so a burst does not fan out into reads.
     */

    /** The close is settled -- see `_close`. */
    private _closing = false;

    constructor() {
        super();
        new DataChangedController(this, () => this.hass, {}, (_kinds, { configRevision }) => {
            if (this._saving) {
                if (configRevision !== undefined) this._configRevisionDuringSave = configRevision;
            } else if (this._session.isStale(configRevision)) {
                this._stale = true;
            }
        });
    }

    connectedCallback(): void {
        super.connectedCallback();
        void loadHaForm().then(() => this.requestUpdate());
        void loadHaSortable().then(() => this.requestUpdate());
        void this._load();
    }

    protected willUpdate(): void {
        if (this._loadedIds !== null && this._loadedIds !== _optimizerIdKey(this.optimizerIds)) {
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
                                  <span>${this._translate("editor.status.changed_elsewhere")}</span>
                                  <button type="button" @click=${this._handleReload}>
                                      ${this._translate("editor.actions.reload_config")}
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
                                  ${this._translate(
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
                        ${this._text("not_found", { id: this.optimizerIds.join(", ") })}
                    </div>
                `;
            case "ready": {
                // Stacked rather than tabbed: seeing what drives a lane
                // *together* is the reason the badge opens more than one, and
                // one shared draft with one Save is what makes them one edit
                // rather than several.
                //
                // A lone optimizer opens expanded -- it is the whole dialog,
                // and there is nothing to choose between. Several start
                // collapsed, so the list of what drives the lane is readable
                // at a glance instead of being several screens of form.
                const expanded = view.indices.length === 1;
                return html`
                    ${view.indices.map((location) => html`
                        <helman-optimizer-editor
                            ?inert=${this._saving}
                            .config=${view.config}
                            .bucket=${location.bucket}
                            .index=${location.index}
                            .schema=${view.schema}
                            .applianceMetadata=${view.applianceMetadata}
                            .expanded=${expanded}
                            .hass=${this.hass}
                            .localize=${this._translate}
                            .listActions=${(basePath: PathSegment[], enabled: boolean) =>
                                this._renderEnabledToggle(basePath, enabled)}
                            @optimizer-config-changed=${this._handleConfigChanged}
                        ></helman-optimizer-editor>
                    `)}
                `;
            }
        }
    }

    /**
     * The optimizer's on/off switch, in the card's summary row.
     *
     * Only the switch -- not the drag handle and remove the config panel puts
     * beside it. Those are *pipeline* operations: they change which optimizers
     * exist and in what order they run, which is the document's business and
     * not something to do from a dialog opened by pressing one lane. Turning an
     * automation off is the opposite: it is about this optimizer alone, and it
     * is the thing a person who just found out a lane is automated most often
     * wants.
     */
    private _renderEnabledToggle(basePath: PathSegment[], enabled: boolean) {
        // Both guards, exactly as the config panel wires them: the row lives
        // inside the card's `<summary>`, where an unhandled click is the
        // browser's own "collapse this card".
        return html`
            <div class="list-actions" @click=${preventSummaryToggle}>
                <div class="summary-toggle" @click=${stopSummaryToggle}>
                    <span>${this._translate("editor.fields.optimizer_enabled")}</span>
                    <ha-switch
                        .checked=${enabled}
                        @change=${(event: Event) =>
                            this._setEnabled(
                                [...basePath, "enabled"],
                                (event.currentTarget as HTMLElement & { checked: boolean }).checked,
                            )}
                    ></ha-switch>
                </div>
            </div>
        `;
    }

    /**
     * Write the switch into the draft the editors are sharing.
     *
     * The editor cards report their edits rather than applying them, and this
     * row is rendered *by the dialog* into a card -- so the write belongs here
     * too, on the same draft and through the same `_dirty` flag, which is what
     * lets the existing Save and the existing collision guard cover it
     * unchanged.
     */
    private _setEnabled(path: PathSegment[], enabled: boolean): void {
        const view = this._view;
        if (view.kind !== "ready") {
            return;
        }
        const draft = cloneJson(view.config);
        setValueAtPath(draft, path, enabled);
        this._view = { ...view, config: draft };
        this._dirty = true;
        this._message = null;
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
    private _translate = getLocalizeFunction();

    private async _load(): Promise<void> {
        const hass = this.hass;
        if (!hass) {
            return;
        }
        this._translate = getLocalizeFunction(hass, this.localize);
        this._view = { kind: "loading" };
        this._dirty = false;
        this._stale = false;
        this._loadedIds = _optimizerIdKey(this.optimizerIds);
        try {
            const [config, schema, appliances] = await Promise.all([
                this._session.load(),
                fetchOptimizerSchema(hass),
                callHelman(hass, "helman/get_appliances", {})
                    .catch(() => null),
            ]);
            const document = config.doc;
            if (!document) {
                this._view = { kind: "not_found" };
                return;
            }
            const indices = findOptimizerLocations(document, this.optimizerIds);
            this._view =
                indices.length === 0
                    ? { kind: "not_found" }
                    : {
                          kind: "ready",
                          config: cloneJson(document),
                          indices,
                          schema,
                          applianceMetadata: appliances,
                      };
        } catch (error) {
            this._view = { kind: "failed", message: describeError(error) };
        }
    }

    private _handleConfigChanged = (event: Event): void => {
        if (this._saving) return;
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
     * The server compares the revision before replacing the whole document.
     */
    private _handleSave = async (): Promise<void> => {
        const view = this._view;
        if (view.kind !== "ready" || !this.hass || this._saving) {
            return;
        }
        this._saving = true;
        this._message = null;
        try {
            const outcome = await this._session.save(view.config);
            if (outcome.kind === "conflict") {
                this._stale = true;
                this._message = { kind: "error", text: this._translate("editor.status.changed_elsewhere") };
                return;
            }
            if (outcome.kind === "error" && outcome.error) throw outcome.error;
            const response = outcome.response;
            if (outcome.kind === "saved") {
                this._view = { ...view, config: cloneJson(outcome.doc) };
                this._stale = false;
                this._dirty = false;
            }
            if (response?.success) {
                // Say what happened on the way out. The restart this started
                // makes the integration's entities briefly unavailable, which
                // is worth knowing about, and the dialog is no longer there to
                // say it -- so it goes to Home Assistant's own toast.
                this._notify(this._translate(
                    response.reloadStarted
                        ? "editor.messages.config_saved_reload_started"
                        : "editor.messages.config_saved",
                ));
                // Saving is finishing, so the dialog closes. Leaving it open on
                // a green message made Cancel the way out of a save that had
                // already succeeded, which reads as though it might undo it.
                this._close();
                return;
            }
            this._message = {
                kind: "error",
                text:
                    response?.reloadError ??
                    this._translate(
                        response?.validation?.valid
                            ? "editor.messages.config_saved_reload_failed"
                            : "editor.messages.save_rejected",
                    ),
            };
        } catch (error) {
            this._message = {
                kind: "error",
                text: `${this._translate("editor.messages.save_failed")} ${describeError(error)}`,
            };
        } finally {
            this._saving = false;
            if (!this._closing && this._session.isStale(this._configRevisionDuringSave)) this._stale = true;
            this._configRevisionDuringSave = undefined;
        }
    };

    /**
     * Home Assistant's own toast, for something the dialog closed before it
     * could show. `hass-notification` is the frontend's standard channel for
     * this and is handled at the `home-assistant` root, which every surface
     * mounting this dialog sits inside.
     */
    private _notify(message: string): void {
        this.dispatchEvent(new CustomEvent("hass-notification", {
            bubbles: true,
            composed: true,
            detail: { message },
        }));
    }

    /** Throw the draft away and read the config again. */
    private _handleReload = (): void => {
        if (this._dirty && !window.confirm(this._translate("editor.confirm.discard_changes"))) {
            return;
        }
        this._message = null;
        void this._load();
    };

    /** Closing on an unsaved draft asks first; the draft is the user's work. */
    private _handleCloseRequest = (): void => {
        if (this._saving) return;
        if (this._dirty && !window.confirm(this._text("discard"))) {
            return;
        }
        this._close();
    };

    /**
     * Every other way out of the dialog: the scrim, Escape, the header's ×.
     *
     * Light dismiss is on, so a reader who opened the dialog to look gets to
     * click away from it -- which is what a dialog that only reads should do.
     * A draft is the one thing worth stopping for, and it is stopped with the
     * same question Cancel asks, because it is the same decision.
     *
     * `wa-hide` is cancellable and fires before the dialog animates away, so
     * refusing it here leaves the draft on screen rather than restoring it
     * after the fact.
     */
    private _handleHideRequest = (event: Event): void => {
        // Dialogs opened from inside this one hide through here too, retargeted
        // to their own host; only this dialog's own hide is ours to answer.
        if (event.target !== this.renderRoot.querySelector("ha-dialog")) {
            return;
        }
        // Ours, so it stops here: the day editor this is mounted inside hides
        // through an `ha-dialog` of its own, and the event's path crosses it.
        event.stopPropagation();
        if (this._closing) {
            return;
        }
        if (this._saving) {
            event.preventDefault();
            return;
        }
        if (!this._dirty) return;
        event.preventDefault();
        if (window.confirm(this._text("discard"))) {
            this._close();
        }
    };

    /**
     * The one way the dialog closes itself.
     *
     * The flag matters because closing hides, and hiding comes back through
     * `_handleHideRequest` -- which would otherwise ask about the draft a
     * second time, after the answer had already been given.
     */
    private _close(): void {
        this._closing = true;
        this.open = false;
        this._notifyClosed();
    }

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

    private _text(suffix: string, values?: Record<string, string | number>): string {
        return this._translate(`${KEY_PREFIX}.${suffix}`, values);
    }

}

/**
 * Where the named optimizers sit in the pipeline, in *config* order.
 *
 * Config order rather than the order the ids were asked for: the cards are read
 * top to bottom as the pipeline that produced the lane, and the pipeline's
 * order is the document's, not the caller's. Ids that no longer resolve are
 * dropped -- an empty result is what raises `not_found`. Both buckets are
 * searched -- the caller only has ids, not which bucket owns them, and a lane
 * badge names whatever actually drives that lane regardless of bucket.
 */
function findOptimizerLocations(
    config: JsonObject,
    optimizerIds: readonly string[],
): OptimizerLocation[] {
    const wanted = new Set(optimizerIds.filter((id) => id.length > 0));
    if (wanted.size === 0) {
        return [];
    }
    return OPTIMIZER_BUCKETS.flatMap((bucket) =>
        readOptimizers(config, bucket)
            .map((entry, index): [number, string | undefined] => [
                index,
                asJsonObject(entry)?.id as string | undefined,
            ])
            .filter(([, id]) => id !== undefined && wanted.has(id))
            .map(([index]): OptimizerLocation => ({ bucket, index })),
    );
}

function readOptimizers(config: JsonObject, bucket: OptimizerBucket) {
    return asJsonArray(asJsonObject(config.automation)?.[bucket]) ?? [];
}

/** One spelling of "this id set", so the two sides of the comparison cannot drift. */
function _optimizerIdKey(optimizerIds: readonly string[]): string {
    return optimizerIds.join("\n");
}

/** A click in the summary row must not collapse the card it sits in. */
const preventSummaryToggle = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
};

const stopSummaryToggle = (event: Event): void => {
    event.stopPropagation();
};

defineOnce("helman-optimizer-edit-dialog", HelmanOptimizerEditDialog);

declare global {
    interface HTMLElementTagNameMap {
        "helman-optimizer-edit-dialog": HelmanOptimizerEditDialog;
    }
}
