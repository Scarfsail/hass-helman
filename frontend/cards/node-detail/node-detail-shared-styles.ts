import { css } from "lit-element";

export const nodeDetailSharedStyles = css`
    :host {
        display: block;
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

/**
 * The pictured node details: a picture or glyph that opens the question it
 * absorbed, the answer tiles and the open answer under them.
 */
export const nodeDetailPictureStyles = css`
    .glyph,
    .picture {
        display: block;
        padding: 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        text-align: inherit;
        cursor: pointer;
        border-radius: 8px;
    }
    .picture {
        width: 100%;
    }
    .picture.strip,
    .picture.chain {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .glyph:focus-visible,
    .picture:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
    }
    .picture-scope {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--secondary-text-color);
    }
    .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
        gap: 8px;
        margin-top: 4px;
    }
    helman-node-question {
        margin-top: 4px;
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
