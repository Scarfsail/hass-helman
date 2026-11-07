import { LitElement, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant, LovelaceCardEditor, HaFormSchema } from "../../types/ha";
import { fireEvent } from "../shared/fire-event";
import type { HelmanCardConfig } from "./HelmanCardConfig";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";

const SCHEMA: readonly HaFormSchema[] = [
    {
        name: "card_size",
        selector: { number: { min: 1, mode: "box" } },
    },
    {
        name: "max_power",
        selector: { number: { min: 0, mode: "box" } },
    },
    {
        name: "collapsed_consumers_count",
        selector: { number: { min: 0, mode: "box" } },
    },
    { name: "show_empty_groups", selector: { boolean: {} } },
    { name: "show_others_group", selector: { boolean: {} } },
] as const;

/** What the card renders an unset flag as, so the form shows the same. */
const FLAG_DEFAULTS = { show_empty_groups: false, show_others_group: true };

@customElement("helman-card-editor")
export class HelmanCardEditor extends LitElement implements LovelaceCardEditor {
    @state() private _hass?: HomeAssistant;
    @state() private _config?: HelmanCardConfig;
    private _localize?: LocalizeFunction;

    public set hass(hass: HomeAssistant) {
        this._hass = hass;
        if (!this._localize) this._localize = getLocalizeFunction(hass);
    }

    public setConfig(config: HelmanCardConfig): void {
        this._config = config;
    }

    protected render() {
        if (!this._hass || !this._config) return html``;

        return html`
            <ha-form
                .hass=${this._hass}
                .data=${{ ...FLAG_DEFAULTS, ...this._config }}
                .schema=${SCHEMA}
                .computeLabel=${this._computeLabel}
                .computeHelper=${this._computeHelper}
                @value-changed=${this._valueChanged}
            ></ha-form>
        `;
    }

    private _computeLabel = (schema: HaFormSchema): string => {
        return this._localize?.(`helman_card_editor.fields.${schema.name}`) ?? schema.name;
    };

    private _computeHelper = (schema: HaFormSchema): string => {
        return this._localize?.(`helman_card_editor.helpers.${schema.name}`) ?? "";
    };

    private _valueChanged(event: CustomEvent<{ value: HelmanCardConfig }>): void {
        fireEvent(this, "config-changed", { config: event.detail.value });
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-card-editor": HelmanCardEditor;
    }
}
