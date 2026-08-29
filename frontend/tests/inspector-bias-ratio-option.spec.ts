import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installFakeHass } from "./support/fake-hass";

/**
 * `show_bias_ratio` on `helman-solar-inspector-card`.
 *
 * The bias-correction diagnostics — the uncorrected ("raw") forecast overlay and
 * the correction impact / per-slot factor / contribution table that ride with it
 * — are hidden when the card opens and revealed at runtime by the chart legend.
 * Since the legend tile that toggles them is itself only drawn once they are
 * shown, a card configured to open with them hidden has no way back to them.
 *
 * The option gives the config that way in: `show_bias_ratio: true` seeds the
 * card so the raw diagnostic starts visible. It defaults to false, so the
 * opening state is unchanged for every card that does not set it.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const PILL_DAYS = 4;

/** Mount the wrapper card against the fake backend with the given config. */
async function mountCard(page: Page, config: Record<string, unknown>): Promise<void> {
    await page.goto("about:blank");
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector-card"));
    await installFakeHass(page, { pillDays: PILL_DAYS });

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

/** Whether the inspector currently counts the raw-forecast series as visible. */
function rawVisible(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as unknown as { _isSeriesVisible: (s: string) => boolean };
        return el._isSeriesVisible("raw");
    });
}

/** Whether the daily-totals panel is showing the "Raw forecast" tile. */
function rawTileShown(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const labels = [...(root?.querySelectorAll(".metric-label") ?? [])];
        return labels.some((n) => n.textContent?.trim() === "Raw forecast");
    });
}

/** Whether the correction-impact strip is currently drawn under the chart. */
function impactStripShown(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        return !!root?.querySelector(".impact-strip-wrap");
    });
}

test("the raw diagnostic stays hidden when the option is unset", async ({ page }) => {
    await mountCard(page, {});

    expect(await rawVisible(page)).toBe(false);
    expect(await rawTileShown(page)).toBe(false);
    expect(await impactStripShown(page)).toBe(false);
});

test("show_bias_ratio: true opens the card with the raw diagnostic visible", async ({ page }) => {
    await mountCard(page, { show_bias_ratio: true });

    expect(await rawVisible(page)).toBe(true);
    expect(await rawTileShown(page)).toBe(true);
    expect(await impactStripShown(page)).toBe(true);
});
