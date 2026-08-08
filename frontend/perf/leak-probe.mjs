// Where are the DOM nodes going?
//
//   node perf/leak-probe.mjs <view> <seconds> <label>
//
// The idle runs show the document's node count climbing while the number of
// custom elements stays flat, so the growth is plain DOM inside something that
// is already mounted. This walks every shadow root on a schedule and reports
// the subtree size of each host, so the growth can be attributed to one.

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.HASS_URL ?? "http://127.0.0.1:8123";
const DASHBOARD = process.env.HASS_DASHBOARD ?? "dashboard-helman";
const TOKEN = process.env.HASS_TOKEN;
if (!TOKEN) throw new Error("HASS_TOKEN not set — see perf/README.md");

const view = process.argv[2] ?? "0";
const seconds = Number(process.argv[3] ?? 600);
const label = process.argv[4] ?? "leak";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await sleep(2500);
await page.evaluate(({ token, base }) => {
  localStorage.setItem("hassTokens", JSON.stringify({
    access_token: token, token_type: "Bearer", expires_in: 1800,
    hassUrl: base, clientId: null, expires: Date.now() + 1800 * 1000, refresh_token: "",
  }));
}, { token: TOKEN, base: BASE });
await page.goto(`${BASE}/${DASHBOARD}/${view}`, { waitUntil: "domcontentloaded" });
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
await sleep(20_000);

// Subtree size per shadow host, keyed by tag plus an index for repeats.
const measure = () => page.evaluate(() => {
  const sizes = {};
  const seen = new Set();
  const countIn = (root) => {
    let n = 0;
    for (const el of root.querySelectorAll("*")) {
      n += 1;
      if (el.shadowRoot) n += countIn(el.shadowRoot);
    }
    return n;
  };
  const walk = (root) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const key = el.localName;
        sizes[key] = (sizes[key] ?? 0) + el.shadowRoot.querySelectorAll("*").length;
        walk(el.shadowRoot);
      }
    }
  };
  walk(document);
  sizes["__lightDom"] = document.querySelectorAll("*").length;
  return sizes;
});

const metrics = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const out = {};
  for (const m of metrics) out[m.name] = m.value;
  return out;
};

const samples = [];
const stepMs = 60_000;
const steps = Math.max(2, Math.round((seconds * 1000) / stepMs));
for (let i = 0; i <= steps; i++) {
  if (i > 0) await sleep(stepMs);
  const m = await metrics();
  samples.push({ atSec: i * (stepMs / 1000), sizes: await measure(), nodes: m.Nodes, listeners: m.JSEventListeners });
  console.log(`t=${i * 60}s nodes=${m.Nodes} listeners=${m.JSEventListeners}`);
}

const first = samples[0].sizes;
const last = samples[samples.length - 1].sizes;
const growth = Object.keys(last)
  .map((k) => ({ tag: k, from: first[k] ?? 0, to: last[k], delta: last[k] - (first[k] ?? 0) }))
  .filter((r) => Math.abs(r.delta) > 5)
  .sort((a, b) => b.delta - a.delta);

console.log(`\nnodes ${samples[0].nodes} -> ${samples[samples.length - 1].nodes} over ${steps * 60}s`);
console.log(`\n${"delta".padStart(8)} ${"from".padStart(8)} ${"to".padStart(8)}  shadow host`);
for (const r of growth.slice(0, 30)) {
  console.log(`${String(r.delta).padStart(8)} ${String(r.from).padStart(8)} ${String(r.to).padStart(8)}  ${r.tag}`);
}

mkdirSync(resolve(HERE, "results"), { recursive: true });
writeFileSync(resolve(HERE, "results", `${label}.json`), JSON.stringify({ label, view, samples, growth }, null, 2));
console.log(`\nwrote perf/results/${label}.json`);
await browser.close();
