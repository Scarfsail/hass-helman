import type { ReactiveController } from "lit";
import { html, type TemplateResult } from "lit";
import { SECTION_SCOPE_IDS } from "../config-editor-scopes";
import {
  renderBooleanField,
  renderOptionalNumberField,
} from "../../cards/shared/config/form-fields";
import type { HelmanConfigEditorPanel } from "../helman-config-editor";

/**
 * Controller for the Visualization tab. Holds tab state and hooks into the host's lifecycle.
 */
export class VisualizationTabController implements ReactiveController {
  constructor(public readonly host: HelmanConfigEditorPanel) {
    this.host.addController(this);
  }

  hostConnected(): void {}
}

/**
 * Render module for the Visualization tab.
 */
export function renderVisualizationTab(
  host: HelmanConfigEditorPanel,
  _controller: VisualizationTabController,
): TemplateResult {
  return html`
    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.visualization.card_labels_and_history,
      html`
        <div class="field-grid">
          ${renderOptionalNumberField(
            host,
            ["visualization", "history_buckets"],
            "editor.fields.history_buckets",
            "editor.helpers.history_buckets",
            "editor.help.history_buckets",
          )}
          ${renderOptionalNumberField(
            host,
            ["visualization", "history_bucket_duration"],
            "editor.fields.history_bucket_duration",
            "editor.helpers.history_bucket_duration",
            "editor.help.history_bucket_duration",
          )}
          ${renderBooleanField(
            host,
            ["visualization", "show_empty_groups"],
            "editor.fields.show_empty_groups",
            false,
          )}
          ${renderBooleanField(
            host,
            ["visualization", "show_others_group"],
            "editor.fields.show_others_group",
            true,
          )}
        </div>
      `,
      { initialOpen: false },
    )}
  `;
}
