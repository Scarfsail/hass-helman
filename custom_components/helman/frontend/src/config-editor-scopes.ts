import {
  createDocumentScopeAdapter,
  createPathScopeAdapter,
  createProjectionScopeAdapter,
  type ScopeProjectionMember,
  type ScopeYamlAdapter,
} from "./config-scope-adapters";

export type EditorMode = "visual" | "yaml";
export type TabId =
  | "general"
  | "power_devices"
  | "scheduler"
  | "automation"
  | "appliances";

export type ScopeId =
  | "document"
  | "tab:general"
  | "tab:power_devices"
  | "tab:scheduler"
  | "tab:automation"
  | "tab:appliances"
  | "section:general.core_labels_and_history"
  | "section:general.device_label_text"
  | "section:power_devices.house"
  | "section:power_devices.solar"
  | "section:power_devices.battery"
  | "section:power_devices.grid"
  | "section:scheduler.schedule_control_mapping"
  | "section:automation.settings"
  | "section:automation.optimizer_pipeline"
  | "section:appliances.configured_appliances";

export interface EditorScope {
  id: ScopeId;
  kind: "document" | "tab" | "section";
  parentId?: ScopeId;
  tabId?: TabId;
  labelKey: string;
  adapter: ScopeYamlAdapter;
}

// MDI icon paths for tabs and sections
export const TAB_ICONS: Record<TabId, string> = {
  general: "M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.95C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.95L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z",
  power_devices: "M7,2V13H10V22L17,11H13L17,2H7Z",
  scheduler: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z",
  automation: "M4,7H13V9H4V7M4,11H13V13H4V11M4,15H10V17H4V15M14.94,13.5L17,17.07L19.06,13.5L17,9.93L14.94,13.5M17,7C17.34,7 17.67,7.04 18,7.09L18.41,5.11H15.59L16,7.09C16.33,7.04 16.66,7 17,7M10.25,8.66L11.92,9.65C12.28,9.13 12.72,8.69 13.24,8.33L12.25,6.66L10.25,8.66M13.24,18.67C12.72,18.31 12.28,17.87 11.92,17.35L10.25,18.34L12.25,20.34L13.24,18.67M17,20C16.66,20 16.33,19.96 16,19.91L15.59,21.89H18.41L18,19.91C17.67,19.96 17.34,20 17,20M20.76,18.67L21.75,20.34L23.75,18.34L22.08,17.35C21.72,17.87 21.28,18.31 20.76,18.67M20.76,8.33C21.28,8.69 21.72,9.13 22.08,9.65L23.75,8.66L21.75,6.66L20.76,8.33Z",
  appliances: "M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M7,7V9H17V7H7M7,11V13H17V11H7M7,15V17H14V15H7Z",
};

