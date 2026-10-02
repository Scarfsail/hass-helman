import { css, html, nothing, type ReactiveController, type ReactiveElement } from "lit";

/**
 * One cell of a hover popup's actual/forecast column, optionally swatched --
 * either with a literal colour, or with a schedule action's tone class, whose
 * accent colour rides in via `schedulingSharedStyles`.
 */
export type TooltipCell = { value: string; color?: string; toneClass?: string } | null;

/**
 * One row of a hover popup: a label, and its actual and forecast readings side
 * by side. `forecast` is the only cell guaranteed present -- a slot with no
 * actual data yet (still ahead of it) leaves `actual` null, and the popup
 * drops that column entirely rather than show it empty.
 *
 * A row with an empty label is a line of text across the whole popup: its
 * `forecast` value, unswatched.
 */
export type TooltipRow = {
    label: string;
    actual: TooltipCell;
    forecast: TooltipCell;
    /** The data-quality kind a text line reports, as `data-quality`: a hook for tests. */
    quality?: string;
};

/**
 * The floating popup that follows the cursor over whichever bar/band it sits
 * on. `hasActual` decides once, for the whole popup, whether the actual
 * column renders -- the hovered slot either has lived through or it hasn't,
 * so every row in one popup agrees on it. `note` is a free-text paragraph
 * under the table.
 */
export type TooltipContent = {
    x: number;
    y: number;
    title?: string;
    hasActual: boolean;
    rows: TooltipRow[];
    note?: string;
};

/** What a popup says, without where it is: what a hover target hands the controller. */
export type TooltipBody = Omit<TooltipContent, "x" | "y">;

/** A forecast-only row: a label and one value, optionally swatched. */
export function tooltipRow(label: string, value: string, color?: string): TooltipRow {
    return { label, actual: null, forecast: { value, color } };
}

/** Two popup cells saying the same thing, coordinates excluded by construction. */
export function sameTooltipCell(a: TooltipCell, b: TooltipCell): boolean {
    if (a === null || b === null) return a === b;
    return a.value === b.value && a.color === b.color && a.toneClass === b.toneClass;
}

/**
 * Whether two popups say the same thing.
 *
 * Compared by value rather than by identity because every source builds its
 * rows fresh per pointer report -- and by contents rather than by position,
 * which is what makes a sweep across one column cost nothing: the popup is
 * only moved, never re-rendered.
 */
export function sameTooltipContent(a: TooltipBody | null, b: TooltipBody | null): boolean {
    if (a === null || b === null) return a === b;
    if (
        a.title !== b.title
        || a.note !== b.note
        || a.hasActual !== b.hasActual
        || a.rows.length !== b.rows.length
    ) {
        return false;
    }
    return a.rows.every((row, index) =>
        row.label === b.rows[index].label
        && row.quality === b.rows[index].quality
        && sameTooltipCell(row.actual, b.rows[index].actual)
        && sameTooltipCell(row.forecast, b.rows[index].forecast));
}

export const hoverTooltipStyles = css`
    .hover-tooltip {
        position: fixed;
        z-index: 20;
        pointer-events: none;
        transform: translate(-50%, -100%) translateY(-10px);
        background: var(--card-background-color, #fff);
        border: 1px solid var(--divider-color);
        border-radius: 6px;
        padding: 6px 9px;
        font-size: 12px;
        line-height: 1.5;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        white-space: nowrap;
    }

    .hover-tooltip-title {
        font-weight: 600;
        margin-bottom: 3px;
    }

    .hover-tooltip-table {
        display: grid;
        column-gap: 10px;
        row-gap: 2px;
        align-items: center;
    }

    .hover-tooltip-table.has-actual {
        grid-template-columns: auto 1fr 1fr;
    }

    .hover-tooltip-table.forecast-only {
        grid-template-columns: auto 1fr;
    }

    .hover-tooltip-header {
        color: var(--secondary-text-color);
        font-size: 0.9em;
        text-align: right;
    }

    .hover-tooltip-cell {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        font-weight: 600;
        text-align: right;
    }

    .hover-tooltip-swatch {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 2px;
        flex: none;
    }

    .hover-tooltip-label {
        color: var(--secondary-text-color);
    }

    .hover-tooltip-line {
        grid-column: 1 / -1;
        white-space: normal;
        max-width: 280px;
    }

    .hover-tooltip-note {
        margin-top: 4px;
        white-space: normal;
        max-width: 280px;
        color: var(--secondary-text-color);
    }
`;

