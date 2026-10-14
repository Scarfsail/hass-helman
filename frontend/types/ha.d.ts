/**
 * The Home Assistant frontend types helman uses, vendored from
 * home-assistant/frontend (`src/types.ts` and the modules it names below) and
 * trimmed to the members helman reads. The websocket types come from
 * `home-assistant-js-websocket`, as they do in HA itself.
 */
import type { HTMLTemplateResult } from "lit";
import type {
  Connection,
  HassConfig,
  HassEntities,
  HassEntity,
  MessageBase,
} from "home-assistant-js-websocket";

/** `common/translations/localize.ts`, without HA's typed key union. */
export type LocalizeFunc = (
  key: string,
  values?: Record<string, string | number | HTMLTemplateResult | null | undefined>,
) => string;

export interface HomeAssistant {
  states: HassEntities;
  entities: Record<string, { device_id?: string }>;
  devices: Record<string, { name: string | null; name_by_user: string | null }>;
  connection: Connection;
  config: HassConfig;
  user?: { is_admin: boolean };
  language: string;
  locale: { language: string; first_weekday: string };
  localize: LocalizeFunc;
  loadBackendTranslation(category: string): Promise<LocalizeFunc>;
  loadFragmentTranslation(fragment: string): Promise<LocalizeFunc | undefined>;
  callWS<T>(msg: MessageBase): Promise<T>;
}

/** `data/lovelace/config/card.ts`. */
export interface LovelaceCardConfig {
  type: string;
  [key: string]: any;
}

/** `panels/lovelace/types.ts`. */
export interface LovelaceCard extends HTMLElement {
  hass?: HomeAssistant;
  getCardSize(): number | Promise<number>;
  setConfig(config: LovelaceCardConfig): void;
}

/** `panels/lovelace/types.ts`. */
export interface LovelaceCardEditor extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: LovelaceCardConfig): void;
}

/** `data/entity/entity.ts`. */
export type HaEntityPickerEntityFilterFunc = (entityId: HassEntity) => boolean;

/** `components/trace/hat-script-graph.ts`. */
export interface NodeInfo {
  path: string;
  config: any;
  type?: "trigger" | "condition" | "action" | "chooseOption";
}

/** `components/ha-form/types.ts`: the selector schema, with the number selector helman uses. */
export interface HaFormSchema {
  name: string;
  selector: { number: { min?: number; mode?: "box" | "slider" } };
}