export const SECTION_ICONS: Record<string, string> = {
  "section:general.core_labels_and_history": "M14,17H7V15H14M17,13H7V11H17M17,9H7V7H17M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3Z",
  "section:general.device_label_text": "M5.5,7A1.5,1.5 0 0,1 4,5.5A1.5,1.5 0 0,1 5.5,4A1.5,1.5 0 0,1 7,5.5A1.5,1.5 0 0,1 5.5,7M21.41,11.58L12.41,2.58C12.05,2.22 11.55,2 11,2H4C2.89,2 2,2.89 2,4V11C2,11.55 2.22,12.05 2.59,12.41L11.58,21.41C11.95,21.77 12.45,22 13,22C13.55,22 14.05,21.77 14.41,21.41L21.41,14.41C21.77,14.05 22,13.55 22,13C22,12.44 21.77,11.94 21.41,11.58Z",
  "section:power_devices.house": "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z",
  "section:power_devices.solar": "M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.5,14.77 5.95,15.5C6.37,16.24 6.91,16.86 7.5,17.37L3.36,17M20.65,7L18.88,10.79C18.74,10 18.5,9.23 18.06,8.5C17.64,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.5,17.36C17.09,16.85 17.63,16.22 18.05,15.5C18.5,14.75 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.82,19 13.63,18.83 14.37,18.56L12,22Z",
  "section:power_devices.battery": "M15.67,4H14V2H10V4H8.33C7.6,4 7,4.6 7,5.33V20.67C7,21.4 7.6,22 8.33,22H15.67C16.4,22 17,21.4 17,20.67V5.33C17,4.6 16.4,4 15.67,4M13,18H11V16H13V18M13,14H11V9H13V14Z",
  "section:power_devices.grid": "M20,14A2,2 0 0,1 22,16V20A2,2 0 0,1 20,22H4A2,2 0 0,1 2,20V16A2,2 0 0,1 4,14H11V12H9V10H11V8H9V6H11V4A2,2 0 0,1 13,4V6H15V8H13V10H15V12H13V14H20M4,16V20H20V16H4M6,17H8V19H6V17M9,17H11V19H9V17M12,17H14V19H12V17Z",
  "section:scheduler.schedule_control_mapping": "M16.53,11.06L15.47,10L10.59,14.88L8.47,12.76L7.41,13.82L10.59,17L16.53,11.06M19,3H18V1H16V3H8V1H6V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M19,19H5V9H19V19M19,7H5V5H19V7Z",
  "section:automation.settings": "M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.95C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.95L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z",
  "section:automation.optimizer_pipeline": "M4,7H20V9H4V7M4,11H20V13H4V11M4,15H14V17H4V15",
  "section:appliances.configured_appliances": "M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M7,7V9H17V7H7M7,11V13H12V11H7Z",
};

export const TABS: Array<{ id: TabId; labelKey: string }> = [
  { id: "general", labelKey: "editor.tabs.general" },
  { id: "power_devices", labelKey: "editor.tabs.power_devices" },
  { id: "scheduler", labelKey: "editor.tabs.scheduler" },
  { id: "automation", labelKey: "editor.tabs.automation" },
  { id: "appliances", labelKey: "editor.tabs.appliances" },
];

export const TAB_SECTIONS: Record<string, TabId> = {
  general: "general",
  power_devices: "power_devices",
  scheduler_control: "scheduler",
  automation: "automation",
  appliances: "appliances",
  root: "general",
};

export const DOCUMENT_SCOPE_ID = "document" as const;

export const TAB_SCOPE_IDS = {
  general: "tab:general",
  power_devices: "tab:power_devices",
  scheduler: "tab:scheduler",
  automation: "tab:automation",
  appliances: "tab:appliances",
} as const satisfies Record<TabId, ScopeId>;

export const SECTION_SCOPE_IDS = {
  general: {
    core_labels_and_history: "section:general.core_labels_and_history",
    device_label_text: "section:general.device_label_text",
  },
  power_devices: {
    house: "section:power_devices.house",
    solar: "section:power_devices.solar",
    battery: "section:power_devices.battery",
    grid: "section:power_devices.grid",
  },
  scheduler: {
    schedule_control_mapping: "section:scheduler.schedule_control_mapping",
  },
  automation: {
    settings: "section:automation.settings",
    optimizer_pipeline: "section:automation.optimizer_pipeline",
  },
  appliances: {
    configured_appliances: "section:appliances.configured_appliances",
  },
} as const;

const GENERAL_PROJECTION_KEYS = [
  "history_buckets",
  "history_bucket_duration",
  "sources_title",
  "consumers_title",
  "groups_title",
  "others_group_label",
  "power_sensor_name_cleaner_regex",
  "show_empty_groups",
  "show_others_group",
  "device_label_text",
] as const;

const CORE_LABELS_AND_HISTORY_KEYS = GENERAL_PROJECTION_KEYS.filter(
  (key) => key !== "device_label_text",
);

const EMPTY_OBJECT = {};
const EMPTY_ARRAY = [];

const GENERAL_PROJECTION_MEMBERS =
  createRootProjectionMembers(GENERAL_PROJECTION_KEYS);
