// A V8 CPU profile of an idle dashboard, attributed per function.
//
//   node perf/profile.mjs <view> <seconds> <label>
//
// Wrapping functions by hand and timing them with `performance.now()` measures
// wall time, which inflates badly once the main thread is saturated — the very
// condition being investigated. The sampling profiler does not have that
// problem: it attributes real CPU, so the numbers here are the ones to trust
// for "what is the page actually spending its time on".

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
const seconds = Number(process.argv[3] ?? 30);
const label = process.argv[4] ?? "profile";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

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

await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
await sleep(seconds * 1000);
const { profile } = await cdp.send("Profiler.stop");

// Self time per node, from the sample counts and the deltas between them.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const selfUs = new Map();
const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
}

const rows = [];
for (const [id, us] of selfUs) {
  const node = byId.get(id);
  if (!node) continue;
  const f = node.callFrame;
  const where = f.url ? f.url.replace(/^https?:\/\/[^/]+/, "") : "";
  rows.push({
    fn: f.functionName || "(anonymous)",
    at: `${where}:${f.lineNumber + 1}`,
    selfMs: us / 1000,
    pct: (100 * us) / total,
  });
}
rows.sort((a, b) => b.selfMs - a.selfMs);

const idle = rows.find((r) => r.fn === "(idle)")?.selfMs ?? 0;
const busyMs = total / 1000 - idle;
console.log(`\n${label}  view=${view}  profiled ${(total / 1e6).toFixed(1)}s`);
console.log(`busy: ${(busyMs / 1000).toFixed(1)}s of ${(total / 1e6).toFixed(1)}s = ${(100 * busyMs) / (total / 1000)}%`.replace(/(\d+\.\d\d)\d+%/, "$1%"));
console.log(`\n${"self ms".padStart(9)} ${"% cpu".padStart(6)}  function`);
for (const r of rows.slice(0, 45)) {
  console.log(`${r.selfMs.toFixed(0).padStart(9)} ${r.pct.toFixed(2).padStart(6)}  ${r.fn}  ${r.at}`);
}

mkdirSync(resolve(HERE, "results"), { recursive: true });
writeFileSync(resolve(HERE, "results", `${label}.cpuprofile`), JSON.stringify(profile));
writeFileSync(resolve(HERE, "results", `${label}-self.json`), JSON.stringify(rows.slice(0, 200), null, 2));
console.log(`\nwrote perf/results/${label}.cpuprofile`);

await browser.close();
