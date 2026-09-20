/**
 * The solar inspector, embedded in the Training tab's solar Diagnostics.
 *
 * The inspector is *not* compiled into this bundle. `helman-card.js` and
 * `helman-config-editor.js` are two vite entry points over one source tree, and
 * everything they share is compiled into both: importing the inspector from here
 * would put a second copy of its whole graph in the editor bundle, which is not
 * merely large (measured: 345 kB -> 959 kB) but broken -- the second
 * `customElements.define` for a shared tag throws, aborting the rest of that
 * bundle's evaluation, and the card's `window.customCards` push would run twice.
 *
 * So the editor loads the already-built card *artifact* instead, by the exact
 * version-stamped URL the backend registered as the Lovelace resource. The
 * browser keys ES module identity on the URL, so if a dashboard has already
 * loaded that URL nothing is evaluated a second time, and if the user came
 * straight to the panel it is loaded once, here. Which is also why the URL comes
 * down in the panel config rather than being assembled in the frontend: a URL
 * that differed by so much as its query string would be a different module.
 */

import type { HelmanSolarInspectorCardConfig } from "../cards/helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { loadOnce } from "../cards/shared/load-ha-elements";

export const INSPECTOR_CARD_TAG = "helman-solar-inspector-card";

/**
 * The card config the embed mounts with -- solar only, on the tab's own surface.
 *
 * Exported rather than written inline because
 * `frontend/tests/inspector-solar-only-options.spec.ts` covers what these
 * options do to the card, and it covers *this* object: the coverage and the
 * embed cannot drift apart if there is only one of them.
 */
export const SOLAR_INSPECTOR_EMBED_CONFIG: HelmanSolarInspectorCardConfig = {
  type: `custom:${INSPECTOR_CARD_TAG}`,
  // The diagnostics are the point of the embed, so they are open from the start.
  show_bias_ratio: true,
  // The section is already inside two nested panels; a third card frame around
  // the chart would read as another level of nesting rather than as a card.
  transparent_background: true,
  hide_schedule_strip: true,
  hide_price_strip: true,
  hide_money_strip: true,
  chart_series: ["actual", "corrected", "raw"],
};

/** The card element, with the two members the embed drives it through. */
export type SolarInspectorCardElement = HTMLElement & {
  setConfig: (config: HelmanSolarInspectorCardConfig) => void;
  hass: unknown;
};

/**
 * Load the card artifact at `url`, at most once per returned loader.
 *
 * `@vite-ignore` is load-bearing: without it the bundler treats the import as a
 * module to resolve at build time and pulls the inspector graph in after all,
 * which is exactly what this file exists to avoid. The URL is a runtime value
 * and must stay one.
 */
export function inspectorCardLoader(url: string): () => Promise<void> {
  return loadOnce([INSPECTOR_CARD_TAG], async () => {
    await import(/* @vite-ignore */ url);
  });
}
