import { svg } from "lit";

/**
 * The vertical "now" line, spanning `top`..`bottom` of whichever SVG chart draws it.
 *
 * Colour and width match the schedule band's `.now-marker`, so a stack reads as
 * one mark drawn straight down the page. Two details keep it that way rather
 * than merely close: the stroke does not scale with the viewBox, so it is 2 CSS
 * pixels at any chart width the way the band's 2px div always is; and the line
 * is snapped to a whole pixel, so those two pixels land on two pixels instead of
 * smearing across three and reading heavier than the band.
 */
export function renderNowMarker(x: number, top: number, bottom: number, title: string) {
    const snapped = Math.round(x);
    return svg`
        <line
            x1=${snapped} y1=${top} x2=${snapped} y2=${bottom}
            stroke="var(--primary-color)" stroke-width="2"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
        ><title>${title}</title></line>
    `;
}
