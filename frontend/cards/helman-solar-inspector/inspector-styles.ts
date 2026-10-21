import { css, unsafeCSS } from "lit";
import { nodeAccentColor } from "../color-utils";

/**
 * The inspector's shared stylesheets.
 *
 * The panels are render helpers that draw into the inspector's own shadow root
 * (see `panels/metrics.ts`), so their styles ride on the inspector; the chart
 * frame is shared by the inspector, which frames the aggregate chart and the
 * strips below the day chart, and by `helman-solar-day-chart`, which frames
 * its own rows the same way.
 */

/** A chart's outline and a strip row's separator and vertical label. */
export const chartFrameStyles = css`
  .chart-wrap {
    /* An outline rather than a border: a border would inset the svg by a
       pixel and narrow it by two, so every hour on this chart would sit a
       fraction off the same hour on the strips and the band below, which
       share the card's full width. */
    outline: 1px solid var(--divider-color);
    outline-offset: -1px;
    border-radius: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--card-background-color);
  }

  .compact-strip-section {
    position: relative;
    width: 100%;
  }

  .chart-separator {
    border-top: 1px solid color-mix(
      in srgb,
      var(--divider-color, #8a8a8a) 55%,
      var(--primary-text-color, #000) 45%
    );
  }

  .compact-strip-label {
    position: absolute;
    inset: 0 auto 0 0;
    width: 22px;
    align-self: stretch;
    color: var(--secondary-text-color);
    font-size: 0.85em;
    line-height: 1;
    pointer-events: none;
    text-align: center;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
  }
`;

