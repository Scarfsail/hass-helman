import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { DeviceNode } from "./DeviceNode";
import { nothing } from "lit-html";

const STRIPS = html`
    ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => html`<div class="strip" style="--index: ${i}"></div>`)}
`;

/**
 * The strips that say power is flowing, and the two rules that keep them cheap.
 *
 * The animation never ends, so its per-frame cost is paid for as long as the
 * card is on the page. It therefore moves nothing but `transform` and
 * `opacity`: the lit strip is painted once as static artwork and the frames
 * only slide and fade it, which the compositor can do without a style recalc
 * and a repaint of the whole card on every one of them. Animating
 * `background-color` and `box-shadow` instead cost a `UpdateLayoutTree` and a
 * `Paint` per frame per strip, measured at ~60 style recalcs and ~3600 paint
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
    @property({ type: Array }) devices: (DeviceNode | undefined)[] = [];
    @property({ type: Number }) maxPower?: number; // Default max power for 3-phase system and 25A per phase
    /**
     * Bumped by the card once per history tick; see `helman-card._historyRevision`.
     *
     * Nothing here reads it. `powerValue` is written in place on the very nodes
     * `devices` holds, so the array's identity never moves and this is the only
     * signal that the widths changed -- the card used to spread the array on
     * every render to say the same thing, at `hass` churn rate rather than at
     * the tick the value actually moves on.
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
                // freezes the strips mid-fade, and un-pausing at the viewport's
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
            .strip {
                position: absolute;
                left: 0;
                right: 0;
                height: 10%;
                top: calc(var(--index) * 10%);
                background-color: rgb(220, 220, 220);
                box-shadow: 0 0 5px rgba(220, 220, 220, 0.8);
                opacity: 0;
                transform: translateY(-10px);
                animation: flow 1.0s linear infinite;
                animation-delay: calc(var(--index) * 0.15s);
            }
            :host([paused]) .strip {
                animation-play-state: paused;
            }

            @keyframes flow {
                0% {
                    opacity: 0;
                    transform: translateY(-10px);
                }
                50% {
                    opacity: 1;
                }
                100% {
                    opacity: 0;
                    transform: translateY(10px);
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
                                ${STRIPS}
                            </div>
                        </div>
                    `;
                })}
            </div>
        `;
    }
}
