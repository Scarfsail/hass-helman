import { css, unsafeCSS } from "lit-element";
import { SIMPLE_CARD_COLORS } from "./simple-card-colors";

const { neutral, state } = SIMPLE_CARD_COLORS;

/**
 * Illustration surfaces stay local; domain aliases read the shared palette.
 * Values are opaque. Components apply transparency with color-mix().
 */
export const simpleCardSharedStyles = css`
    :host {
        --simple-card-source-solar: var(--helman-solar);
        --simple-card-source-grid: var(--helman-grid);
        --simple-card-source-battery: var(--helman-battery);
        --simple-card-house-color: var(--helman-house);

        --simple-card-neutral-stroke: var(--helman-neutral);
        --simple-card-neutral-stroke-soft: ${unsafeCSS(neutral.strokeSoft)};
        --simple-card-surface-dark: ${unsafeCSS(neutral.surfaceDark)};
        --simple-card-surface-dark-soft: ${unsafeCSS(neutral.surfaceDarkSoft)};
        --simple-card-surface-mid: ${unsafeCSS(neutral.surfaceMid)};
        --simple-card-surface-light: var(--helman-neutral-light);
        --simple-card-surface-lightest: ${unsafeCSS(neutral.surfaceLightest)};
        --simple-card-label-color: var(--helman-neutral);

        --simple-card-warning-color: ${unsafeCSS(state.warning)};
        --simple-card-danger-color: ${unsafeCSS(state.danger)};
        --simple-card-warm-color: ${unsafeCSS(state.warm)};
        --simple-card-warm-soft-color: ${unsafeCSS(state.warmSoft)};
        --simple-card-solar-glow-color: var(--helman-solar);
        --simple-card-grid-accent: var(--helman-grid-import);
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