/** The metrics panels, the house composition and the contribution table. */
export const panelStyles = css`
  .day-state {
    color: var(--secondary-text-color);
    font-size: 0.9rem;
  }

  .interpolation-note {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 8px;
    padding: 1px 6px;
    border: 1px dashed var(--primary-text-color);
    border-radius: 999px;
    font-size: 0.75rem;
    color: var(--secondary-text-color);
    background: var(--secondary-background-color);
  }

  .contribution-row.synthetic {
    cursor: default;
    font-style: italic;
    color: var(--secondary-text-color);
  }

  .contribution-row.synthetic:hover td,
  .contribution-row.synthetic:focus-within td {
    background: transparent;
  }

  .contribution-row.muted td {
    color: color-mix(in srgb, var(--secondary-text-color) 70%, transparent);
  }

  .contribution-row.selected.muted td {
    color: color-mix(in srgb, var(--secondary-text-color) 90%, var(--primary-text-color));
  }

  .contribution-table td.ratio {
    padding: 4px 6px;
    width: 1%;
    min-width: 140px;
  }

  .contribution-row.muted td.ratio {
    padding: 8px 10px;
    text-align: right;
  }

  .ratio-gauge {
    box-sizing: border-box;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    width: 100%;
    min-height: 18px;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--helman-discharge) 8%, transparent),
      color-mix(in srgb, var(--card-background-color) 90%, transparent),
      color-mix(in srgb, var(--helman-charge) 8%, transparent)
    );
    box-shadow: inset 0 0 0 1px var(--divider-color);
    font-variant-numeric: tabular-nums;
  }

  .ratio-gauge-center {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 50%;
    width: 1px;
    z-index: 1;
    background: color-mix(in srgb, var(--primary-text-color) 26%, transparent);
    transform: translateX(-50%);
  }

  .ratio-gauge-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 0;
    pointer-events: none;
  }

  .ratio-gauge-fill.positive {
    left: 50%;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--helman-charge) 60%, transparent),
      color-mix(in srgb, var(--helman-charge) 25%, transparent)
    );
    border-radius: 0 4px 4px 0;
  }

  .ratio-gauge-fill.negative {
    right: 50%;
    background: linear-gradient(
      270deg,
      color-mix(in srgb, var(--helman-discharge) 60%, transparent),
      color-mix(in srgb, var(--helman-discharge) 25%, transparent)
    );
    border-radius: 4px 0 0 4px;
  }

  .ratio-gauge-text {
    position: relative;
    z-index: 2;
    color: var(--primary-text-color);
  }

  .contribution-row.muted .ratio-gauge-text {
    color: color-mix(in srgb, var(--secondary-text-color) 70%, transparent);
  }

  .metrics-section {
    display: grid;
    gap: 6px;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
    gap: 6px;
    min-width: 0;
  }

  .metric-card {
    border: 1px solid var(--divider-color);
    border-radius: 6px;
    padding: 6px 7px;
    min-width: 0;
  }

  .metric-card.legend-toggle {
    font: inherit;
    text-align: left;
    cursor: pointer;
    display: block;
    width: 100%;
  }

  .metric-card.legend-toggle:focus-visible {
    outline: 2px solid var(--primary-color, #2563eb);
    outline-offset: 1px;
  }

  .metric-card.hidden-series {
    background: none !important;
    opacity: 0.5;
  }

  .metric-card.hidden-series .metric-label {
    text-decoration: line-through;
  }

  .metric-card.hidden-series {
    border-left-color: var(--divider-color) !important;
  }

  .metric-card.hidden-series .metric-chip {
    background: none !important;
  }

  .metric-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .metric-chip {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
  }

  .metric-label {
    color: var(--secondary-text-color);
    font-size: 0.72rem;
    line-height: 1.15;
    min-height: 1.7em;
  }

  .metric-value {
    color: var(--primary-text-color);
    font-weight: 700;
    font-size: 0.92rem;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  /* The day-total counterpart of the chart's partial-bucket scrim: a sum
     whose series has an interior hole is real but short, so it keeps its
     own colour rather than being greyed out like a genuinely missing value
     -- only the mark says it should be read as a lower bound. */
  .incomplete-mark {
    color: var(--secondary-text-color);
    font-weight: 700;
    margin-left: 1px;
  }

  .contribution-summary {
    display: grid;
    gap: 2px;
  }

  .contribution-toggle {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--primary-text-color);
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0;
    font: inherit;
    font-weight: bold;
    text-align: left;
  }

  .contribution-toggle-icon {
    display: inline-block;
    font-style: normal;
    transition: transform 0.2s;
    font-size: 0.7em;
    opacity: 0.7;
  }

  .contribution-toggle-icon.expanded {
    transform: rotate(90deg);
  }

  .impact-strip-switch {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    cursor: pointer;
    color: var(--secondary-text-color);
    font-size: 0.85em;
  }

  .impact-strip-switch input {
    margin: 0;
    cursor: pointer;
  }

  .contribution-table-wrap {
    overflow-x: auto;
  }

  .contribution-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86rem;
  }

  .contribution-table th,
  .contribution-table td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--divider-color);
    text-align: left;
    white-space: nowrap;
  }

  .contribution-table th.numeric,
  .contribution-table td.numeric {
    text-align: right;
  }

  .contribution-row {
    cursor: pointer;
  }

  .contribution-row:hover td,
  .contribution-row:focus-within td {
    background: var(--secondary-background-color);
  }

  .contribution-row.selected td {
    background: rgba(21, 101, 192, 0.12);
  }

  .house-breakdown {
    display: grid;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--divider-color);
    border-left: 3px solid var(--helman-house);
    border-radius: 6px;
    background: color-mix(in srgb, var(--helman-house) 8%, transparent);
    /* Every box here is a breakdown of the house, so it carries the house
       tint — the same declaration the power card's house section makes. The
       boxes set no --device-tint of their own, so helman-tree-item's fallback
       inherits this one across the shadow boundary. */
    --device-tint: ${unsafeCSS(nodeAccentColor("house"))};
  }

  .house-breakdown-title {
    color: var(--secondary-text-color);
    font-size: 0.78rem;
    font-weight: 600;
  }
`;
