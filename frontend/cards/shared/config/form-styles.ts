import { css } from "lit";

/**
 * The form and card styles the Helman config surfaces share.
 *
 * Lifted out of `helman-config-editor`'s one big `static styles` block when the
 * optimizer card became a mountable element of its own. Two elements now draw
 * the same markup -- the config panel and `<helman-optimizer-editor>` -- and a
 * copy of these rules in each would drift the moment either got a tweak.
 *
 * Selectors the optimizer element never renders (`.nested-card`,
 * `details.section-card`) are kept in the rules they were written with rather
 * than split out: they cost the element nothing, and splitting a shared
 * declaration block is how the two surfaces would start looking different.
 */
export const configFormStyles = css`
    * {
        box-sizing: border-box;
    }

    .actions button,
    .inline-actions button,
    .list-actions button,
    .add-button {
        border: 1px solid var(--divider-color);
        background: var(--card-background-color);
        color: var(--primary-text-color);
        padding: 10px 14px;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        transition: background 0.2s ease, border-color 0.2s ease;
    }

    .actions button:hover,
    .inline-actions button:hover,
    .list-actions button:hover,
    .add-button:hover {
        background: rgba(127, 127, 127, 0.08);
    }

    .actions button.primary,
    .add-button.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: var(--text-primary-color, white);
    }

    .actions button.primary:hover,
    .add-button.primary:hover {
        filter: brightness(1.03);
    }

    .actions button.danger,
    .inline-actions button.danger,
    .list-actions button.danger {
        border-color: var(--error-color);
        color: var(--error-color);
    }

    .actions button:disabled,
    .inline-actions button:disabled,
    .list-actions button:disabled,
    .add-button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
    }

    details.section-card,
    .list-card,
    .nested-card {
        border: 1px solid var(--divider-color);
        border-radius: 18px;
        background: var(--card-background-color);
    }

    /* Collapsible appliance cards */
    details.list-card {
        padding: 0;
    }

    details.list-card > summary {
        list-style: none;
        cursor: pointer;
        padding: 14px 16px;
        border-radius: 18px;
        transition: border-radius 0.15s ease;
        user-select: none;
    }

    details.list-card[open] > summary {
        border-radius: 18px 18px 0 0;
        border-bottom: 1px solid var(--divider-color);
    }

    details.list-card > summary::-webkit-details-marker {
        display: none;
    }

    .appliance-summary-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }

    .appliance-summary-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }

    .appliance-chevron {
        flex-shrink: 0;
        width: 16px;
        height: 16px;
        fill: var(--secondary-text-color);
        transition: transform 0.2s ease;
        transform: rotate(0deg);
        margin-left: 4px;
    }

    details.list-card[open] > summary .appliance-chevron {
        transform: rotate(90deg);
    }

    .appliance-body {
        padding: 16px;
        display: grid;
        gap: 14px;
    }

    /* A borderless glyph button, so renaming sits beside the name without
       competing with the up/down/remove pills on the other end of the row. */
    .icon-button {
        border: none;
        background: none;
        padding: 2px;
        display: inline-flex;
        align-items: center;
        cursor: pointer;
        border-radius: 6px;
        opacity: 0.6;
        transition: opacity 0.15s ease, background 0.15s ease;
    }

    .icon-button:hover {
        opacity: 1;
        background: rgba(127, 127, 127, 0.12);
    }

    .icon-button-glyph {
        width: 15px;
        height: 15px;
        fill: var(--secondary-text-color);
    }

    .field-grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }

    .field-grid > * {
        min-width: 0;
    }

    .field-grid--roomy {
        grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
    }

    .field {
        display: grid;
        gap: 8px;
        align-content: start;
        min-width: 0;
    }

    .field label {
        font-weight: 600;
        font-size: 0.93rem;
    }

    .field input,
    .field select,
    .field textarea {
        width: 100%;
        border-radius: 12px;
        border: 1px solid var(--divider-color);
        background: var(--secondary-background-color);
        color: var(--primary-text-color);
        padding: 12px 14px;
        font: inherit;
    }

    .number-input-wrap {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: stretch;
    }

    .number-input-wrap input {
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
    }

    .number-input-suffix {
        display: inline-flex;
        align-items: center;
        padding: 0 12px;
        border: 1px solid var(--divider-color);
        border-left: 0;
        border-top-right-radius: 12px;
        border-bottom-right-radius: 12px;
        background: var(--secondary-background-color);
        color: var(--secondary-text-color);
        font-size: 0.9rem;
        white-space: nowrap;
    }

    .field textarea {
        min-height: 120px;
        resize: vertical;
    }

    .field ha-entity-picker,
    .field ha-selector {
        display: block;
        width: 100%;
        min-width: 0;
        max-width: 100%;
    }

    .helper {
        color: var(--secondary-text-color);
        font-size: 0.86rem;
        line-height: 1.4;
    }

    .checkbox-group {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        padding: 4px 0;
    }

    .checkbox-option {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.92rem;
    }

    .list-card,
    .nested-card {
        padding: 16px;
    }

    .card-title {
        display: grid;
        gap: 4px;
    }

    .card-title strong {
        font-size: 1rem;
    }

    .card-subtitle {
        color: var(--secondary-text-color);
        font-size: 0.88rem;
    }

    .inline-actions,
    .list-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
    }

    .summary-toggle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--divider-color);
        background: var(--card-background-color);
        color: var(--primary-text-color);
        font-size: 0.82rem;
        font-weight: 600;
        white-space: nowrap;
    }

    .summary-toggle ha-switch {
        --mdc-theme-secondary: var(--primary-color);
    }

    pre.raw-preview {
        margin: 0;
        padding: 14px;
        border-radius: 14px;
        background: var(--secondary-background-color);
        overflow: auto;
        white-space: pre-wrap;
        font-size: 0.84rem;
        line-height: 1.45;
    }

    .field-label-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .field-label-row label {
        flex: 1;
        min-width: 0;
    }

    .help-btn {
        flex-shrink: 0;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 1px solid var(--secondary-text-color);
        background: transparent;
        color: var(--secondary-text-color);
        cursor: pointer;
        font: inherit;
        font-size: 0.72rem;
        font-weight: 700;
        line-height: 1;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    .help-btn:hover {
        border-color: var(--primary-color);
        color: var(--primary-color);
        background: rgba(3, 169, 244, 0.08);
    }

    .help-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
    }

    .help-dialog {
        background: var(--card-background-color);
        border-radius: 18px;
        padding: 22px 24px;
        max-width: 480px;
        width: 100%;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
    }

    .help-dialog-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 14px;
    }

    .help-dialog-header strong {
        font-size: 1.05rem;
        line-height: 1.3;
    }

    .help-dialog-close {
        flex-shrink: 0;
        border: 1px solid var(--divider-color);
        background: var(--card-background-color);
        color: var(--primary-text-color);
        width: 28px;
        height: 28px;
        border-radius: 50%;
        cursor: pointer;
        font: inherit;
        font-size: 0.9rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
    }

    .help-dialog-close:hover {
        background: rgba(127, 127, 127, 0.08);
    }

    .help-dialog-body {
        color: var(--secondary-text-color);
        line-height: 1.55;
        margin: 0;
        font-size: 0.93rem;
    }
`;
