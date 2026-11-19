/**
 * A stand-in for Home Assistant's `ha-select` inside the Playwright harness.
 *
 * HA defines `ha-select` at startup, so a card can use it as is; the harness
 * has no HA, so the tag would be an empty undefined element. The stub keeps
 * the real element's contract: `options` as `{ value, label }`, `value`,
 * `label` and `disabled` properties; the field shows the label of the option
 * whose value is `value`, or `value` itself when no option has it; a pick
 * fires `selected` with `{ value }` only when it differs, and never changes
 * `value` itself. Like the real one, a disabled select renders no items.
 *
 * The field is `[data-value]`, the name `[data-label]`, each item a
 * `button[data-item]` a spec clicks to pick.
 */
export const HA_SELECT_STUB = `
class HelmanTestHaSelect extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this._props = { options: [], value: undefined, label: "", disabled: false };
    }
    connectedCallback() { this._render(); }
    _render() {
        const { options, value, label, disabled } = this._props;
        const picked = options.find((option) => String(option.value) === String(value));
        const root = this.shadowRoot;
        root.innerHTML = "";
        const name = document.createElement("span");
        name.dataset.label = "";
        name.textContent = label;
        const field = document.createElement("span");
        field.dataset.value = "";
        field.textContent = picked ? picked.label : value ?? "";
        root.append(name, field);
        if (disabled) return;
        for (const option of options) {
            const item = document.createElement("button");
            item.dataset.item = option.value;
            item.textContent = option.label;
            item.addEventListener("click", () => {
                if (option.value !== this._props.value) this.dispatchEvent(new CustomEvent("selected", { detail: { value: option.value } }));
            });
            root.append(item);
        }
    }
}
for (const key of ["options", "value", "label", "disabled"]) {
    Object.defineProperty(HelmanTestHaSelect.prototype, key, {
        get() { return this._props[key]; },
        set(next) { this._props[key] = next; this._render(); },
    });
}
if (!customElements.get("ha-select")) {
    customElements.define("ha-select", HelmanTestHaSelect);
}
`;
