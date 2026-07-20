import { css, unsafeCSS } from "lit-element";
import { SIMPLE_CARD_COLORS } from "./simple-card-colors";

const { source, neutral, state } = SIMPLE_CARD_COLORS;

/**
 * Every var here is generated from SIMPLE_CARD_COLORS so a color is written
 * down exactly once. Values are opaque: components that need transparency
 * apply it themselves with color-mix(), rather than the palette shipping a
 * pre-baked variant per alpha step.
 */
export const simpleCardSharedStyles = css`
    :host {
        --simple-card-source-solar: ${unsafeCSS(source.solar)};
        --simple-card-source-grid: ${unsafeCSS(source.grid)};
        --simple-card-source-battery: ${unsafeCSS(source.battery)};

        --simple-card-neutral-stroke: ${unsafeCSS(neutral.stroke)};
        --simple-card-neutral-stroke-soft: ${unsafeCSS(neutral.strokeSoft)};
        --simple-card-surface-dark: ${unsafeCSS(neutral.surfaceDark)};
        --simple-card-surface-dark-soft: ${unsafeCSS(neutral.surfaceDarkSoft)};
        --simple-card-surface-mid: ${unsafeCSS(neutral.surfaceMid)};
        --simple-card-surface-light: ${unsafeCSS(neutral.surfaceLight)};
        --simple-card-surface-lightest: ${unsafeCSS(neutral.surfaceLightest)};
        --simple-card-label-color: ${unsafeCSS(neutral.label)};

        --simple-card-warning-color: ${unsafeCSS(state.warning)};
        --simple-card-danger-color: ${unsafeCSS(state.danger)};
        --simple-card-warm-color: ${unsafeCSS(state.warm)};
        --simple-card-warm-soft-color: ${unsafeCSS(state.warmSoft)};
        --simple-card-solar-glow-color: ${unsafeCSS(state.solarGlow)};
        --simple-card-grid-accent: ${unsafeCSS(state.gridAccent)};
    }

    .power-label {
        font-size: 0.78rem;
        font-weight: 700;
        color: var(--simple-card-label-color);
        min-height: 1.1em;
        text-align: center;
        line-height: 1.3;
    }

    .unit {
        font-size: 0.7em;
        font-weight: 400;
        opacity: 0.8;
    }
`;
