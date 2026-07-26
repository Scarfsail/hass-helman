import * as cs from "./translations/cs.json";
import * as en from "./translations/en.json";

import type { HomeAssistantLike } from "../types";

const languages: Record<string, any> = {
  cs,
  en,
};

export type LocalizeFunction = (key: string) => string;

export function getLocalizeFunction(
  hass?: Pick<HomeAssistantLike, "language" | "locale">,
): LocalizeFunction {
  const lang = getLanguage(hass?.language || hass?.locale?.language || "cs");
  return (key: string) => localize(key, lang);
}

/** Marker for a key that resolves in no language. See `localize` below. */
export const MISSING_TRANSLATION_PREFIX = "⚠ ";

function localize(key: string, language = "cs"): string {
  const selectedLanguage = language.replace(/['"]+/g, "").replace("_", "-");
  const translated =
    lookup(key, languages[selectedLanguage]) ?? lookup(key, languages.cs);
  // Deliberately loud: the schema-driven optimizer card names every field from
  // a translation key, so a silent fallback to the raw key would let a new
  // field ship unnamed and look almost right.
  return translated ?? `${MISSING_TRANSLATION_PREFIX}${key}`;
}

function lookup(key: string, table: unknown): string | undefined {
  let current: any = table;
  for (const part of key.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return typeof current === "string" ? current : undefined;
}

export function getLanguage(language?: string): string {
  return language ? language.substring(0, 2) : "cs";
}
