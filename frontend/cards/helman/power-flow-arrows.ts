import { LitElement, css, html, unsafeCSS } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { TreeItem } from "../shared/data/tree-item";
import { nothing } from "lit-html";
import { NEUTRAL_LIGHT_COLOR, canonicalSourceColor } from "../color-utils";
import { FLOW_BAND_LENGTH, FLOW_BAND_PEAK_OPACITY, FLOW_RIBBON_OPACITY, FLOW_SWEEP_DURATION } from "../shared/flow-style";

/** One coloured band of a ribbon: where a share of its power came from. */
interface FlowBand {
    /** The source it came from; `null` for energy nobody can attribute. */
    sourceType: string | null;
    share: number;
}

/**
 * The bands one column's ribbon is split into. A source is its own colour;
 * anything else is split by the sources' shares of its latest bucket, in
 * `sources` order, so the bands line up with the source row above. With
 * nothing to attribute it is one neutral band.
 */
function flowBands(item: TreeItem, sources: readonly TreeItem[]): FlowBand[] {
    if (item.isSource) {
        return [{ sourceType: item.sourceType ?? null, share: 1 }];
    }
    const history = item.sourcePowerHistory;
    const bucket = history?.[history.length - 1];
    const powers = bucket
        ? sources
            .map((source) => ({ sourceType: source.sourceType ?? null, power: bucket[source.id]?.power ?? 0 }))
            .filter((entry) => entry.power > 0)
        : [];
    const sum = powers.reduce((total, entry) => total + entry.power, 0);
    if (sum <= 0) {
        return [{ sourceType: null, share: 1 }];
    }
    return powers.map((entry) => ({ sourceType: entry.sourceType, share: entry.power / sum }));
}

/**
 * The light band that says power is flowing, and the two rules that keep it cheap.
 *
 * The animation never ends, so its per-frame cost is paid for as long as the
 * card is on the page. It therefore moves nothing but `transform`: the light
 * band is painted once as static artwork and the frames only slide it, which
 * the compositor can do without a style recalc and a repaint of the whole
 * card on every one of them. Animating `background-color` and `box-shadow`
 * instead cost a `UpdateLayoutTree` and a `Paint` per frame per animated
 * element, measured at ~60 style recalcs and ~3600 paint
 * events a second on three arrow rows.
 *
 * And frames nobody can see are not worth running at all, so the animation is
 * paused while this element is scrolled out of the viewport or the tab is in
 * the background, and resumes where it left off on the way back. The pause is
 * an attribute rather than reactive state because it changes nothing the
 * template says, so it must not cost a render.
 */
@customElement("power-flow-arrows")
export class PowerFlowArrows extends LitElement {
    @property({ type: Array }) devices: (TreeItem | undefined)[] = [];
    @property({ type: Number }) maxPower?: number; // Default max power for 3-phase system and 25A per phase
    /** The source row, left to right: names each bucket key and orders the bands. */
    @property({ type: Array }) sources: readonly TreeItem[] = [];
    /**
     * Bumped by the card once per history tick; see `helman-card._historyRevision`.
     *
     * Nothing here reads it. `powerValue` and `sourcePowerHistory` are written
     * in place on the very items `devices` holds, so the array's identity never
     * moves and this is the only signal that the widths and bands changed --
     * the card used to spread the array on every render to say the same thing,
     * at `hass` churn rate rather than at the tick the value actually moves on.
     */
    @property({ type: Number }) historyRevision?: number;

    private _observer?: IntersectionObserver;
    private _onScreen = true;

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener("visibilitychange", this._onVisibilityChange);
        if (typeof IntersectionObserver !== "undefined") {
            this._observer = new IntersectionObserver(entries => {
                this._onScreen = entries[entries.length - 1].isIntersecting;
                this._syncPaused();
            }, {
                // Resumed just before it is on screen: `animation-play-state`
                // freezes the light band mid-sweep, and un-pausing at the viewport's
                // very edge shows that still frame for a frame or two.
                rootMargin: "200px",
            });
            this._observer.observe(this);
        }
        this._syncPaused();
    }

    disconnectedCallback() {
        document.removeEventListener("visibilitychange", this._onVisibilityChange);
        this._observer?.disconnect();
        this._observer = undefined;
        // A remount starts before the fresh observer has reported anything, so
        // the verdict it starts from must not be the one this mount ended on.
        this._onScreen = true;
        super.disconnectedCallback();
    }

    private _onVisibilityChange = () => this._syncPaused();

    private _syncPaused() {
        this.toggleAttribute("paused", document.hidden || !this._onScreen);
    }

    static get styles() {
        return css`
            .container {
                display: flex;
                flex-direction: row;
                gap: 5px;
                justify-content: space-evenly;
            }
            .item-container {
                flex: 1;
                min-width: 0;
                text-align: center;
            }
            .animated-arrow {
                position: relative;
                width: 100%;
                height: 22px;
                margin: 0 auto;
                border-radius: 0px;
                overflow: hidden;
            }
            .segments {
                display: flex;
                height: 100%;
            }
            .segment {
                min-width: 0;
                opacity: ${unsafeCSS(FLOW_RIBBON_OPACITY)};
            }
            .band {
                position: absolute;
                left: 0;
                right: 0;
                top: 0;
                height: ${unsafeCSS(FLOW_BAND_LENGTH * 100)}%;
                background: linear-gradient(to bottom, transparent, rgba(255, 255, 255, ${unsafeCSS(FLOW_BAND_PEAK_OPACITY)}), transparent);
                transform: translateY(-100%);
                animation: sweep ${unsafeCSS(FLOW_SWEEP_DURATION)} linear infinite;
            }
            :host([paused]) .band {
                animation-play-state: paused;
            }
            @keyframes sweep {
                from { transform: translateY(-100%); }
                /* Clear of the ribbon's far end: its length is 1 / FLOW_BAND_LENGTH bands. */
                to { transform: translateY(${unsafeCSS(100 / FLOW_BAND_LENGTH)}%); }
            }
            @media (prefers-reduced-motion: reduce) {
                .band {
                    animation: none;
                }
            }
        `;
    }

    render() {
        if (!this.devices || this.devices.length === 0) {
            return nothing;
        }
        const maxPower = this.maxPower || (25 * 230 * 3); // Default to 3-phase system with 25A per phase
        return html`
            <div class="container">
                ${this.devices.map((device) => {
                    if (!device?.powerValue || device.powerValue <= 0.4) {
                        return html`<div class="item-container"></div>`;
                    }
                    const widthPercentage = Math.min((device.powerValue / maxPower) * 100, 100);
                    return html`
                        <div class="item-container">
                            <div class="animated-arrow" style="width: ${widthPercentage}%">
                                <div class="segments">
                                    ${flowBands(device, this.sources).map((band) => html`
                                        <div
                                            class="segment"
                                            data-source=${band.sourceType ?? "none"}
                                            style="flex: ${band.share} 1 0; background-color: ${canonicalSourceColor(band.sourceType, NEUTRAL_LIGHT_COLOR)}"
                                        ></div>
                                    `)}
                                </div>
                                <div class="band"></div>
                            </div>
                        </div>
                    `;
                })}
            </div>
        `;
    }
}
