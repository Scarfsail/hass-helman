/**
 * Moved to `cards/shared`, which is the one directory both vite entry points
 * compile: the schedule card needs the same trick to reach HA's trace renderer.
 * Re-exported from here so the editor's imports keep reading the way they did.
 */
export { loadHaForm, loadHaTrace, loadHaYamlEditor } from "../cards/shared/load-ha-elements";
