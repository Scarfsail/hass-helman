import { asJsonArray, asJsonObject } from "../config/config-document";
import { booleanValue, stringValue } from "../config/form-fields";
import type { HomeAssistantLike, JsonObject } from "../config/types";
import { getSharedDataChangedFeed, type DataChangedHost } from "../../helman/data-changed";
import { fetchOptimizerSchema, type OptimizerSchemaDocument } from "./optimizer-schema";

/**
 * The backend's "you are not an admin", which `helman/get_config` answers a
 * non-admin viewer with. Matched on the code the handler sends, not on the
 * message, which is prose.
 */
function _isUnauthorized(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && (error as { code?: unknown }).code === "unauthorized";
}

/**
 * Which automations drive one controllable, and whether any of them is live.
 *
 * `optimizerIds` lists *every* optimizer targeting the lane in config order,
 * enabled or not: the badge that opens them is the one place a person goes to
 * switch a disabled automation back on, so hiding the disabled ones would hide
 * the only thing they came for.
 */
export interface LaneAutomationCoverage {
    state: LaneAutomationCoverageState;
    optimizerIds: readonly string[];
}

export type LaneAutomationCoverageState = "active" | "disabled_only" | "none";

/** Coverage by controllable id -- `target.controllable_id`, the lane's own key. */
export type AutomationCoverageIndex = ReadonlyMap<string, LaneAutomationCoverage>;

const EMPTY_COVERAGE: LaneAutomationCoverage = { state: "none", optimizerIds: [] };

/** A lane the index says nothing about has no automation on it. */
export function getLaneAutomationCoverage(
    index: AutomationCoverageIndex | null,
    controllableId: string,
): LaneAutomationCoverage {
    return index?.get(controllableId) ?? EMPTY_COVERAGE;
}

/**
 * The config's optimizer pipeline, read as "what drives which lane".
 *
 * Every optimizer kind names its lane the same way -- `target.controllable_id`,
 * with `"inverter"` for the inverter -- which is exactly the string a band lane
 * carries as its `target`. That shared spelling is the whole mapping; nothing
 * here has to know what an appliance is.
 *
 * The field is optional on the kinds that have a reserved default for it, and
 * the reader resolves those from the schema rather than from the document. So
 * does this: a hand-authored `charge_hold` with no target still drives the
 * inverter, and a badge that called that lane manual would be wrong in exactly
 * the way the badge exists to prevent. The default is read from the served
 * schema rather than from a list spelled out here, because a list here would be
 * a second answer to "which kinds mean the inverter" and would go stale the day
 * a fourth one arrives.
 *
 * `enabled` defaults to true when absent, the same reading
 * `helman-optimizer-editor` uses to style its card, so the badge and the card
 * can never disagree about whether an automation is on.
 *
 * The automation's master switch overrides every optimizer: with `automation`
 * off nothing in the pipeline runs, so a lane whose optimizers are all enabled
 * is still not being driven. Calling that `active` would be a lie the user
 * could act on.
 */
export function buildAutomationCoverageIndex(
    config: JsonObject,
    schema: OptimizerSchemaDocument | null = null,
): AutomationCoverageIndex {
    const automation = asJsonObject(config.automation);
    const masterEnabled = booleanValue(automation?.enabled, true);
    const index = new Map<string, { optimizerIds: string[]; anyEnabled: boolean }>();

    for (const entry of asJsonArray(automation?.optimizers) ?? []) {
        const optimizer = asJsonObject(entry);
        if (!optimizer) {
            continue;
        }
        const controllableId = stringValue(asJsonObject(optimizer.target)?.controllable_id)
            || _schemaTargetDefault(schema, stringValue(optimizer.kind));
        if (controllableId.length === 0) {
            continue;
        }

        const existing = index.get(controllableId) ?? { optimizerIds: [], anyEnabled: false };
        // An optimizer with no id cannot be opened in the edit dialog, which
        // resolves by id -- but it still counts towards the lane's state, so
        // the badge does not call an automated lane manual.
        const optimizerId = stringValue(optimizer.id);
        if (optimizerId.length > 0) {
            existing.optimizerIds.push(optimizerId);
        }
        existing.anyEnabled ||= masterEnabled && booleanValue(optimizer.enabled, true);
        index.set(controllableId, existing);
    }

    return new Map(
        [...index].map(([controllableId, { optimizerIds, anyEnabled }]): [string, LaneAutomationCoverage] => [
            controllableId,
            { state: anyEnabled ? "active" : "disabled_only", optimizerIds },
        ]),
    );
}

/** The lane a kind drives when its document does not say -- the schema's own default. */
function _schemaTargetDefault(schema: OptimizerSchemaDocument | null, kind: string): string {
    const target = schema?.kinds.find((entry) => entry.kind === kind)?.target;
    return stringValue(target?.find((field) => field.key === "controllable_id")?.default);
}

