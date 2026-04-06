import { HelmanConfigEditorPanel } from "./helman-config-editor";

const tagName = "helman-config-editor-panel";

if (!customElements.get(tagName)) {
  customElements.define(tagName, HelmanConfigEditorPanel);
}
