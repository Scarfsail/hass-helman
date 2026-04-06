const REQUIRED_ELEMENTS = ["ha-entity-picker", "ha-formfield", "ha-switch"] as const;

let loadHaFormPromise: Promise<void> | null = null;

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
