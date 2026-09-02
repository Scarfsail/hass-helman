import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installFakeHass } from "./support/fake-hass";

/**
 * `dim_incomplete_slots` on `helman-solar-inspector-card`.
 *
 * The dimming is the only #202 mark with no runtime control -- there is no
 * legend tile for it -- so the config is the one way to switch it off, for a
 * reader who would rather read the chart than be told where it is short.
 *
 * What it must not switch off is the wording: the daily total of an incomplete
 * series keeps its marker either way. The dimming is a chart treatment and can
 * be a matter of taste; a total quietly reading low is a fact about the number.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Mount the wrapper card against the fake backend with the given config. */
async function mountCard(page: Page, config: Record<string, unknown>): Promise<void> {
    await page.goto("about:blank");
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector-card"));
    await installFakeHass(page, { pillDays: 4 });

    await page.evaluate((cfg) => {
        (window as unknown as { __inspectorRoot: () => ShadowRoot | null | undefined })
            .__inspectorRoot = () =>
                document.querySelector("helman-solar-inspector-card")
                    ?.shadowRoot?.querySelector("helman-solar-inspector")?.shadowRoot;

        const card = document.createElement("helman-solar-inspector-card") as HTMLElement &
            { setConfig: (config: unknown) => void; hass: unknown };
        card.setConfig({ type: "custom:helman-solar-inspector-card", ...cfg });
        card.hass = (window as unknown as { __fakeHass: unknown }).__fakeHass;
        document.body.appendChild(card);
    }, config);

    await page.waitForFunction(() => (window as unknown as {
        __pendingInspector: () => number;
    }).__pendingInspector() === 1);
    await page.evaluate(() => (window as unknown as {
        __releaseInspector: () => void;
    }).__releaseInspector());
    await page.waitForFunction(() => !!(window as unknown as {
        __inspectorRoot: () => ShadowRoot | null | undefined;
    }).__inspectorRoot()?.querySelector(".metric-card"));
}

/**
 * Give the day a house-actual series with a two-slot hole, and draw it at hour
 * width so the 10:00 column is short of two of its four readings.
 *
 * Written rather than filtered: the fake backend serves this series empty, so
 * there is nothing to punch a hole in until there is a series.
 */
async function punchHoleAtHourWidth(page: Page): Promise<void> {
    await page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        const payload = JSON.parse(JSON.stringify(el._payload));
        const points = [];
        for (let minutes = 0; minutes < 1440; minutes += 15) {
            if (minutes === 615 || minutes === 630) continue; // 10:15, 10:30
            const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
            const mm = String(minutes % 60).padStart(2, "0");
            points.push({ timestamp: `${payload.date}T${hh}:${mm}:00`, valueWh: -200 });
        }
        payload.series.houseActual = points;
        payload.totals.houseActualWh = -18000;
        el._payload = payload;
        el._slotMinutes = 60;
        el.requestUpdate();
    });
    await page.waitForFunction(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        return !!(root?.host as any).updateComplete;
    });
}

/** How many columns the chart is currently dimming. */
function dimmedColumns(page: Page): Promise<number> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        return root?.querySelectorAll(".chart-wrap svg g.partial-bucket-mark").length ?? 0;
    });
}

/** Whether any daily total is carrying the incomplete marker. */
function totalsMarked(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const sections = [...(root?.querySelectorAll(".metrics-section") ?? [])];
        const totals = sections.find((section) =>
            section.querySelector("strong")?.textContent?.includes("Daily totals"));
        return !!totals?.querySelector(".incomplete-mark");
    });
}

test("an unset option dims the incomplete column", async ({ page }) => {
    await mountCard(page, {});
    await punchHoleAtHourWidth(page);

    expect(await dimmedColumns(page)).toBe(1);
    expect(await totalsMarked(page)).toBe(true);
});

test("dim_incomplete_slots: false leaves the chart alone but still marks the total", async ({ page }) => {
    await mountCard(page, { dim_incomplete_slots: false });
    await punchHoleAtHourWidth(page);

    expect(await dimmedColumns(page)).toBe(0);
    expect(await totalsMarked(page)).toBe(true);
});
