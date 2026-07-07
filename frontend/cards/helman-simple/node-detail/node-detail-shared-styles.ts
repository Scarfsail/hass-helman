import { css } from "lit-element";

export const nodeDetailSharedStyles = css`
    :host {
        display: block;
    }

    .content {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 240px;
        padding: 8px 0;
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
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        color: var(--secondary-text-color);
        letter-spacing: 0.05em;
        margin-top: 4px;
    }

    .power-device-wrapper {
        display: flex;
        width: 100%;
    }

    .power-devices-dual {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        gap: 8px;
        width: 100%;
    }

    .power-device-section {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 160px;
        gap: 4px;
    }

    .forecast-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

`;
