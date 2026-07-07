import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import { getScheduleApplianceActionPresentation } from "../model/schedule-appliance-action-presentation";
import type { ScheduleApplianceMetadata } from "../model/schedule-appliance-metadata";
import type { ScheduleApplianceProjectionBadge } from "../model/schedule-appliance-projection";
import { getScheduleApplianceProjectionBadgeLabel } from "../model/schedule-appliance-projection-presentation";
import type { ScheduleActionAuthorshipSummary, ScheduleApplianceAction } from "../schedule-types";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

type SchedulingApplianceChipMetadata = Pick<ScheduleApplianceMetadata, "id" | "name" | "kind" | "icon">;

@customElement("scheduling-appliance-chip")
export class SchedulingApplianceChip extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            :host {
                display: inline-flex;
                min-width: 0;
                max-width: 100%;
            }

            .chip {
                box-sizing: border-box;
                width: 100%;
                min-width: 0;
                max-width: 100%;
                overflow: hidden;
                justify-content: flex-start;
            }

            .chip.compact {
                min-height: 20px;
                padding: 2px 6px;
                font-size: 0.75rem;
                line-height: 1.1;
                gap: 4px;
            }

            .chip.compact.has-badge {
                padding-top: 4px;
                padding-right: 9px;
            }

            .chip-icon {
                flex-shrink: 0;
                color: var(--schedule-action-tone-icon, currentColor);
                --mdc-icon-size: 0.85rem;
            }

            .chip-icon-stack {
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                inline-size: 1rem;
                block-size: 1rem;
                flex-shrink: 0;
            }

            .chip-icon-badge {
                position: absolute;
                inset-block-start: -0.12rem;
                inset-inline-end: -0.18rem;
                z-index: 1;
                min-width: 0.78rem;
                padding: 0 0.16rem;
                border-radius: 999px;
                background: rgba(0, 0, 0, 0.65);
                box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
                color: white;
                font-size: 0.52rem;
                font-weight: 700;
                line-height: 1.25;
                text-align: center;
                white-space: nowrap;
                pointer-events: none;
            }

            .chip-label {
                flex: 1 1 auto;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
        `,
    ];

    @property({ attribute: false }) public appliance?: SchedulingApplianceChipMetadata;
    @property({ attribute: false }) public action: ScheduleApplianceAction | null = null;
    @property({ attribute: false }) public projectionBadge: ScheduleApplianceProjectionBadge | null = null;
    @property({ attribute: false }) public localize?: LocalizeFunction;
    @property({ type: String }) public size: "compact" | "regular" = "regular";
    @property({ type: Boolean }) public iconOnly = false;
    @property({ type: Boolean }) public summary = false;
    @property({ attribute: false }) public authorship: ScheduleActionAuthorshipSummary | null = null;
    @property({ type: String }) public titleText = "";

    render() {
        if (this.summary) {
            const projectionBadge = this._resolveProjectionBadge();
            const summaryLabel = this.localize ? this.localize("scheduling.dialog.appliances") : "";
            const classes = [
                "chip",
                "action",
                "action-tone-charge",
                ...this._buildAuthorshipClasses(),
                this.size === "compact" ? "compact" : "",
                projectionBadge === null ? "" : "has-badge",
            ].filter((className) => className.length > 0).join(" ");
            return html`
                <span class=${classes} title=${this._buildChipTitle(projectionBadge)}>
                    <span class="chip-icon-stack">
                        <ha-icon class="chip-icon" .icon=${"mdi:power-plug-outline"} aria-hidden="true"></ha-icon>
                        ${projectionBadge === null ? nothing : html`
                            <span
                                class="chip-icon-badge"
                                aria-hidden="true"
                            >
                                ${projectionBadge.text}
                            </span>
                        `}
                    </span>
                    ${this.iconOnly ? nothing : html`
                        <span class="chip-label">${summaryLabel}</span>
                    `}
                </span>
            `;
        }

        if (!this.appliance || this.action === undefined || !this.localize) {
            return nothing;
        }

        const presentation = this._resolvePresentation();
        const projectionBadge = this._resolveProjectionBadge();
        const classes = [
            "chip",
            "action",
            presentation.toneClass,
            ...this._buildAuthorshipClasses(),
            this.size === "compact" ? "compact" : "",
            projectionBadge === null ? "" : "has-badge",
        ].filter((className) => className.length > 0).join(" ");
        return html`
            <span class=${classes} title=${this._buildChipTitle(projectionBadge)}>
                <span class="chip-icon-stack">
                    <ha-icon class="chip-icon" .icon=${presentation.icon} aria-hidden="true"></ha-icon>
                    ${projectionBadge === null ? nothing : html`
                        <span
                            class="chip-icon-badge"
                            aria-hidden="true"
                        >
                            ${projectionBadge.text}
                        </span>
                    `}
                </span>
                ${this.iconOnly ? nothing : html`
                    <span class="chip-label">${this.appliance.name} · ${presentation.label}</span>
                `}
            </span>
        `;
    }

    private _resolvePresentation() {
        return getScheduleApplianceActionPresentation({
            appliance: this.appliance!,
            action: this.action!,
            localize: this.localize!,
        });
    }

    private _resolveProjectionBadge(): ScheduleApplianceProjectionBadge | null {
        if (this.projectionBadge === null) {
            return null;
        }

        if (this.projectionBadge.kind === "vehicle_soc") {
            if (
                typeof this.projectionBadge.expectedVehicleSocPct !== "number"
                || !Number.isFinite(this.projectionBadge.expectedVehicleSocPct)
            ) {
                return null;
            }

            const expectedVehicleSocPct = Math.max(0, Math.min(100, Math.round(this.projectionBadge.expectedVehicleSocPct)));
            return {
                kind: "vehicle_soc",
                text: String(expectedVehicleSocPct),
                expectedVehicleSocPct,
            };
        }

        if (typeof this.projectionBadge.energyKwh !== "number" || !Number.isFinite(this.projectionBadge.energyKwh)) {
            return null;
        }

        return {
            kind: "energy",
            text: this.projectionBadge.text,
            energyKwh: this.projectionBadge.energyKwh,
            applianceKind: this.projectionBadge.applianceKind,
            mode: this.projectionBadge.mode,
            projectionMethod: this.projectionBadge.projectionMethod,
        };
    }

    private _buildProjectionBadgeTitle(projectionBadge: ScheduleApplianceProjectionBadge): string {
        return this.localize
            ? getScheduleApplianceProjectionBadgeLabel(projectionBadge, this.localize)
            : "";
    }

    private _buildChipTitle(projectionBadge: ScheduleApplianceProjectionBadge | null): string {
        return [
            this.titleText,
            projectionBadge === null ? "" : this._buildProjectionBadgeTitle(projectionBadge),
        ].filter((part) => part.length > 0).join(" · ");
    }

    private _buildAuthorshipClasses(): string[] {
        if (this.authorship === null || this.authorship.state === "none") {
            return [];
        }

        return ["authorship-decorated", `authorship-${this.authorship.state}`];
    }
}
