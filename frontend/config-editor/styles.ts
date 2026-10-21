import { css } from "lit";
import { configFormStyles } from "../cards/shared/config/form-styles";
import { optimizerCardStyles } from "../cards/shared/optimizer/optimizer-styles";
import { deviceEditorStyles } from "../cards/shared/devices/helman-device-editor";
import { deviceEnergyStyles } from "../cards/shared/devices/device-energy";
import { hardwareProfileStyles } from "../cards/shared/devices/hardware-profile";

/**
 * Styles for the editor shell: layout, header, tabs, actions, issue board,
 * document-level YAML, and responsive layout.
 */
export const editorShellStyles = css`
  :host {
    display: block;
    min-height: 100%;
    background: var(--primary-background-color);
    color: var(--primary-text-color);
  }

  .page {
    max-width: 1240px;
    margin: 0 auto;
    padding: 24px 20px 48px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 24px;
  }

  .title-block h1 {
    margin: 0 0 8px;
    font-size: 1.9rem;
    line-height: 1.2;
  }

  .title-block p {
    margin: 0;
    color: var(--secondary-text-color);
    max-width: 780px;
    line-height: 1.5;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: flex-end;
  }

  .status-row {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    margin-bottom: 16px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 0.88rem;
    border: 1px solid var(--divider-color);
    background: var(--card-background-color);
  }

  .badge.info {
    color: var(--secondary-text-color);
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 20px;
  }

  .tabs button {
    border: 1px solid var(--divider-color);
    background: var(--card-background-color);
    color: var(--primary-text-color);
    border-radius: 999px;
    padding: 10px 16px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font: inherit;
  }

  .tabs button.active {
    border-color: var(--primary-color);
    color: var(--primary-color);
    background: rgba(3, 169, 244, 0.08);
  }

  .tab-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    border-radius: 999px;
    padding: 0 6px;
    font-size: 0.78rem;
    background: rgba(127, 127, 127, 0.18);
    color: inherit;
  }

  .tab-count.errors {
    background: rgba(244, 67, 54, 0.12);
    color: var(--error-color);
  }

  .tab-count.warnings {
    background: rgba(255, 152, 0, 0.12);
    color: #ef6c00;
  }

  .tab-warning-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--error-color, #db4437);
  }

  .issue-board {
    display: grid;
    gap: 14px;
    margin-bottom: 20px;
  }

  .issue-group {
    border: 1px solid var(--divider-color);
    border-radius: 16px;
    padding: 16px;
    background: var(--card-background-color);
  }

  .issue-group h3 {
    margin: 0 0 10px;
    font-size: 1rem;
  }

  .issue-group ul {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 8px;
  }

  .tab-body {
    display: grid;
    gap: 16px;
  }

  .tab-scope {
    display: grid;
    gap: 16px;
  }

  .scope-toolbar {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
  }

  .tab-icon {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    fill: currentColor;
  }

  .yaml-field--document ha-yaml-editor {
    --code-mirror-height: clamp(420px, 72vh, 980px);
    --code-mirror-max-height: clamp(420px, 72vh, 980px);
  }

  .yaml-error {
    margin: 0;
  }

  @media (max-width: 900px) {
    .header {
      flex-direction: column;
    }

    .actions,
    .scope-toolbar {
      justify-content: flex-start;
    }
  }
`;

/**
 * Styles for the entities-only view filter.
 */
