import { test, expect } from "@playwright/test";
import { EDITOR_BUNDLE, CARD_BUNDLE, loadBundle } from "./support/card-page";
import { configDoc, treeNode, treePayload } from "./support/payload-builders";
import { readFileSync } from "node:fs";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import type { TreeItemDTO } from "../cards/helman-api";
import { installMockHass } from "./support/mock-hass";

const ORIGIN = "http://helman.test";
const CARD_MODULE_URL = "/helman_frontend/helman-card.js?v=9.9.9";

const BASE_CONFIG = configDoc({
  energy_nodes: {
    solar: {
      max_power: 5000,
      forecast: {
        total_energy_entity_id: "sensor.solar_energy",
      },
    },
    house: {
      forecast: {
        total_energy_entity_id: "sensor.house_energy",
      },
    },
  },
  devices: {
    consumers: [
      {
        id: "dishwasher",
        name: "Dishwasher",
        schedulable: true,
        consumption: {
          energy_entity_id: "sensor.dishwasher_energy",
          projection: { strategy: "history_average", lookback_days: 21 },
        },
      },
    ],
  },
  training: {
    house_consumption: { min_history_days: 14, training_window_days: 56 },
    solar_bias: { min_history_days: 10, max_training_window_days: 90 },
  },
});

function dto(overrides: Partial<TreeItemDTO>) {
  return treeNode({ childrenFullWidth: true, ...overrides });
}

const DEVICE_TREE = treePayload({
  sources: [],
  consumers: [
    dto({
      id: "house",
      displayName: "House",
      children: [
        dto({
          id: "sensor.dishwasher_energy",
          displayName: "Dishwasher",
          energyEntityId: "sensor.dishwasher_energy",
        }),
      ],
    }),
  ],
  consumptionTotalSensorId: null,
  productionTotalSensorId: null,
  uiConfig: { device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
});

async function openTab(page: any, label: string): Promise<void> {
  await page.locator(".tabs button", { hasText: label }).click();
}

async function openTabSection(page: any, label: string): Promise<void> {
  await page
    .locator("helman-config-editor-panel")
    .locator("details.section-card", {
      has: page.locator(":scope > summary .section-summary-label", { hasText: label }),
    })
    .evaluate((details: any) => { details.open = true; });
}

function applianceRows(page: any) {
  return page
    .locator("details.section-card", {
      has: page.locator('helman-training-job-status[data-job="appliance_energy"]'),
    })
    .locator(".training-depth-table tbody tr");
}

test("F1: help dialog opens and closes reactively via @state() _helpDialog", async ({
  page,
}) => {
  await loadBundle(page, "helman-config-editor-panel", EDITOR_BUNDLE);

  await page.evaluate(({ config }: { config: unknown }) => {
    const w = window as any;
    w.__stored = JSON.parse(JSON.stringify(config));
    const element = document.createElement(
      "helman-config-editor-panel",
    ) as HTMLElement & Record<string, unknown>;
    element.hass = {
      language: "en",
      locale: { language: "en" },
      user: { is_admin: true },
      connection: window.__mockHass().connection,
      callWS: window.__mockHass({
        "helman/get_config": async () => JSON.parse(JSON.stringify(w.__stored)),
        "helman/inspect_entities": async () => ({ results: [] }),
      }).callWS,
    };
    document.body.appendChild(element);
  }, { config: BASE_CONFIG as unknown });

  const panel = page.locator("helman-config-editor-panel");
  await expect(panel).toBeVisible();

  // Initially help overlay is not mounted
  const helpOverlay = panel.locator(".help-overlay");
  await expect(helpOverlay).toHaveCount(0);

  // Open the Solar section on Energy nodes tab so its max_power field is visible
  await openTabSection(page, "Solar");

  // Click a help button
  const helpBtn = panel.locator("details[open] .help-btn").first();
  await expect(helpBtn).toBeVisible();
  await helpBtn.click();

  // Dialog must open reactively
  await expect(helpOverlay).toHaveCount(1);
  const helpDialog = helpOverlay.locator(".help-dialog");
  await expect(helpDialog).toBeVisible();

  // Close the dialog using the close button
  const closeBtn = helpDialog.locator("button.help-dialog-close");
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();

  // Dialog must close reactively
  await expect(helpOverlay).toHaveCount(0);
});

test("F2: training appliance table device names become clickable after device tree loads without incidental updates", async ({
  page,
}) => {
  const card = readFileSync(CARD_BUNDLE, "utf8");
  await page.route(`${ORIGIN}/`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.route(`${ORIGIN}/helman_frontend/*`, (route) =>
    route.fulfill({ contentType: "text/javascript", body: card }),
  );
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: HA_DIALOG_STUB });
  await installMockHass(page);
  await page.addScriptTag({ path: EDITOR_BUNDLE, type: "module" });
  await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

  await page.evaluate(
    ({ config, cardModuleUrl }: { config: unknown; cardModuleUrl: string }) => {
      const w = window as any;
      let resolveDeviceTree: (val: any) => void;
      w.__deviceTreePromise = new Promise((resolve) => {
        resolveDeviceTree = resolve;
      });
      w.__resolveDeviceTree = (val: any) => resolveDeviceTree(val);

      const element = document.createElement(
        "helman-config-editor-panel",
      ) as HTMLElement & Record<string, unknown>;
      element.panel = { config: { card_module_url: cardModuleUrl } };
      element.hass = {
        language: "en",
        locale: { language: "en" },
        user: { is_admin: true },
        connection: window.__mockHass().connection,
        callWS: window.__mockHass({
          "helman/get_config": async () => JSON.parse(JSON.stringify(config)),
          "helman/get_device_tree": async () => w.__deviceTreePromise,
          "helman/inspect_entities": async () => ({ results: [] }),
          "helman/training/status": async () => null,
        }).callWS,
      };
      document.body.appendChild(element);
    },
    { config: BASE_CONFIG as unknown, cardModuleUrl: CARD_MODULE_URL },
  );

  // Switch to the Training tab
  await openTab(page, "Training");

  // Wait for rows to exist
  const rows = applianceRows(page);
  await expect(rows).toHaveCount(1);

  // While device tree is pending, the device name is rendered as plain text label, NOT as a button
  const button = rows.first().locator('button[aria-label="Show details of Dishwasher"]');
  await expect(button).toHaveCount(0);
  await expect(rows.first().locator(".training-depth-label").first()).toHaveText("Dishwasher");

  // Now resolve the device tree promise. Without any other event or inspection poll,
  // the controller's deviceTreeItems setter must trigger host.requestUpdate()
  await page.evaluate(({ tree }: { tree: unknown }) => {
    (window as any).__resolveDeviceTree(tree);
  }, { tree: DEVICE_TREE as unknown });

  // The button must now appear reactively
  await expect(button).toHaveCount(1);
  await expect(button).toContainText("Dishwasher");
});

