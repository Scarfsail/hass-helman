/**
 * Home Assistant's own elements, borrowed from the frontend hosting us.
 *
 * HA ships its panels as lazily-loaded chunks and registers their custom
 * elements as a side effect of loading one. Nothing exports them, so the only
 * way to reach `ha-form`, `ha-yaml-editor` or the trace renderer from a card is
 * to ask a throwaway router to load the chunk that defines them and then wait
 * for the tag to appear. That is what every loader here does; they differ only
 * in which chunk they walk to and which tags they wait for.
 *
 * Shared by both bundles: the config editor builds HA's condition builder out
 * of `ha-selector`, and the schedule card draws a condition *trace* with HA's
 * own trace components. Lives under `cards/shared` because that is the one
 * directory both vite entry points compile.
 */

import type { LocalizeFunc } from "../../hass-frontend/src/common/translations/localize";
import type { HomeAssistant } from "../../hass-frontend/src/types";

const REQUIRED_ELEMENTS = ["ha-entity-picker", "ha-form", "ha-formfield", "ha-switch"] as const;
const YAML_EDITOR_TAG = "ha-yaml-editor";
const TRACE_ELEMENTS = ["hat-script-graph", "ha-trace-path-details"] as const;

/**
 * Wrap a chunk walk so it runs at most once and never twice at a time.
 *
 * Every loader wants the same three things: skip the work when the tags are
 * already registered, share one in-flight attempt between concurrent callers,
 * and forget a failed attempt so a later caller may retry. Writing that out per
 * loader is what made this file three copies of one idea.
 */
function loadOnce(
  tags: readonly string[],
  walk: () => Promise<void>,
): () => Promise<void> {
  let pending: Promise<void> | null = null;

  return async (): Promise<void> => {
    if (tags.every((tag) => customElements.get(tag))) {
      return;
    }

    if (pending === null) {
      pending = (async () => {
        await walk();
        // The walk only *starts* the chunk; registration is what we are after.
        await Promise.all(tags.map((tag) => customElements.whenDefined(tag)));
      })();
    }

    try {
      await pending;
    } catch (error) {
      pending = null;
      throw error;
    }
  };
}

/**
 * Walk to the automation panel, which is where the form elements come from.
 *
 * `partial-panel-resolver` resolves a *panel* to its chunk, and `ha-panel-config`
 * is itself a router whose `automation` route loads the editor. `routerOptions`
 * is `protected`, hence the cast: this is deliberate use of HA's internals, and
 * the cast is the honest way to say so.
 */
async function loadAutomationPanel(): Promise<void> {
  await customElements.whenDefined("partial-panel-resolver");

  const partialPanelResolver = document.createElement(
    "partial-panel-resolver",
  ) as unknown as {
    hass: unknown;
    _updateRoutes: () => void;
    routerOptions: { routes: { tmp: { load: () => Promise<void> } } };
  };

  partialPanelResolver.hass = {
    panels: [{ url_path: "tmp", component_name: "config" }],
  };
  partialPanelResolver._updateRoutes();
  await partialPanelResolver.routerOptions.routes.tmp.load();

  await customElements.whenDefined("ha-panel-config");

  const configPanelResolver = document.createElement("ha-panel-config") as unknown as {
    routerOptions: { routes: { automation: { load: () => Promise<void> } } };
  };
  await configPanelResolver.routerOptions.routes.automation.load();
}

export const loadHaForm = loadOnce(REQUIRED_ELEMENTS, loadAutomationPanel);

const loadTraceChunk = loadOnce(TRACE_ELEMENTS, async () => {
  await loadAutomationPanel();
  await customElements.whenDefined("ha-config-automation");

  const automationRouter = document.createElement("ha-config-automation") as unknown as {
    routerOptions: { routes: { trace: { load: () => Promise<void> } } };
  };
  await automationRouter.routerOptions.routes.trace.load();
});

/**
 * The trace renderer: `hat-script-graph` and `ha-trace-path-details`.
 *
 * One router deeper than the form elements. `ha-config-automation` is the
 * automation panel's own router, and its `trace` route loads
 * `ha-automation-trace`, which imports both components as a side effect.
 *
 * The chunk is only half of it. `ha-trace-path-details` writes almost every
 * visible string through the translations, and a dashboard has loaded none of
 * them because a dashboard is not that panel:
 *
 * - the tab names, the step heading and the "executed at" line come from the
 *   `config` *fragment*;
 * - the condition's own name comes from the `conditions` *backend* category,
 *   without which `describeCondition` falls through to "unknown condition" for
 *   every platform condition.
 *
 * Loading the chunk brings neither. Measured in a live Lovelace view, the pane
 * rendered exactly one piece of visible text -- the raw `result:` block -- until
 * both were loaded; HA's own trace panel loads them for the same reason
 * (`ha-automation-trace.ts:323`). Both are cached, so asking on every open
 * costs nothing.
 *
 * Returns the *refreshed* localize, which the caller must hand to the trace
 * components rather than reusing the one on its own `hass`. Loading resources
 * replaces the `hass` object on `<home-assistant>`; a reference captured before
 * that -- which is what a card holds while a dialog is open -- keeps the old
 * localize and goes on resolving every one of those keys to `""`. Measured:
 * after the load, `<home-assistant>.hass` localizes `trace.tabs.step_config` to
 * "Krok nastavení" while the captured one still answers "". Awaited in sequence
 * so the returned localize is the one that saw both loads land.
 */
export async function loadHaTrace(hass: HomeAssistant): Promise<LocalizeFunc> {
  await Promise.all([loadTraceChunk(), hass.loadFragmentTranslation("config")]);
  return hass.loadBackendTranslation("conditions");
}

/**
 * `ha-yaml-editor`, which lives in developer tools rather than in config.
 */
export const loadHaYamlEditor = loadOnce([YAML_EDITOR_TAG], async () => {
  await customElements.whenDefined("partial-panel-resolver");

  const partialPanelResolver = document.createElement(
    "partial-panel-resolver",
  ) as unknown as {
    getRoutes: (panels: { component_name: string; url_path: string }[]) => {
      routes?: Record<string, { load?: () => Promise<void> }>;
    };
  };

  const routes = partialPanelResolver.getRoutes([
    { component_name: "developer-tools", url_path: "tmp" },
  ]);
  await routes.routes?.tmp?.load?.();

  await customElements.whenDefined("developer-tools-router");

  const developerToolsRouter = document.createElement(
    "developer-tools-router",
  ) as unknown as {
    routerOptions?: { routes?: { service?: { load?: () => Promise<void> } } };
  };
  await developerToolsRouter.routerOptions?.routes?.service?.load?.();
});
