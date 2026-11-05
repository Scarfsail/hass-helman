/** Below this page width a card treats the screen as a phone. */
export const NARROW_VIEWPORT_PX = 768;

/** True on a phone-width page, false on anything wider or outside a browser. */
export function isNarrowViewport(): boolean {
  const width = typeof window !== "undefined" ? window.innerWidth : 0;
  return width > 0 && width < NARROW_VIEWPORT_PX;
}
