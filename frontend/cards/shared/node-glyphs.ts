import { mdiCurrentAc } from "@mdi/js";
import { html } from "lit";

/**
 * The inverter: a cabinet with the AC wave the card's centre cell shows. The
 * inverter has no colour of its own, so it is drawn in the palette's neutral,
 * a custom property: the host includes `helmanColorVars`.
 */
export function inverterGlyph() {
    return html`
        <svg class="node-glyph" data-glyph="inverter" width="56" height="64" viewBox="0 0 56 64" aria-hidden="true">
            <rect x="4" y="4" width="48" height="56" rx="6" fill="var(--helman-neutral)" fill-opacity="0.12"
                stroke="var(--helman-neutral)" stroke-width="2.4"></rect>
            <path d=${mdiCurrentAc} transform="translate(12 16) scale(1.33)" fill="var(--helman-neutral)"></path>
            <path d="M14 50 H42" stroke="var(--helman-neutral)" stroke-width="2" stroke-linecap="round"></path>
        </svg>
    `;
}
