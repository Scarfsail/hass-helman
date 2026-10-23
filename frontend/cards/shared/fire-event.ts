/**
 * HA's `fireEvent` (`common/dom/fire_event.ts`): an event that bubbles out of
 * the shadow root it is fired in, which is how HA's editors hear a card editor.
 */
export function fireEvent<T>(node: HTMLElement, type: string, detail: T): void {
    node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/**
 * Home Assistant's own toast, for something the element showing it may no
 * longer be there to say. `hass-notification` is handled at the
 * `home-assistant` root, which every surface mounting these sits inside.
 */
export function showToast(node: HTMLElement, message: string): void {
    fireEvent(node, "hass-notification", { message });
}
