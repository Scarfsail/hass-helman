import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../../hass-frontend/src/types";
import type { NodeInfo } from "../../../../hass-frontend/src/components/trace/hat-script-graph";
import type { LocalizeFunc } from "../../../../hass-frontend/src/common/translations/localize";
import type { LocalizeFunction } from "../../../localize/localize";
import { loadHaTrace } from "../../load-ha-elements";
import { formatScheduleTime } from "../model/schedule-time";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

const KEY_PREFIX = "scheduling.explanation.diagram.trace";

/** The `helman/get_condition_trace` payload, or null for nothing recorded. */
interface ConditionTracePayload {
    optimizerId: string;
    groupIndex: number;
    runAt: string;
    /** The group's `custom` list, exactly as it was evaluated. */
    config: unknown[];
    /**
     * HA trace path -> the steps recorded at it.
     *
     * A step may carry a `params` key the backend put there: the entities the
     * entry read, which HA's own trace has no place for. Nothing here has to
     * draw it -- `ha-trace-path-details` dumps every step key it does not
     * recognise into the block at the top of its pane.
     */
    trace: Record<string, unknown[]>;
}

/** What the dialog is doing, which is all the render needs to branch on. */
type TraceViewState =
    | { kind: "loading" }
    /** Asked and answered with nothing: no run has evaluated this group yet. */
    | { kind: "empty" }
    /** The websocket refused. Saying which is the difference from `empty`. */
    | { kind: "failed"; message: string }
    /**
     * `trace` is the synthetic automation built once, when the payload landed.
     *
     * Not rebuilt per render, and that is load-bearing rather than tidy:
     * `hat-script-graph` rebuilds its whole node index whenever the `trace`
     * property *identity* changes and re-announces its first tracked node when
     * it does. A fresh object literal each render therefore feeds the selection
     * it emits straight back into the render that emits it.
     *
     * `hass` is built once for the same reason, and carries the localize that
     * came back from loading the `config` fragment rather than the stale one on
     * this element's own property.
     */
    | {
        kind: "ready";
        payload: ConditionTracePayload;
        trace: SyntheticTrace;
        hass: HomeAssistant;
    }
    /**
     * The payload arrived and HA's renderer did not. The trace is the answer
     * either way, so it is shown raw rather than thrown away.
     */
    | { kind: "raw"; payload: ConditionTracePayload };

/**
 * One condition group's evaluation, shaped as the automation trace HA draws.
 *
 * `hat-script-graph` walks `config.conditions` and looks each entry up at
 * `condition/<i>`, which is exactly where the backend re-roots each `custom`
 * entry -- so the group's list needs no translation, only a frame around it.
 * The remaining fields are inert: nothing here was ever a real automation run,
 * and the renderer only reads them to decide it has nothing extra to say.
 */
interface SyntheticTrace {
    domain: "automation";
    item_id: string;
    run_id: string;
    state: "stopped";
    script_execution: "finished";
    last_step: null;
    timestamp: { start: string; finish: string };
    context: { id: string; parent_id: null; user_id: null };
    config: { triggers: never[]; conditions: unknown[]; actions: never[] };
    trace: Record<string, unknown[]>;
}

function buildSyntheticTrace(payload: ConditionTracePayload): SyntheticTrace {
    return {
        domain: "automation",
        item_id: `${payload.optimizerId}#${payload.groupIndex}`,
        run_id: payload.runAt,
        state: "stopped",
        script_execution: "finished",
        last_step: null,
        timestamp: { start: payload.runAt, finish: payload.runAt },
        context: { id: payload.runAt, parent_id: null, user_id: null },
        config: { triggers: [], conditions: payload.config, actions: [] },
        trace: payload.trace,
    };
}

/**
 * The last evaluation of one condition group's custom conditions.
 *
 * The diagram's custom-conditions block reports a single tri-state -- held,
 * did not hold, blew up -- which is enough to know the slot is a candidate and
 * useless for knowing *why*. This is the rest of the answer: Home Assistant's
 * own condition trace over the group's `custom` list, drawn by Home Assistant's
 * own components, so the tree the user built in the condition builder is the
 * tree they get back rather than a second visual language for the same thing.
 *
 * **Only the newest evaluation is kept**, and it is usually newer than the row
 * that opened it: the explanation record accumulates across runs while the
 * coordinator holds one trace per group, and the pre-execution reality check
 * re-evaluates every group on every execution cycle once the plan leaves its
 * freshness window. So the heading names this the *last* evaluation and the
 * line under it dates it, rather than warning about a gap that is the normal
 * case rather than the exception.
 */
