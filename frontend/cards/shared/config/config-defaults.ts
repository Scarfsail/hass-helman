import type { PathSegment } from "./types";

/**
 * What an unset optional config field is worth at runtime, by dotted path.
 *
 * Served by `helman/get_config_defaults`, built in Python from the very
 * constants the readers fall back to. Nothing here is declared on this side:
 * a hint that disagrees with the backend is worse than no hint at all.
 */
export type ConfigDefaults = Record<string, string | number | boolean>;

interface HassLike {
    callWS<T>(request: { type: string }): Promise<T>;
}

/**
 * Fetch the defaults once per editor session.
 *
 * Alongside the config the editor already awaits on open, so it costs no
 * extra user-visible latency. A failure resolves to `null`: a placeholder is
 * a nicety, and losing it must not cost the form.
 */
export async function fetchConfigDefaults(
    hass: HassLike | undefined,
): Promise<ConfigDefaults | null> {
    if (!hass) return null;
    try {
        return await hass.callWS<ConfigDefaults>({
            type: "helman/get_config_defaults",
        });
    } catch {
        return null;
    }
}

/**
 * The placeholder for a field, or `""` when nothing is known about its path.
 *
 * One lookup for every field renderer, so a path's default is resolved the
 * same way wherever it is drawn. Paths with a numeric segment -- a list item's
 * fields -- simply never match a key, which is what makes the plain join safe.
 */
export function configDefaultHint(
    defaults: ConfigDefaults | null,
    path: PathSegment[],
): string {
    const value = configDefaultValue(defaults, path);
    return value === undefined ? "" : String(value);
}

/**
 * The raw default for a path, or `undefined` when nothing is known.
 *
 * A checkbox or a select cannot show a placeholder: it always renders *some*
 * state, so an unset field has to render the backend's default rather than an
 * empty one. Those controls read the value itself, not its string form.
 */
export function configDefaultValue(
    defaults: ConfigDefaults | null,
    path: PathSegment[],
): string | number | boolean | undefined {
    return defaults?.[path.join(".")];
}
