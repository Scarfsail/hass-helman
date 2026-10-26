import { css } from "lit-element";

export const nodeDetailSharedStyles = css`
    :host {
        display: block;
    }

    /* A detail's Overview; the sections after it run edge to edge. */
    .overview {
        padding: 0 var(--ha-space-6, 24px) var(--ha-space-5, 20px);
    }

    /* The last section is closed off from the footer; a detail without sections ends on its Overview, unlined. */
    helman-detail-section:last-child,
    slot[name="schedule"]:last-child::slotted(helman-detail-section) {
        border-bottom: 1px solid var(--divider-color);
    }

    .content {
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-width: 240px;
    }


    /* A grouped block on the dialog surface: label rows, a car, a price. */
    .tile {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 12px 14px;
        border-radius: var(--ha-border-radius-lg, 12px);
        background: var(--secondary-background-color);
    }
    /* A secondary action on the surface, like Override… */
    .outline-button {
        align-self: flex-start;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 10px 16px;
        border: 1px solid var(--divider-color);
        border-radius: 22px;
        background: none;
        color: var(--primary-text-color);
        font: inherit;
        font-size: 14px;
        cursor: pointer;
    }
    .outline-button:hover:not(:disabled) {
        background: var(--secondary-background-color);
    }
    .outline-button:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
    }
    .outline-button:disabled {
        cursor: default;
        opacity: 0.5;
    }
    .tile .row {
        align-items: baseline;
        font-size: 14px;
    }
    .tile .label,
    .tile .value {
        font-size: inherit;
        font-weight: inherit;
    }

    .detail-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
    }

    .detail-row.clickable {
        cursor: pointer;
        border-radius: 4px;
        padding: 2px 4px;
        margin: 0 -4px;
    }

    .detail-row.clickable:hover {
        background: var(--secondary-background-color);
    }

    .label {
        color: var(--secondary-text-color);
        font-size: 0.9rem;
    }

    .value {
        font-weight: 600;
        font-size: 0.9rem;
    }

    .section-title {
        display: flex;
        align-items: center;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        color: var(--secondary-text-color);
        letter-spacing: 0.08em;
    }

    /* History & statistics: a part of the row above it, figures as tiles, energy by source. */
    .row.indent {
        padding-left: 14px;
    }
    /* History and technical figures read as plain text; a key figure is bolded where it is. */
    [data-history-body] .row .value,
    [data-technical-body] .row .value {
        font-weight: inherit;
    }
    .stat-tiles {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
    }
    .stat-tiles.two {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .stat-value {
        font-size: 18px;
        overflow-wrap: anywhere;
    }
    .stat-caption {
        font-size: 12px;
        line-height: 1.45;
        color: var(--secondary-text-color);
    }
    /* HA's history graph sits on the section, not in a card of its own. */
    hui-history-graph-card {
        --ha-card-background: transparent;
        --ha-card-border-width: 0;
        --ha-card-box-shadow: none;
    }
    .share-bar {
        display: flex;
        gap: 2px;
        height: 16px;
    }
    .share-bar > span {
        min-width: 4px;
        border-radius: 4px;
    }
    .swatch-mark {
        margin-right: 4px;
    }

    .error {
        margin: 0;
        font-size: 0.85rem;
        color: var(--error-color, #c62828);
    }

`;

/** The question-led node details: the overview summary, answer rows and tables. */
export const nodeDetailQuestionStyles = css`
    .summary {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .figures {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
        gap: 8px;
    }
    .figure {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }
    .figure-label {
        font-size: 0.75rem;
        color: var(--secondary-text-color);
    }
    .figure-value {
        font-size: 1.05rem;
        font-weight: 600;
        overflow-wrap: anywhere;
    }
    .next {
        margin: 0;
        font-size: 0.9rem;
        color: var(--secondary-text-color);
    }
    .exception {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 8px;
        padding: 8px 10px;
        border-radius: 8px;
        border-left: 3px solid var(--warning-color, #ffa600);
        background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
        font-size: 0.9rem;
    }
    .link-button {
        font: inherit;
        background: none;
        border: none;
        padding: 4px 0;
        color: var(--primary-color);
        font-weight: 600;
        cursor: pointer;
        min-height: 32px;
    }
    .rows {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
        font-size: 0.9rem;
    }
    .row .label {
        flex: 1 1 auto;
        min-width: 0;
    }
    .row .value {
        text-align: right;
        overflow-wrap: anywhere;
        min-width: 0;
        max-width: 60%;
    }
    .reading {
        font: inherit;
        font-weight: 600;
        color: inherit;
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        cursor: pointer;
        text-decoration: underline dotted;
        text-underline-offset: 3px;
        border-radius: 2px;
    }
    .reading::after {
        content: " ↗";
        visibility: hidden;
    }
    .reading:hover::after,
    .reading:focus-visible::after {
        visibility: visible;
    }
    .reading:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
    }
    .note {
        margin: 0;
        font-size: 0.82rem;
        color: var(--secondary-text-color);
    }
    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.82rem;
        font-variant-numeric: tabular-nums;
    }
    th, td {
        padding: 3px 4px;
        text-align: right;
        overflow-wrap: anywhere;
    }
    th:first-child, td:first-child {
        text-align: left;
    }
    th {
        color: var(--secondary-text-color);
        font-weight: 600;
    }
    .plan {
        margin: 0 -8px;
    }
`;

/** The inverter's plan → command → inverter chain, and a meter bar under a figure. */
export const nodeDetailPictureStyles = css`
    .picture.chain {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .meter {
        display: block;
        height: 6px;
        margin-top: 4px;
        border-radius: 3px;
        background: var(--divider-color, rgba(0, 0, 0, 0.12));
        overflow: hidden;
    }
    .meter-fill {
        display: block;
        height: 100%;
        border-radius: 3px;
        background: var(--meter-accent, var(--schedule-action-tone-accent));
    }
`;
