import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { DeviceNode } from "./DeviceNode";
import { nothing, TemplateResult } from "lit-html";
import { BatteryDeviceConfig, GridDeviceConfig, HouseDeviceConfig, SolarDeviceConfig } from "./DeviceConfig";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { sharedStyles } from "./shared-styles";
import { convertToKWh, getDisplayEnergyUnit } from "./energy-unit-converter";
import "../schedule-badge";

/** Helman's own bias-corrected "still to come today" sensor. Not configurable:
 *  it is the integration's own output, published under a fixed entity id. */
const SOLAR_REMAINING_TODAY_ENERGY_ENTITY_ID = "sensor.helman_energy_production_today_remaining";

@customElement("power-device-info")
export class PowerDeviceInfo extends LitElement {
    @property({ attribute: false }) device!: DeviceNode;
    @property({ attribute: false }) public hass!: HomeAssistant;

    static get styles() {
        return [sharedStyles, css`
            .container {
                display: flex;
                flex-direction: row;
                gap: 5px;
                justify-content: space-evenly;
                height: 16px;
                margin-left:5px;
                margin-right:5px;
            }
            .info {
                display: flex;
                flex-direction: row;
                align-items: center;
                flex-basis: 100%;
                justify-content: space-evenly;   
                font-size: 0.7em;
                color: var(--secondary-text-color);
                white-space: nowrap;
            }

            .custom-labels {
                font-style: italic;
                opacity: 0.8;
                justify-content: left;
            }

            /* Pinned right whatever else the row holds — the labels keep the
               left, and a box with nothing but a badge still puts it there. */
            helman-schedule-badge {
                margin-left: auto;
            }


        `];
    }
    private _showMoreInfo(entityId: string) {
        const event = new CustomEvent("show-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
        });
        this.dispatchEvent(event);
    }
    render() {
        if (!this.device) {
            return nothing;
        }

        const hasAdditionalInfo = this.device.show_additional_info;
        const customLabels = this.device.customLabelTexts ?? [];
        const hasCustomLabels = customLabels.length > 0;
        // What the box says about the schedule. Decided here — beside
        // power-device's tint, off the same `deferrable` flag — which is what
        // makes the power card and the solar inspector mark a load identically.
        // Gating on the flag rather than on the id alone matters: the forecast
        // breakdown names the controllable behind every scheduled appliance,
        // including one that opted out of being shiftable, and that one belongs
        // in the base-load group unbadged, exactly as it is on the power card.
        //
        // A group is not a controllable, so it stands for its shiftable
        // descendants and folds their states into one tint — the inspector's
        // "Deferrable consumption" row, not the house total and not every label
        // category that happens to contain a dishwasher.
        const deferrable = this.device.deferrable === true;
        const controllableId = deferrable ? this.device.controllableId ?? null : null;
        const controllableIds = deferrable && controllableId === null
            ? _collectControllableIds(this.device)
            : [];
        const hasBadge = controllableId !== null || controllableIds.length > 0;

        if (!hasAdditionalInfo && !hasCustomLabels && !hasBadge) {
            return nothing;
        }

        return html`
            <div class="container">
                ${hasAdditionalInfo ? html`
                    <div class="info">
                        ${this._renderDeviceInfo(this.device)}
                    </div>
                ` : nothing}
                ${hasCustomLabels ? html`
                    <div class="info custom-labels">
                        ${customLabels.join(' • ')}
                    </div>
                ` : nothing}
                ${hasBadge ? html`
                    <helman-schedule-badge
                        .hass=${this.hass}
                        .controllableId=${controllableId}
                        .controllableIds=${controllableIds}
                    ></helman-schedule-badge>
                ` : nothing}
            </div>
        `;
    }

    private _renderDeviceInfo(device: DeviceNode): TemplateResult | typeof nothing {
        const batteryConfig = device.deviceConfig as BatteryDeviceConfig;
        if (batteryConfig.entities.capacity)
            return this._renderBatteryInfo(device, batteryConfig)

        if (device.sourceType === "solar")
            return this._renderSolarInfo(device, device.deviceConfig as SolarDeviceConfig)

        const gridConfig = device.deviceConfig as GridDeviceConfig;
        if (gridConfig.entities.today_export || gridConfig.entities.today_import)
            return this._renderGridInfo(device, gridConfig)

        const houseConfig = device.deviceConfig as HouseDeviceConfig;
        if (device.id === "house" && houseConfig.entities.today_energy)
            return this._renderHouseInfo(houseConfig)

        return nothing;
    }

    private _renderGridInfo(device: DeviceNode, gridConfig: GridDeviceConfig): TemplateResult | typeof nothing {
        if (!gridConfig.entities.today_export || !gridConfig.entities.today_import) {
            return nothing;
        }
        const todayImportState = this.hass.states[gridConfig.entities.today_import];
        const todayExportState = this.hass.states[gridConfig.entities.today_export];

        if (!todayImportState || !todayExportState) {
            return nothing;
        }
        const todayImportRaw = parseFloat(todayImportState.state);
        const todayExportRaw = parseFloat(todayExportState.state);

        if (isNaN(todayImportRaw) || isNaN(todayExportRaw)) {
            return nothing;
        }

        // Convert to kWh using unit detection
        const todayImportKWh = convertToKWh(todayImportRaw, todayImportState.attributes.unit_of_measurement);
        const todayExportKWh = convertToKWh(todayExportRaw, todayExportState.attributes.unit_of_measurement);

        if (device.isSource) {
            const importDisplay = getDisplayEnergyUnit(todayImportKWh);
            return html`
                <span class="clickable" @click=${() => this._showMoreInfo(gridConfig.entities.today_import!)}>⚡ ${importDisplay.value.toFixed(1)} <span class="units">${importDisplay.unit}</span></span>
            `;
        } else {
            const exportDisplay = getDisplayEnergyUnit(todayExportKWh);
            return html`
                <span class="clickable" @click=${() => this._showMoreInfo(gridConfig.entities.today_export!)}>⚡ ${exportDisplay.value.toFixed(1)} <span class="units">${exportDisplay.unit}</span></span>
            `;
        }
    }

    private _renderSolarInfo(device: DeviceNode, solarConfig: SolarDeviceConfig): TemplateResult | typeof nothing {
        if (!solarConfig.entities.today_energy) {
            return nothing;
        }
        const todayEnergyState = this.hass.states[solarConfig.entities.today_energy];
        const forecastEnergyState = this.hass.states[SOLAR_REMAINING_TODAY_ENERGY_ENTITY_ID];

        if (!todayEnergyState || !forecastEnergyState) {
            return nothing;
        }
        const todayEnergyRaw = parseFloat(todayEnergyState.state);
        const forecastEnergyRaw = parseFloat(forecastEnergyState.state);

        if (isNaN(todayEnergyRaw) || isNaN(forecastEnergyRaw)) {
            return nothing;
        }

        // Convert to kWh using unit detection
        const todayEnergyKWh = convertToKWh(todayEnergyRaw, todayEnergyState.attributes.unit_of_measurement);
        const forecastEnergyKWh = convertToKWh(forecastEnergyRaw, forecastEnergyState.attributes.unit_of_measurement);

        // Get appropriate display units
        const todayDisplay = getDisplayEnergyUnit(todayEnergyKWh);
        const forecastDisplay = getDisplayEnergyUnit(forecastEnergyKWh);

        return html`
            <span class="clickable" @click=${() => this._showMoreInfo(solarConfig.entities.today_energy!)}>⚡${todayDisplay.value.toFixed(1)} <span class="units">${todayDisplay.unit}</span></span>
            <span class="clickable" @click=${() => this._showMoreInfo(SOLAR_REMAINING_TODAY_ENERGY_ENTITY_ID)}>✨${forecastDisplay.value.toFixed(1)} <span class="units">${forecastDisplay.unit}</span></span>
        `;
    }

    private _renderHouseInfo(houseConfig: HouseDeviceConfig): TemplateResult | typeof nothing {
        if (!houseConfig.entities.today_energy) {
            return nothing;
        }

        const todayEnergyState = this.hass.states[houseConfig.entities.today_energy];
        if (!todayEnergyState) {
            return nothing;
        }

        const todayEnergyRaw = parseFloat(todayEnergyState.state);
        if (isNaN(todayEnergyRaw)) {
            return nothing;
        }

        const todayEnergyKWh = convertToKWh(todayEnergyRaw, todayEnergyState.attributes.unit_of_measurement);
        const todayDisplay = getDisplayEnergyUnit(todayEnergyKWh);

        return html`
            <span class="clickable" @click=${() => this._showMoreInfo(houseConfig.entities.today_energy!)}>⚡ ${todayDisplay.value.toFixed(1)} <span class="units">${todayDisplay.unit}</span></span>
        `;
    }

    private _renderBatteryInfo(device: DeviceNode, cfg: BatteryDeviceConfig): TemplateResult | typeof nothing {
        const targetSocEntityId = device.isSource ? cfg.entities.min_soc : cfg.entities.max_soc;
        const targetSocState = targetSocEntityId ? this.hass?.states[targetSocEntityId] : null;
        const targetSoc = targetSocState ? parseFloat(targetSocState.state) : NaN;

        const etaEntityId = device.isSource
            ? "sensor.helman_battery_time_to_empty"
            : "sensor.helman_battery_time_to_full";
        const etaSensor = this.hass?.states[etaEntityId];
        const etaValid = etaSensor && etaSensor.state !== "unavailable" && etaSensor.state !== "unknown";
        const totalMinutes = etaValid ? parseFloat(etaSensor!.state) : NaN;
        const isActive = !isNaN(totalMinutes) && totalMinutes > 0;

        let targetTimeStr: string | null = null;
        let hours = 0;
        let mins = 0;

        if (isActive) {
            const targetTime = new Date(etaSensor!.attributes.target_time);
            if (!isNaN(targetTime.getTime())) {
                targetTimeStr = targetTime.toLocaleTimeString(this.hass.locale?.language || navigator.language, {
                    hourCycle: 'h23',
                    hour: '2-digit',
                    minute: '2-digit',
                });
                hours = Math.floor(totalMinutes / 60);
                mins = Math.round(totalMinutes % 60);
            }
        }

        if (isNaN(targetSoc) && !targetTimeStr) return nothing;

        return html`
            ${!isNaN(targetSoc) && targetSocEntityId ? html`
                <span class="clickable" @click=${() => this._showMoreInfo(targetSocEntityId)}>➜${targetSoc}%</span>
            ` : nothing}
            ${targetTimeStr ? html`
                <span class="clickable" @click=${() => this._showMoreInfo(etaEntityId)}>🕓${targetTimeStr}</span>
                <span class="clickable" @click=${() => this._showMoreInfo(etaEntityId)}>⏳${hours}:${String(mins).padStart(2, '0')}</span>
            ` : nothing}
        `;
    }



}

/** Every controllable under a group row, at whatever depth it sits. */
function _collectControllableIds(device: DeviceNode): string[] {
    const ids: string[] = [];
    for (const child of device.children ?? []) {
        if (child.controllableId) {
            ids.push(child.controllableId);
        }
        ids.push(..._collectControllableIds(child));
    }
    return ids;
}
