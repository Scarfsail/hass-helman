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

function localize(key: string, language = "cs"): string {
  const selectedLanguage = language.replace(/['"]+/g, "").replace("_", "-");

  let translated: string;

  try {
    translated = key.split(".").reduce((current, part) => current[part], languages[selectedLanguage]);
  } catch (_error) {
    try {
      translated = key.split(".").reduce((current, part) => current[part], languages.cs);
    } catch (_fallbackError) {
      translated = key;
    }
  }

  if (translated === undefined) {
    try {
      translated = key.split(".").reduce((current, part) => current[part], languages.cs);
    } catch (_fallbackError) {
      translated = key;
    }
  }

  return translated;
}

export function getLanguage(language?: string): string {
  return language ? language.substring(0, 2) : "cs";
}
