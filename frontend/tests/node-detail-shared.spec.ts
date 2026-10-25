import { expect, test } from "@playwright/test";
import { CARD_BUNDLE } from "./support/card-page";

test.beforeEach(async ({ page }) => {
    await page.setContent("<div id='mount' style='width:320px'></div>");
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-flow-gauge"));
});

test("a single 0.8 kW gauge segment fills the bar and opens its node", async ({ page }) => {
    await page.evaluate(() => {
        (window as any).__target = null;
        const gauge = document.createElement("helman-flow-gauge") as any;
        gauge.items = [{ node: "solar", powerW: 800 }];
        gauge.localize = (key: string) => key;
        gauge.addEventListener("helman-node-detail-request", (event: Event) => { (window as any).__target = (event as CustomEvent).detail.target; });
        document.getElementById("mount")!.append(gauge);
    });
    const gauge = page.locator("helman-flow-gauge");
    const widths = await gauge.evaluate((el) => {
        const bar = el.shadowRoot!.querySelector(".bar")!.getBoundingClientRect();
        const segment = el.shadowRoot!.querySelector("button")!.getBoundingClientRect();
        return { bar: bar.width, segment: segment.width };
    });
    expect(widths.segment).toBeCloseTo(widths.bar, 0);
    await expect(gauge.locator(".percent")).toHaveText("100 %");
    await gauge.locator("button").click();
    expect(await page.evaluate(() => (window as any).__target)).toBe("solar");
});

test("help tips close on Escape and opening another tip", async ({ page }) => {
    await page.evaluate(() => {
        for (const explanation of ["First explanation", "Second explanation"]) {
            const tip = document.createElement("helman-help-tip") as any;
            tip.explanation = explanation;
            document.getElementById("mount")!.append(tip);
        }
    });
    const tips = page.locator("helman-help-tip");
    await tips.first().locator("button").click();
    await expect(tips.first().locator(".popup")).toBeVisible();
    await tips.nth(1).locator("button").click();
    await expect(tips.first().locator(".popup")).toBeHidden();
    await expect(tips.nth(1).locator(".popup")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tips.nth(1).locator(".popup")).toBeHidden();
});

test("a help popup near the right edge stays inside a 390 px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.evaluate(() => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:flex-end;box-sizing:border-box;padding-right:16px;width:390px";
        const tip = document.createElement("helman-help-tip") as any;
        tip.explanation = "A long explanation that would run past the right edge of the narrow viewport when start-aligned, so it has to flip.";
        row.append(tip);
        document.getElementById("mount")!.style.width = "390px";
        document.getElementById("mount")!.append(row);
    });
    await page.locator("helman-help-tip button").click();
    const popup = page.locator("helman-help-tip .popup");
    await expect(popup).toBeVisible();
    await expect.poll(async () => {
        const box = (await popup.boundingBox())!;
        return box.x >= 0 && box.x + box.width <= 390;
    }).toBe(true);
});

