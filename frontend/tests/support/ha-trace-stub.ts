/**
 * Stand-ins for Home Assistant's trace renderer inside the Playwright harness.
 *
 * `hat-script-graph` and `ha-trace-path-details` live in HA's automation-trace
 * chunk, not in this bundle, so the harness can never have the real ones. What
 * it *can* pin is the contract between them and the dialog: the synthetic trace
 * the dialog builds must carry one condition per configured entry, index onto
 * the `condition/<i>` paths the backend records, and mark exactly the nodes the
 * run actually reached.
 *
 * The stubs therefore render one node per condition and mark the tracked ones,
 * which is the same reading of `trace.config.conditions` and `trace.trace` the
 * real `hat-script-graph` does. Defining them also short-circuits
 * `loadHaTrace()`, whose first act is to give up when both tags are registered
 * -- so the specs never walk HA's panel routers, which do not exist here.
 */
export const HA_TRACE_STUB = `
class HelmanTestScriptGraph extends HTMLElement {
    set trace(value) {
        // Lit re-commits object-valued property bindings on every render -- it
        // cannot know whether the object mutated -- and the real component
        // filters those through Lit's own \`hasChanged\`, so it only rebuilds
        // when the identity actually changes. A stub without that check turns
        // the selection it announces into the render that re-announces it.
        if (value === this._trace) {
            return;
        }
        this._trace = value;
        this.renderedNodes = {};
        this.trackedNodes = {};
        const conditions = (value && value.config && value.config.conditions) || [];
        this.innerHTML = "";
        conditions.forEach((config, index) => {
            const path = "condition/" + index;
            const info = { path, config, type: "condition" };
            this.renderedNodes[path] = info;
            const tracked = !!(value.trace && path in value.trace);
            if (tracked) {
                this.trackedNodes[path] = info;
            }
            const node = document.createElement("span");
            node.className = "node";
            node.setAttribute("data-path", path);
            node.setAttribute("data-tracked", tracked ? "true" : "false");
            node.textContent = config && config.condition ? config.condition : "";
            this.appendChild(node);
        });
        // The real graph selects its first tracked node as soon as it has one,
        // which is what gives the detail pane something to show. It does that
        // from \`updated()\`, i.e. after the whole render committed -- firing it
        // straight out of the setter would beat the listener Lit attaches a
        // part later, and the selection would land nowhere.
        const first = Object.keys(this.trackedNodes)[0];
        if (first !== undefined) {
            queueMicrotask(() => {
                this.dispatchEvent(new CustomEvent("graph-node-selected", {
                    detail: this.trackedNodes[first],
                    bubbles: true,
                    composed: true,
                }));
            });
        }
    }
    get trace() { return this._trace; }
}

// The real pane destructures a step into the keys it knows and YAML-dumps
// whatever is left into the block at the top (\`_renderSelectedTraceInfo\`), which
// is the whole mechanism by which the backend's \`params\` reach the reader. The
// stub reproduces that split -- the same key list, the same "render the rest"
// rule -- so a spec can pin the contract without owning HA's layout.
const HA_STEP_KEYS = [
    "path", "timestamp", "result", "error", "template_errors", "changed_variables",
];

class HelmanTestTracePathDetails extends HTMLElement {
    set trace(value) { this._trace = value; this._paint(); }
    get trace() { return this._trace; }
    set selected(value) {
        this._selected = value;
        this.setAttribute("data-selected", (value && value.path) || "");
        this._paint();
    }
    get selected() { return this._selected; }
    _paint() {
        const path = this._selected && this._selected.path;
        const steps = (this._trace && this._trace.trace && this._trace.trace[path]) || [];
        this.innerHTML = "";
        steps.forEach((step) => {
            const rest = {};
            Object.keys(step)
                .filter((key) => HA_STEP_KEYS.indexOf(key) === -1)
                .forEach((key) => { rest[key] = step[key]; });
            if (Object.keys(rest).length === 0) {
                return;
            }
            const dump = document.createElement("pre");
            dump.className = "rest";
            dump.textContent = JSON.stringify(rest);
            this.appendChild(dump);
        });
    }
}

if (!customElements.get("hat-script-graph")) {
    customElements.define("hat-script-graph", HelmanTestScriptGraph);
}
if (!customElements.get("ha-trace-path-details")) {
    customElements.define("ha-trace-path-details", HelmanTestTracePathDetails);
}
`;

/**
 * A `partial-panel-resolver` whose chunk walk fails.
 *
 * The one way to reach the dialog's raw-JSON fallback from a spec: with the
 * trace tags undefined, `loadHaTrace()` walks HA's routers, and this makes that
 * walk reject the way an upstream reshuffle would.
 */
export const HA_PANEL_RESOLVER_FAILING_STUB = `
class HelmanTestFailingResolver extends HTMLElement {
    get routerOptions() {
        return { routes: { tmp: { load: () => Promise.reject(new Error("no such chunk")) } } };
    }
    _updateRoutes() {}
}
if (!customElements.get("partial-panel-resolver")) {
    customElements.define("partial-panel-resolver", HelmanTestFailingResolver);
}
`;
