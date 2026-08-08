# Card performance harness

Measures what the Helman cards cost while they sit on a real dashboard: how
often each component re-renders, which property caused it, how much CPU that
costs, what the page asks the backend for, and whether heap / DOM nodes /
listeners grow over time.

It drives the **real local Home Assistant**, because the two things that matter
most here only exist there: the true rate at which `hass` is replaced (once per
state change anywhere in the house), and real payload sizes.

Nothing in here runs as part of `npm test` — it is a measuring instrument, not a
gate.

## Running it

```bash
cd frontend
npm run build                       # the dashboard serves the compiled bundle
export HASS_TOKEN=<long-lived token> # from Home Assistant → profile → tokens

node perf/run-perf.mjs <view> <seconds> <label> [idle|hover]  # render/WS counters
python3 perf/report.py perf/results/<label>.json              # summarise them
node perf/profile.mjs <view> <seconds> <label>                # CPU attribution
node perf/leak-probe.mjs <view> <seconds> <label>             # DOM growth by host
node perf/reconnect-retention.mjs <view> [reconnects]         # retention per reconnect
```

- `<view>` — the dashboard path segment, e.g. `0` or `inspektor`
- `hover` sweeps the pointer across the chart for the whole run, which is what a
  person reading the chart does and what the idle runs deliberately exclude
- `HASS_URL` and `HASS_DASHBOARD` override the defaults, which is how the
  retention test is pointed at a dashboard carrying no Helman cards — the
  control that says whether a leak is ours or the dashboard's

Results land in `perf/results/` (gitignored).

**Trust the profiler over the wrappers for CPU.** `perf-instrument*.js` measure
wall time around a call, which inflates once the main thread is saturated — the
very condition worth investigating. Their call *counts* and the properties that
triggered each render are exact; their millisecond totals are not. `profile.mjs`
samples real CPU and is the number to quote.

## How it measures

| File | What it does |
| --- | --- |
| `perf-init.js` | Injected before any page script: wraps `WebSocket` to count every frame the page sends and receives by message type, and counts `subscribe_entities` state frames so the `hass` churn rate is a measured number rather than an assumption. Also collects `longtask` entries. |
| `perf-instrument.js` | Wraps each Helman element's Lit `update()`/`render()` and its `hass` setter. Records call counts, time, and **the `changedProperties` keys read before `render()` runs** — a property set during render is appended to that same map and then thrown away by Lit, so counting afterwards would credit a render with a change it never acted on (`setDuringRender` reports those separately). |
| `perf-instrument2.js` | Times the inspector's own render helpers, so a render's cost can be split between re-deriving the day and painting the SVG. |
| `run-perf.mjs` | Logs in, opens the dashboard, waits for the first load to settle, then samples every 30 s. Heap is read through CDP after a forced GC, so growth is real retention rather than uncollected garbage. |
| `profile.mjs` | A V8 sampling profile of the idle dashboard, aggregated to self time per function. The authority on where CPU goes. |
| `leak-probe.mjs` | Walks every shadow root on a schedule and reports each host's subtree size, to attribute node growth to a component. Blind to *detached* trees by construction — if it reports no growth while the document's node count climbs, the extra nodes are detached, and `reconnect-retention.mjs` is the next step. |
| `reconnect-retention.mjs` | Forces websocket reconnects and compares, per element class, how many instances are attached to the document against how many are alive in the heap after a forced GC (`Runtime.queryObjects`). A live count above the attached count is retained detached DOM. |

The token is read from the environment and never written to disk.