@customElement("scheduling-condition-trace-dialog")
export class SchedulingConditionTraceDialog extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            .trace-content {
                display: flex;
                flex-direction: column;
                gap: 10px;
                min-width: min(720px, 80vw);
            }

            .run-at {
                color: var(--secondary-text-color);
                font-size: 0.8rem;
            }

            /* Graph left, the selected node's detail right -- the automation
               editor's own arrangement, which is the point of the exercise. */
            .trace-body {
                display: flex;
                gap: 12px;
                align-items: flex-start;
            }

            hat-script-graph {
                flex: 0 0 auto;
                border-right: 1px solid var(--divider-color);
                padding-right: 12px;
            }

            ha-trace-path-details {
                display: block;
                flex: 1 1 auto;
                min-width: 0;
            }

            .placeholder {
                padding: 12px 2px;
                color: var(--secondary-text-color);
            }

            .raw {
                max-height: 50vh;
                overflow: auto;
                margin: 0;
                padding: 8px;
                border: 1px solid var(--divider-color);
                border-radius: 8px;
                background: var(--secondary-background-color);
                font-size: 0.75rem;
                white-space: pre-wrap;
                word-break: break-word;
            }
        `,
    ];

    @property({ attribute: false }) public hass?: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ type: Boolean }) public open = false;
    @property({ type: String }) public optimizerId: string | null = null;
    @property({ type: Number }) public groupIndex: number | null = null;
    @property({ type: String }) public locale = "cs";
    @property({ type: String }) public timeZone = "UTC";

    @state() private _view: TraceViewState = { kind: "loading" };
    /** Which node of the graph the detail pane is showing. */
    @state() private _selected: NodeInfo | null = null;

    updated(changedProperties: Map<string, unknown>): void {
        super.updated(changedProperties);
        // A press is a fresh question even when it lands on the group already
        // open: the trace is only ever the newest one, and a run may have
        // happened since. Re-asking on open is the whole of that.
        if (
            changedProperties.has("open")
            || changedProperties.has("optimizerId")
            || changedProperties.has("groupIndex")
        ) {
            if (this.open) {
                void this._load();
            }
        }
    }

    render() {
        if (!this.open) {
            return nothing;
        }

        const heading = this._text("title");
        return html`
            <ha-dialog
                .open=${this.open}
                width="full"
                .heading=${heading}
                .headerTitle=${heading}
                @closed=${this._handleClosed}
            >
                <div class="trace-content">${this._renderView()}</div>
                <ha-dialog-footer slot="footer">
                    <ha-button slot="primaryAction" @click=${this._close}>
                        ${this._text("close")}
                    </ha-button>
                </ha-dialog-footer>
            </ha-dialog>
        `;
    }

    private _renderView() {
        switch (this._view.kind) {
            case "loading":
                return html`<div class="placeholder loading">${this._text("loading")}</div>`;
            case "empty":
                return html`<div class="placeholder empty">${this._text("empty")}</div>`;
            case "failed":
                return html`
                    <div class="placeholder error">
                        ${this._text("error")} — ${this._view.message}
                    </div>
                `;
            case "raw":
                return html`
                    ${this._renderProvenance(this._view.payload)}
                    <div class="placeholder unrendered">${this._text("unrendered")}</div>
                    <pre class="raw">${JSON.stringify(this._view.payload.trace, null, 2)}</pre>
                `;
            case "ready":
                return this._renderTrace(this._view.payload, this._view.trace, this._view.hass);
        }
    }

    /**
     * The trace as the automation editor draws it: graph left, detail right.
     *
     * `logbookEntries` is empty by construction -- nothing here was ever a real
     * automation run, so its logbook tab has nothing to show. The two tabs that
     * matter, the step's config and the values it recorded, do not need it.
     *
     * The node index comes off the graph itself, so the detail pane is one
     * render behind on the first paint. That resolves itself: the graph
     * announces its first tracked node, which is a state change, which is the
     * render where the index is there.
     */
    private _renderTrace(
        payload: ConditionTracePayload,
        trace: SyntheticTrace,
        hass: HomeAssistant,
    ) {
        const graph = this.shadowRoot?.querySelector("hat-script-graph") as
            (HTMLElement & { renderedNodes: unknown; trackedNodes: unknown }) | null;

        return html`
            ${this._renderProvenance(payload)}
            <div class="trace-body">
                <hat-script-graph
                    .trace=${trace}
                    .selected=${this._selected?.path}
                    @graph-node-selected=${this._handleNodeSelected}
                ></hat-script-graph>
                <ha-trace-path-details
                    .hass=${hass}
                    .trace=${trace}
                    .logbookEntries=${[]}
                    .selected=${this._selected}
                    .renderedNodes=${graph?.renderedNodes ?? {}}
                    .trackedNodes=${graph?.trackedNodes ?? {}}
                ></ha-trace-path-details>
            </div>
        `;
    }

    /**
     * When this evaluation happened.
     *
     * The timestamp alone, with no comparison against the row that opened the
     * dialog. Warning about the difference was the obvious thing to do and the
     * wrong one: the pre-execution reality check re-evaluates every group on
     * every execution cycle once the plan leaves its freshness window, so the
     * trace is newer than the row essentially always and a banner saying so
     * fired on every slot. The heading already calls this the *last*
     * evaluation, and this line dates it; a reader who needs to know whether it
     * is the row's own run can read the two times.
     */
    private _renderProvenance(payload: ConditionTracePayload) {
        const traceMs = Date.parse(payload.runAt);
        return html`
            <div class="run-at">
                ${this._text("run_at")}:
                ${Number.isFinite(traceMs)
                    ? formatScheduleTime(traceMs, this.locale, this.timeZone)
                    : payload.runAt}
            </div>
        `;
    }

    private async _load(): Promise<void> {
        const hass = this.hass;
        const optimizerId = this.optimizerId;
        const groupIndex = this.groupIndex;
        if (!hass || optimizerId === null || groupIndex === null) {
            return;
        }

        this._view = { kind: "loading" };
        this._selected = null;

        let payload: ConditionTracePayload | null;
        try {
            payload = await hass.callWS<ConditionTracePayload | null>({
                type: "helman/get_condition_trace",
                optimizer_id: optimizerId,
                group_index: groupIndex,
            });
        } catch (error) {
            this._view = { kind: "failed", message: describeError(error) };
            return;
        }

        // Answered with nothing: no run has evaluated this group yet, which is
        // not the same as a question that could not be asked.
        if (payload === null || payload === undefined) {
            this._view = { kind: "empty" };
            return;
        }

        // A press that landed while an earlier one was still in flight owns the
        // dialog now; the older answer must not overwrite it.
        if (payload.optimizerId !== this.optimizerId || payload.groupIndex !== this.groupIndex) {
            return;
        }

        let localize: LocalizeFunc;
        try {
            localize = await loadHaTrace(hass);
        } catch {
            // HA moved its chunks. The trace is still the answer, so it is
            // shown raw rather than as an empty box.
            this._view = { kind: "raw", payload };
            return;
        }

        this._view = {
            kind: "ready",
            payload,
            trace: buildSyntheticTrace(payload),
            // Loading translations replaces the `hass` on `<home-assistant>`;
            // the one this element was handed still answers "" for every key
            // the pane writes through. Splice the refreshed localize onto it so
            // the pane reads the same either way, rather than waiting on the
            // card above to push a new `hass` down into an open dialog.
            hass: { ...hass, localize },
        };
    }

    private _handleNodeSelected(event: CustomEvent<NodeInfo>): void {
        event.stopPropagation();
        this._selected = event.detail;
    }

    private _close(): void {
        this.open = false;
        this._handleClosed();
    }

    /**
     * Closing this dialog must not close the day editor behind it.
     *
     * This dialog is mounted *inside* the day editor's own `ha-dialog`, and
     * `closed` is the event name both of them use. Left alone, one press of ✕
     * shuts both: the inner dialog's `closed` bubbles straight past us into the
     * outer dialog's `@closed`, and the notification we send the panel -- which
     * used to bubble and cross shadow roots -- arrives there as a second one.
     *
     * So the incoming event stops here, and ours does not travel: the panel
     * listens on this element directly (`scheduling-explanation-panel.ts`), so
     * a bubbling event bought nothing and cost the editor.
     */
    private _handleClosed(event?: Event): void {
        event?.stopPropagation();
        this.dispatchEvent(new CustomEvent("closed"));
    }

    private _text(suffix: string): string {
        return this.localize(`${KEY_PREFIX}.${suffix}`);
    }
}

function describeError(error: unknown): string {
    if (typeof error === "object" && error !== null && "message" in error) {
        return String((error as { message: unknown }).message);
    }

    return String(error);
}

declare global {
    interface HTMLElementTagNameMap {
        "scheduling-condition-trace-dialog": SchedulingConditionTraceDialog;
    }
}
