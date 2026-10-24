import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { HomeAssistant } from "../../types/ha";
import { getLocalizeFunction } from "../localize/localize";
import { DataChangedController } from "../shared/data/data-changed";
import { describeError } from "../shared/describe-error";
import { showToast } from "../shared/fire-event";
import { cloneJson } from "../shared/config/config-document";
import { ConfigSession } from "../shared/config/config-session";
import type { JsonObject } from "../shared/config/types";

/**
 * The configuration behind a Control view's automation switches. Only an
 * admin reads it; a failed read, or a newer revision announced elsewhere, is
 * read again on the next config change. Each switch reads the current
 * document again before it saves its one change with the revision it read.
 */
export class AdminConfigController implements ReactiveController {
    /** The configuration read: what the switches show. */
    public config: JsonObject | null = null;
    /** Why the read failed; the next data change reads again. */
    public error: string | null = null;
    /** The switch being saved, by the key its caller names it with; `null` while none is. */
    public saving: string | null = null;

    private readonly _session: ConfigSession;
    /** The read that owns its answer: a newer read or a save supersedes an older one. */
    private _load = 0;
    private _started = false;

    constructor(
        private readonly _host: ReactiveControllerHost & HTMLElement,
        private readonly _hass: () => HomeAssistant | undefined,
    ) {
        _host.addController(this);
        this._session = new ConfigSession(_hass);
        new DataChangedController(_host, _hass, { kinds: ["config"] }, (_kinds, { configRevision }) => {
            if (this.saving !== null) return;
            if (this.error !== null || this._session.isStale(configRevision)) void this._read();
        });
    }

    public get isAdmin(): boolean {
        return this._hass()?.user?.is_admin === true;
    }

    hostConnected(): void {
        this._sync();
    }

    hostUpdate(): void {
        this._sync();
    }

    hostDisconnected(): void {
        this._started = false;
    }

    /**
     * Save one change: read the current document, let `edit` change a copy
     * (it answers false when what it changes is no longer there) and save it
     * with the revision read. A conflict keeps the newer document on screen
     * and saves nothing: the switch is pressed again, deliberately, against
     * what is there now. A failed save shows the document as it was read.
     */
    public async save(key: string, edit: (doc: JsonObject) => boolean): Promise<void> {
        if (this.saving !== null) return;
        this.saving = key;
        // A read still in flight is older than this one.
        this._load += 1;
        this._host.requestUpdate();
        const editor = getLocalizeFunction(this._hass()!);
        try {
            const { doc } = await this._session.load();
            const next = doc ? cloneJson(doc) : null;
            if (!doc || !next || !edit(next)) {
                this.config = doc ?? null;
                showToast(this._host, editor("editor.status.changed_elsewhere"));
                return;
            }
            const outcome = await this._session.save(next);
            switch (outcome.kind) {
                case "saved":
                    this.config = outcome.doc;
                    // Saved, but the integration's reload may still have failed.
                    showToast(this._host, outcome.response.success
                        ? editor(outcome.response.reloadStarted
                            ? "editor.messages.config_saved_reload_started"
                            : "editor.messages.config_saved")
                        : outcome.response.reloadError ?? editor("editor.messages.config_saved_reload_failed"));
                    break;
                case "conflict":
                    this.config = outcome.doc;
                    showToast(this._host, editor("editor.status.changed_elsewhere"));
                    break;
                case "invalid":
                    this.config = doc;
                    showToast(this._host, editor("editor.messages.save_rejected"));
                    break;
                case "error":
                    this.config = doc;
                    showToast(this._host, `${editor("editor.messages.save_failed")} ${describeError(outcome.error ?? outcome.response?.reloadError ?? "")}`);
                    break;
            }
        } catch (error) {
            showToast(this._host, `${editor("editor.messages.save_failed")} ${describeError(error)}`);
        } finally {
            this.saving = null;
            this._host.requestUpdate();
        }
    }

    private _sync(): void {
        if (this._started || !this.isAdmin) return;
        this._started = true;
        void this._read();
    }

    private async _read(): Promise<void> {
        const load = ++this._load;
        try {
            const { doc } = await this._session.load();
            if (load !== this._load) return;
            this.config = doc ?? null;
            this.error = null;
        } catch (error) {
            if (load !== this._load) return;
            console.error("admin-config: failed to load the configuration", error);
            this.error = describeError(error);
        }
        this._host.requestUpdate();
    }
}
