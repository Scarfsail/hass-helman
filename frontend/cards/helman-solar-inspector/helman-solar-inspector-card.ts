import { LitElement, css, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import type { HelmanSolarInspectorCardConfig } from "./HelmanSolarInspectorCardConfig";
import {
    hassContextChanged,
    watchedEntityChanged,
    type WatchedEntitiesDetail,
} from "../shared/hass-change";
import "./helman-solar-inspector";

@customElement("helman-solar-inspector-card")
export class HelmanSolarInspectorCard extends LitElement implements LovelaceCard {
    public static async getStubConfig(_hass: HomeAssistant): Promise<Partial<HelmanSolarInspectorCardConfig>> {
        return { type: "custom:helman-solar-inspector-card" };
    }

    public static getConfigForm() {
        return {
            schema: [
                {
                    name: "transparent_background",
                    selector: { boolean: {} },
                },
                {
                    name: "daylight_threshold_w",
                    selector: { number: { min: 0, step: 10, mode: "box", unit_of_measurement: "W" } },
                },
                {
                    name: "daylight_only_default",
                    selector: { boolean: {} },
                },
                {
                    name: "slot_minutes",
                    selector: {
                        select: {
                            mode: "dropdown",
                            options: [
                                { value: "15", label: "15" },
                                { value: "30", label: "30" },
                                { value: "60", label: "60" },
                            ],
                        },
                    },
                },
                {
                    name: "show_bias_ratio",
                    selector: { boolean: {} },
                },
                {
                    name: "dim_incomplete_slots",
                    selector: { boolean: {} },
                },
            ],
        };
    }

    static styles = css`
        :host { display: block; }
        ha-card { overflow: hidden; }
        ha-card.transparent {
            background: transparent;
            box-shadow: none;
            border: none;
        }
        .card-content {
            padding: 12px;
        }
    `;

    private _config!: HelmanSolarInspectorCardConfig;

    @state() private _hass?: HomeAssistant;

    /** The last `hass` handed to the card, accepted or not. */
    private _latestHass?: HomeAssistant;
    /** Every entity id the subtree told us it reads, unioned across dispatchers. */
    private _watchedEntityIds: ReadonlySet<string> = new Set();
    /** The connection the watch set belongs to; a new one resets it. */
    private _watchedConnection: unknown = null;

    /**
     * The filter. See `frontend/cards/README.md`, "Card rendering discipline".
     *
     * **An empty watch set means "watch nothing" here — the opposite of
     * `helman-card`'s policy.** That card treats empty as "the device tree has
     * not hydrated yet" and passes everything through; for this subtree empty is
     * a legitimate steady state — the schedule band can be collapsed forever,
     * and a house with no metered consumers never contributes a switch entity —
     * so falling back to pass-through would mean never filtering at all.
     * `hassContextChanged` is what makes that safe: a card watching no entity
     * still notices a reconnect, a moved time zone or a language change.
     *
     * There is deliberately **no** "pass everything through while a dialog is
     * open" hatch. All three dialogs reachable from here were checked and none
     * reads `hass.states`: the day editor and the explanation panel only forward
     * `hass` on, the condition-trace dialog uses `callWS` alone. The one live
     * read reachable from an open editor is the band's lane icon, whose
     * `lane.entityId` is a controllable entity id and therefore already in the
     * watch set before any editor can be opened. A hatch would reinstate the
     * full ~21 updates/s for a read set that is already covered.
     */
    public set hass(value: HomeAssistant) {
        const previous = this._latestHass;
        this._latestHass = value;
        if (hassContextChanged(previous, value)) {
            this._hass = value;
            return;
        }
        if (watchedEntityChanged(previous, value, this._watchedEntityIds)) {
            this._hass = value;
        }
        // Nothing this card's subtree reads changed — skip the re-render entirely.
    }

    /**
     * Merge a dispatcher's watch set in.
     *
     * A union, not a per-source map: no contributor's set is day-dependent — the
     * band strip's comes from config and is refetched only on reconnect, and the
     * inspector dispatches the unfiltered consumer roster — so the union cannot
     * creep upward as the user pages through days. It is reset on connection
     * change, which is also when a removed appliance's dead id drops out; until
     * then a dead id is inert, since `previous.states[id] !== next.states[id]` on
     * an entity Home Assistant does not know is `undefined !== undefined`.
     *
     * When the set actually grows, hand the current `hass` down once: otherwise a
     * newly-watched badge stays blank until that entity happens to change.
     */
    private _handleWatchedEntities(event: CustomEvent<WatchedEntitiesDetail>) {
        event.stopPropagation();
        if (this._watchedConnection !== this._latestHass?.connection) {
            this._watchedConnection = this._latestHass?.connection;
            this._watchedEntityIds = new Set();
        }
        const merged = new Set(this._watchedEntityIds);
        for (const id of event.detail.entityIds) merged.add(id);
        if (merged.size === this._watchedEntityIds.size) return;
        this._watchedEntityIds = merged;
        if (this._latestHass) this._hass = this._latestHass;
    }

    getCardSize() {
        return 4;
    }

    setConfig(config: HelmanSolarInspectorCardConfig) {
        this._config = {
            transparent_background: false,
            daylight_threshold_w: 100,
            daylight_only_default: true,
            show_bias_ratio: false,
            dim_incomplete_slots: true,
            ...config,
        };
    }

    render() {
        if (!this._hass) {
            return html`
                <ha-card class=${this._config?.transparent_background ? "transparent" : ""}></ha-card>
            `;
        }

        return html`
            <ha-card class=${this._config?.transparent_background ? "transparent" : ""}>
                <div class="card-content">
                    <helman-solar-inspector
                        @helman-watched-entities=${this._handleWatchedEntities}
                        .hass=${this._hass}
                        .daylightThresholdW=${this._config?.daylight_threshold_w ?? 100}
                        .daylightOnlyDefault=${this._config?.daylight_only_default ?? true}
                        .slotMinutesDefault=${this._config?.slot_minutes != null ? Number(this._config.slot_minutes) : undefined}
                        .biasRatioDefault=${this._config?.show_bias_ratio ?? false}
                        .dimIncompleteSlots=${this._config?.dim_incomplete_slots ?? true}
                    ></helman-solar-inspector>
                </div>
            </ha-card>
        `;
    }
}

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: "helman-solar-inspector-card",
    name: "Helman Solar Inspector Card",
    description: "Solar forecast bias correction inspector.",
    preview: true,
});
