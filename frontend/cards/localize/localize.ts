import * as cardCs from './translations/cs.json';
import * as cardEn from './translations/en.json';
import * as editorCs from './editor-translations/cs.json';
import * as editorEn from './editor-translations/en.json';
import type { HomeAssistant } from '../../types/ha';

export type TemplateValues = Record<string, string | number>;
export type LocalizeFunction = {
    (key: string, values?: TemplateValues): string;
    has?(key: string): boolean;
};
export type Localizer = LocalizeFunction & { has(key: string): boolean };
export const MISSING_TRANSLATION_PREFIX = "⚠ ";
const languages = { cs: { card: cardCs, editor: editorCs }, en: { card: cardEn, editor: editorEn } };

/** Substitutes literal placeholders, including repeated names and dollar signs. */
export function fillTemplate(template: string, values: TemplateValues): string {
    return Object.entries(values).reduce((text, [key, value]) => text.split('{' + key + '}').join(String(value)), template);
}

/** Resolve full keys in the card and editor bundles, with Czech fallback. */
export function getLocalizeFunction(
    hass?: Partial<Pick<HomeAssistant, "language" | "locale">>,
    cardLocalize?: LocalizeFunction,
): Localizer {
    const language = getLanguage(hass?.language || hass?.locale?.language || "cs");
    const lookup = (key: string): string | undefined => {
        const read = (lang: string): string | undefined => {
            for (const namespace of ["card", "editor"] as const) {
                let value: any = languages[lang as keyof typeof languages]?.[namespace];
                for (const segment of key.split(".")) value = value?.[segment];
                if (typeof value === "string") return value;
            }
            return undefined;
        };
        return read(language) ?? read("cs");
    };
    const t: Localizer = (key, values) => {
        // Dialog callers may provide card labels; editor labels still use this bundle.
        const text = cardLocalize && !key.startsWith("editor.") && !key.startsWith("common.")
            ? cardLocalize(key)
            : lookup(key) ?? `${MISSING_TRANSLATION_PREFIX}${key}`;
        return values ? fillTemplate(text, values) : text;
    };
    t.has = key => lookup(key) !== undefined;
    return t;
}

export function getLanguage(language?: string): string {
    return language ? language.replace(/['"]/g, '').substring(0, 2) : 'cs';
}