/**
 * The coverage index, read once per connection and kept current.
 *
 * Every lane of every band asks the same question of the same document, so the
 * read is shared the way `getSharedHelmanStore` shares its own: one
 * `helman/get_config` per connection rather than one per element. `get()`
 * answers `null` until the first read lands, which callers draw as "no badge
 * yet" rather than guessing at "no automation".
 *
 * The `helman_data_changed` feed is what keeps it honest -- saving an optimizer
 * from the badge's own dialog is exactly the case that must not leave a stale
 * colour behind. The kinds are ignored on purpose, per that feed's listener
 * contract.
 */
export interface AutomationCoverageSource {
    get(): AutomationCoverageIndex | null;
    subscribe(listener: (index: AutomationCoverageIndex) => void): () => void;
}

export type AutomationCoverageHost = HomeAssistantLike & DataChangedHost;

const sources = new WeakMap<object, AutomationCoverageSourceImpl>();

/**
 * Keyed by the connection where there is one, so the config editor's narrow
 * `HomeAssistantLike` and the cards' real `hass` share a source when they share
 * a socket. A host without a connection gets its own, which is what the
 * Playwright mounts do.
 */
export function getSharedAutomationCoverage(hass: AutomationCoverageHost): AutomationCoverageSource {
    const key: object = hass.connection ?? hass;
    let source = sources.get(key);
    if (!source) {
        source = new AutomationCoverageSourceImpl(hass);
        sources.set(key, source);
    } else {
        source.updateHass(hass);
    }

    return source;
}

class AutomationCoverageSourceImpl implements AutomationCoverageSource {
    private _hass: AutomationCoverageHost;
    private _index: AutomationCoverageIndex | null = null;
    private readonly _listeners = new Set<(index: AutomationCoverageIndex) => void>();
    private _unsubscribeDataChanged: (() => void) | null = null;
    /** The read in flight, so a burst of mounting lanes costs one round trip. */
    private _pending: Promise<void> | null = null;
    /**
     * A change arrived while a read was in flight.
     *
     * Without the trailing edge the coalescing silently drops it: the feed
     * flushes 400ms after the first event of a batch, which can easily land
     * inside a round trip, and the badge would then keep the pre-change colour
     * until some later, unrelated event happened to shake it loose.
     */
    private _rereadRequested = false;
    /**
     * The optimizer schema, which needs reading once.
     *
     * It is compiled into the integration, so it changes only when Home
     * Assistant restarts -- and a restart drops this connection and with it
     * this whole source.
     */
    private _schema: OptimizerSchemaDocument | null = null;
    /**
     * `helman/get_config` is admin-gated, and a non-admin's refusal is not a
     * transient failure -- it is the answer. Retrying it on every announcement
     * for the life of the page would be a rejected round trip per re-plan, for
     * a badge that can never appear.
     */
    private _refused = false;

    constructor(hass: AutomationCoverageHost) {
        this._hass = hass;
    }

    public updateHass(hass: AutomationCoverageHost): void {
        this._hass = hass;
    }

    public get(): AutomationCoverageIndex | null {
        return this._index;
    }

    public subscribe(listener: (index: AutomationCoverageIndex) => void): () => void {
        this._listeners.add(listener);
        this._ensureDataChangedSubscription();
        void this._read();

        let isSubscribed = true;
        return () => {
            if (!isSubscribed) {
                return;
            }
            isSubscribed = false;
            this._listeners.delete(listener);
            if (this._listeners.size === 0) {
                this._unsubscribeDataChanged?.();
                this._unsubscribeDataChanged = null;
            }
        };
    }

    private _ensureDataChangedSubscription(): void {
        if (this._unsubscribeDataChanged !== null) {
            return;
        }
        this._unsubscribeDataChanged = getSharedDataChangedFeed(this._hass).subscribe(() => {
            void this._read();
        });
    }

    private async _read(): Promise<void> {
        if (this._refused) {
            return;
        }
        if (this._pending !== null) {
            this._rereadRequested = true;
            return this._pending;
        }

        this._pending = (async () => {
            try {
                this._schema ??= await fetchOptimizerSchema(this._hass);
                const config = asJsonObject(await this._hass.callWS<unknown>({ type: "helman/get_config" }));
                if (!config) {
                    return;
                }
                this._index = buildAutomationCoverageIndex(config, this._schema);
                for (const listener of this._listeners) {
                    listener(this._index);
                }
            } catch (error) {
                // A failed read leaves the last good index in place, and the
                // badge stays dark until the first one lands. Coverage is
                // decoration on a band that has to keep drawing regardless.
                // A refusal, though, is a final answer -- see `_refused`.
                this._refused = _isUnauthorized(error);
            } finally {
                this._pending = null;
                if (this._rereadRequested) {
                    this._rereadRequested = false;
                    void this._read();
                }
            }
        })();

        return this._pending;
    }
}
