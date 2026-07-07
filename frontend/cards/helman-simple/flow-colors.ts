import { withAlpha } from "../color-utils";
import { SIMPLE_CARD_COLORS } from "./simple-card-colors";

export type FlowSource = "solar" | "grid" | "battery";

interface GridInternalFlowColors {
    base: string;
    glow: string;
    accent: string;
}

export function getFlowColor(source: FlowSource): string {
    switch (source) {
        case "solar":
            return SIMPLE_CARD_COLORS.source.solar;
        case "grid":
            return SIMPLE_CARD_COLORS.source.grid;
        case "battery":
            return SIMPLE_CARD_COLORS.source.battery;
    }
}

export function getFlowGlow(color: string, alphaHex = "aa"): string {
    return withAlpha(color, alphaHex);
}

export function getGridInternalFlowColors(importing: boolean, exportSourceColor?: string): GridInternalFlowColors {
    if (importing) {
        const base = SIMPLE_CARD_COLORS.source.grid;
        return {
            base,
            glow: getFlowGlow(base, "99"),
            accent: SIMPLE_CARD_COLORS.state.gridAccent,
        };
    }

    const base = exportSourceColor ?? SIMPLE_CARD_COLORS.source.grid;
    return {
        base,
        glow: getFlowGlow(base, "99"),
        accent: base,
    };
}
