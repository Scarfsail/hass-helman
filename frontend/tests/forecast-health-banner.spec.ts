import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The forecast-health banner is the only user-visible signal that the backend's
 * forecast refresh loop has stopped: reads no longer rebuild, so a card happily
 * renders a week-old snapshot without it. Two properties are worth pinning —
 * it stays completely invisible while the forecast is healthy (it is mounted
 * unconditionally in dense cards), and when something is stale it names which
 * half and how old.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

type Health = {
    generatedAt: string | null;
    isStale: boolean;
    reason: string | null;
    hint: string | null;
};

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() =>
        !!customElements.get("helman-forecast-health-banner"),
    );
}

/** Mount the banner with the given items and return its rendered text (empty when it draws nothing). */
async function renderBanner(
    page: Page,
    items: Array<{ label: string; health: Health | null }>,
): Promise<string> {
    return page.evaluate(async (mounted) => {
        const el = document.createElement("helman-forecast-health-banner") as any;
        // English keys, so the assertions read in the language of the source.
        el.localize = (key: string) =>
            ({
                "forecast_health.reason.stale_forecast": "has not refreshed for over an hour",
                "forecast_health.reason.unknown": "reported a problem",
                "forecast_health.age.minutes": "min ago",
                "forecast_health.age.hours": "h ago",
                "forecast_health.age.days": "d ago",
                "forecast_health.age.never": "never built",
            })[key] ?? key;
        el.items = mounted;
        document.body.appendChild(el);
        await el.updateComplete;
        return (el.shadowRoot!.textContent ?? "").replace(/\s+/g, " ").trim();
    }, items);
}

function healthyAt(minutesAgo: number): Health {
    return {
        generatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        isStale: false,
        reason: null,
        hint: null,
    };
}

function staleAt(minutesAgo: number): Health {
    return {
        generatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        isStale: true,
        reason: "stale_forecast",
        hint: "Forecast has not been rebuilt for over an hour.",
    };
}

test.describe("helman-forecast-health-banner", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("draws nothing while every forecast is healthy", async ({ page }) => {
        const text = await renderBanner(page, [
            { label: "Solar forecast", health: healthyAt(7) },
            { label: "House consumption forecast", health: healthyAt(7) },
        ]);

        expect(text).toBe("");
    });

    test("draws nothing when no health block was supplied at all", async ({ page }) => {
        // An older backend sends no staleness block; the card must not warn on that.
        const text = await renderBanner(page, [
            { label: "Solar forecast", health: null },
        ]);

        expect(text).toBe("");
    });

    test("names the stale half and how old it is, and stays silent about the healthy one", async ({ page }) => {
        const text = await renderBanner(page, [
            { label: "Solar forecast", health: staleAt(3 * 60) },
            { label: "House consumption forecast", health: healthyAt(5) },
        ]);

        expect(text).toContain("Solar forecast");
        expect(text).toContain("has not refreshed for over an hour");
        expect(text).toContain("3 h ago");
        expect(text).not.toContain("House consumption forecast");
    });

    test("wording comes from the localized reason, not the backend's English hint", async ({ page }) => {
        const text = await renderBanner(page, [
            { label: "Solar forecast", health: staleAt(90) },
        ]);

        expect(text).not.toContain("Forecast has not been rebuilt");
        expect(text).toContain("1 h ago");
    });

    test("falls back to the backend hint for a reason this frontend does not know", async ({ page }) => {
        // What P3's trained-profile warning looks like before it gets its own key.
        const text = await renderBanner(page, [
            {
                label: "Solar bias profile",
                health: {
                    generatedAt: null,
                    isStale: true,
                    reason: "untrained_profile",
                    hint: "No trained bias profile yet.",
                },
            },
        ]);

        expect(text).toContain("No trained bias profile yet.");
        expect(text).toContain("never built");
    });
});
