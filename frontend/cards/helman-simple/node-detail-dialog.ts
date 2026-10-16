import { DialogHistoryController } from "../shared/dialog-history-controller";
import { LitElement, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing, TemplateResult } from "lit-html";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import type { NodeDetailParams } from "./node-detail/node-detail-types";
import type { TreeItem } from "../helman/tree-item";
import { getSharedHelmanStore } from "../helman/store";
import "./node-detail/node-detail-battery-content";
import "./node-detail/node-detail-solar-content";
import "./node-detail/node-detail-grid-content";
import "./node-detail/node-detail-house-content";
import "./node-detail/node-detail-inverter-content";
import "./node-detail/node-detail-ev-charger-content";
import type { NodeDetailDeviceContent } from "./node-detail/node-detail-device-content";
import "./node-detail/node-detail-device-content";

@customElement("node-detail-dialog")
export class NodeDetailDialog extends LitElement {
    private readonly _history = new DialogHistoryController(this, "__helmanNodeDetailDialogId", {
        onBack: () => this.shadowRoot?.querySelector<NodeDetailDeviceContent>("node-detail-device-content")?.handleBack() ?? false,
        close: () => this._closeDialogElement(),
    });

    // Public properties
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: NodeDetailParams;
    @property({ type: Boolean }) public open = false;

    /**
     * Each schedulable appliance's kind by id, read once per opening: a device
     * that is an EV charger opens the charger's own detail. `null` until read.
     */
    @state() private _applianceKinds: Map<string, string> | null = null;
    /** Bumped on each opening, so a roster read for an earlier one is dropped. */
    private _opening = 0;
    private _applianceKindsRequested = false;

    // Lifecycle methods
    willUpdate(changedProperties: Map<string, unknown>): void {
        // A config change between openings can change what a device is.
        if (changedProperties.has("open") && this.open) {
            this._opening += 1;
            this._applianceKinds = null;
            this._applianceKindsRequested = false;
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
                ${this._renderContent()}
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
                // Not yet known: nothing rather than the generic detail flashing first.
                if (chargerId === undefined) return html``;
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
     * configured appliance kind; `null` for any other device, `undefined`
     * while the appliance roster is read. A roster that cannot be read leaves
     * the generic detail, which needs none of it.
     */
    private _evChargerId(item: TreeItem): string | null | undefined {
        const ids = item.controllableIds ?? [];
        if (ids.length !== 1) return null;
        if (this._applianceKinds === null) {
            this._loadApplianceKinds();
            return undefined;
        }
        return this._applianceKinds.get(ids[0]) === "ev_charger" ? ids[0] : null;
    }

    private _loadApplianceKinds(): void {
        if (this._applianceKindsRequested) return;
        this._applianceKindsRequested = true;
        const opening = this._opening;
        getSharedHelmanStore(this.hass).getAppliances()
            .then((payload) => new Map((payload?.appliances ?? []).map((appliance) => [appliance.id, appliance.kind])))
            .catch((error) => {
                console.error("node-detail-dialog: failed to read the appliance roster", error);
                return new Map<string, string>();
            })
            .then((kinds) => {
                if (opening === this._opening) this._applianceKinds = kinds;
            });
    }

    private _closeDialogElement(): void {
        this.shadowRoot?.querySelector<HTMLElement>("[data-dialog='close']")?.click();
    }

    private _onClosed(): void {
        this._history.closed();

        this.dispatchEvent(new CustomEvent("closed", { bubbles: true, composed: true }));
    }
}