test("F3: reload asks for confirmation when clean config has blocking YAML errors", async ({
  page,
}) => {
  await loadBundle(page, "helman-config-editor-panel", EDITOR_BUNDLE);

  await page.evaluate(({ config }: { config: unknown }) => {
    if (!customElements.get("ha-yaml-editor")) {
      customElements.define("ha-yaml-editor", class extends HTMLElement {
        connectedCallback() {
          this.style.display = "block";
          this.style.height = "100px";
        }
      });
    }
    const w = window as any;
    w.__stored = JSON.parse(JSON.stringify(config));
    const element = document.createElement(
      "helman-config-editor-panel",
    ) as HTMLElement & Record<string, unknown>;
    element.hass = {
      language: "en",
      locale: { language: "en" },
      user: { is_admin: true },
      connection: window.__mockHass().connection,
      callWS: window.__mockHass({
        "helman/get_config": async () => JSON.parse(JSON.stringify(w.__stored)),
        "helman/inspect_entities": async () => ({ results: [] }),
      }).callWS,
    };
    document.body.appendChild(element);
  }, { config: BASE_CONFIG as unknown });

  const panel = page.locator("helman-config-editor-panel");
  await expect(panel).toBeVisible();

  // Switch document scope to YAML mode
  const docYamlBtn = panel.locator(".header .actions .mode-toggle button", { hasText: "YAML" });
  await expect(docYamlBtn).toBeVisible();
  await docYamlBtn.click();

  // Find the mounted ha-yaml-editor
  const yamlEditor = panel.locator("ha-yaml-editor").first();
  await expect(yamlEditor).toBeVisible();

  // Dispatch invalid YAML event (e.g. parse error)
  await yamlEditor.evaluate((editor) => {
    editor.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { isValid: false, errorMsg: "Invalid YAML syntax" },
        bubbles: true,
        composed: true,
      }),
    );
  });

  // Verify YAML error is visible and config is not marked dirty
  const errorMsg = panel.locator(".yaml-error");
  await expect(errorMsg).toContainText("Invalid YAML syntax");
  await expect(panel.locator(".status-row .badge", { hasText: "Unsaved changes" })).toHaveCount(0);

  // Set up dialog handler to verify confirmation prompt
  let dialogMessage = "";
  page.once("dialog", async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.dismiss();
  });

  // Click Reload button
  const reloadBtn = panel.locator(".header .actions button", { hasText: "Reload stored config" });
  await reloadBtn.click();

  // Must have prompted with the discard confirmation message
  expect(dialogMessage).toBe("Discard unsaved changes and reload the stored config?");
});

