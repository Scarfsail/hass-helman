import { DialogHistoryController } from "../shared/dialog-history-controller";
import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { nothing, TemplateResult } from "lit-html";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import type { NodeDetailParams, NodeDetailTab, NodeDetailTabRequest } from "./node-detail-types";
import type { TreeItem } from "../shared/data/tree-item";
import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { loadHaEntityToggle } from "../shared/load-ha-elements";
import "./node-detail-battery-content";
import "./node-detail-solar-content";
import "./node-detail-grid-content";
import "./node-detail-house-content";
import "./node-detail-inverter-content";
import "./node-detail-ev-charger-content";
import "./node-detail-device-content";
import "./node-control";
import "./node-control-rollup";
import type { HelmanDeviceEditDialog } from "../shared/devices/helman-device-edit-dialog";
import "../shared/devices/helman-device-edit-dialog";
import { deviceControllableIds, deviceDirectControls } from "./node-detail-utils";
const TABS: readonly NodeDetailTab[] = ["overview", "schedule"];

/**
 * A node's detail in Home Assistant's dialog. A node with controls opens on
 * its Overview with a Schedule tab beside it, or on the tab the power card was
 * asked for; only the tab shown is in the page, so a hidden one reads nothing.
 * Another node swaps in place, inside the one history entry the dialog holds.
 */
@customElement("node-detail-dialog")
export class NodeDetailDialog extends LitElement {
    static styles = css`
        .tabs {
            display: flex;
            gap: 4px;
            border-bottom: 1px solid var(--divider-color);
            margin-bottom: 8px;
        }
        .tabs button {
            font: inherit;
            font-size: 0.9rem;
            min-height: 40px;
            padding: 4px 16px;
            border: none;
            border-bottom: 2px solid transparent;
            background: none;
            color: var(--secondary-text-color);
            cursor: pointer;
        }
        .tabs button[aria-selected="true"] {
            border-bottom-color: var(--primary-color);
            color: var(--primary-text-color);
            font-weight: 600;
        }
        .tabs button:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: -2px;
        }
        .header-title {
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .header-title ha-icon, .header-title ha-state-icon {
            flex: none;
        }
        .settings-button {
            margin-inline-end: auto;
        }
    `;

    private readonly _history = new DialogHistoryController(this, "__helmanNodeDetailDialogId", {
        onBack: () => {
            if (!this._settingsOpen) return false;
            this.shadowRoot?.querySelector<HelmanDeviceEditDialog>("helman-device-edit-dialog")?.requestClose();
            return true;
        },
        close: () => this._closeDialogElement(),
    });

    // Public properties
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: NodeDetailParams;
    @property({ type: Boolean }) public open = false;

    @state() private _tab: NodeDetailTab = "overview";
    @state() private _settingsOpen = false;
    @state() private _stateIconReady = !!customElements.get("ha-state-icon");
    /** The node the tab was chosen for; an opening or another node starts on the tab requested. */
    private _tabTarget: string | null = null;
    /** The request the tab was chosen for; a new one selects its tab, even on the same node. */
    private _tabRequest: NodeDetailTabRequest | null = null;

    connectedCallback(): void {
        super.connectedCallback();
        loadHaEntityToggle()
            .then(() => { this._stateIconReady = true; })
            .catch((error) => console.error("node-detail-dialog: failed to load HA's state icon", error));
    }

