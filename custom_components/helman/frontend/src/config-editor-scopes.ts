import {
  createDocumentScopeAdapter,
  createPathScopeAdapter,
  createProjectionScopeAdapter,
  type ScopeProjectionMember,
  type ScopeYamlAdapter,
} from "./config-scope-adapters";

export type EditorMode = "visual" | "yaml";
export type TabId = "general" | "power_devices" | "scheduler" | "appliances";

export type ScopeId =
  | "document"
  | "tab:general"
  | "tab:power_devices"
  | "tab:scheduler"
  | "tab:appliances"
  | "section:general.core_labels_and_history"
  | "section:general.device_label_text"
  | "section:power_devices.house"
  | "section:power_devices.solar"
  | "section:power_devices.battery"
  | "section:power_devices.grid"
  | "section:scheduler.schedule_control_mapping"
  | "section:appliances.configured_appliances";

export interface EditorScope {
  id: ScopeId;
  kind: "document" | "tab" | "section";
  parentId?: ScopeId;
  tabId?: TabId;
  labelKey: string;
  adapter: ScopeYamlAdapter;
}

export const TABS: Array<{ id: TabId; labelKey: string }> = [
  { id: "general", labelKey: "editor.tabs.general" },
  { id: "power_devices", labelKey: "editor.tabs.power_devices" },
  { id: "scheduler", labelKey: "editor.tabs.scheduler" },
  { id: "appliances", labelKey: "editor.tabs.appliances" },
];

export const TAB_SECTIONS: Record<string, TabId> = {
  general: "general",
  power_devices: "power_devices",
  scheduler_control: "scheduler",
  appliances: "appliances",
  root: "general",
};

export const DOCUMENT_SCOPE_ID = "document" as const;

export const TAB_SCOPE_IDS = {
  general: "tab:general",
  power_devices: "tab:power_devices",
  scheduler: "tab:scheduler",
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
