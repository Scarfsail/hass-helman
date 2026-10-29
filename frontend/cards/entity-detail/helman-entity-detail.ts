import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../types/ha";
import { EnergyCardHost } from "../shared/energy-card-host";
import { getSharedHelmanStore } from "../shared/data/store";
import { hydrateDeviceTree } from "../shared/data/tree-item-hydrator";
import { HistoryEngine } from "../shared/data/history-engine";
import { deviceEntityIds, findDeviceForEntity } from "../shared/data/device-entities";
import "../node-detail/node-detail-dialog";
import "../shared/schedule/dialogs/scheduling-day-editor-host";

/**
 * The public way for another dashboard card to open a Helman device's detail
 * by entity id. Rendered into the consumer's tree, it opens the detail of the
 * device `entityId` belongs to; when the detail closes it fires a non-bubbling
 * `closed` and the consumer removes it. An entity that no longer maps to a
 * device, or a failed load, gets HA's more-info instead, then `closed`.
 */
@customElement("helman-entity-detail")
export class HelmanEntityDetail extends LitElement {
    // 1. Static lookup
    /** Every entity id that opens a device detail; a one-shot read of the current config. */
    public static async entityIds(hass: HomeAssistant): Promise<ReadonlySet<string>> {
        const payload = await getSharedHelmanStore(hass).getDeviceTree();
        const tree = hydrateDeviceTree(payload, (key) => key);
        return new Set(HistoryEngine.walkTree(tree).flatMap(deviceEntityIds));
    }

    // 3. Public & private properties & Host controller
    @property({ attribute: false }) public entityId?: string;

    private readonly _host = new EnergyCardHost(this, {
        whichNodesToWalk: (tree) => tree,
    });
    /** The entity whose detail was opened, so a closed detail does not reopen. */
    private _openedFor?: string;
    /** Whether the detail this element opened is still up, so a refresh that drops it still fires `closed`. */
    private _detailOpen = false;
    /** The device tree the last update saw: only a refresh assigns a new one. */
    private _seenTree?: readonly unknown[];

    // 7. HA-specific setters
    public set hass(hass: HomeAssistant) {
        this._host.setHass(hass);
    }

    // 9. Lifecycle methods
    willUpdate(changedProperties: Map<string, any>): void {
        super.willUpdate(changedProperties);
        // A refresh that drops the open device closes the detail. The detail
        // briefly has no request while it hops to a schedule lane's device too,
        // but that keeps the tree, so it is not a close.
        const treeChanged = this._host.deviceTree !== this._seenTree;
        this._seenTree = this._host.deviceTree;
        if (this._detailOpen && !this._host.dialogRequest && treeChanged) {
            this._detailOpen = false;
            this.dispatchEvent(new CustomEvent("closed"));
        }
        const settled = this._host.loaded || this._host.loadFailed;
        if (!settled || !this.entityId || this.entityId === this._openedFor) return;
        this._openedFor = this.entityId;
        const item = findDeviceForEntity(this._host.deviceTree, this.entityId);
        if (item) {
            this._host.openNode(item);
            this._detailOpen = true;
            return;
        }
        this.dispatchEvent(new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId: this.entityId },
        }));
        this.dispatchEvent(new CustomEvent("closed"));
    }

    // 10. Render method
    render() {
        const hass = this._host.hass;
        if (!hass) return nothing;
        const dialogParams = this._host.dialogParams;
        return html`
            <scheduling-day-editor-host
                .hass=${hass}
                .timeZone=${hass.config?.time_zone || "UTC"}
            ></scheduling-day-editor-host>
            ${dialogParams ? html`
                <node-detail-dialog
                    .hass=${hass}
                    .localize=${this._host.localize!}
                    .open=${true}
                    .params=${dialogParams}
                    @closed=${this._onClosed}
                ></node-detail-dialog>
            ` : nothing}
        `;
    }

    /** The detail's own `closed` bubbles and is composed; the consumer hears only this one. */
    private _onClosed = (event: Event): void => {
        event.stopPropagation();
        this._detailOpen = false;
        this._host.closeDialog();
        this.dispatchEvent(new CustomEvent("closed"));
    };
}
