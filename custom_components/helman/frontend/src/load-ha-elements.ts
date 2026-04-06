const REQUIRED_ELEMENTS = ["ha-entity-picker", "ha-formfield", "ha-switch"] as const;
const YAML_EDITOR_TAG = "ha-yaml-editor";

let loadHaFormPromise: Promise<void> | null = null;
let loadHaYamlEditorPromise: Promise<void> | null = null;

export const loadHaForm = async (): Promise<void> => {
  if (REQUIRED_ELEMENTS.every((tagName) => customElements.get(tagName))) {
    return;
  }

  if (loadHaFormPromise) {
    return loadHaFormPromise;
  }

  loadHaFormPromise = (async () => {
    await customElements.whenDefined("partial-panel-resolver");

    const partialPanelResolver = document.createElement(
      "partial-panel-resolver",
    ) as {
      hass: unknown;
      _updateRoutes: () => void;
      routerOptions: {
        routes: {
          tmp: {
            load: () => Promise<void>;
          };
        };
      };
    };

    partialPanelResolver.hass = {
      panels: [
        {
          url_path: "tmp",
          component_name: "config",
        },
      ],
    };
    partialPanelResolver._updateRoutes();
    await partialPanelResolver.routerOptions.routes.tmp.load();

    await customElements.whenDefined("ha-panel-config");

    const configPanelResolver = document.createElement("ha-panel-config") as {
      routerOptions: {
        routes: {
          automation: {
            load: () => Promise<void>;
          };
        };
      };
    };
    await configPanelResolver.routerOptions.routes.automation.load();
    await Promise.all(REQUIRED_ELEMENTS.map((tagName) => customElements.whenDefined(tagName)));
  })();

  try {
    await loadHaFormPromise;
  } catch (error) {
    loadHaFormPromise = null;
    throw error;
  }
};

export const loadHaYamlEditor = async (): Promise<void> => {
  if (customElements.get(YAML_EDITOR_TAG)) {
    return;
  }

  if (loadHaYamlEditorPromise) {
    return loadHaYamlEditorPromise;
  }

  loadHaYamlEditorPromise = (async () => {
    await customElements.whenDefined("partial-panel-resolver");

    const partialPanelResolver = document.createElement(
      "partial-panel-resolver",
    ) as {
      getRoutes: (panels: Array<{ component_name: string; url_path: string }>) => {
        routes?: Record<string, { load?: () => Promise<void> }>;
      };
    };

    const routes = partialPanelResolver.getRoutes([
      {
        component_name: "developer-tools",
        url_path: "tmp",
      },
    ]);
    await routes.routes?.tmp?.load?.();

    await customElements.whenDefined("developer-tools-router");

    const developerToolsRouter = document.createElement(
      "developer-tools-router",
    ) as {
      routerOptions?: {
        routes?: {
          service?: {
            load?: () => Promise<void>;
          };
        };
      };
    };
    await developerToolsRouter.routerOptions?.routes?.service?.load?.();
    await customElements.whenDefined(YAML_EDITOR_TAG);
  })();

  try {
    await loadHaYamlEditorPromise;
  } catch (error) {
    loadHaYamlEditorPromise = null;
    throw error;
  }
};
