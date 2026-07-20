import { css, unsafeCSS } from "lit-element";
import { SIMPLE_CARD_COLORS } from "./simple-card-colors";

const { source, neutral, state } = SIMPLE_CARD_COLORS;
const v = (color: string) => unsafeCSS(color);

/**
 * Every var here is generated from SIMPLE_CARD_COLORS so a color is written
 * down exactly once. Values are opaque: components that need transparency
 * apply it themselves with color-mix(), rather than the palette shipping a
 * pre-baked variant per alpha step.
 */
export const simpleCardSharedStyles = css`
    :host {
        --simple-card-source-solar: ${v(source.solar)};
        --simple-card-source-grid: ${v(source.grid)};
        --simple-card-source-battery: ${v(source.battery)};

        --simple-card-neutral-stroke: ${v(neutral.stroke)};
        --simple-card-neutral-stroke-soft: ${v(neutral.strokeSoft)};
        --simple-card-surface-dark: ${v(neutral.surfaceDark)};
        --simple-card-surface-dark-soft: ${v(neutral.surfaceDarkSoft)};
        --simple-card-surface-mid: ${v(neutral.surfaceMid)};
        --simple-card-surface-light: ${v(neutral.surfaceLight)};
        --simple-card-surface-lightest: ${v(neutral.surfaceLightest)};
        --simple-card-label-color: ${v(neutral.label)};

        --simple-card-warning-color: ${v(state.warning)};
        --simple-card-danger-color: ${v(state.danger)};
        --simple-card-warm-color: ${v(state.warm)};
        --simple-card-warm-soft-color: ${v(state.warmSoft)};
        --simple-card-solar-glow-color: ${v(state.solarGlow)};
        --simple-card-grid-accent: ${v(state.gridAccent)};
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
