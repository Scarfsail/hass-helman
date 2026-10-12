import { html, svg } from "lit";

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

/** One source's share of what the house used, and its colour. */
export interface HouseShare {
    id: string;
    /** 0–1; the shares add up to 1. */
    share: number;
    color: string;
}

/**
 * The house, its body filled bottom-up with the mix of its sources: shares
 * of what it used, not a level, so the fill always reaches the roof. Without a known mix
 * (`null`) it is an empty outline, never a fill of nothing.
 */
export function houseGlyph(shares: HouseShare[] | null) {
    // The body under the roof, so each band's height is its share of the area.
    const top = 28;
    const bottom = 70;
    let y = bottom;
    const bands = (shares ?? []).filter((item) => item.share > 0).map((item) => {
        const height = item.share * (bottom - top);
        y -= height;
        return svg`<rect data-house-fill=${item.id} data-share=${item.share.toFixed(3)} x="0" y=${y} width="64" height=${height} fill=${item.color}></rect>`;
    });
    return html`
        <svg class="node-glyph" data-glyph="house" width="64" height="74" viewBox="0 0 64 74" aria-hidden="true">
            <defs>
                <clipPath id="house-shape"><path d="M32 4 L60 28 L60 70 L4 70 L4 28 Z"></path></clipPath>
            </defs>
            <g clip-path="url(#house-shape)" fill-opacity="0.75">${bands}</g>
            <path d="M32 4 L60 28 L60 70 L4 70 L4 28 Z" fill="none" stroke="var(--helman-house)" stroke-width="2.4" stroke-linejoin="round"></path>
        </svg>
    `;
}
