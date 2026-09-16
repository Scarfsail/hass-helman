import { css } from "lit";

/**
 * The rules the optimizer card's own markup needs, on top of
 * `configFormStyles`.
 *
 * Split from the form styles rather than merged into them because these follow
 * `optimizer-card.ts` / `optimizer-condition-groups.ts`: a change to what those
 * render belongs here, and a change to how a field looks belongs there.
 */
export const optimizerCardStyles = css`
    details.optimizer-card > summary {
        border: 1px solid transparent;
    }

    details.optimizer-card.optimizer-card--enabled > summary {
        background: rgba(46, 125, 50, 0.1);
        border-color: rgba(46, 125, 50, 0.28);
    }

    details.optimizer-card.optimizer-card--disabled > summary {
        background: rgba(127, 127, 127, 0.08);
        border-color: rgba(127, 127, 127, 0.22);
    }

    /* A requires_appliance provider planned later in the appliance section --
       the same warning palette the config editor's own tab counters use. */
    .optimizer-warning-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 0.76rem;
        font-weight: var(--ha-font-weight-medium, 500);
        background: rgba(255, 152, 0, 0.12);
        color: #ef6c00;
        white-space: nowrap;
    }

    details.condition-section {
        border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.12));
        border-radius: 8px;
        background: var(--secondary-background-color, rgba(255, 255, 255, 0.04));
    }

    details.condition-section > summary {
        cursor: pointer;
        padding: 12px 14px;
        font-weight: var(--ha-font-weight-medium, 500);
        list-style: revert;
    }

    details.condition-section > .condition-body {
        padding: 0 14px 14px;
        display: grid;
        gap: 10px;
    }

    /* An appliance group spans the card: each row is one member, and the row
       order is the priority order. */
    .controllable-targets {
        grid-column: 1 / -1;
    }

    .controllable-target-row {
        display: grid;
        gap: 8px;
        padding: 10px 14px;
        border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.12));
        border-radius: 8px;
        background: var(--secondary-background-color, rgba(255, 255, 255, 0.04));
    }

    .condition-groups {
        display: grid;
        gap: 10px;
        margin-top: 14px;
    }

    .condition-groups-head {
        display: flex;
        align-items: baseline;
        gap: 10px;
        flex-wrap: wrap;
    }

    /* An optional param object: the toggle owns the block, and its fields only
       exist while it is on, so the indent shows what turning it off removes. */
    .optional-param-group {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: subgrid;
        gap: 10px;
        padding-left: 12px;
        border-left: 2px solid var(--divider-color, rgba(255, 255, 255, 0.12));
    }

    .optional-param-group > .field-label-row {
        grid-column: 1 / -1;
    }

    .optional-param-group label {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    /* A group reads as one more card in the same visual family as the optimizer
       card it sits in, so the OR list looks like a list and not like nesting. */
    details.condition-group,
    details.param-override {
        border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.12));
        border-radius: 8px;
        background: var(--secondary-background-color, rgba(255, 255, 255, 0.04));
    }

    details.condition-group > summary,
    details.param-override > summary {
        cursor: pointer;
        padding: 10px 14px;
        font-weight: var(--ha-font-weight-medium, 500);
        list-style: revert;
    }

    /* The group's own chevron, so the marker and the name share one line — the
       native ::marker sits outside the flex row and drops the name below it. */
    details.condition-group > summary {
        list-style: none;
        user-select: none;
    }

    details.condition-group > summary::-webkit-details-marker {
        display: none;
    }

    details.condition-group[open] > summary .appliance-chevron {
        transform: rotate(90deg);
    }

    .condition-group-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .condition-group-name-input {
        font: inherit;
        font-weight: var(--ha-font-weight-medium, 500);
        padding: 2px 6px;
        min-width: 12ch;
    }

    details.condition-group > .condition-group-body,
    details.param-override > .condition-group-body {
        padding: 0 14px 14px;
        display: grid;
        gap: 12px;
    }
`;