function renderCell(cell: TooltipCell) {
    if (!cell) return html`<span class="hover-tooltip-cell">—</span>`;
    const swatch = cell.toneClass
        ? html`<span class="hover-tooltip-swatch ${cell.toneClass}" style="background: var(--schedule-action-tone-accent);"></span>`
        : cell.color
            ? html`<span class="hover-tooltip-swatch" style="background: ${cell.color};"></span>`
            : "";
    return html`
        <span class="hover-tooltip-cell">
            ${swatch}
            ${cell.value}
        </span>
    `;
}

/**
 * The popup itself: a title, then a label/actual/forecast table, at `point`.
 * A slot with no actual reading yet drops the actual column entirely rather
 * than pad it with dashes -- what the popup states as "the" value there is
 * simply the forecast. `headers` caption the two columns when both show.
 *
 * Position comes from `point`, not from the content: a popup that follows the
 * pointer is moved by writing its element's style directly, and this binding
 * only has to put a freshly-created popup where the cursor already is.
 */
export function renderHoverTooltip(
    content: TooltipContent,
    point: { x: number; y: number },
    headers?: readonly [string, string],
) {
    const { title, hasActual, rows, note } = content;
    return html`
        <div class="hover-tooltip" style="left: ${point.x}px; top: ${point.y}px;">
            ${title ? html`<div class="hover-tooltip-title">${title}</div>` : ""}
            <div class="hover-tooltip-table ${hasActual ? "has-actual" : "forecast-only"}">
                ${hasActual && headers
                    ? html`
                        <span></span>
                        <span class="hover-tooltip-header">${headers[0]}</span>
                        <span class="hover-tooltip-header">${headers[1]}</span>
                    `
                    : ""}
                ${rows.map((row) => row.label === ""
                    ? html`<span class="hover-tooltip-line" data-quality=${row.quality ?? nothing}>${row.forecast?.value ?? ""}</span>`
                    : html`
                        <span class="hover-tooltip-label">${row.label}</span>
                        ${hasActual ? renderCell(row.actual) : ""}
                        ${renderCell(row.forecast)}
                    `)}
            </div>
            ${note ? html`<div class="hover-tooltip-note">${note}</div>` : ""}
        </div>
    `;
}

/**
 * One element's hover popup, as a Lit controller: the device reports' (the
 * inspector keeps its own plumbing, which couples the popup to the hover
 * minute it shares across strips).
 *
 * The host binds `show` on `mousemove`, `hide` on `mouseleave` and `toggle` on
 * `click` of each hover target, and renders `render()` once. Moves are applied
 * once per frame; a move that says the same thing only moves the popup, without
 * re-rendering anything.
 *
 * A tap toggles: the first opens the popup, the second closes it, and a press
 * anywhere outside the target it was opened on closes it too. The mouse events
 * a browser emulates after a tap are ignored, or the tap would open the popup by
 * "hovering" and then close it by clicking. A keyboard activation has no
 * pointer, so its popup sits on the target instead.
 *
 * The host hides it when the data it describes changes (a refresh reuses the
 * target's node, so nothing here would notice), and a scroll or resize hides it.
 *
 * The popup is kept inside the viewport: shifted sideways off an edge, and
 * dropped below the pointer when there is no room above it.
 */
export class HoverTooltipController implements ReactiveController {
    content: TooltipContent | null = null;
    point: { x: number; y: number } | null = null;

    private _pending: { next: TooltipContent | null } | null = null;
    private _frame = 0;
    /** The kind of the last pointer pressed or moved: a tap's emulated mouse events are not a hover. */
    private _pointerType: string | null = null;
    /** The target the popup describes: a press anywhere else closes it. */
    private _anchor: EventTarget | null = null;

    constructor(private readonly _host: ReactiveElement) {
        _host.addController(this);
    }

