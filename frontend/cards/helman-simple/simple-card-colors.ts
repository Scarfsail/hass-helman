import { BATT_COLOR, GRID_COLOR, SOLAR_COLOR } from '../color-utils';

export const SIMPLE_CARD_COLORS = {
    source: {
        solar: SOLAR_COLOR,
        grid: GRID_COLOR,
        battery: BATT_COLOR,
    },
    neutral: {
        stroke: '#6b7280',
        strokeSoft: '#4b5563',
        surfaceDark: '#1f2937',
        surfaceDarkSoft: '#2d3748',
        surfaceMid: '#374151',
        surfaceLight: '#9ca3af',
        surfaceLightest: '#d1d5db',
        label: '#6b7280',
    },
    state: {
        warning: '#f97316',
        danger: '#ef4444',
        warm: '#fde68a',
        warmSoft: '#fef08a',
        solarGlow: '#fde047',
        gridAccent: '#7dd3fc',
    },
} as const;
