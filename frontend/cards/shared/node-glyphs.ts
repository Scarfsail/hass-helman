import { html } from "lit";

/**
 * The centre glyphs of the node flows that need no state of their own: a
 * drawing in the node's colour. Their colours are the palette's custom
 * properties, so the host includes `helmanColorVars`.
 */

/** A transmission pylon in the grid's colour: the grid flow's centre. */
export function pylonGlyph() {
    return html`
        <svg class="node-glyph" data-glyph="pylon" width="56" height="72" viewBox="0 0 56 72" aria-hidden="true"
            fill="none" stroke="var(--helman-grid)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">
            <path d="M28 4 L16 68 M28 4 L40 68 M20.5 44 L35.5 44 M18.5 56 L37.5 56 M22.6 33 L33.4 33"></path>
            <path d="M6 18 L50 18 M10 28 L46 28 M24.5 18 L34 28 M31.5 18 L22 28 M17 44 L39 56 M39 44 L17 56"></path>
            <path d="M6 18 v5 M50 18 v5 M10 28 v5 M46 28 v5"></path>
        </svg>
    `;
}

/**
 * A solar panel: the solar flow's centre. It lights in the solar colour
 * while `producing`, and is drawn grey otherwise.
 */
export function panelGlyph(producing: boolean) {
    const color = producing ? "var(--helman-solar)" : "var(--helman-neutral-light)";
    return html`
        <svg class="node-glyph" data-glyph="panel" data-producing=${producing ? "true" : "false"} width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"
            stroke=${color} stroke-width="2" stroke-linejoin="round">
            <path d="M14 10 L50 10 L58 46 L6 46 Z" fill=${color} fill-opacity=${producing ? "0.35" : "0.12"}></path>
            <path d="M10 22 L54 22 M8 34 L56 34 M26 10 L24 46 M38 10 L40 46" fill="none"></path>
            <path d="M32 46 L32 58 M22 58 L42 58" fill="none" stroke-linecap="round"></path>
        </svg>
    `;
}