export const entitiesOnlyStyles = css`
  .entities-only-toggle {
    /* The toolbar packs to the right; this one control belongs on the left,
       away from the tab's YAML toggle it must not be mistaken for. */
    margin-right: auto;
  }

  /*
   * The entities-only view.
   *
   * Everything that is not an entity group goes away, and every container
   * left holding no group goes with it -- otherwise the view is a column of
   * empty section headings, which is the noise this exists to remove.
   *
   * :has() is what makes that possible without threading a "contains a
   * group" flag down every render path, and it is why the sections are forced
   * open by an attribute rather than by CSS: a closed details renders no
   * content at all, so :has() could not find a group inside one and every
   * collapsed section would hide itself.
   *
   * The guard against a group's *own* fields is the pair of rules at the end.
   * A group's slotted settings -- a polarity, a history-day count -- are not
   * in its shadow root; they are children of <helman-entity-group> in this
   * element's tree, which is exactly where .entities-only .field reaches.
   * Hiding them would leave every group showing a picker and a reading with
   * the settings that qualify it gone, which is the opposite of the point.
   */
  .entities-only .field,
  .entities-only .field-grid:not(:has(helman-entity-group)),
  .entities-only .list-stack:not(:has(helman-entity-group, .scope-yaml)),
  .entities-only .list-card:not(.scope-yaml):not(:has(helman-entity-group, .scope-yaml)),
  .entities-only details.section-card:not(.scope-yaml):not(:has(helman-entity-group, .scope-yaml)),
  .entities-only .inline-note,
  .entities-only helman-info-callout,
  .entities-only .section-footer,
  .entities-only .mode-toggle {
    display: none;
  }

  .entities-only helman-entity-group .field,
  .entities-only helman-entity-group .field-grid {
    display: grid;
  }

  .entities-only helman-entity-group .toggle-field {
    display: block;
  }

  /*
   * A scope left in YAML mode is kept, editor and all.
   *
   * It renders a code editor instead of fields, so it holds no group and
   * every rule above would sweep it away -- and the rule that hides the
   * per-section mode toggles would take away the only control that could
   * switch it back. A user who left the Battery section in YAML mode and
   * later turns this view on to audit their entities would be shown a tab
   * with the battery silently missing from it and no way to find out.
   *
   * The promise is "nothing missed", not "nothing I can introspect". The
   * entity ids are right there in the YAML, so the honest answer is to show
   * the scope as it is and leave its toggle working.
   */
  .entities-only details.scope-yaml {
    display: block;
  }

  .entities-only .scope-yaml .yaml-surface,
  .entities-only .scope-yaml .yaml-field {
    display: grid;
  }

  .entities-only .scope-yaml > summary .mode-toggle {
    display: inline-flex;
  }

  /*
   * "There are no entities here", said only when it is true.
   *
   * The same :has() that hides the empty sections decides this, which is
   * what keeps the two from ever disagreeing: the message appears exactly
   * when every section on the tab has been hidden. Being a CSS question
   * rather than a piece of state also means it cannot flash before the first
   * inspection poll -- it is about whether the tab *configures* an entity,
   * not about whether a reading has arrived for one -- and a scope left in
   * YAML mode counts as content, because its entity ids are on screen even
   * though no group is.
   */
  .entities-only-empty {
    display: none;
  }

  .entities-only:not(:has(helman-entity-group, .scope-yaml)) > .entities-only-empty {
    display: block;
  }
`;

/**
 * Styles for the Training tab: depth tables and job status.
 */
export const trainingTabStyles = css`
  /*
   * The training tab's per-entity depth tables.
   *
   * A horizontal scroller of its own -- a long entity id plus six numeric
   * columns does not fit a narrow panel, and the page itself must never
   * gain a horizontal scrollbar because of one table inside it.
   */
  .training-depth-table-wrap {
    overflow-x: auto;
    margin-top: 4px;
  }

  .training-depth-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86rem;
  }

  .training-depth-table th,
  .training-depth-table td {
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--divider-color);
  }

  /* Nested two panels deep since #313 (job panel, then Diagnostics), so a
     phone has less width to give; tighter cells keep it from scrolling. */
  @media (max-width: 600px) {
    .training-depth-table th,
    .training-depth-table td {
      padding: 6px 5px;
    }
  }

  /* Only the digits hold a line. Everything else -- the prose, the entity
     ids, and these columns' own two-word headings -- wraps, so a narrow
     screen makes the table taller instead of pushing it sideways. */
  .training-depth-table th.training-depth-number,
  .training-depth-table td.training-depth-number {
    text-align: right;
  }

  .training-depth-table td.training-depth-number {
    white-space: nowrap;
  }

  .training-depth-table th {
    color: var(--secondary-text-color);
    font-weight: 600;
  }

  .training-depth-label {
    font-weight: 600;
  }

  .training-depth-entity-id {
    color: var(--secondary-text-color);
    font-size: 0.82rem;
    /* Entity ids are long and have no spaces to break at. */
    overflow-wrap: anywhere;
  }

  /* The name and id, as one target for HA's more-info dialog. A button so
     it is reachable by keyboard and announced as an action; styled back
     down to the plain two-line cell it replaces. */
  .training-depth-entity-button {
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  /* The id is as much the target as the name -- it is the part a reader
     recognises -- so both take the hover treatment, not just the heading. */
  .training-depth-entity-button:hover .training-depth-label,
  .training-depth-entity-button:hover .training-depth-entity-id,
  .training-depth-entity-button:focus-visible .training-depth-label,
  .training-depth-entity-button:focus-visible .training-depth-entity-id {
    color: var(--primary-color);
    text-decoration: underline;
  }

  .training-depth-entity-button:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: 2px;
  }

  .training-depth-unset {
    font-style: italic;
  }

  /* Entity names and ids. A share of the table rather than a width in ch,
     because the overflow-wrap: anywhere below drops the column's intrinsic
     width to a single character -- auto layout would otherwise hand the
     whole table to the prose column and break every id across four lines. */
  .training-depth-table td:first-child,
  .training-depth-table th:first-child {
    width: 26%;
  }

  /* The one column that is prose: it takes what the rest leaves and wraps
     inside it, so the table never needs horizontal scrolling. */
  .training-depth-role {
    color: var(--secondary-text-color);
  }

  /* Same hue the entity-group badge uses when a row's spliced depth falls
     short of its requirement. On the row rather than one cell since #186:
     it is the pair of columns that is short, not either one of them. The
     two cells that declare their own colour need it unset explicitly -- a
     declared value beats an inherited one whatever the selector's
     specificity, so without this the role and the entity id stay grey and
     the row reads as half-marked. */
  tr.training-depth-warn {
    color: var(--warning-color, #ffa600);
    font-weight: 600;
  }

  tr.training-depth-warn .training-depth-role,
  tr.training-depth-warn .training-depth-entity-id {
    color: inherit;
  }

  /* A collapsed Diagnostics panel's header: something inside is short or
     reported an issue. An icon, not a count -- the two sources overlap. */
  .training-attention {
    display: flex;
  }

  .training-attention-icon {
    width: 20px;
    height: 20px;
    fill: var(--warning-color, #ffa600);
  }
`;

