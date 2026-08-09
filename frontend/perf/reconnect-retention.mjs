// Does a websocket reconnect leave a detached copy of the cards behind?
//
//   node perf/reconnect-retention.mjs <view> [reconnects]
//
// The idle runs show the document's node count taking one large step and never
// coming back, and a walk of the attached tree cannot find the extra nodes —
// which is what detached-but-retained DOM looks like. `Runtime.queryObjects`
// settles the question: it returns every live object with a given prototype, so
// comparing that count against the number actually in the document says whether
// the retained copy is ours.

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
const reconnects = Number(process.argv[3] ?? 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAGS = [
  "helman-card", "helman-simple-card", "helman-solar-inspector-card",
  "helman-solar-inspector", "helman-solar-day-pills",
  "helman-solar-schedule-band-strip", "helman-solar-export-price-strip",
  "scheduling-entity-day-band", "power-device", "helman-power-history-bars",
  // Home Assistant's own elements, as the control: if these duplicate too then
  // the retention is the dashboard's, not the cards'.
  "hui-view", "hui-section", "hui-card", "ha-card", "hui-heading-card",
  "hui-entities-card", "hui-masonry-view", "hui-sections-view",
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Runtime.enable");
await cdp.send("HeapProfiler.enable");
await cdp.send("Performance.enable");

// Keep every socket the page opens, so a reconnect can be forced on demand.
await context.addInitScript(() => {
  const Orig = window.WebSocket;
  window.__sockets = [];
  function Patched(url, protocols) {
    const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    window.__sockets.push(ws);
    return ws;
  }
  Patched.prototype = Orig.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Patched[k] = Orig[k];
  window.WebSocket = Patched;
});

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
      if (el.localName.startsWith("helman-") || el.localName === "hui-card") return true;
      if (el.shadowRoot && walk(el.shadowRoot)) return true;
    }
    return false;
  };
  return walk(document);
}, null, { timeout: 60_000 });
await sleep(20_000);

/** How many of each tag are reachable from the document right now. */
const attached = () => page.evaluate((tags) => {
  const counts = Object.fromEntries(tags.map((t) => [t, 0]));
  const seen = new Set();
  const walk = (root) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    for (const el of root.querySelectorAll("*")) {
      if (el.localName in counts) counts[el.localName] += 1;
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return counts;
}, TAGS);

/** How many exist at all — attached or not — after a forced GC. */
async function live() {
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(500);
  const out = {};
  for (const tag of TAGS) {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(customElements.get(${JSON.stringify(tag)}) || {}).prototype`,
    });
    if (!result.objectId) { out[tag] = null; continue; }
    const { objects } = await cdp.send("Runtime.queryObjects", { prototypeObjectId: result.objectId });
    const { result: count } = await cdp.send("Runtime.callFunctionOn", {
      objectId: objects.objectId,
      functionDeclaration: "function () { return this.length; }",
      returnByValue: true,
    });
    out[tag] = count.value;
    await cdp.send("Runtime.releaseObject", { objectId: objects.objectId });
    await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
  }
  return out;
}

const nodes = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === "Nodes").value;
};

const rows = [];
rows.push({ phase: "baseline", nodes: await nodes(), attached: await attached(), live: await live() });
console.log("baseline", JSON.stringify(rows[0], null, 1));

for (let i = 1; i <= reconnects; i++) {
  await page.evaluate(() => { for (const ws of window.__sockets) try { ws.close(); } catch {} });
  await sleep(25_000); // HA backs off before retrying
  await page.waitForFunction(() => {
    const seen = new Set();
    const walk = (root) => {
      if (!root || seen.has(root)) return false;
      seen.add(root);
      for (const el of root.querySelectorAll("*")) {
        if (el.localName.startsWith("helman-") || el.localName === "hui-card") return true;
        if (el.shadowRoot && walk(el.shadowRoot)) return true;
      }
      return false;
    };
    return walk(document);
  }, null, { timeout: 60_000 });
  await sleep(15_000);
  const row = { phase: `after reconnect ${i}`, nodes: await nodes(), attached: await attached(), live: await live() };
  rows.push(row);
  console.log(row.phase, JSON.stringify(row, null, 1));
}

console.log(`\n${"tag".padEnd(36)} ${"attached".padStart(9)} ${"live".padStart(6)}  (last phase)`);
const last = rows[rows.length - 1];
for (const tag of TAGS) {
  const a = last.attached[tag] ?? 0;
  const l = last.live[tag];
  if (a === 0 && !l) continue;
  console.log(`${tag.padEnd(36)} ${String(a).padStart(9)} ${String(l).padStart(6)}${l > a ? `   <-- ${l - a} retained but detached` : ""}`);
}
console.log("\nnodes:", rows.map((r) => r.nodes).join(" -> "));

mkdirSync(resolve(HERE, "results"), { recursive: true });
writeFileSync(resolve(HERE, "results", `reconnect-${view}.json`), JSON.stringify(rows, null, 2));
await browser.close();
