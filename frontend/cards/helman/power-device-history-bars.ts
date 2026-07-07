import { LitElement, TemplateResult, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { DeviceNode } from "./DeviceNode";

type BarSegment = { heightPct: number; color: string };
type Bar = { heightPct: number; segments: BarSegment[] };

@customElement("power-device-history-bars")
export class PowerDeviceHistoryBars extends LitElement {
    static get styles() {
        return css`
            .historyContainer {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                display: flex;
                flex-direction: row;
                align-items: flex-end;
                pointer-events: none;
                overflow: hidden;
                //border-radius: 10px;
                z-index: 1;
            }
            .historyBarContainer {
                flex-grow: 1;
                display: flex;
                flex-direction: column-reverse; /* To stack from bottom up */
            }
            .historyBarSegment {
                width: 100%;
            }
        `;
    }

    @property({ attribute: false }) public device!: DeviceNode;
    @property({ attribute: false }) public historyToRender!: number[];
    @property({ type: Number }) public maxHistoryPower!: number;
    @property({ type: String }) public historyBarColor!: string;

    @state() private _bars: Bar[] = [];

    willUpdate(changedProperties: Map<string, unknown>): void {
        if (!changedProperties.has('historyToRender')
            && !changedProperties.has('maxHistoryPower')
            && !changedProperties.has('device')
            && !changedProperties.has('historyBarColor')) {
            return;
        }

        const hist = this.historyToRender ?? [];
        const max = this.maxHistoryPower;
        const sourcePerBucket = this.device.sourcePowerHistory;
        const isSource = this.device.isSource;
        const fallbackColor = this.historyBarColor;

        const bars: Bar[] = new Array(hist.length);
        for (let i = 0; i < hist.length; i++) {
            const p = hist[i];
            const heightPct = max > 0 ? Math.min(100, (p / max) * 100) : 0;
            const sourceHistory = !isSource ? sourcePerBucket?.[i] : undefined;
            const segments: BarSegment[] = [];
            if (sourceHistory) {
                for (const s of Object.values(sourceHistory)) {
                    if (p > 0) {
                        segments.push({ heightPct: (s.power / p) * 100, color: s.color });
                    }
                }
            }
            if (segments.length === 0) {
                segments.push({ heightPct: 100, color: fallbackColor });
            }
            bars[i] = { heightPct, segments };
        }
        this._bars = bars;
    }

    render(): TemplateResult {
        return html`
            <div class="historyContainer">
                ${this._bars.map(bar => html`
                    <div class="historyBarContainer" style="height: ${bar.heightPct}%;">
                        ${bar.segments.map(s => html`
                            <div class="historyBarSegment"
                                 style="height: ${s.heightPct}%; background-color: ${s.color};"></div>
                        `)}
                    </div>
                `)}
            </div>
        `;
    }
}
