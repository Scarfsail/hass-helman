/**
 * Colors specific to the simple card's own chrome — the surfaces, strokes and
 * glows that draw its house, battery and grid illustrations. These stay local
 * because no other card renders that illustration.
 *
 * Domain colors come from helmanColorVars in each component.
 */
export const SIMPLE_CARD_COLORS = {
    neutral: {
        strokeSoft: '#4b5563',
        surfaceDark: '#1f2937',
        surfaceDarkSoft: '#2d3748',
        surfaceMid: '#374151',
        surfaceLightest: '#d1d5db',
    },
    state: {
        warning: '#f97316',
        danger: '#ef4444',
        warm: '#fde68a',
        warmSoft: '#fef08a',
    },
} as const;
