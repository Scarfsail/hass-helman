import { LitElement, css, html, nothing } from "lit-element";
import { property, state } from "lit/decorators.js";

import type { LocalizeFunction } from "../../localize/localize";
import { defineOnce } from "../define-once";
import { loadHaForm } from "../load-ha-elements";
import { getSharedDataChangedFeed } from "../../helman/data-changed";
import {
    asJsonArray,
    asJsonObject,
    canonicalJson,
    cloneJson,
    setValueAtPath,
} from "../config/config-document";
import {
    getLocalizeFunction,
    type LocalizeFunction as EditorLocalizeFunction,
} from "../config/localize/localize";
import type {
    ApplianceMetadataResponse,
    HomeAssistantLike,
    JsonObject,
    PathSegment,
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
         */
        indices: readonly number[];
        /** How many optimizers the document holds, for the cards' bounds. */
        total: number;
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

    @property({ attribute: false }) public hass?: HomeAssistantLike;

    /** The card bundle's localize, for this dialog's own chrome. */
    @property({ attribute: false }) public localize!: LocalizeFunction;

    @property({ type: Boolean }) public open = false;

    /**
     * Which optimizers to edit, by `automation.optimizers[].id`.
     *
     * A list rather than one id because a lane is not a single automation: the
     * inverter has three, and the coverage badge that opens this dialog means
     * "show me what drives this lane", not "show me one of the things that do".
     */
    @property({ attribute: false }) public optimizerIds: readonly string[] = [];

    @state() private _view: EditViewState = { kind: "loading" };

    @state() private _dirty = false;

    @state() private _saving = false;

    @state() private _message: SaveMessage | null = null;

    /**
     * The config changed under us, and the draft must not be written over it.
     *
     * Every `helman_data_changed` sends the dialog to look -- the event says
     * something moved, never who moved it -- and the re-read at save time is
     * the backstop for a page that missed the announcement entirely. See
     * `_refreshStale` and `_handleSave`.
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
    private _stalenessCheck: Promise<void> | null = null;

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
                        ${this._format("not_found", { id: this.optimizerIds.join(", ") })}
                    </div>
                `;
            case "ready":
                // Stacked and all expanded rather than tabbed: seeing what
                // drives a lane *together* is the reason the badge opens more
                // than one, and one shared draft with one Save is what makes
                // them one edit rather than several.
                return html`
                    ${view.indices.map((index) => html`
                        <helman-optimizer-editor
                            .config=${view.config}
                            .index=${index}
                            .total=${view.total}
                            .schema=${view.schema}
                            .applianceMetadata=${view.applianceMetadata}
                            .expanded=${true}
                            .hass=${this.hass}
                            .localize=${(key: string) => this._editorText(key)}
                            .listActions=${(basePath: PathSegment[], enabled: boolean) =>
                                this._renderEnabledToggle(basePath, enabled)}
                            @optimizer-config-changed=${this._handleConfigChanged}
                        ></helman-optimizer-editor>
                    `)}
                `;
        }
    }

    /**
     * The optimizer's on/off switch, in the card's summary row.
     *
     * Only the switch -- not the up/down/remove the config panel puts beside
     * it. Those are *pipeline* operations: they change which optimizers exist
     * and in what order they run, which is the document's business and not
     * something to do from a dialog opened by pressing one lane. Turning an
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
                    <span>${this._editorText("editor.fields.optimizer_enabled")}</span>
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
    private async _load(): Promise<void> {
        const hass = this.hass;
        if (!hass) {
            return;
        }
        this._view = { kind: "loading" };
        this._dirty = false;
        this._stale = false;
        this._loadedIds = _optimizerIdKey(this.optimizerIds);
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
            const indices = findOptimizerIndices(document, this.optimizerIds);
            this._view =
                indices.length === 0
                    ? { kind: "not_found" }
                    : {
                          kind: "ready",
                          config: cloneJson(document),
                          indices,
                          total: optimizerCount(document),
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
            const response = await this.hass.callWS<SaveConfigResponse>({
                type: "helman/save_config",
                config: view.config,
            });
            if (response.validation?.valid !== false) {
                // The document we just wrote is the new baseline. Without this
                // a retry would compare against the pre-save read, find our own
                // write, and refuse. Re-read rather than reuse the draft: the
                // backend stamps `config_version` on write, and the baseline
                // has to be what a later read will actually return.
                //
                // Done whenever the *write* landed, which is not the same as
                // the save succeeding: `save_config` stores the document before
                // it attempts the entry reload, so a reload that then failed
                // still leaves the stored document ours. That is exactly the
                // case where the dialog stays open and the user tries again.
                await this._rebaseline();
                // The stored document *is* the baseline again, so whatever the
                // reload's own announcements arrive to say, they are not news
                // that somebody else wrote.
                this._stale = false;
                this._dirty = false;
            }
            if (response.success) {
                // Say what happened on the way out. The restart this started
                // makes the integration's entities briefly unavailable, which
                // is worth knowing about, and the dialog is no longer there to
                // say it -- so it goes to Home Assistant's own toast.
                this._notify(this._editorText(
                    response.reloadStarted
                        ? "editor.messages.config_saved_reload_started"
                        : "editor.messages.config_saved",
                ));
                // Saving is finishing, so the dialog closes. Leaving it open on
                // a green message made Cancel the way out of a save that had
                // already succeeded, which reads as though it might undo it.
                this.open = false;
                this._notifyClosed();
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
     * A failed re-read answers `"unknown"`, and the two callers want opposite
     * things from that: the save must refuse (a retry costs the user a click,
     * saving over someone else costs them their work), while the banner must
     * stay quiet (a dropped frame is not evidence that anybody wrote anything).
     */
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

    /**
     * Whether to raise the "changed elsewhere" banner, checked rather than
     * inferred from the announcement.
     *
     * `helman_data_changed` cannot tell us who wrote: one `save_config` fires
     * several of them -- the entry reload it starts re-plans, and the plan and
     * schedule announcements land well after the feed's collapse window closes
     * on the first. A dialog that treated "one event is mine, the rest are
     * someone else's" therefore accused itself, showing the banner beside its
     * own success message. Reading the document and comparing it is the only
     * thing that actually answers the question the banner asks.
     *
     * Skipped while our own write is in flight: the document is legitimately in
     * motion then, and `_handleSave` adopts the result as the new baseline the
     * moment it settles.
     */
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
            }
        } catch {
            // Leaving the old baseline in place is the safe failure: the next
            // save re-reads anyway and will refuse rather than clobber.
        }
    }

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

