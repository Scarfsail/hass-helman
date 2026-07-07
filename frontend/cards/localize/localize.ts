import * as cs from './translations/cs.json';
import * as en from './translations/en.json';
import type { HomeAssistant } from '../../hass-frontend/src/types';

const languages: Record<string, any> = {
    cs: cs,
    en: en,
};

export type LocalizeFunction = (key: string) => string;

export function getLocalizeFunction(hass: HomeAssistant): LocalizeFunction {
    const lang = getLanguage(hass?.language || 'cs');
    return (string: string) => localize(string, lang);
}

function localize(string: string, language: string = 'cs'): string {
    const selectedLanguage = language.replace(/['"]+/g, '').replace('_', '-');

    let translated: string;

    try {
        translated = string.split('.').reduce((o, i) => o[i], languages[selectedLanguage]);
    } catch (e) {
        try {
            translated = string.split('.').reduce((o, i) => o[i], languages['cs']);
        } catch (e) {
            translated = string;
        }
    }

    if (translated === undefined) {
        try {
            translated = string.split('.').reduce((o, i) => o[i], languages['cs']);
        } catch (e) {
            translated = string;
        }
    }

    return translated;
}

export function getLanguage(language?: string): string {
    return language ? language.substring(0, 2) : 'cs';
}
