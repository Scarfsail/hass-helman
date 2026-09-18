import { mdiDelete, mdiDragVertical } from "@mdi/js";
import { html, type TemplateResult } from "lit";

import { renderSvgIcon } from "./form-fields";

/**
 * The one reorderable-list idiom every Helman config surface draws with.
 *
 * Nine lists -- controllables, both optimizer buckets, an optimizer's targets,
 * the condition groups, vehicles, import price windows, daily energy entities
 * -- each grew its own Up / Down / Remove row, none of them sharing a line of
 * code. Reordering a long list by clicking Up is slow, and the three text pills
 * crowded every summary row. One handle and one icon button replace them all.
 *
 * Dragging is Home Assistant's own `<ha-sortable>` (SortableJS underneath, so
 * it works on touch), borrowed from the frontend hosting us exactly as `ha-form`
 * and `ha-yaml-editor` are -- see `load-ha-elements.ts`. It is deliberately not
 * native HTML5 drag and drop, which has no touch support and would leave us
 * drawing the drop indicator ourselves.
 *
 * Render helpers over a small host, like `form-fields.ts` and
 * `optimizer-condition-groups.ts`, rather than a custom element: the callers are
 * two unrelated elements -- a full-page panel and a card -- and an element of
 * our own would need its own localize and hass plumbing to gain nothing.
 *
 * The markup here is paired with `configFormStyles`; a host that renders these
 * without adopting that stylesheet gets an unstyled glyph and no grab cursor.
 */

/** All these helpers need of their caller: its translations. */
export interface SortableListHost {
    t(key: string): string;
}

/** What `renderDragHandle` draws, and what `ha-sortable` drags by. */
const HANDLE_SELECTOR = ".sortable-handle";

export interface SortableListOptions<TItem> {
    items: readonly TItem[];
    renderItem(item: TItem, index: number): TemplateResult;
    /** Where the reorder is applied -- always an existing document mutator. */
    onMove(oldIndex: number, newIndex: number): void;
    /**
     * The class of the single element `ha-sortable` makes its drag container.
     *
     * `ha-sortable` sorts `this.children[0]`'s children, so the list needs one
     * wrapper -- which every call site already had (`.list-stack` and friends).
     * Passing its class keeps the layout the list already has.
     */
    containerClass: string;
}

/**
 * A list whose items reorder by dragging their handle.
 *
 * `rollback` is left at `ha-sortable`'s default: SortableJS puts the DOM back
 * the way it found it and Lit redraws from the moved data, so the DOM never
 * disagrees with the document.
 */
export function renderSortableList<TItem>(
    options: SortableListOptions<TItem>,
): TemplateResult {
    return html`
        <ha-sortable
            handle-selector=${HANDLE_SELECTOR}
            @item-moved=${(event: Event) => {
                // A card's own lists sit inside the list that holds the card,
                // and `item-moved` bubbles: without this an inner reorder would
                // be applied a second time to the outer list.
                event.stopPropagation();
                const detail = (event as CustomEvent<{ oldIndex?: number; newIndex?: number }>)
                    .detail;
                if (
                    typeof detail?.oldIndex !== "number" ||
                    typeof detail?.newIndex !== "number"
                ) {
                    return;
                }
                options.onMove(detail.oldIndex, detail.newIndex);
            }}
        >
            <div class=${options.containerClass}>
                ${options.items.map((item, index) => options.renderItem(item, index))}
            </div>
        </ha-sortable>
    `;
}

/** The grip a list item is dragged by. Belongs on the left of its header row. */
export function renderDragHandle(host: SortableListHost): TemplateResult {
    const label = host.t("editor.actions.drag_to_reorder");
    return html`
        <span
            class="sortable-handle"
            role="img"
            aria-label=${label}
            title=${label}
            @click=${stopSummaryToggle}
        >
            ${renderSvgIcon(mdiDragVertical, "sortable-handle-glyph")}
        </span>
    `;
}

export interface RemoveButtonOptions {
    onRemove(): void;
    /** Translated already. Defaults to plain "Remove", which most rows want. */
    label?: string;
    /** A list that must keep its last entry disables the button instead. */
    disabled?: boolean;
    /** Translated already: it is also the button's label while disabled. */
    disabledReason?: string;
    /** An extra class, for callers whose button is addressed by name. */
    className?: string;
}

/**
 * The one way to remove a list entry: an icon button that asks first.
 *
 * `window.confirm` rather than a dialog of our own, because that is the
 * mechanism the editor already reaches for when an action would throw work away
 * (`helman-config-editor.ts`'s dirty reload, the edit dialog's discard).
 */
export function renderRemoveButton(
    host: SortableListHost,
    options: RemoveButtonOptions,
): TemplateResult {
    const disabled = options.disabled ?? false;
    const label =
        disabled && options.disabledReason
            ? options.disabledReason
            : (options.label ?? host.t("editor.actions.remove"));
    return html`
        <button
            type="button"
            class=${["danger", "icon", options.className ?? ""]
                .filter((className) => className.length > 0)
                .join(" ")}
            ?disabled=${disabled}
            aria-label=${label}
            title=${label}
            @click=${(event: Event) => {
                stopSummaryToggle(event);
                if (disabled) {
                    return;
                }
                if (window.confirm(host.t("editor.confirm.remove_item"))) {
                    options.onRemove();
                }
            }}
        >
            ${renderSvgIcon(mdiDelete, "icon-button-glyph")}
        </button>
    `;
}

/**
 * A click inside a `<summary>` is the browser's own "collapse this card".
 *
 * Both the handle and the remove button live in summary rows, so both guard
 * against it the way every other control in one already does. Exported because
 * a container of summary controls needs the same guard: a click landing on the
 * row's own padding, gap or border reaches the `<summary>` without it.
 */
export function stopSummaryToggle(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
}
