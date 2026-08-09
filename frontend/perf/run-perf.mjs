// Drives the real local Home Assistant dashboard and records what the Helman
// cards cost while they sit on screen.
//
//   node run-perf.mjs <view> <seconds> <label> [mode]
//
// view:  dashboard path, e.g. "0" or "inspektor"
// mode:  "idle" (default) or "hover" (sweeps the pointer over the chart)

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.HASS_URL ?? "http://127.0.0.1:8123";
const TOKEN = process.env.HASS_TOKEN;
if (!TOKEN) throw new Error("HASS_TOKEN not set — see perf/README.md");

const view = process.argv[2] ?? "0";
const DASHBOARD = process.env.HASS_DASHBOARD ?? "dashboard-helman";
const seconds = Number(process.argv[3] ?? 300);
const label = process.argv[4] ?? "run";
const mode = process.argv[5] ?? "idle";

const initScript = readFileSync(resolve(HERE, "perf-init.js"), "utf8");
const instrumentScript = readFileSync(resolve(HERE, "perf-instrument.js"), "utf8");
const instrument2Script = readFileSync(resolve(HERE, "perf-instrument2.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ["--js-flags=--expose-gc"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
await context.addInitScript(initScript);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");

page.on("console", (msg) => {
  const t = msg.type();
  if (t === "error" || t === "warning") {
    const text = msg.text();
    if (/helman|lit|scheduled an update|change-in-update/i.test(text)) {
      console.log(`[console.${t}] ${text.slice(0, 300)}`);
    }
  }
});

// --- authenticate -----------------------------------------------------------
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await sleep(2500);
await page.evaluate(({ token, base }) => {
  const expires = Date.now() + 1800 * 1000;
  localStorage.setItem("hassTokens", JSON.stringify({
    access_token: token,
    token_type: "Bearer",
    expires_in: 1800,
    hassUrl: base,
    clientId: null,
    expires,
    refresh_token: "",
  }));
}, { token: TOKEN, base: BASE });

await page.goto(`${BASE}/${DASHBOARD}/${view}`, { waitUntil: "domcontentloaded" });

// Wait until the Helman cards have actually rendered inside the nested shadow DOM.
await page.waitForFunction(() => {
  const seen = new Set();
  const walk = (root) => {
    if (!root || seen.has(root)) return false;
    seen.add(root);
    for (const el of root.querySelectorAll("*")) {
      if (el.localName.startsWith("helman-")) return true;
      if (el.shadowRoot && walk(el.shadowRoot)) return true;
    }
    return false;
  };
  return walk(document);
}, null, { timeout: 60_000 });

// Let the first data load and its follow-up renders settle before measuring.
await sleep(20_000);

const wrapped = await page.evaluate(instrumentScript);
console.log(`instrumented: ${wrapped.join(", ")}`);
const wrapped2 = await page.evaluate(instrument2Script);
console.log(`fn-timed: ${JSON.stringify(wrapped2)}`);

const metrics = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const out = {};
  for (const m of metrics) out[m.name] = m.value;
  return out;
};

const heap = async () => {
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(300);
  const m = await metrics();
  return m.JSHeapUsedSize;
};

await page.evaluate(() => window.__perfReset());
const baseMetrics = await metrics();
const baseHeap = await heap();
const baseInstances = await page.evaluate(() => window.__perfCountInstances());

const samples = [];
const stepMs = 30_000;
const steps = Math.max(1, Math.round((seconds * 1000) / stepMs));

const chartBox = await page.evaluate(() => {
  const seen = new Set();
  let found = null;
  const walk = (root) => {
    if (!root || seen.has(root) || found) return;
    seen.add(root);
    for (const el of root.querySelectorAll("*")) {
      if (el.localName === "helman-solar-inspector" && el.shadowRoot) {
        const wrap = el.shadowRoot.querySelector(".chart-wrap svg");
        if (wrap) { const r = wrap.getBoundingClientRect(); found = { x: r.x, y: r.y, w: r.width, h: r.height }; return; }
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return found;
});
if (mode === "hover" && !chartBox) console.log("WARNING: chart not found for hover mode");

for (let i = 0; i < steps; i++) {
  if (mode === "hover" && chartBox) {
    // A slow sweep across the plot: what a person reading the chart does.
    const t0 = Date.now();
    while (Date.now() - t0 < stepMs) {
      for (let f = 0; f <= 40; f++) {
        await page.mouse.move(chartBox.x + (chartBox.w * f) / 40, chartBox.y + chartBox.h / 2);
        await sleep(25);
      }
    }
  } else {
    await sleep(stepMs);
  }
  const snap = await page.evaluate(() => window.__perfSnapshot());
  const m = await metrics();
  samples.push({
    atSec: Math.round(((i + 1) * stepMs) / 1000),
    snap,
    metrics: {
      Nodes: m.Nodes, JSEventListeners: m.JSEventListeners,
      LayoutCount: m.LayoutCount, RecalcStyleCount: m.RecalcStyleCount,
      ScriptDuration: m.ScriptDuration, LayoutDuration: m.LayoutDuration,
      RecalcStyleDuration: m.RecalcStyleDuration, JSHeapUsedSize: m.JSHeapUsedSize,
      Documents: m.Documents, Frames: m.Frames,
    },
  });
  console.log(`  t=${samples[samples.length - 1].atSec}s heap=${(m.JSHeapUsedSize / 1e6).toFixed(1)}MB nodes=${m.Nodes} listeners=${m.JSEventListeners}`);
}

const endHeap = await heap();
const endInstances = await page.evaluate(() => window.__perfCountInstances());
const endMetrics = await metrics();

const result = {
  label, view, mode, seconds: steps * (stepMs / 1000),
  baseHeap, endHeap, baseInstances, endInstances,
  baseMetrics: {
    Nodes: baseMetrics.Nodes, JSEventListeners: baseMetrics.JSEventListeners,
    LayoutCount: baseMetrics.LayoutCount, RecalcStyleCount: baseMetrics.RecalcStyleCount,
    ScriptDuration: baseMetrics.ScriptDuration,
  },
  endMetrics: {
    Nodes: endMetrics.Nodes, JSEventListeners: endMetrics.JSEventListeners,
    LayoutCount: endMetrics.LayoutCount, RecalcStyleCount: endMetrics.RecalcStyleCount,
    ScriptDuration: endMetrics.ScriptDuration,
  },
  samples,
};

mkdirSync(resolve(HERE, "results"), { recursive: true });
const out = resolve(HERE, "results", `${label}.json`);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`\nwrote ${out}`);

await browser.close();
