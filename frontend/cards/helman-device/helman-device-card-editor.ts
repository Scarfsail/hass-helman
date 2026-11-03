import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant, LovelaceCardEditor } from "../../types/ha";
import { fireEvent } from "../shared/fire-event";
import { getSharedHelmanStore } from "../shared/data/store";
import { hydrateDeviceTree } from "../shared/data/tree-item-hydrator";
import { HistoryEngine } from "../shared/data/history-engine";
import type { TreeItem } from "../shared/data/tree-item";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { resolveEnergyNodes, type EnergyNodes } from "../node-detail/node-detail-readings";
import { ENERGY_NODE_TYPES, availableFields, resolveTarget, type DeviceCardTarget, type FieldId } from "./device-card-fields";
import type { HelmanDeviceCardConfig } from "./HelmanDeviceCardConfig";

/** The form's data: the config with its target as one `node:` or `device:` value. */
interface EditorData {
    target?: string;
    name?: string;
    fields?: FieldId[];
    hide_when_idle?: FieldId[];
}

/** The device card's visual editor: one target, its fields in order, which of them hide while idle, and a name. */
@customElement("helman-device-card-editor")
export class HelmanDeviceCardEditor extends LitElement implements LovelaceCardEditor {
    // A new hass is not a change signal: only the first one renders.
    private _hass?: HomeAssistant;
    @state() private _config?: HelmanDeviceCardConfig;
    @state() private _tree?: { items: TreeItem[]; nodes: EnergyNodes };
    @state() private _loadFailed = false;
    private _localize?: LocalizeFunction;
    /** The tree is read once per editor: a failed read is not retried on every hass push. */
    private _loadRequested = false;
    // The form's inputs, derived in willUpdate.
    private _schema: readonly object[] = [];
    private _data: EditorData = {};

    public set hass(hass: HomeAssistant) {
        const first = !this._hass;
        this._hass = hass;
        if (!this._localize) this._localize = getLocalizeFunction(hass);
        if (!this._loadRequested) void this._loadTree(hass);
        if (first) this.requestUpdate();
    }

    public setConfig(config: HelmanDeviceCardConfig): void {
        this._config = config;
    }

    private async _loadTree(hass: HomeAssistant): Promise<void> {
        this._loadRequested = true;
        try {
            const items = hydrateDeviceTree(await getSharedHelmanStore(hass).getDeviceTree(), this._localize!);
            this._tree = { items, nodes: resolveEnergyNodes(items) };
        } catch (error) {
            console.error("helman-device-card-editor: failed to load the device tree", error);
            this._loadFailed = true;
        }
    }

    private _target(config: HelmanDeviceCardConfig): DeviceCardTarget | null {
        return this._tree ? resolveTarget(config, this._tree.items, this._tree.nodes) : null;
    }

    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        if (!changedProperties.has("_config") && !changedProperties.has("_tree")) return;
        const config = this._config;
        const tree = this._tree;
        const localize = this._localize;
        if (!config || !tree || !localize) return;
        const options = (fields: readonly FieldId[]) => fields.map((field) => ({ value: field, label: localize(`device_card.fields.${field}`) }));
        const targets = [
            ...ENERGY_NODE_TYPES.filter((node) => resolveTarget({ node }, tree.items, tree.nodes))
                .map((node) => ({ value: `node:${node}`, label: localize(`node_detail.title.${node}`) })),
            ...HistoryEngine.walkTree(tree.items).filter((item) => item.deviceKey)
                .map((item) => ({ value: `device:${item.deviceKey}`, label: item.name })),
        ];
        const target = this._target(config);
        const fields = config.fields ?? [];
        this._data = {
            target: config.node ? `node:${config.node}` : config.device ? `device:${config.device}` : undefined,
            name: config.name,
            fields,
            hide_when_idle: config.hide_when_idle ?? [],
        };
        this._schema = [
            { name: "target", required: true, selector: { select: { mode: "dropdown", options: targets } } },
            { name: "name", selector: { text: {} } },
            { name: "fields", selector: { select: { multiple: true, reorder: true, options: options(target ? availableFields(target) : []) } } },
            { name: "hide_when_idle", selector: { select: { multiple: true, options: options(fields) } } },
        ];
    }

    protected render() {
        if (this._loadFailed && this._localize) {
            return html`<ha-alert alert-type="error">${this._localize("node_detail.device.edit.load_failed")}</ha-alert>`;
        }
        if (!this._hass || !this._config || !this._tree) return nothing;
        return html`
            <ha-form
                .hass=${this._hass}
                .data=${this._data}
                .schema=${this._schema}
                .computeLabel=${this._computeLabel}
                .computeHelper=${this._computeHelper}
                @value-changed=${this._valueChanged}
            ></ha-form>
        `;
    }

    private _computeLabel = (schema: { name: string }): string =>
        this._localize?.(`device_card_editor.fields.${schema.name}`) ?? schema.name;

    private _computeHelper = (schema: { name: string }): string =>
        this._localize?.has?.(`device_card_editor.helpers.${schema.name}`) ? this._localize(`device_card_editor.helpers.${schema.name}`) : "";

    /**
     * Writes the target as `device:` or `node:`, and drops the fields a target
     * that resolves does not offer; keys the editor does not own are kept.
     */
    private _valueChanged(event: CustomEvent<{ value: EditorData }>): void {
        const { target: value, name, fields, hide_when_idle: hidden } = event.detail.value;
        const [kind, key] = value ? [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)] : [];
        const config: HelmanDeviceCardConfig = { ...this._config! };
        delete config.node;
        delete config.device;
        delete config.name;
        delete config.hide_when_idle;
        if (kind === "node") config.node = key as HelmanDeviceCardConfig["node"];
        if (kind === "device") config.device = key;
        if (name) config.name = name;
        const target = this._target(config);
        config.fields = target ? (fields ?? []).filter((field) => availableFields(target).includes(field)) : fields ?? [];
        const kept = (hidden ?? []).filter((field) => config.fields!.includes(field));
        if (kept.length) config.hide_when_idle = kept;
        fireEvent(this, "config-changed", { config });
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-device-card-editor": HelmanDeviceCardEditor;
    }
}
