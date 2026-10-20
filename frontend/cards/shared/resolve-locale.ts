import type { HomeAssistant } from "../../types/ha";

export function resolveLocale(hass?: HomeAssistant): string {
    return hass?.locale?.language || (typeof navigator !== "undefined" ? navigator.language : "cs");
}
