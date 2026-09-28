import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";

import { asJsonArray, asJsonObject } from "../cards/shared/config/config-document";
import { consumerGroups, isSchedulable, type DeviceFilter, type GroupedDeviceEntry } from "../cards/shared/config/devices";
import type { EntityInspectionResult } from "../cards/shared/config/entity-group";
import { stringValue } from "../cards/shared/config/form-fields";
import type { JsonObject, PathSegment } from "../cards/shared/config/types";
import { defineOnce } from "../cards/shared/define-once";
import { deviceName, type DeviceConfigChangedDetail } from "../cards/shared/devices/helman-device-editor";

/** The rules of the grouped view; the host adopts them next to `configFormStyles`. */
export const deviceGroupingViewStyles = css`
  .grouping-section-rows {
    display: grid;
    gap: 8px;
  }

  .grouping-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .grouping-row .card-title {
    min-width: 0;
  }

  .grouping-row select {
    flex-shrink: 0;
    max-width: 50%;
  }
`;

/**
 * The Devices tab's consumers grouped by one grouping: a section per group,
 * in the grouping's order, then "Unassigned", every consumer listed flat
 * under its effective group -- children included -- with a select that
 * reassigns it.
 *
 * Membership is all it edits; the list view keeps the full device card. Like
 * `helman-device-editor` it renders into its host's tree, so the panel's form
 * styles apply, and it reports an edit as `device-config-changed` rather than
 * applying it.
 */
export class HelmanDeviceGroupingView extends LitElement {
  /** The whole config document. Not mutated -- edits are reported, not applied. */
  @property({ attribute: false }) config: JsonObject | null = null;

  /** The `devices.groupings` entry the consumers are grouped by. */
  @property({ attribute: false }) grouping: JsonObject = {};

  @property({ attribute: false }) localize: (key: string) => string = (key) => key;

  /** The host's entity readings, which carry each device's resolved name. */
  @property({ attribute: false })
  inspections: Readonly<Record<string, EntityInspectionResult>> = {};

  /** The Devices tab's filter; a row is shown when its own device matches. */
  @property({ attribute: false }) filter: DeviceFilter = "all";

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult {
    const groupingId = stringValue(this.grouping.id);
    const groups = (asJsonArray(this.grouping.groups) ?? []).flatMap((group) => {
      const object = asJsonObject(group);
      return object ? [object] : [];
    });
    const groupIds = new Set(groups.map((group) => stringValue(group.id)));
    const entries = consumerGroups(this.config, groupingId).filter(
      ({ device }) => this.filter === "all" || isSchedulable(device) === (this.filter === "schedulable"),
    );
    const section = (id: string, title: string, members: GroupedDeviceEntry[]) => html`
      <div class="list-card grouping-section" data-group-id=${id}>
        <div class="card-title"><strong>${title}</strong></div>
        ${members.length > 0
          ? html`<div class="grouping-section-rows">
              ${repeat(
                members,
                (entry) => entry.path.join("."),
                (entry) => this._renderRow(entry, groupingId, groups, groupIds),
              )}
            </div>`
          : nothing}
      </div>
    `;
    return html`
      <div class="list-stack device-grouping-view">
        ${groups.map((group) => {
          const id = stringValue(group.id);
          return section(
            id,
            `${stringValue(group.name)} (${stringValue(group.short_name)})`,
            entries.filter((entry) => entry.group === id),
          );
        })}
        ${section(
          "",
          this.t("editor.device_view.unassigned"),
          // An id the grouping does not have fails validation; until it is
          // fixed the device shows here rather than nowhere.
          entries.filter((entry) => entry.group === null || !groupIds.has(entry.group)),
        )}
      </div>
    `;
  }

  private _renderRow(
    { device, parent, path }: GroupedDeviceEntry,
    groupingId: string,
    groups: JsonObject[],
    groupIds: ReadonlySet<string>,
  ): TemplateResult {
    const own = stringValue(asJsonObject(device.groups)?.[groupingId]);
    // A parent's path is its child's path minus `children, index`.
    const parentPath = path.slice(0, -2);
    const label = this.t("editor.device_view.group");
    return html`
      <div class="grouping-row" data-device-id=${stringValue(device.id)}>
        <div class="card-title">
          <strong>${deviceName(this, this.inspections, device, path)}</strong>
          ${parent ? html`<span class="card-subtitle">${deviceName(this, this.inspections, parent, parentPath)}</span>` : nothing}
        </div>
        <select
          class="group-select"
          title=${label}
          aria-label=${label}
          .value=${live(own)}
          @change=${(event: Event) =>
            this._assign(device, path, groupingId, (event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${own === ""}>
            ${this.t(parent ? "editor.device_view.same_as_parent" : "editor.device_view.none")}
          </option>
          ${groups.map((group) => {
            const id = stringValue(group.id);
            return html`<option value=${id} ?selected=${own === id}>${stringValue(group.name)}</option>`;
          })}
          ${own && !groupIds.has(own)
            ? // An id the grouping lacks (validation fails it): shown as is, so the picker matches the config.
              html`<option value=${own} selected>${own}</option>`
            : nothing}
        </select>
      </div>
    `;
  }

  /** Sets or unsets `groups.<groupingId>`, dropping a `groups` map left empty. */
  private _assign(device: JsonObject, path: PathSegment[], groupingId: string, groupId: string): void {
    const groups = { ...(asJsonObject(device.groups) ?? {}) };
    if (groupId) groups[groupingId] = groupId;
    else delete groups[groupingId];
    this.dispatchEvent(
      new CustomEvent<DeviceConfigChangedDetail>("device-config-changed", {
        detail: { path: [...path, "groups"], value: Object.keys(groups).length > 0 ? groups : undefined },
      }),
    );
  }

  t(key: string): string {
    return this.localize(key);
  }
}

defineOnce("helman-device-grouping-view", HelmanDeviceGroupingView);
