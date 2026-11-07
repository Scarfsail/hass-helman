import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant, LovelaceCard, LovelaceCardEditor } from "../../types/ha";
import type { EvChargerDetailPayload } from "../helman-api";
import { EnergyCardHost } from "../shared/energy-card-host";
import { getSharedHelmanStore } from "../shared/data/store";
import { hydrateDeviceTree } from "../shared/data/tree-item-hydrator";
import { HistoryEngine } from "../shared/data/history-engine";
import type { TreeItem } from "../shared/data/tree-item";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { readTodayKWh } from "../shared/devices/device-energy";
import { todayKey } from "../shared/time/day-key";
import { helmanColorVars } from "../color-vars";
import { fillTemplate } from "../localize/localize";
import { evChargerId, powerEntity } from "../node-detail/node-detail-utils";
import {
    ENERGY_NODE_TYPES,
    availableFields,
    fieldEntityIds,
    isConnected,
    isIdle,
    readField,
    resolveTarget,
    type DeviceCardTarget,
    type FieldContext,
} from "./device-card-fields";
import type { HelmanDeviceCardConfig } from "./HelmanDeviceCardConfig";
import "../node-detail/node-detail-dialog";
import "../shared/schedule/dialogs/scheduling-day-editor-host";
import "../helman-simple/simple-card-solar";
import "../helman-simple/simple-card-battery";
import "../helman-simple/simple-card-grid";
import "../helman-simple/simple-card-house";
import "./helman-device-card-editor";

/**
 * One helman device or energy node as a tile: its icon, its name and the
 * configured fields joined with " · ". Tapping it opens the helman detail.
 */
@customElement("helman-device-card")
export class HelmanDeviceCard extends LitElement implements LovelaceCard {
    // 1. Static HA configuration methods
    public static async getStubConfig(hass: HomeAssistant): Promise<Partial<HelmanDeviceCardConfig>> {
        const tree = hydrateDeviceTree(await getSharedHelmanStore(hass).getDeviceTree(), (key) => key);
        const device = HistoryEngine.walkTree(tree).find((item) => item.deviceKey && powerEntity(item));
        return { type: "custom:helman-device-card", ...(device ? { device: device.deviceKey } : { node: "solar" }), fields: ["state", "power"] };
    }

    public static getConfigElement(): LovelaceCardEditor {
        return document.createElement("helman-device-card-editor") as unknown as LovelaceCardEditor;
    }

    // 2. Static styles
    static styles = [helmanColorVars, css`
        :host { display: block; height: 100%; min-width: 0; }
        ha-card {
            height: 100%;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 0 10px;
            min-height: 56px;
            box-sizing: border-box;
            cursor: pointer;
        }
        ha-card:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: -2px;
        }
        .icon {
            flex: none;
            width: 40px;
            height: 40px;
            display: grid;
            place-items: center;
        }
        .icon ha-icon {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            display: grid;
            place-items: center;
            --mdc-icon-size: 22px;
            color: var(--state-inactive-color, var(--disabled-text-color));
            background: color-mix(in srgb, currentColor 15%, transparent);
        }
        .icon.active ha-icon {
            color: var(--state-active-color, var(--primary-color));
        }
        .icon.connected ha-icon {
            color: var(--success-color, #43a047);
        }
        .info {
            min-width: 0;
            display: flex;
            flex-direction: column;
        }
        .name, .line {
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }
        .name {
            font-size: 14px;
            font-weight: 500;
            line-height: 20px;
            color: var(--primary-text-color);
        }
        .line {
            font-size: 12px;
            line-height: 16px;
            color: var(--secondary-text-color);
        }
        .line::first-letter {
            text-transform: uppercase;
        }
        ha-alert { display: block; }
    `];

    // 3. Private properties & Host controller
    @state() private _config?: HelmanDeviceCardConfig;
    private readonly _host = new EnergyCardHost(this, {
        // The tile watches only what it announces: walking a node would watch its children too.
        whichNodesToWalk: () => [],
    });
    /** The tree and config the target was resolved from: only a refresh or a new config re-resolves it. */
    private _resolvedFrom?: { tree: TreeItem[]; config: HelmanDeviceCardConfig };
    private _target: DeviceCardTarget | null = null;
    private _ev: EvChargerDetailPayload | null = null;
    private _evId: string | null = null;
    /** The run mode state the overview was last asked for under. */
    private _evStatus?: string;
    private _evRequest = 0;
    /** Whether the last overview read failed: the next update reads it again. */
    private _evFailed = false;
    private _meterState?: unknown;
    /** The local day the energy today was last read on: a new day reads it again. */
    private _meterDay?: string;
    private _meter?: string;
    private _todayKWh?: number | null;
    private _todayRequest = 0;
    // What render draws, derived in willUpdate.
    private _name = "";
    private _line = "";
    private _tone: "active" | "connected" | "inactive" = "inactive";

