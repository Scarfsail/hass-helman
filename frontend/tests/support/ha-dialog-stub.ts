/**
 * A stand-in for Home Assistant's `ha-dialog` inside the Playwright harness.
 *
 * `ha-dialog`, `ha-dialog-footer`, `ha-button` and `ha-icon` come from the HA
 * frontend, not from this bundle, so in the harness they are *undefined*
 * elements. An undefined element still renders its children, which means a spec
 * that asserts dialog **contents** passes even when the dialog would never
 * present in the real app — exactly the failure mode a test is supposed to
 * catch.
 *
 * This stub closes the most load-bearing half of that gap: it reveals its
 * children only while `open` is set, so a spec that forgets to open the dialog
 * now finds nothing rather than finding everything. It does **not** emulate
 * `<dialog>`/top-layer semantics, so it still cannot prove that a dialog opened
 * from inside another dialog presents (#17) — only real HA can.
 */
export const HA_DIALOG_STUB = `
class HelmanTestHaDialog extends HTMLElement {
    static get observedAttributes() { return ["open"]; }
    constructor() {
        super();
        this._open = false;
    }
    connectedCallback() { this._sync(); }
    attributeChangedCallback() { this._open = this.hasAttribute("open"); this._sync(); }
    get open() { return this._open; }
    set open(value) { this._open = !!value; this._sync(); }
    _sync() {
        this.style.display = this._open ? "block" : "none";
    }
}
if (!customElements.get("ha-dialog")) {
    customElements.define("ha-dialog", HelmanTestHaDialog);
}
`;