    hostConnected(): void {
        document.addEventListener("pointerdown", this._onPointer, true);
        document.addEventListener("pointermove", this._onPointer, true);
        // Capture, because the scroller is an ancestor of the card (HA's view), not
        // the window. A fixed popup would stay put while its target moves away.
        window.addEventListener("scroll", this._onViewportChange, { capture: true, passive: true });
        window.addEventListener("resize", this._onViewportChange, { passive: true });
    }

    hostDisconnected(): void {
        document.removeEventListener("pointerdown", this._onPointer, true);
        document.removeEventListener("pointermove", this._onPointer, true);
        window.removeEventListener("scroll", this._onViewportChange, { capture: true });
        window.removeEventListener("resize", this._onViewportChange);
        cancelAnimationFrame(this._frame);
        this._frame = 0;
        this._pending = null;
    }

    hostUpdated(): void {
        // The target re-rendered away (a toggle, a tab, a refresh): its popup goes with it.
        if (this.content !== null && this._anchor instanceof Node && !this._anchor.isConnected) {
            this.hide();
            return;
        }
        this._position();
    }

    show(event: MouseEvent, body: TooltipBody): void {
        if (this._pointerType === "touch") return;
        this._anchor = event.currentTarget;
        this._schedule({ ...body, ...this._pointOf(event) });
    }

    hide(): void {
        this._anchor = null;
        this._schedule(null);
    }

    /** A tap: open the popup, or close it when it already says this. */
    toggle(event: MouseEvent, body: TooltipBody): void {
        // A mouse or pen is already hovering what it clicks: the click must not close it.
        if (this._pointerType === "touch" && sameTooltipContent(this._pending?.next ?? this.content, body)) {
            this.hide();
            return;
        }
        this._anchor = event.currentTarget;
        this._schedule({ ...body, ...this._pointOf(event) });
    }

    render() {
        return this.content ? renderHoverTooltip(this.content, this.point ?? this.content) : nothing;
    }

    private _onViewportChange = (): void => {
        if (this.content !== null || this._pending !== null) this.hide();
    };

    private _onPointer = (event: PointerEvent): void => {
        this._pointerType = event.pointerType;
        if (
            event.type === "pointerdown"
            && this.content !== null
            && !(this._anchor !== null && event.composedPath().includes(this._anchor))
        ) {
            this.hide();
        }
    };

    /** The pointer, or for a keyboard activation (no pointer) the top centre of its target. */
    private _pointOf(event: MouseEvent): { x: number; y: number } {
        const target = event.currentTarget;
        if (event.detail === 0 && event.type === "click" && target instanceof Element) {
            const rect = target.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top };
        }
        return { x: event.clientX, y: event.clientY };
    }

    private _schedule(next: TooltipContent | null): void {
        this._pending = { next };
        if (next !== null) this.point = { x: next.x, y: next.y };
        if (this._frame !== 0) return;
        this._frame = requestAnimationFrame(() => {
            this._frame = 0;
            const pending = this._pending;
            this._pending = null;
            if (pending === null) return;
            if (sameTooltipContent(this.content, pending.next)) {
                this._position();
                return;
            }
            this.content = pending.next;
            this._host.requestUpdate();
        });
    }

    /** Move the popup to the pointer, inside the viewport, without re-rendering anything. */
    private _position(): void {
        const point = this.point;
        const popup = this._host.renderRoot?.querySelector(".hover-tooltip") as HTMLElement | null;
        if (point === null || popup === null) return;
        const margin = 8;
        // Wider than the viewport (a long device name): cap it and let it wrap.
        const max = window.innerWidth - 2 * margin;
        popup.style.maxWidth = max + "px";
        popup.style.whiteSpace = "";
        if (popup.scrollWidth > max) popup.style.whiteSpace = "normal";
        const half = popup.offsetWidth / 2;
        const x = Math.max(margin + half, Math.min(window.innerWidth - margin - half, point.x));
        // The popup hangs 10px above its `top` (translate -100%, -10px): above the
        // point, or with no room there below it -- and either way kept on screen,
        // its top edge winning when it is taller than the viewport.
        const height = popup.offsetHeight;
        const above = point.y - height - 10 >= margin;
        const wanted = above ? point.y : point.y + height + 20;
        const top = Math.max(margin + height + 10, Math.min(window.innerHeight - margin + 10, wanted));
        popup.style.left = x + "px";
        popup.style.top = top + "px";
    }
}