const CORE_LABELS_AND_HISTORY_MEMBERS = createRootProjectionMembers(
  CORE_LABELS_AND_HISTORY_KEYS,
);
const AUTOMATION_SETTINGS_MEMBERS = [
  {
    yamlKey: "enabled",
    documentPath: ["automation", "enabled"],
  },
] satisfies ScopeProjectionMember[];

export const EDITOR_SCOPES = {
  [DOCUMENT_SCOPE_ID]: {
    id: DOCUMENT_SCOPE_ID,
    kind: "document",
    labelKey: "editor.title",
    adapter: createDocumentScopeAdapter(),
  },
  [TAB_SCOPE_IDS.general]: {
    id: TAB_SCOPE_IDS.general,
    kind: "tab",
    parentId: DOCUMENT_SCOPE_ID,
    tabId: "general",
    labelKey: "editor.tabs.general",
    adapter: createProjectionScopeAdapter(GENERAL_PROJECTION_MEMBERS),
  },
  [TAB_SCOPE_IDS.power_devices]: {
    id: TAB_SCOPE_IDS.power_devices,
    kind: "tab",
    parentId: DOCUMENT_SCOPE_ID,
    tabId: "power_devices",
    labelKey: "editor.tabs.power_devices",
    adapter: createPathScopeAdapter(["power_devices"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [TAB_SCOPE_IDS.scheduler]: {
    id: TAB_SCOPE_IDS.scheduler,
    kind: "tab",
    parentId: DOCUMENT_SCOPE_ID,
    tabId: "scheduler",
    labelKey: "editor.tabs.scheduler",
    adapter: createPathScopeAdapter(["scheduler"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [TAB_SCOPE_IDS.automation]: {
    id: TAB_SCOPE_IDS.automation,
    kind: "tab",
    parentId: DOCUMENT_SCOPE_ID,
    tabId: "automation",
    labelKey: "editor.tabs.automation",
    adapter: createPathScopeAdapter(["automation"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [TAB_SCOPE_IDS.appliances]: {
    id: TAB_SCOPE_IDS.appliances,
    kind: "tab",
    parentId: DOCUMENT_SCOPE_ID,
    tabId: "appliances",
    labelKey: "editor.tabs.appliances",
    adapter: createPathScopeAdapter(["appliances"], {
      emptyValue: EMPTY_ARRAY,
      rootKind: "array",
    }),
  },
  [SECTION_SCOPE_IDS.general.core_labels_and_history]: {
    id: SECTION_SCOPE_IDS.general.core_labels_and_history,
    kind: "section",
    parentId: TAB_SCOPE_IDS.general,
    tabId: "general",
    labelKey: "editor.sections.core_labels_and_history",
    adapter: createProjectionScopeAdapter(CORE_LABELS_AND_HISTORY_MEMBERS),
  },
  [SECTION_SCOPE_IDS.general.device_label_text]: {
    id: SECTION_SCOPE_IDS.general.device_label_text,
    kind: "section",
    parentId: TAB_SCOPE_IDS.general,
    tabId: "general",
    labelKey: "editor.sections.device_label_text",
    adapter: createPathScopeAdapter(["device_label_text"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [SECTION_SCOPE_IDS.power_devices.house]: {
    id: SECTION_SCOPE_IDS.power_devices.house,
    kind: "section",
    parentId: TAB_SCOPE_IDS.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.house",
    adapter: createPathScopeAdapter(["power_devices", "house"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [SECTION_SCOPE_IDS.power_devices.solar]: {
    id: SECTION_SCOPE_IDS.power_devices.solar,
    kind: "section",
    parentId: TAB_SCOPE_IDS.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.solar",
    adapter: createPathScopeAdapter(["power_devices", "solar"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [SECTION_SCOPE_IDS.power_devices.battery]: {
    id: SECTION_SCOPE_IDS.power_devices.battery,
    kind: "section",
    parentId: TAB_SCOPE_IDS.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.battery",
    adapter: createPathScopeAdapter(["power_devices", "battery"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [SECTION_SCOPE_IDS.power_devices.grid]: {
    id: SECTION_SCOPE_IDS.power_devices.grid,
    kind: "section",
    parentId: TAB_SCOPE_IDS.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.grid",
    adapter: createPathScopeAdapter(["power_devices", "grid"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [SECTION_SCOPE_IDS.scheduler.schedule_control_mapping]: {
    id: SECTION_SCOPE_IDS.scheduler.schedule_control_mapping,
    kind: "section",
    parentId: TAB_SCOPE_IDS.scheduler,
    tabId: "scheduler",
    labelKey: "editor.sections.schedule_control_mapping",
    adapter: createPathScopeAdapter(["scheduler", "control"], {
      emptyValue: EMPTY_OBJECT,
      rootKind: "object",
    }),
  },
  [SECTION_SCOPE_IDS.automation.settings]: {
    id: SECTION_SCOPE_IDS.automation.settings,
    kind: "section",
    parentId: TAB_SCOPE_IDS.automation,
    tabId: "automation",
    labelKey: "editor.sections.automation_settings",
    adapter: createProjectionScopeAdapter(AUTOMATION_SETTINGS_MEMBERS),
  },
  [SECTION_SCOPE_IDS.automation.optimizer_pipeline]: {
    id: SECTION_SCOPE_IDS.automation.optimizer_pipeline,
    kind: "section",
    parentId: TAB_SCOPE_IDS.automation,
    tabId: "automation",
    labelKey: "editor.sections.optimizer_pipeline",
    adapter: createPathScopeAdapter(["automation", "optimizers"], {
      emptyValue: EMPTY_ARRAY,
      rootKind: "array",
    }),
  },
  [SECTION_SCOPE_IDS.appliances.configured_appliances]: {
    id: SECTION_SCOPE_IDS.appliances.configured_appliances,
    kind: "section",
    parentId: TAB_SCOPE_IDS.appliances,
    tabId: "appliances",
    labelKey: "editor.sections.configured_appliances",
    adapter: createPathScopeAdapter(["appliances"], {
      emptyValue: EMPTY_ARRAY,
      rootKind: "array",
    }),
  },
} as const satisfies Record<ScopeId, EditorScope>;

const CHILD_SCOPE_IDS = buildChildScopeIds();

export function getScope(scopeId: ScopeId): EditorScope {
  return EDITOR_SCOPES[scopeId];
}

export function getAncestorScopeIds(scopeId: ScopeId): ScopeId[] {
  const ancestors: ScopeId[] = [];
  let currentScope = EDITOR_SCOPES[scopeId].parentId;

  while (currentScope) {
    ancestors.push(currentScope);
    currentScope = EDITOR_SCOPES[currentScope].parentId;
  }

  return ancestors;
}

export function getDescendantScopeIds(scopeId: ScopeId): ScopeId[] {
  const descendants: ScopeId[] = [];
  const stack = [...CHILD_SCOPE_IDS[scopeId]];

  while (stack.length > 0) {
    const currentScope = stack.pop();
    if (!currentScope) {
      continue;
    }

    descendants.push(currentScope);
    stack.push(...CHILD_SCOPE_IDS[currentScope]);
  }

  return descendants;
}

function createRootProjectionMembers(
  keys: readonly string[],
): ScopeProjectionMember[] {
  return keys.map((key) => ({
    yamlKey: key,
    documentPath: [key],
  }));
}

function buildChildScopeIds(): Record<ScopeId, ScopeId[]> {
  const children = Object.fromEntries(
    Object.keys(EDITOR_SCOPES).map((scopeId) => [scopeId, []]),
  ) as Record<ScopeId, ScopeId[]>;

  for (const scope of Object.values(EDITOR_SCOPES)) {
    if (scope.parentId) {
      children[scope.parentId].push(scope.id);
    }
  }

  return children;
}
