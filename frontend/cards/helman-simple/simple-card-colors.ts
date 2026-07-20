import {
    BATT_COLOR,
    GRID_COLOR,
    GRID_EXPORT_COLOR,
    NEUTRAL_COLOR,
    NEUTRAL_LIGHT_COLOR,
    SOLAR_COLOR,
} from '../color-utils';

/**
 * Colors specific to the simple card's own chrome — the surfaces, strokes and
 * glows that draw its house, battery and grid illustrations. These stay local
 * because no other card renders that illustration.
 *
 * Anything with domain meaning comes from color-utils instead, so the two files
 * never disagree about what a source color is.
 */
export const SIMPLE_CARD_COLORS = {
    source: {
        solar: SOLAR_COLOR,
        grid: GRID_COLOR,
        battery: BATT_COLOR,
    },
    neutral: {
        stroke: NEUTRAL_COLOR,
        strokeSoft: '#4b5563',
        surfaceDark: '#1f2937',
        surfaceDarkSoft: '#2d3748',
        surfaceMid: '#374151',
        surfaceLight: NEUTRAL_LIGHT_COLOR,
        surfaceLightest: '#d1d5db',
        label: NEUTRAL_COLOR,
    },
    state: {
        warning: '#f97316',
        danger: '#ef4444',
        warm: '#fde68a',
        warmSoft: '#fef08a',
        solarGlow: '#fde047',
        gridAccent: GRID_EXPORT_COLOR,
    },
} as const;
