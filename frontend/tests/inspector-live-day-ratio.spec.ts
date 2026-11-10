import { test, expect, type Page } from "@playwright/test";
import { loadBundle } from "./support/card-page";

/** Today's live day ratio as a line in the inspector's daily totals, absent on any other day. */

const LIVE = { ratio: 0.6, appliedRatio: 0.6, weight: 0.8, factor: 0.6 ** 0.8, elapsedShare: 0.4 };

async function mountInspector(page: Page, liveDayRatio: typeof LIVE | null, language = "en"): Promise<void> {
    await loadBundle(page, "helman-solar-inspector");
    await page.evaluate(({ liveDayRatio, language }) => {
        const payload = window.__inspectorDay({
            date: "2026-11-10",
            status: "applied",
            effectiveVariant: "adjusted",
            range: { minDate: "2026-11-10", maxDate: "2026-11-10", isToday: liveDayRatio !== null },
            series: { corrected: [{ slot: "10:00", valueWh: 100 }] },
            totals: { rawWh: 100, correctedWh: 100, actualWh: 50 },
            availability: { hasProfile: true },
            liveDayRatio,
        });
        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.hass = {
            language,
            locale: { language },
            config: { time_zone: "UTC" },
            connection: {},
            callWS: window.__mockHass({
                "helman/solar_bias/inspector": async (msg: { date: string }) => ({ ...payload, date: msg.date }),
            }).callWS,
        };
        document.body.appendChild(el);
    }, { liveDayRatio, language });
    await page.waitForFunction(() =>
        !!(document.querySelector("helman-solar-inspector") as any)?.shadowRoot?.querySelector(".metric-card"));
}

function metric(page: Page, label: string): Promise<string | null> {
    return page.evaluate((wanted) => {
        const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
        const card = [...root.querySelectorAll(".metric-card")].find(
            (node: Element) => node.querySelector(".metric-label")?.textContent?.trim() === wanted,
        );
        return card?.querySelector(".metric-value")?.textContent?.trim() ?? null;
    }, label);
}

test("today's totals show the live day ratio and its trust", async ({ page }) => {
    await mountInspector(page, LIVE);
    expect(await metric(page, "Today's live ratio")).toBe("× 0.66 · 80 % trusted");
});

test("the live day ratio uses the viewer's decimals", async ({ page }) => {
    await mountInspector(page, LIVE, "cs");
    expect(await metric(page, "Dnešní živý poměr")).toBe("× 0,66 · důvěra 80 %");
});

test("a day without a live day ratio shows no such line", async ({ page }) => {
    await mountInspector(page, null);
    expect(await metric(page, "Today's live ratio")).toBeNull();
});
