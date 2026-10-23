import { DialogHistoryController } from "../shared/dialog-history-controller";
import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing, TemplateResult } from "lit-html";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import type { NodeDetailParams } from "./node-detail-types";
import type { TreeItem } from "../shared/data/tree-item";
import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import "./node-detail-battery-content";
import "./node-detail-solar-content";
import "./node-detail-grid-content";
import "./node-detail-house-content";
import "./node-detail-inverter-content";
import "./node-detail-ev-charger-content";
import type { NodeDetailDeviceContent } from "./node-detail-device-content";
import "./node-detail-device-content";
import "./node-control";

type NodeDetailTab = "overview" | "control";
const TABS: readonly NodeDetailTab[] = ["overview", "control"];

/**
 * A node's detail in Home Assistant's dialog. A node Helman controls opens on
 * its Overview with a Control tab beside it; only the tab shown is in the
 * page, so a hidden one reads nothing.
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
    `;

    private readonly _history = new DialogHistoryController(this, "__helmanNodeDetailDialogId", {
        onBack: () => this.shadowRoot?.querySelector<NodeDetailDeviceContent>("node-detail-device-content")?.handleBack() ?? false,
        close: () => this._closeDialogElement(),
    });

    // Public properties
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: NodeDetailParams;
    @property({ type: Boolean }) public open = false;

    @state() private _tab: NodeDetailTab = "overview";
    /** The node the tab was chosen for; an opening or another node starts on Overview. */
    private _tabTarget: string | null = null;

    // Lifecycle methods
    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        if (!changedProperties.has("open") && !changedProperties.has("params")) return;
        const target = this.open && this.params ? this._targetKey() : null;
        if (target !== this._tabTarget) {
            this._tabTarget = target;
            this._tab = "overview";
        }
    }

    updated(changedProperties: Map<string, unknown>): void {
        super.updated(changedProperties);
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
                .headerTitle=${title}
            >
                ${this._renderBody()}
                <ha-dialog-footer slot="footer">
                    <mwc-button slot="primaryAction" data-dialog="close">
                        ${this.localize("node_detail.close")}
                    </mwc-button>
                </ha-dialog-footer>
            </ha-dialog>
        `;
    }

    // Private helper methods
    private _title(): string {
        if (this.params.nodeType === "device") {
            return this.params.item.displayName || this.params.item.name;
        }
        return this.localize(`node_detail.title.${this.params.nodeType}`);
    }

    /** The params are rebuilt on every card render: the node is its type, and a device its item. */
    private _targetKey(): string {
        return this.params.nodeType === "device" ? `device:${this.params.item.id}` : this.params.nodeType;
    }

    /** The lane a node's Control tab drives; `null` for a node without one. The battery is driven through the inverter's. */
    private _controllableId(): string | null {
        return this.params.nodeType === "inverter" || this.params.nodeType === "battery" ? INVERTER_CONTROLLABLE_ID : null;
    }

    private _renderBody(): TemplateResult {
        const controllableId = this._controllableId();
        if (controllableId === null) return this._renderContent();
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
                ${this._tab === "overview" ? this._renderContent() : html`
                    <helman-node-control
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .controllableId=${controllableId}
                        .note=${this.params.nodeType === "battery" ? this.localize("node_detail.control.battery_lane") : null}
                    ></helman-node-control>
                `}
            </div>
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
