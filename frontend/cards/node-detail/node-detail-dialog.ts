import { DialogHistoryController } from "../shared/dialog-history-controller";
import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { nothing, TemplateResult } from "lit-html";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import type { NodeDetailParams, NodeDetailSectionRequest } from "./node-detail-types";
import type { TreeItem } from "../shared/data/tree-item";
import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import { getSharedScheduleOwner } from "../shared/schedule/schedule-owner";
import type { SchedulePayload } from "../helman-api";
import { formatScheduleTime } from "../shared/schedule/model/schedule-time";
import { laneActionLabel, laneRuns, nextLaneChange, nextLaneStart } from "./node-detail-schedule";
import { houseControlLanes } from "./node-control-rollup";
import { fillTemplate } from "../localize/localize";
import "./detail-section";
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
import { deviceControllableIds } from "./node-detail-utils";

/**
 * A node's detail in Home Assistant's dialog. A node with controls has a
 * collapsible Schedule section; requests can open that section immediately.
 * Another node swaps in place, inside the one history entry the dialog holds.
 */
@customElement("node-detail-dialog")
export class NodeDetailDialog extends LitElement {
    static styles = css`
        .header-title { display: inline-flex; align-items: center; }
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

    @state() private _settingsOpen = false;
    @state() private _scheduleExpanded = false;
    @state() private _schedule: SchedulePayload | null = null;
    private _scheduleUnsubscribe?: () => void;
    private _sectionTarget: string | null = null;
    private _sectionRequest: NodeDetailSectionRequest | null = null;

    connectedCallback(): void {
        super.connectedCallback();
        if (this.hass) this._watchSchedule();
    }

    disconnectedCallback(): void { super.disconnectedCallback(); this._scheduleUnsubscribe?.(); this._scheduleUnsubscribe = undefined; }

    private _watchSchedule(): void {
        if (this._scheduleUnsubscribe || !this.hass) return;
        this._scheduleUnsubscribe = getSharedScheduleOwner(this.hass).subscribe((snapshot) => { this._schedule = snapshot.schedule; });
    }

    // Lifecycle methods
    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        if (changedProperties.has("hass")) this._watchSchedule();
        if (!changedProperties.has("open") && !changedProperties.has("params")) return;
        const target = this.open && this.params ? this._targetKey() : null;
        const request = target !== null ? this.params.sectionRequest ?? null : null;
        if (target !== this._sectionTarget || request !== this._sectionRequest) {
            if (target !== this._sectionTarget) this._settingsOpen = false;
            this._sectionTarget = target;
            this._sectionRequest = request;
            this._scheduleExpanded = request?.section === "schedule";
            void this.updateComplete.then(() => {
                const section = this.shadowRoot?.querySelector<HTMLElement>("helman-detail-section[data-schedule]");
                if (section && request?.section === "schedule") { section.scrollIntoView({ block: "nearest" }); section.shadowRoot?.querySelector<HTMLElement>("button")?.focus(); }
            });
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
                .ariaLabelledBy=${"node-detail-dialog-title"}
            >
                <span id="node-detail-dialog-title" slot="headerTitle" class="header-title">
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

    /** The params are rebuilt on every card render: the node is its type, and a device its item. */
    private _targetKey(): string {
        return this.params.nodeType === "device" ? `device:${this.params.item.id}` : this.params.nodeType;
    }

    /**
     * The lanes a node's Schedule section drives, once each in tree order: the
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
            ${this._renderContent()}
            <helman-detail-section data-schedule icon="mdi:calendar" .title=${this.localize("node_detail.control.tab.schedule")}
                .expanded=${this._scheduleExpanded} @expanded-changed=${(event: CustomEvent<boolean>) => { this._scheduleExpanded = event.detail; }}>
                <span slot="summary"><strong>${this._scheduleSummary()}</strong></span>
                ${schedule}
            </helman-detail-section>
        `;
    }

    private _scheduleSummary(): string {
        const schedule = this._schedule;
        if (!schedule) return this.localize("node_detail.shared.schedule.none");
        const now = Date.now();
        const zone = this.hass.config.time_zone;
        const locale = this.hass.locale?.language ?? this.hass.language ?? "en";
        if (this.params.nodeType === "house") {
            const lanes = houseControlLanes(this.params.houseNode, true).filter((lane) => lane.controllableId !== INVERTER_CONTROLLABLE_ID);
            const changes = lanes.map((lane) => ({ lane, run: nextLaneStart(laneRuns(schedule, lane.controllableId, now), now, zone) }))
                .filter((entry) => entry.run !== null)
                .sort((a, b) => a.run!.startMs - b.run!.startMs);
            const first = changes[0];
            return first?.run ? fillTemplate(this.localize("node_detail.shared.schedule.house_next"), {
                device: typeof first.lane.target === "string" ? first.lane.target : first.lane.target.displayName || first.lane.target.name,
                time: formatScheduleTime(first.run.startMs, locale, zone),
            }) : this.localize("node_detail.shared.schedule.none");
        }
        const changes = this._controllableIds().map((id) => nextLaneChange(laneRuns(schedule, id, now), now, zone))
            .filter((run) => run !== null).sort((a, b) => a!.startMs - b!.startMs);
        const first = changes[0];
        return first ? fillTemplate(this.localize("node_detail.shared.schedule.next"), {
            action: laneActionLabel(first.action, this.localize), time: formatScheduleTime(first.startMs, locale, zone),
        }) : this.localize("node_detail.shared.schedule.none");
    }

    /**
     * The Schedule section's content; `null` for a node without one. The house
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
