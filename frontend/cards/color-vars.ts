import { css, unsafeCSS } from "lit-element";
import {
    BATT_COLOR,
    CHARGE_COLOR,
    DISCHARGE_COLOR,
    FORECAST_RAW_COLOR,
    GRID_COLOR,
    GRID_EXPORT_COLOR,
    GRID_IMPORT_COLOR,
    HOUSE_COLOR,
    NEUTRAL_COLOR,
    NEUTRAL_LIGHT_COLOR,
    PHASE_COLORS,
    PRICE_NEGATIVE_COLOR,
    PRICE_POSITIVE_COLOR,
    SELECTION_COLOR,
    SOLAR_COLOR,
} from "./color-utils";

/**
 * The palette from color-utils, as CSS custom properties.
 *
 * This lives apart from color-utils so that module stays free of any rendering
 * dependency — history-engine imports it from contexts
 * that have no business pulling in Lit.
 *
 * Custom properties set on one element's :host do not reach a sibling custom
 * element's shadow tree, so every *component* that reads one of these has to
 * include this block in its own `static styles`. Putting it only on the card
 * root is not enough: the component then renders uncolored anywhere else,
 * including when the Playwright specs mount it standalone.
 *
 * Each value indirects through a `--helman-theme-*` hook so a Home Assistant
 * theme can still override it. Without that hook a plain `:host` declaration
 * would beat the theme's document-level value, making these colors *less*
 * themeable than the inline fallbacks they replaced.
 *
 * Values are opaque by design. Transparency belongs to the component that needs
 * it — `color-mix(in srgb, var(--helman-solar) 24%, transparent)` in CSS, or
 * withAlpha() in chart code that builds fill strings in JS.
 */
export const helmanColorVars = css`
    :host {
        --helman-solar: var(--helman-theme-solar, ${unsafeCSS(SOLAR_COLOR)});
        --helman-grid: var(--helman-theme-grid, ${unsafeCSS(GRID_COLOR)});
        --helman-battery: var(--helman-theme-battery, ${unsafeCSS(BATT_COLOR)});
        --helman-house: var(--helman-theme-house, ${unsafeCSS(HOUSE_COLOR)});

        --helman-grid-import: var(--helman-theme-grid-import, ${unsafeCSS(GRID_IMPORT_COLOR)});
        --helman-grid-export: var(--helman-theme-grid-export, ${unsafeCSS(GRID_EXPORT_COLOR)});

        --helman-price-negative: var(--helman-theme-price-negative, ${unsafeCSS(PRICE_NEGATIVE_COLOR)});
        --helman-price-positive: var(--helman-theme-price-positive, ${unsafeCSS(PRICE_POSITIVE_COLOR)});

        --helman-forecast-raw: var(--helman-theme-forecast-raw, ${unsafeCSS(FORECAST_RAW_COLOR)});
        --helman-selection: var(--helman-theme-selection, ${unsafeCSS(SELECTION_COLOR)});

        --helman-charge: var(--helman-theme-charge, ${unsafeCSS(CHARGE_COLOR)});
        --helman-discharge: var(--helman-theme-discharge, ${unsafeCSS(DISCHARGE_COLOR)});

        --helman-neutral: var(--helman-theme-neutral, ${unsafeCSS(NEUTRAL_COLOR)});
        --helman-neutral-light: var(--helman-theme-neutral-light, ${unsafeCSS(NEUTRAL_LIGHT_COLOR)});

        --helman-phase-l1: var(--helman-theme-phase-l1, ${unsafeCSS(PHASE_COLORS[1])});
        --helman-phase-l2: var(--helman-theme-phase-l2, ${unsafeCSS(PHASE_COLORS[2])});
        --helman-phase-l3: var(--helman-theme-phase-l3, ${unsafeCSS(PHASE_COLORS[3])});
    }
`;