    // 7. HA-specific setters
    public set hass(hass: HomeAssistant) {
        this._host.setHass(hass);
    }

    // 8. HA-specific methods
    public setConfig(config: HelmanDeviceCardConfig): void {
        if (config.device && config.node) throw new Error("helman-device-card: set either device or node, not both");
        if (config.node && !ENERGY_NODE_TYPES.includes(config.node)) {
            throw new Error(`helman-device-card: node must be one of ${ENERGY_NODE_TYPES.join(", ")}`);
        }
        for (const key of ["fields", "hide_when_idle"] as const) {
            if (config[key] !== undefined && !Array.isArray(config[key])) throw new Error(`helman-device-card: ${key} must be a list`);
        }
        this._config = config;
    }

    public getCardSize(): number {
        return 1;
    }

    public getGridOptions() {
        return { columns: 6, rows: 1, min_columns: 3, min_rows: 1 };
    }

    // 9. Lifecycle methods
    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        const config = this._config;
        const hass = this._host.hass;
        const localize = this._host.localize;
        // A failed load settles on an empty tree: the target is not found.
        if (!config || !hass || !localize || !(this._host.loaded || this._host.loadFailed)) return;

        const tree = this._host.deviceTree;
        if (this._resolvedFrom?.tree !== tree || this._resolvedFrom.config !== config) {
            // A refreshed tree may carry a changed power entity under the same EV id: the overview is read again.
            const treeRefreshed = !!this._resolvedFrom && this._resolvedFrom.tree !== tree;
            this._resolvedFrom = { tree, config };
            this._target = resolveTarget(config, tree, this._host.energyNodes);
            const evId = this._target?.kind === "device" ? evChargerId(this._target.item) : null;
            if (evId !== this._evId) {
                this._evId = evId;
                this._ev = null;
                this._evStatus = undefined;
                this._evFailed = false;
                this._evRequest += 1;
                if (evId) void this._loadEv(evId, false);
            } else if (evId && treeRefreshed) {
                void this._loadEv(evId, true);
            }
            this._announceWatched();
        }
        const target = this._target;
        if (!target) return;
        const fields = config.fields ?? [];

        // The overview's status is the backend's reading of the run mode: a new run mode is read again.
        if (this._evId && this._ev && this._statusState(hass) !== this._evStatus) {
            this._evStatus = this._statusState(hass);
            void this._loadEv(this._evId, true);
        } else if (this._evId && this._evFailed) {
            this._evFailed = false;
            void this._loadEv(this._evId, true);
        }

        const meter = target.kind === "device" && fields.includes("energy_today") ? target.item.energyEntityId : undefined;
        if (meter !== this._meter) {
            this._meter = meter;
            this._meterState = undefined;
            this._todayKWh = undefined;
            this._todayRequest += 1;
        }
        const meterState = meter ? hass.states[meter] : undefined;
        // The host's periodic history tick updates an idle tile past midnight.
        const day = todayKey(hass.config?.time_zone);
        if (meter && (meterState !== this._meterState || day !== this._meterDay)) {
            this._meterState = meterState;
            this._meterDay = day;
            void this._loadToday(meter);
        }

