/**
 * Register a custom element, unless the page already has one by that name.
 *
 * `cards/shared` is compiled into *both* bundles — `helman-card.js` and
 * `helman-config-editor.js` — and Home Assistant loads both on the same page.
 * A tag defined from shared code therefore gets defined twice, and the second
 * `customElements.define` throws a `DOMException` that aborts the rest of that
 * bundle's module evaluation. Which bundle loses is a matter of load order, so
 * the symptom is a card that silently fails to register.
 *
 * `@customElement` cannot express this, hence the manual define. First one in
 * wins: both copies are built from this source at the same version, so they are
 * the same element, which is the same assumption `config-editor/index.ts` and
 * `helman-solar-inspector.ts` already make.
 */
export function defineOnce(tagName: string, constructor: CustomElementConstructor): void {
    if (!customElements.get(tagName)) {
        customElements.define(tagName, constructor);
    }
}
