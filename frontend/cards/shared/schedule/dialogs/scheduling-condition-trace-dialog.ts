import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../../hass-frontend/src/types";
import type { NodeInfo } from "../../../../hass-frontend/src/components/trace/hat-script-graph";
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
    /** HA trace path -> the steps recorded at it. */
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
     */
    | { kind: "ready"; payload: ConditionTracePayload; trace: SyntheticTrace }
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
 * **Only the newest evaluation is kept.** The explanation record accumulates
 * across runs while the coordinator holds one trace per group, so the trace can
 * be from a later run than the diagram row that opened it. That is the one
 * thing the dialog must not let pass silently, hence the header time and the
 * banner: a reader comparing a 14:00 row against an 18:30 evaluation and told
 * neither would be reading a coincidence as an explanation.
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

            /* The same shape the day editor uses to say the schedule moved
               under you: a warning about provenance, not about a failure. */
            .stale-banner {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                border-radius: 8px;
                background: color-mix(in srgb, var(--warning-color, #ef6c00) 14%, transparent);
                color: var(--primary-text-color);
                font-size: 0.82rem;
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
    /**
     * When the run that wrote the diagram row happened, for comparison.
     *
     * Null where the record carries no run time, in which case the dialog says
     * when the *trace* was taken and claims nothing about the row.
     */
    @property({ type: String }) public cellRunAt: string | null = null;
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
                return this._renderTrace(this._view.payload, this._view.trace);
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
    private _renderTrace(payload: ConditionTracePayload, trace: SyntheticTrace) {
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
                    .hass=${this.hass}
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
     * When this evaluation happened, and whether that is the row's own run.
     *
     * Compared as instants rather than as strings: the two timestamps come from
     * different serializers and an offset written differently would read as a
     * different run.
     */
    private _renderProvenance(payload: ConditionTracePayload) {
        const traceMs = Date.parse(payload.runAt);
        const cellMs = this.cellRunAt === null ? Number.NaN : Date.parse(this.cellRunAt);
        const stale = Number.isFinite(traceMs) && Number.isFinite(cellMs) && traceMs > cellMs;
        return html`
            <div class="run-at">
                ${this._text("run_at")}:
                ${Number.isFinite(traceMs)
                    ? formatScheduleTime(traceMs, this.locale, this.timeZone)
                    : payload.runAt}
            </div>
            ${stale ? html`
                <div class="stale-banner">
                    <ha-icon icon="mdi:alert-outline"></ha-icon>
                    <span>${this._text("stale")}</span>
                </div>
            ` : nothing}
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

        try {
            await loadHaTrace();
        } catch {
            // HA moved its chunks. The trace is still the answer, so it is
            // shown raw rather than as an empty box.
            this._view = { kind: "raw", payload };
            return;
        }

        this._view = { kind: "ready", payload, trace: buildSyntheticTrace(payload) };
    }

    private _handleNodeSelected(event: CustomEvent<NodeInfo>): void {
        event.stopPropagation();
        this._selected = event.detail;
    }

    private _close(): void {
        this.open = false;
        this._handleClosed();
    }

    private _handleClosed(): void {
        this.dispatchEvent(new CustomEvent("closed", { bubbles: true, composed: true }));
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