/**
 * Where the named optimizers sit in the pipeline, in *config* order.
 *
 * Config order rather than the order the ids were asked for: the cards are read
 * top to bottom as the pipeline that produced the lane, and the pipeline's
 * order is the document's, not the caller's. Ids that no longer resolve are
 * dropped -- an empty result is what raises `not_found`.
 */
function findOptimizerIndices(config: JsonObject, optimizerIds: readonly string[]): number[] {
    const wanted = new Set(optimizerIds.filter((id) => id.length > 0));
    if (wanted.size === 0) {
        return [];
    }
    return readOptimizers(config)
        .map((entry, index): [number, string | undefined] => [index, asJsonObject(entry)?.id as string | undefined])
        .filter(([, id]) => id !== undefined && wanted.has(id))
        .map(([index]) => index);
}

/** How many optimizers the pipeline holds, for the cards' list bounds. */
function optimizerCount(config: JsonObject): number {
    return readOptimizers(config).length;
}

function readOptimizers(config: JsonObject) {
    return asJsonArray(asJsonObject(config.automation)?.optimizers) ?? [];
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

function describeError(error: unknown): string {
    if (typeof error === "object" && error !== null && "message" in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}

defineOnce("helman-optimizer-edit-dialog", HelmanOptimizerEditDialog);

declare global {
    interface HTMLElementTagNameMap {
        "helman-optimizer-edit-dialog": HelmanOptimizerEditDialog;
    }
}