/**
 * Styles for the Devices tab: group rows, member chips, groupings, phase board, and filter.
 */
export const devicesTabStyles = css`
  /* One group, one line: handle, name, id, short name, remove -- wrapping
     only when the card is too narrow to hold them. The columns are named
     once, in a head row, rather than labelled on every row. */
  .group-rows {
    display: grid;
    gap: 8px;
    padding: 0 16px 8px;
  }

  .group-rows-list {
    display: grid;
    gap: 8px;
  }

  .group-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .group-row > .group-name-cell {
    flex: 2 1 220px;
    min-width: 150px;
  }

  /* An id is a short slug and the short name usually an emoji or two, so
     they take what is left over rather than half the row. */
  .group-row > .group-id-cell,
  .group-row > .group-short-name-cell {
    flex: 1 1 120px;
    min-width: 100px;
    max-width: 240px;
  }

  .group-row > .list-actions {
    margin-left: auto;
    flex: 0 0 auto;
  }

  .group-row-head label {
    font-weight: 600;
    font-size: 0.93rem;
    color: var(--secondary-text-color);
  }

  /* Hold the head row's columns over the drag handle and the remove button
     below them: each is its 18px glyph plus padding. */
  .group-row-handle-spacer,
  .group-row-actions-spacer {
    flex: 0 0 auto;
    width: 32px;
  }

  /* A group's devices, on their own line under its fields. The list keeps
     a height when empty, so a device can still be dropped into it. */
  .group-members {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 32px;
    padding: 4px;
    box-sizing: border-box;
    border: 1px dashed var(--divider-color);
    border-radius: 12px;
  }

  .group-row > ha-sortable {
    flex: 1 0 100%;
  }

  .group-unassigned {
    display: grid;
    gap: 6px;
    padding: 0 16px 8px;
  }

  /* The phase board has no name row above its buckets to space them from
     the summary, so its rows take that row's top padding. */
  .phase-card > .group-rows {
    padding-top: 16px;
  }

  .member-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--divider-color);
    border-radius: 999px;
    background: var(--secondary-background-color);
    font-size: 0.93rem;
  }

  /* The whole chip is the drag surface; like the sortable handle, it takes
     touch-action: none so on touch a drag wins over page scrolling. */
  .member-chip.draggable {
    cursor: grab;
    padding-left: 4px;
    touch-action: none;
  }

  .member-chip-glyph {
    width: 16px;
    height: 16px;
    fill: var(--secondary-text-color);
  }

  .member-parent {
    color: var(--secondary-text-color);
  }

  .member-parent::before {
    content: "· ";
  }

  .grouping-name {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 16px 16px 8px;
  }

  .grouping-name-input,
  .grouping-id-input {
    font-size: 1rem;
    font-weight: var(--ha-font-weight-medium, 500);
    border-radius: 12px;
    border: 1px solid var(--divider-color);
    background: var(--secondary-background-color);
    color: var(--primary-text-color);
    padding: 8px 12px;
    max-width: 320px;
  }

  /* The Devices tab. A hidden card keeps its place in the sortable list, so
     the list's indices stay the document's; the card styles set a display,
     which would otherwise win over the hidden attribute. */
  details.device-card[hidden] {
    display: none;
  }

  .device-filter {
    justify-self: start;
  }
`;

/**
 * All styles composed for the HelmanConfigEditorPanel element.
 */
export const configEditorStyles = [
  configFormStyles,
  optimizerCardStyles,
  deviceEditorStyles,
  deviceEnergyStyles,
  hardwareProfileStyles,
  editorShellStyles,
  entitiesOnlyStyles,
  trainingTabStyles,
  devicesTabStyles,
];
