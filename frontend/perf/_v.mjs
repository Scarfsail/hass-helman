// Live validation of the P1 price strip against the real local Home Assistant.
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8123";
const TOKEN = process.env.HASS_TOKEN;
const DASHBOARD = "dashboard-helman";
const VIEW = process.argv[2] ?? "inspektor";
const OUT = process.argv[3] ?? "/tmp/strip.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1700, height: 1400 } });
const page = await context.newPage();
page.on("console", (m) => {
  if (/error/i.test(m.type()) && /helman|lit/i.test(m.text())) {
    console.log(`[console.error] ${m.text().slice(0, 300)}`);
  }
});
page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`));

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await sleep(2500);
await page.evaluate(({ token, base }) => {
  localStorage.setItem("hassTokens", JSON.stringify({
    access_token: token, token_type: "Bearer", expires_in: 1800,
    hassUrl: base, clientId: null, expires: Date.now() + 1800e3, refresh_token: "",
  }));
}, { token: TOKEN, base: BASE });

await page.goto(`${BASE}/${DASHBOARD}/${VIEW}`, { waitUntil: "domcontentloaded" });

// The strip lives several shadow roots deep; find it by tag name.
const findDeep = (tag) => {
  const seen = new Set();
  const walk = (root) => {
    if (!root || seen.has(root)) return null;
    seen.add(root);
    for (const el of root.querySelectorAll("*")) {
      if (el.localName === tag) return el;
      if (el.shadowRoot) { const hit = walk(el.shadowRoot); if (hit) return hit; }
    }
    return null;
  };
  return walk(document);
};

await page.waitForFunction(
  (src) => !!new Function(`return (${src})`)()("helman-solar-price-strip"),
  findDeep.toString(),
  { timeout: 90_000 },
);
await sleep(12_000);

// Read back what the strip actually drew, per rail.
const report = await page.evaluate((src) => {
  const find = new Function(`return (${src})`)();
  const strip = find("helman-solar-price-strip");
  if (!strip) return { error: "strip not found" };
  const rects = [...strip.shadowRoot.querySelectorAll("rect")]
    .filter((r) => r.style.fill && r.style.fill !== "none")
    .map((r) => ({
      x: Math.round(parseFloat(r.getAttribute("x"))),
      w: Math.round(parseFloat(r.getAttribute("width"))),
      fill: r.style.fill,
    }));
  const byFill = {};
  for (const r of rects) (byFill[r.fill] ??= []).push(r);
  return {
    date: strip.date,
    slotMinutes: strip.slotMinutes,
    unit: strip.unit,
    importPoints: strip.importPrice?.length ?? 0,
    exportPoints: strip.exportPrice?.length ?? 0,
    importSample: (strip.importPrice ?? []).slice(0, 3),
    exportSample: (strip.exportPrice ?? []).slice(0, 3),
    barsByFill: Object.fromEntries(
      Object.entries(byFill).map(([fill, rs]) => [
        fill,
        { count: rs.length, widths: [...new Set(rs.map((r) => r.w))].sort((a, b) => a - b) },
      ]),
    ),
  };
}, findDeep.toString());
console.log(JSON.stringify(report, null, 2));

const handle = await page.evaluateHandle(
  (src) => new Function(`return (${src})`)()("helman-solar-price-strip"),
  findDeep.toString(),
);
const el = handle.asElement();
if (el) await el.screenshot({ path: OUT });
console.log(`screenshot: ${OUT}`);
await browser.close();
