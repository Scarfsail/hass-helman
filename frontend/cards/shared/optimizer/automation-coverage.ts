import { callHelman } from "../data/helman-commands";
import type { HomeAssistant } from "../../../types/ha";
import type { AutomationCoverageStateDTO } from "../../helman-api";
import { getSharedDataChangedFeed } from "../../helman/data-changed";

/**
 * Which automations drive one controllable, and whether any of them is live.
 *
 * `optimizerIds` lists *every* optimizer targeting the lane in config order,
 * enabled or not: the badge that opens them is the one place a person goes to
 * switch a disabled automation back on, so hiding the disabled ones would hide
 * the only thing they came for.
 *
 * The backend resolves it from the parsed automation config -- both target
 * shapes, the schema's default target, `enabled` and the master switch -- so the
 * badge and the pipeline read one answer. A lane it says nothing about is
 * `none`: no optimizer targets it.
 */
export interface LaneAutomationCoverage {
    state: LaneAutomationCoverageState;
    optimizerIds: readonly string[];
}

export type LaneAutomationCoverageState = AutomationCoverageStateDTO | "none";

/** Coverage by controllable id -- the lane's own key. */
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
 * The coverage index, read once per connection and kept current.
 *
 * Every lane of every band asks the same question of the same document, so the
 * read is shared the way `getSharedHelmanStore` shares its own: one
 * `helman/get_automation_coverage` per connection rather than one per element. `get()`
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

const sources = new WeakMap<object, AutomationCoverageSourceImpl>();

/**
 * Keyed by the connection where there is one, so the config editor and the
 * cards share a source when they share a socket. A host without a connection gets its own, which is what the
 * Playwright mounts do.
 */
export function getSharedAutomationCoverage(hass: HomeAssistant): AutomationCoverageSource {
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
    private _hass: HomeAssistant;
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

    constructor(hass: HomeAssistant) {
        this._hass = hass;
    }

    public updateHass(hass: HomeAssistant): void {
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
        this._unsubscribeDataChanged = getSharedDataChangedFeed(this._hass).subscribe((kinds) => {
            if (kinds.has("config")) void this._read();
        });
    }

    private async _read(): Promise<void> {
        if (this._pending !== null) {
            this._rereadRequested = true;
            return this._pending;
        }

        this._pending = (async () => {
            try {
                const coverage = await callHelman(this._hass, "helman/get_automation_coverage", {});
                this._index = new Map(Object.entries(coverage.controllables));
                for (const listener of this._listeners) {
                    listener(this._index);
                }
            } catch {
                // A failed read leaves the last good index in place, and the
                // badge stays dark until the first one lands. Coverage is
                // decoration on a band that has to keep drawing regardless.
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
