import type { HomeAssistant } from "../../../types/ha";
import { callHelman } from "../data/helman-commands";
import { asJsonObject } from "./config-document";
import type { JsonObject, SaveConfigResponse } from "./types";

export type SaveOutcome =
    | { kind: "saved"; doc: JsonObject; revision: string; response: SaveConfigResponse }
    | { kind: "conflict"; doc: JsonObject; revision: string; response: SaveConfigResponse }
    | { kind: "invalid"; response: SaveConfigResponse }
    | { kind: "error"; error?: unknown; response?: SaveConfigResponse; doc?: JsonObject; revision?: string };

/** The document and revision agreed with by one config editor or dialog. */
export class ConfigSession {
    private _revision: string | null = null;

    constructor(private readonly _hass: () => HomeAssistant | undefined) {}

    get revision(): string | null { return this._revision; }

    async load(): Promise<{ doc: JsonObject | undefined; revision: string }> {
        const hass = this._hass();
        if (!hass) throw new Error("Home Assistant unavailable");
        const response = await callHelman(hass, "helman/get_config", { include_revision: true });
        if (typeof response?.revision !== "string") {
            throw new Error("Configuration revision unavailable; reload after updating Helman");
        }
        this._revision = response.revision;
        return { doc: asJsonObject(response.config), revision: response.revision };
    }

    isStale(eventRevision: string | undefined): boolean {
        return eventRevision !== undefined && this._revision !== null && eventRevision !== this._revision;
    }

    async save(doc: JsonObject): Promise<SaveOutcome> {
        const hass = this._hass();
        if (!hass) return { kind: "error", error: new Error("Home Assistant unavailable") };
        try {
            const response = await callHelman(hass, "helman/save_config", {
                config: doc,
                ...(this._revision !== null ? { expected_revision: this._revision } : {}),
            });
            const stored = asJsonObject(response.config);
            if (response.conflict) {
                return stored && response.revision
                    ? { kind: "conflict", doc: stored, revision: response.revision, response }
                    : { kind: "error", response };
            }
            if (stored && response.revision) {
                this._revision = response.revision;
                return { kind: "saved", doc: stored, revision: response.revision, response };
            }
            if (response.validation?.valid === false) return { kind: "invalid", response };
            return { kind: "error", response };
        } catch (error) {
            return { kind: "error", error };
        }
    }
}
