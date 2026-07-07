import { css } from "lit-element";

export const forecastSharedStyles = css`
    :host {
        display: block;
        --forecast-grid-import: #2563eb;
        --forecast-grid-export: var(--simple-card-grid-accent, #7dd3fc);
        --forecast-house-color: #8b5cf6;
        --forecast-battery-soc-soft: color-mix(
            in srgb,
            var(--simple-card-source-battery, #22c55e) 46%,
            var(--secondary-text-color) 54%
        );
        --forecast-battery-soc-max: color-mix(
            in srgb,
            var(--simple-card-source-battery, #22c55e) 88%,
            white 12%
        );
        --forecast-battery-soc-min: color-mix(in srgb, var(--error-color, #c62828) 72%, white 28%);
    }

    .forecast-detail-days {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 8px;
        align-items: start;
    }

    .forecast-day-card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
        padding: 10px;
        border: 1px solid var(--divider-color);
        border-radius: 12px;
        background: var(--secondary-background-color);
        transition: border-color 120ms ease, box-shadow 120ms ease;
    }

    .forecast-day-card.today {
        border-color: var(--primary-color);
    }

    .forecast-day-card.expanded {
        border-color: var(--primary-color);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    }

    .forecast-day-summary {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
        padding: 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
    }

    .forecast-day-summary:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
        border-radius: 8px;
    }

    .forecast-day-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
    }

    .forecast-day-label {
        font-size: 0.88rem;
        font-weight: 600;
        line-height: 1.2;
    }

    .forecast-day-toggle {
        color: var(--secondary-text-color);
        font-size: 1rem;
        font-weight: 600;
        line-height: 1;
    }

    .forecast-day-gauge {
        box-sizing: border-box;
        display: flex;
        flex-wrap: wrap;
        position: relative;
        overflow: hidden;
        align-items: baseline;
        gap: 4px;
        min-width: 0;
        min-height: 20px;
        padding: 1px 4px 1px 5px;
        border-radius: 4px;
        font-size: 0.96rem;
        font-weight: 700;
        line-height: 1.2;
    }

    .forecast-day-gauge > :not(.forecast-day-gauge-fill, .forecast-day-gauge-center) {
        position: relative;
        z-index: 1;
    }

    .forecast-day-gauge-fill {
        position: absolute;
        inset: 0 auto 0 0;
        z-index: 0;
        border-radius: inherit;
        pointer-events: none;
    }

    .forecast-day-gauge-center {
        position: absolute;
        top: 3px;
        bottom: 3px;
        left: 50%;
        width: 1px;
        z-index: 1;
        background: color-mix(in srgb, var(--primary-text-color) 26%, transparent);
        transform: translateX(-50%);
    }

    .forecast-day-gauge.solar {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--simple-card-source-solar, #facc15) 12%, #201f1c),
            color-mix(in srgb, var(--simple-card-source-solar, #facc15) 6%, #0f0f0e)
        );
        color: color-mix(in srgb, white 90%, var(--simple-card-source-solar, #facc15));
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--simple-card-source-solar, #facc15) 14%, #2d2b26);
    }

    .forecast-day-gauge.solar .forecast-day-gauge-fill {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--simple-card-source-solar, #facc15) 44%, #332c00),
            color-mix(in srgb, var(--simple-card-source-solar, #facc15) 32%, #1c1800)
        );
    }

    .forecast-day-gauge.solar .forecast-day-gauge-fill.muted {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--simple-card-source-solar, #facc15) 28%, #282200),
            color-mix(in srgb, var(--simple-card-source-solar, #facc15) 20%, #151100)
        );
    }

    .forecast-day-gauge.battery {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 16%, transparent),
            color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 8%, transparent)
        );
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 20%, var(--divider-color));
    }

    .forecast-day-gauge.battery .forecast-day-gauge-fill {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 66%, white 8%),
            color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 44%, transparent)
        );
    }

    .forecast-day-gauge.grid {
        justify-content: flex-end;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 13%, #141b25),
            color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 6%, #070b10),
            color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 13%, #141b25)
        );
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 13%, #232d39);
    }

    .forecast-day-gauge.grid .forecast-day-gauge-fill.import {
        inset: 0 auto 0 auto;
        right: 50%;
        left: auto;
        background: linear-gradient(
            270deg,
            color-mix(in srgb, var(--forecast-grid-import) 74%, white 6%),
            color-mix(in srgb, var(--forecast-grid-import) 46%, transparent)
        );
        border-radius: 4px 0 0 4px;
    }

    .forecast-day-gauge.grid .forecast-day-gauge-fill.export {
        inset: 0 auto 0 50%;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--forecast-grid-export) 74%, white 6%),
            color-mix(in srgb, var(--forecast-grid-export) 46%, transparent)
        );
        border-radius: 0 4px 4px 0;
    }

    .forecast-day-gauge.solar .forecast-day-gauge-primary {
        color: color-mix(in srgb, white 90%, var(--simple-card-source-solar, #facc15));
        text-shadow: none;
    }

    .forecast-day-gauge.battery .forecast-day-gauge-primary,
    .forecast-day-gauge.battery .forecast-day-gauge-unit {
        color: color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 34%, var(--primary-text-color));
        text-shadow:
            0 0 1px rgba(255, 255, 255, 0.55),
            0 1px 1px rgba(24, 44, 28, 0.12);
    }

    .forecast-day-gauge.grid .forecast-day-gauge-primary,
    .forecast-day-gauge.grid .forecast-day-gauge-unit {
        color: color-mix(in srgb, var(--primary-text-color) 92%, transparent);
        text-shadow:
            0 0 1px rgba(255, 255, 255, 0.55),
            0 1px 1px rgba(24, 32, 52, 0.1);
    }

    .forecast-day-gauge.solar .forecast-day-gauge-separator,
    .forecast-day-gauge.solar .forecast-day-gauge-secondary,
    .forecast-day-gauge.solar .forecast-day-gauge-unit {
        color: color-mix(in srgb, white 72%, var(--simple-card-source-solar, #facc15));
        text-shadow: none;
    }

    .forecast-day-gauge.zero .forecast-day-gauge-primary,
    .forecast-day-gauge.zero .forecast-day-gauge-secondary,
    .forecast-day-gauge.zero .forecast-day-gauge-separator,
    .forecast-day-gauge.zero .forecast-day-gauge-unit {
        color: var(--secondary-text-color);
        text-shadow: none;
    }

    .forecast-day-gauge.grid.zero,
    .forecast-day-gauge.solar.zero {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--secondary-text-color) 14%, #0f0f10),
            color-mix(in srgb, var(--secondary-text-color) 8%, #040404)
        );
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--secondary-text-color) 18%, #1b1b1c);
    }

    .forecast-day-gauge.zero .forecast-day-gauge-center {
        background: color-mix(in srgb, var(--secondary-text-color) 32%, transparent);
    }

    .forecast-day-gauge-secondary {
        font-weight: 600;
    }

    .forecast-day-gauge-unit {
        display: inline-block;
        margin-inline-start: 0.2rem;
        font-size: 0.5em;
        font-weight: 700;
        line-height: 1;
        vertical-align: baseline;
        white-space: nowrap;
    }

    .forecast-day-price-line {
        --forecast-day-price-font-size: 0.74rem;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        min-height: 1rem;
        font-size: var(--forecast-day-price-font-size);
        font-weight: 600;
        line-height: 1.2;
    }

    .forecast-day-price-chip {
        display: inline-flex;
        align-items: baseline;
        gap: 0.18rem;
        white-space: nowrap;
        font-size: var(--forecast-day-price-font-size);
        font-weight: inherit;
        line-height: inherit;
    }

    .forecast-day-price-prefix {
        font-size: 0.82em;
        line-height: 1;
    }

    .forecast-day-price-value {
        font-size: var(--forecast-day-price-font-size);
        line-height: inherit;
    }

    .forecast-day-price-unit {
        color: var(--secondary-text-color);
        font-size: inherit;
        line-height: inherit;
    }

    .forecast-day-price-chip.muted {
        opacity: 0.7;
    }

    .forecast-day-price-separator {
        color: var(--secondary-text-color);
    }

    .forecast-day-chart-row {
        display: block;
    }

    .forecast-day-chart-track {
        position: relative;
        display: flex;
        align-items: stretch;
        flex: 1 1 auto;
        gap: 2px;
        min-width: 0;
        height: 18px;
        padding: 1px 0;
    }

    .forecast-day-chart-track::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 1px;
        border-radius: 999px;
        background: var(--divider-color);
        opacity: 0.7;
    }

    .forecast-day-chart-track.price.has-negative::before {
        bottom: 50%;
    }

    .forecast-day-chart-track.grid::before {
        bottom: 50%;
    }

    .forecast-day-chart-track.empty::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: 2px;
        bottom: 2px;
        border: 1px dashed var(--divider-color);
        border-radius: 999px;
        opacity: 0.45;
    }

    .forecast-day-chart-bar {
        position: relative;
        flex: 1 1 0;
        min-width: 0;
        color: var(--primary-color);
    }

    .forecast-day-chart-bar.solar {
        color: var(--simple-card-source-solar, #facc15);
    }

    .forecast-day-chart-bar.battery-soc {
        color: var(--forecast-battery-soc-soft);
    }

    .forecast-day-chart-bar.battery-soc.hit-max {
        color: var(--forecast-battery-soc-max);
    }

    .forecast-day-chart-bar.battery-soc.hit-min {
        color: var(--forecast-battery-soc-min);
    }

    .forecast-day-chart-bar.battery-soc.soft::before {
        opacity: 0.72;
    }

    .forecast-day-chart-bar.battery-soc.hit-max::before {
        opacity: 1;
        box-shadow: 0 0 0 1px color-mix(
            in srgb,
            var(--simple-card-source-battery, #22c55e) 32%,
            transparent
        );
    }

    .forecast-day-chart-bar.past {
        opacity: 0.35;
    }

    .forecast-day-chart-bar::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: var(--forecast-bar-offset, 0%);
        height: var(--forecast-bar-height, 0%);
        border-radius: 999px;
        background: currentColor;
        opacity: 0.95;
    }

    .forecast-day-chart-bar.gap::before {
        display: none;
    }

    .forecast-day-chart-bar.gap::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 10%;
        bottom: 10%;
        border-left: 1px dashed var(--divider-color);
        opacity: 0.45;
        transform: translateX(-50%);
    }

    .forecast-detail-panel {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px;
        border: 1px solid var(--divider-color);
        border-radius: 12px;
        background: var(--card-background-color);
    }

    .forecast-detail-panel-header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 12px;
    }

    .forecast-detail-panel-heading {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .forecast-detail-panel-title {
        font-size: 0.95rem;
        font-weight: 700;
        line-height: 1.2;
    }

    .forecast-detail-panel-subtitle,
    .forecast-status-note {
        color: var(--secondary-text-color);
        font-size: 0.8rem;
    }

    .forecast-detail-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 12px 16px;
        align-items: flex-start;
    }

    .forecast-detail-summary-item {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
    }

    .forecast-detail-summary-label,
    .forecast-detail-row-label {
        color: var(--secondary-text-color);
        font-size: 0.72rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .forecast-detail-row-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .forecast-detail-row-label.multiline {
        overflow: visible;
        text-overflow: clip;
        white-space: pre-line;
        line-height: 1.15;
    }

    .forecast-detail-summary-value {
        font-size: 0.85rem;
        font-weight: 600;
        line-height: 1.2;
    }

    .forecast-detail-summary-item .forecast-day-price-line {
        --forecast-day-price-font-size: 0.78rem;
        min-height: 0;
    }

    .forecast-detail-chart {
        --forecast-detail-label-column-width: clamp(64px, 20vw, 96px);
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .forecast-detail-disclosure {
        display: flex;
        align-items: center;
    }

    .forecast-detail-disclosure-button {
        appearance: none;
        border: none;
        padding: 0;
        background: none;
        color: var(--secondary-text-color);
        font: inherit;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 0.14em;
    }

    .forecast-detail-disclosure-button:hover {
        color: var(--primary-color);
    }

    .forecast-detail-disclosure-button:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
        border-radius: 3px;
    }

    .forecast-detail-row,
    .forecast-detail-axis {
        display: grid;
        grid-template-columns:
            minmax(0, var(--forecast-detail-label-column-width))
            minmax(0, 1fr);
        gap: 8px;
        align-items: center;
    }

    .forecast-detail-row.primary .forecast-detail-row-label {
        color: var(--primary-text-color);
        font-weight: 700;
    }

    .forecast-detail-track,
    .forecast-detail-axis-grid {
        position: relative;
        display: grid;
        grid-template-columns: repeat(var(--forecast-column-count, 1), minmax(0, 1fr));
        gap: 4px;
        min-width: 0;
    }

    .forecast-detail-track {
        min-height: 76px;
    }

    .forecast-detail-track::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 1px;
        border-radius: 999px;
        background: var(--divider-color);
        opacity: 0.8;
    }

    .forecast-detail-track.price.has-negative::before {
        bottom: 50%;
    }

    .forecast-detail-track.grid::before {
        bottom: 50%;
    }

    .forecast-detail-track.empty::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: 6px;
        bottom: 6px;
        border: 1px dashed var(--divider-color);
        border-radius: 12px;
        opacity: 0.45;
    }

    .forecast-detail-column {
        position: relative;
        min-width: 0;
    }

    .forecast-detail-column.gap::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 8px;
        bottom: 8px;
        border-left: 1px dashed var(--divider-color);
        opacity: 0.5;
        transform: translateX(-50%);
    }

    .forecast-detail-column.past .forecast-detail-bar,
    .forecast-detail-column.past .forecast-detail-highlight {
        opacity: 0.38;
    }

    .forecast-detail-column.past .forecast-detail-battery-change,
    .forecast-detail-column.past .forecast-detail-battery-step,
    .forecast-detail-column.past .forecast-detail-battery-flow {
        opacity: 0.38;
    }

    .forecast-detail-bar {
        position: absolute;
        left: 50%;
        bottom: var(--forecast-bar-offset, 0%);
        width: calc(100% - 2px);
        max-width: 12px;
        min-width: 4px;
        height: var(--forecast-bar-height, 0%);
        transform: translateX(-50%);
        border-radius: 999px;
        background: currentColor;
        opacity: 0.95;
    }

    .forecast-detail-bar.solar,
    .forecast-detail-highlight.solar {
        color: var(--simple-card-source-solar, #facc15);
    }

    .forecast-detail-highlight {
        position: absolute;
        left: 50%;
        z-index: 1;
        padding: 1px 4px;
        border-radius: 999px;
        background: var(--card-background-color);
        box-shadow: 0 0 0 1px var(--divider-color);
        font-size: 0.64rem;
        font-weight: 700;
        line-height: 1.2;
        white-space: nowrap;
        transform: translateX(-50%);
        pointer-events: none;
    }

    .forecast-detail-highlight.top {
        top: 2px;
    }

    .forecast-detail-highlight.bottom {
        bottom: 2px;
    }

    .forecast-detail-axis {
        align-items: start;
    }

    .forecast-detail-axis-tick {
        display: flex;
        justify-content: center;
        min-width: 0;
        color: var(--secondary-text-color);
        font-size: 0.68rem;
        line-height: 1.2;
    }

    .forecast-detail-axis-tick.past {
        opacity: 0.45;
    }

    .forecast-day-chart-track.price .forecast-day-chart-bar.price-positive,
    .forecast-day-price-chip.price-positive,
    .forecast-detail-track.price .forecast-detail-bar.price-positive,
    .forecast-detail-highlight.price-positive {
        color: var(--forecast-price-positive, #8d6e63);
    }

    .forecast-day-chart-track.price .forecast-day-chart-bar.price-negative,
    .forecast-day-price-chip.price-negative,
    .forecast-detail-track.price .forecast-detail-bar.price-negative,
    .forecast-detail-highlight.price-negative {
        color: var(--forecast-price-negative, #6d4c41);
    }

    .forecast-day-chart-track.price .forecast-day-chart-bar.price-neutral,
    .forecast-day-price-chip.price-neutral,
    .forecast-detail-track.price .forecast-detail-bar.price-neutral,
    .forecast-detail-highlight.price-neutral {
        color: var(--forecast-price-neutral, #a1887f);
    }

    .forecast-day-chart-track.grid .forecast-day-chart-bar.grid-import {
        color: var(--forecast-grid-import);
    }

    .forecast-day-chart-track.grid .forecast-day-chart-bar.grid-export {
        color: var(--forecast-grid-export);
    }

    .forecast-day-chart-track.grid .forecast-day-chart-bar.grid-neutral {
        color: color-mix(in srgb, var(--secondary-text-color) 72%, transparent);
    }

    .forecast-detail-track.grid .forecast-detail-bar.grid-import,
    .forecast-detail-highlight.grid-import {
        color: var(--forecast-grid-import);
    }

    .forecast-detail-track.grid .forecast-detail-bar.grid-export,
    .forecast-detail-highlight.grid-export {
        color: var(--forecast-grid-export);
    }

    .forecast-detail-track.grid .forecast-detail-bar.grid-neutral,
    .forecast-detail-highlight.grid-neutral {
        color: color-mix(in srgb, var(--secondary-text-color) 72%, transparent);
    }

    .muted {
        color: var(--secondary-text-color);
        font-size: 0.9rem;
    }

    .forecast-day-chart-bar.house-baseline {
        color: var(--forecast-house-color);
    }

    .forecast-detail-row.primary .forecast-detail-track::before {
        background: color-mix(in srgb, var(--forecast-house-color) 26%, var(--divider-color));
        opacity: 1;
    }

    .forecast-detail-row.primary .forecast-detail-track.battery-soc::before {
        background: color-mix(in srgb, var(--forecast-battery-soc-soft) 26%, var(--divider-color));
    }

    .forecast-detail-track.battery-combined {
        overflow: hidden;
    }

    .forecast-detail-bar.house-consumption {
        color: var(--forecast-house-color);
    }

    .forecast-detail-highlight.house-consumption {
        color: var(--forecast-house-color);
    }

    .forecast-detail-band {
        position: absolute;
        left: 15%;
        right: 15%;
        height: 2px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.35;
        pointer-events: none;
        color: var(--primary-color);
    }

    .forecast-detail-band.lower,
    .forecast-detail-band.upper {
        bottom: var(--forecast-band-offset, 0%);
    }

    .forecast-detail-reference-line {
        position: absolute;
        left: 0;
        right: 0;
        bottom: min(var(--forecast-reference-offset, 0%), calc(100% - 1px));
        z-index: 0;
        border-top: 1px dashed currentColor;
        opacity: 0.55;
        pointer-events: none;
    }

    .forecast-detail-reference-line.min-soc {
        color: var(--forecast-battery-soc-min);
    }

    .forecast-detail-reference-line.max-soc {
        color: var(--forecast-battery-soc-max);
    }

    .forecast-detail-battery-change,
    .forecast-detail-battery-step,
    .forecast-detail-battery-flow {
        position: absolute;
        pointer-events: none;
    }

    .forecast-detail-battery-change,
    .forecast-detail-battery-step {
        color: var(--forecast-battery-soc-soft);
    }

    .forecast-detail-battery-change {
        left: 50%;
        z-index: 1;
        bottom: var(--forecast-change-offset, 0%);
        width: 4px;
        height: var(--forecast-change-height, 0%);
        transform: translateX(-50%);
        border-radius: 999px;
        background: currentColor;
        opacity: 0.45;
    }

    .forecast-detail-battery-step {
        left: 0;
        right: 0;
        z-index: 3;
        bottom: min(var(--forecast-step-offset, 0%), calc(100% - 2px));
        height: 2px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.82;
    }

    .forecast-detail-battery-flow {
        left: 50%;
        z-index: 2;
        bottom: var(--forecast-flow-offset, 0%);
        width: calc(100% - 6px);
        max-width: 10px;
        min-width: 4px;
        height: var(--forecast-flow-height, 0%);
        transform: translateX(-50%);
        border-radius: 999px;
        background: currentColor;
        opacity: 0.92;
    }

    .forecast-detail-battery-flow.charge {
        color: var(--success-color, #2e7d32);
    }

    .forecast-detail-battery-flow.discharge {
        color: var(--error-color, #c62828);
    }

    .forecast-detail-battery-change.hit-min,
    .forecast-detail-battery-step.hit-min {
        color: var(--forecast-battery-soc-min);
    }

    .forecast-detail-battery-change.hit-max,
    .forecast-detail-battery-step.hit-max {
        color: var(--forecast-battery-soc-max);
    }

    .forecast-detail-battery-change.hit-min,
    .forecast-detail-battery-change.hit-max {
        width: 6px;
        opacity: 0.72;
    }

    .forecast-detail-battery-step.hit-min,
    .forecast-detail-battery-step.hit-max {
        height: 3px;
        opacity: 1;
    }

`;