        const ctx: FieldContext = { hass, localize, readings: this._host.readings, todayKWh: this._todayKWh, ev: this._ev };
        const hidden = config.hide_when_idle ?? [];
        const idle = isIdle(target, ctx);
        const text = (field: (typeof fields)[number]) => {
            const value = readField(target, field, ctx);
            return value === null ? null : value.unit ? `${value.text} ${value.unit}` : value.text;
        };
        const offered = availableFields(target);
        const shown = idle ? fields.filter((field) => !hidden.includes(field)) : fields;
        const parts = shown.map(text).filter((part): part is string => part !== null);
        // Every field hidden while idle leaves the idle state, and no reading says so: never an empty line.
        this._line = !shown.length && fields.length ? text("state") ?? localize("device_card.idle")
            : !parts.length && shown.some((field) => offered.includes(field)) ? localize("node_detail.shared.technical.unavailable")
            : parts.join(" · ");
        this._name = config.name || (target.kind === "node" ? localize(`node_detail.title.${target.node}`) : target.item.name);
        this._tone = !idle ? "active" : isConnected(target, ctx) ? "connected" : "inactive";
    }

    // 10. Render method
    render() {
        const hass = this._host.hass;
        const localize = this._host.localize;
        if (!hass || !localize || !this._config) return nothing;
        const dialogParams = this._host.dialogParams;
        return html`
            ${this._renderTile()}
            <scheduling-day-editor-host
                .hass=${hass}
                .timeZone=${hass.config?.time_zone || "UTC"}
            ></scheduling-day-editor-host>
            ${dialogParams ? html`
                <node-detail-dialog
                    .hass=${hass}
                    .localize=${localize}
                    .open=${true}
                    .params=${dialogParams}
                    @closed=${this._onClosed}
                ></node-detail-dialog>
            ` : nothing}
        `;
    }

    private _renderTile() {
        const localize = this._host.localize!;
        if (!this._host.loaded && !this._host.loadFailed) return html`<ha-card><div class="line">${localize("card.loading")}</div></ha-card>`;
        const target = this._target;
        if (!target) {
            const name = this._config!.device ?? this._config!.node;
            return html`<ha-alert alert-type="warning">${name
                ? fillTemplate(localize("device_card.not_found"), { target: name })
                : localize("device_card.no_target")}</ha-alert>`;
        }
        return html`
            <ha-card role="button" tabindex="0" @click=${this._open} @keydown=${this._onKeydown}>
                <div class=${this._tone === "inactive" ? "icon" : "icon " + this._tone}>${this._renderIcon(target)}</div>
                <div class="info">
                    <span class="name">${this._name}</span>
                    <span class="line">${this._line}</span>
                </div>
            </ha-card>
        `;
    }

    private _renderIcon(target: DeviceCardTarget) {
        const readings = this._host.readings;
        if (target.kind === "node") {
            switch (target.node) {
                case "solar": return html`<simple-card-solar .compact=${true} .power=${readings?.solarPower ?? 0}></simple-card-solar>`;
                case "battery": return html`<simple-card-battery .compact=${true} .power=${readings?.batteryPower ?? 0}
                    .soc=${readings?.batterySoc ?? 0}></simple-card-battery>`;
                case "grid": return html`<simple-card-grid .compact=${true} .power=${readings?.gridPowerSigned ?? 0}></simple-card-grid>`;
                case "house": return html`<simple-card-house .compact=${true} .power=${readings?.housePower ?? 0}></simple-card-house>`;
            }
        }
        const item = target.item;
        const icon = item.icon || (this._evId ? "mdi:car-electric" : item.climateEntityId ? "mdi:air-conditioner"
            : item.coverEntityId ? "mdi:window-shutter" : "mdi:power-plug");
        return html`<ha-icon .icon=${icon}></ha-icon>`;
    }

    /** Every entity the configured fields read, and what idleness reads, which tints the icon. */
    private _announceWatched(): void {
        const target = this._target;
        const fields = new Set([...(this._config!.fields ?? []), "state", "power"] as const);
        const ids = target ? [...fields].flatMap((field) => fieldEntityIds(target, field, this._ev)) : [];
        dispatchWatchedEntities(this, "device-card", ids);
    }

    /** The run mode entity's state, read even while the overview resolved no status from it. */
    private _statusState(hass: HomeAssistant): string | undefined {
        const entityId = this._ev?.entities.run_mode;
        return entityId ? hass.states[entityId]?.state : undefined;
    }

    private async _loadEv(deviceId: string, fresh: boolean): Promise<void> {
        const request = ++this._evRequest;
        try {
            const overview = await getSharedHelmanStore(this._host.latestHass!)
                .getNodeDetail<EvChargerDetailPayload>({ node: "ev_charger", device_id: deviceId }, { fresh });
            if (request !== this._evRequest) return;
            const first = this._ev === null;
            this._ev = overview;
            if (first) this._evStatus = this._statusState(this._host.hass!);
            this._announceWatched();
            this.requestUpdate();
        } catch (error) {
            if (request !== this._evRequest) return;
            this._evFailed = true;
            console.error("helman-device-card: failed to load the charger overview", error);
        }
    }

    private async _loadToday(meter: string): Promise<void> {
        const request = ++this._todayRequest;
        const kwh = await readTodayKWh(this._host.latestHass!, meter);
        if (request !== this._todayRequest) return;
        this._todayKWh = kwh;
        this.requestUpdate();
    }

    private _open = (): void => {
        const target = this._target;
        if (target) this._host.openNode(target.kind === "node" ? target.node : target.item);
    };

    private _onKeydown = (event: KeyboardEvent): void => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this._open();
    };

    private _onClosed = (event: Event): void => {
        event.stopPropagation();
        this._host.closeDialog();
    };
}

// Card registration
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: "helman-device-card",
    name: "Helman Device Card",
    description: "One helman device or energy node as a tile: its state, power and energy, opening its helman detail on tap.",
    preview: true,
});