    // Lifecycle methods
    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        if (!changedProperties.has("open") && !changedProperties.has("params")) return;
        const target = this.open && this.params ? this._targetKey() : null;
        const request = target !== null ? this.params.tabRequest ?? null : null;
        if (target !== this._tabTarget || request !== this._tabRequest) {
            if (target !== this._tabTarget) this._settingsOpen = false;
            this._tabTarget = target;
            this._tabRequest = request;
            this._tab = request?.tab ?? "overview";
            // A Schedule request swaps the content the press came from: focus lands on the tab, not the dialog.
            if (request?.tab === "schedule") {
                void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLElement>('[data-tab="schedule"]')?.focus());
            }
        }
    }

    updated(changedProperties: Map<string, unknown>): void {
        super.updated(changedProperties);
        if (changedProperties.has("params") || changedProperties.has("open")) {
            const switchId = this.open && this.params?.nodeType === "device"
                ? deviceDirectControls(this.params.item)?.switchEntityId : null;
            dispatchWatchedEntities(this, "node-detail:header-icon", [switchId]);
        }
        if (!this.open || !this.params || this._history.active) {
            return;
        }

        if (changedProperties.has("open") || changedProperties.has("params")) {
            this._history.push();
        }
    }

    // Render method
    render() {
        if (!this.open || !this.params) return nothing;

        const title = this._title();
        return html`
            <ha-dialog
                .open=${this.open}
                @closed=${this._onClosed}
                .heading=${title}
                .ariaLabelledBy=${"node-detail-dialog-title"}
            >
                <span id="node-detail-dialog-title" slot="headerTitle" class="header-title">
                    ${this.params.nodeType === "device" ? this._renderDeviceIcon(this.params.item) : nothing}
                    ${title}
                </span>
                ${this._renderBody()}
                <ha-dialog-footer slot="footer">
                    ${this.params.nodeType === "device" && this.params.item.deviceKey && this.hass.user?.is_admin === true ? html`
                        <ha-button class="settings-button" slot="secondaryAction" appearance="plain" variant="neutral" data-settings @click=${() => { this._settingsOpen = true; }}>
                            <ha-icon slot="start" icon="mdi:cog"></ha-icon>
                            ${this.localize("node_detail.device.edit.button")}
                        </ha-button>
                    ` : nothing}
                    <ha-button slot="primaryAction" appearance="filled" variant="neutral" data-dialog="close">
                        ${this.localize("node_detail.close")}
                    </ha-button>
                </ha-dialog-footer>
            </ha-dialog>
            ${this._renderSettings()}
        `;
    }

    // Private helper methods
    private _title(): string {
        if (this.params.nodeType === "device") {
            return this.params.item.displayName || this.params.item.name;
        }
        return this.localize(`node_detail.title.${this.params.nodeType}`);
    }

    private _deviceIcon(item: TreeItem): string {
        return item.icon || (item.applianceKind === "ev_charger" ? "mdi:car-electric"
            : item.climateEntityId ? "mdi:air-conditioner" : "mdi:power-plug");
    }

    private _renderDeviceIcon(item: TreeItem): TemplateResult {
        const switchId = deviceDirectControls(item)?.switchEntityId;
        const stateObj = switchId ? this.hass.states[switchId] : undefined;
        return this._stateIconReady && stateObj
            ? html`<ha-state-icon .hass=${this.hass} .stateObj=${stateObj}></ha-state-icon>`
            : html`<ha-icon .icon=${this._deviceIcon(item)}></ha-icon>`;
    }

    /** The params are rebuilt on every card render: the node is its type, and a device its item. */
    private _targetKey(): string {
        return this.params.nodeType === "device" ? `device:${this.params.item.id}` : this.params.nodeType;
    }

    /**
     * The lanes a node's Schedule tab drives, once each in tree order: the
     * battery is driven through the inverter's, a device through its own and
     * those its meter stands for, as a meter shared by several controllables.
     */
    private _controllableIds(): readonly string[] {
        if (this.params.nodeType === "inverter" || this.params.nodeType === "battery") return [INVERTER_CONTROLLABLE_ID];
        return this.params.nodeType === "device" ? deviceControllableIds(this.params.item) : [];
    }

    private _renderBody(): TemplateResult {
        const schedule = this._renderSchedule();
        if (schedule === null) return this._renderContent();
        return html`
            <div class="tabs" role="tablist" aria-label=${this.localize("node_detail.control.tabs")} @keydown=${this._onTabKeydown}>
                ${TABS.map((tab) => html`
                    <button
                        type="button"
                        role="tab"
                        id=${`node-detail-tab-${tab}`}
                        data-tab=${tab}
                        aria-selected=${this._tab === tab ? "true" : "false"}
                        aria-controls="node-detail-tabpanel"
                        tabindex=${this._tab === tab ? "0" : "-1"}
                        @click=${() => { this._tab = tab; }}
                    >${this.localize(`node_detail.control.tab.${tab}`)}</button>
                `)}
            </div>
            <div role="tabpanel" id="node-detail-tabpanel" aria-labelledby=${`node-detail-tab-${this._tab}`}>
                ${this._tab === "overview" ? this._renderContent() : schedule}
            </div>
        `;
    }

    /**
     * The Schedule tab's content; `null` for a node without one. The house
     * rolls up its lanes, and other schedulable nodes drive their own lanes.
     */
    private _renderSchedule(): TemplateResult | null {
        switch (this.params.nodeType) {
            case "house":
                return html`
                    <helman-house-control
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .houseNode=${this.params.houseNode}
                    ></helman-house-control>
                `;
            case "grid":
            case "solar":
                return null;
        }
        const controllableIds = this._controllableIds();
        if (controllableIds.length === 0) return null;
        return html`
            ${repeat(controllableIds, (controllableId) => controllableId, (controllableId) => html`
                <helman-node-control
                    .hass=${this.hass}
                    .localize=${this.localize}
                    .controllableId=${controllableId}
                    .titled=${controllableIds.length > 1}
                    .note=${this.params.nodeType === "battery" ? this.localize("node_detail.control.battery_lane") : null}
                ></helman-node-control>
            `)}
        `;
    }

    private _renderSettings() {
        if (!this._settingsOpen || this.params.nodeType !== "device" || !this.params.item.deviceKey) return nothing;
        return html`
            <helman-device-edit-dialog
                .hass=${this.hass}
                .localize=${this.localize}
                .open=${true}
                .deviceKey=${this.params.item.deviceKey}
                .keyIsMeter=${this.params.item.deviceKeyIsMeter === true}
                @closed=${() => { this._settingsOpen = false; }}
            ></helman-device-edit-dialog>
        `;
    }

    /** The tab list's arrow keys, Home and End move the selection and its focus. */
    private _onTabKeydown(event: KeyboardEvent): void {
        const index = TABS.indexOf(this._tab);
        const next = event.key === "ArrowRight" ? TABS[(index + 1) % TABS.length]
            : event.key === "ArrowLeft" ? TABS[(index + TABS.length - 1) % TABS.length]
            : event.key === "Home" ? TABS[0]
            : event.key === "End" ? TABS[TABS.length - 1]
            : null;
        if (next === null) return;
        event.preventDefault();
        this._tab = next;
        void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus());
    }

    private _renderContent(): TemplateResult {
        switch (this.params.nodeType) {
            case "battery":
                return html`
                    <node-detail-battery-content
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .params=${this.params}
                    ></node-detail-battery-content>
                `;
            case "solar":
                return html`
                    <node-detail-solar-content
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .params=${this.params}
                    ></node-detail-solar-content>
                `;
            case "grid":
                return html`
                    <node-detail-grid-content
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .params=${this.params}
                    ></node-detail-grid-content>
                `;
            case "house":
                return html`
                    <node-detail-house-content
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .params=${this.params}
                    ></node-detail-house-content>
                `;
            case "inverter":
                return html`
                    <node-detail-inverter-content
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .params=${this.params}
                    ></node-detail-inverter-content>
                `;
            case "device": {
                const chargerId = this._evChargerId(this.params.item);
                if (chargerId !== null) {
                    return html`
                        <node-detail-ev-charger-content
                            .hass=${this.hass}
                            .localize=${this.localize}
                            .deviceId=${chargerId}
                            .params=${this.params}
                        ></node-detail-ev-charger-content>
                    `;
                }
                return html`
                    <node-detail-device-content
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .params=${this.params}
                    ></node-detail-device-content>
                `;
            }
        }
    }

    /**
     * The charger id when the device is one schedulable EV charger, by its
     * configured appliance kind; `null` for any other device.
     */
    private _evChargerId(item: TreeItem): string | null {
        const ids = item.controllableIds ?? [];
        if (ids.length !== 1) return null;
        return item.applianceKind === "ev_charger" ? ids[0] : null;
    }

    private _closeDialogElement(): void {
        this.shadowRoot?.querySelector<HTMLElement>("[data-dialog='close']")?.click();
    }

    private _onClosed(): void {
        this._history.closed();

        this.dispatchEvent(new CustomEvent("closed", { bubbles: true, composed: true }));
    }
}
