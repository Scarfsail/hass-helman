import { css } from "lit-element";

export const simpleCardSharedStyles = css`
    :host {
        --simple-card-source-solar: #facc15;
        --simple-card-source-solar-99: #facc1599;
        --simple-card-source-grid: #38bdf8;
        --simple-card-source-grid-99: #38bdf899;
        --simple-card-source-battery: #22c55e;
        --simple-card-source-battery-88: #22c55e88;

        --simple-card-neutral-stroke: #6b7280;
        --simple-card-neutral-stroke-soft: #4b5563;
        --simple-card-surface-dark: #1f2937;
        --simple-card-surface-dark-soft: #2d3748;
        --simple-card-surface-mid: #374151;
        --simple-card-surface-light: #9ca3af;
        --simple-card-surface-lightest: #d1d5db;
        --simple-card-label-color: #6b7280;

        --simple-card-warning-color: #f97316;
        --simple-card-warning-color-88: #f9731688;
        --simple-card-danger-color: #ef4444;
        --simple-card-danger-color-88: #ef444488;
        --simple-card-warm-color: #fde68a;
        --simple-card-warm-color-44: #fde68a44;
        --simple-card-warm-color-66: #fde68a66;
        --simple-card-warm-color-88: #fde68a88;
        --simple-card-warm-color-99: #fde68a99;
        --simple-card-warm-soft-color: #fef08a;
        --simple-card-solar-glow-color: #fde047;
        --simple-card-grid-accent: #7dd3fc;
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
