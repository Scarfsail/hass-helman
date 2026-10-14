/**
 * HA's `fireEvent` (`common/dom/fire_event.ts`): an event that bubbles out of
 * the shadow root it is fired in, which is how HA's editors hear a card editor.
 */
export function fireEvent<T>(node: HTMLElement, type: string, detail: T): void {
    node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}
