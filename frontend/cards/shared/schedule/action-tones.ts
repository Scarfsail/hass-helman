import { css } from "lit-element";
import type { ScheduleAction } from "./schedule-types";

/**
 * The scheduler's action tones, defined once: which tone an action kind takes
 * and the colours a tone class paints. The schedule's chips, strips and
 * tooltips and the node details' tiles and pills all read these, so a charge
 * looks the same everywhere: normal neutral, charge green, discharge amber,
 * stop red.
 */
export type ScheduleActionTone = "empty" | "neutral" | "normal" | "charge" | "discharge" | "stop";
export type ScheduleActionToneClass = `action-tone-${ScheduleActionTone}`;

export function getScheduleActionTone(actionKind: ScheduleAction["kind"]): ScheduleActionTone {
    switch (actionKind) {
        case "empty":
            return "neutral";
        case "normal":
            return "normal";
        case "charge_to_target_soc":
            return "charge";
        case "discharge_to_target_soc":
            return "discharge";
        case "stop_charging":
        case "stop_discharging":
        case "stop_export":
            return "stop";
    }
}

/**
 * Each tone class sets `--schedule-action-tone-accent` and the background,
 * border, text and icon colours derived from it; an element styles itself
 * from those.
 */
export const scheduleActionToneStyles = css`
    .action-tone-empty,
    .action-tone-neutral,
    .action-tone-normal,
    .action-tone-charge,
    .action-tone-discharge,
    .action-tone-stop {
        --schedule-action-tone-bg: color-mix(in srgb, var(--schedule-action-tone-accent) 14%, transparent);
        --schedule-action-tone-border: color-mix(in srgb, var(--schedule-action-tone-accent) 30%, var(--divider-color));
        --schedule-action-tone-color: color-mix(in srgb, var(--schedule-action-tone-accent) 82%, var(--primary-text-color));
        --schedule-action-tone-icon: var(--schedule-action-tone-color);
    }

    .action-tone-empty {
        --schedule-action-tone-accent: var(--schedule-action-empty-color, var(--secondary-text-color));
        --schedule-action-tone-bg: color-mix(in srgb, var(--schedule-action-tone-accent) 7%, transparent);
        --schedule-action-tone-border: color-mix(in srgb, var(--schedule-action-tone-accent) 16%, var(--divider-color));
        --schedule-action-tone-color: var(--disabled-text-color, var(--secondary-text-color));
        --schedule-action-tone-icon: color-mix(in srgb, var(--disabled-text-color, var(--secondary-text-color)) 84%, var(--primary-text-color));
    }

    .action-tone-neutral {
        --schedule-action-tone-accent: var(--schedule-action-neutral-color, var(--secondary-text-color));
        --schedule-action-tone-color: var(--secondary-text-color);
        --schedule-action-tone-icon: color-mix(in srgb, var(--secondary-text-color) 88%, var(--primary-text-color));
    }

    .action-tone-normal {
        --schedule-action-tone-accent: var(--schedule-action-normal-color, #ffffff);
        --schedule-action-tone-bg: color-mix(in srgb, var(--schedule-action-tone-accent) 12%, var(--card-background-color));
        --schedule-action-tone-border: color-mix(in srgb, var(--schedule-action-tone-accent) 44%, var(--divider-color));
        --schedule-action-tone-color: var(--primary-text-color);
        --schedule-action-tone-icon: color-mix(in srgb, var(--schedule-action-tone-accent) 86%, var(--primary-text-color));
    }

    .action-tone-charge {
        --schedule-action-tone-accent: var(--schedule-action-charge-color, var(--success-color, #2e7d32));
    }

    .action-tone-discharge {
        --schedule-action-tone-accent: var(--schedule-action-discharge-color, var(--warning-color, #c27c0e));
    }

    .action-tone-stop {
        --schedule-action-tone-accent: var(--schedule-action-stop-color, var(--error-color, #c62828));
    }
`;
