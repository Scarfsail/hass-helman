import { expect, test } from "@playwright/test";
import { CARD_BUNDLE, loadBundle } from "./support/card-page";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { onDashboard } from "./support/node-detail-harness";

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


test("the question, tile and flow components are gone and nothing imports them", async () => {
    const { readdirSync, readFileSync, statSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "..");
    for (const file of ["cards/shared/node-question.ts", "cards/shared/node-tile.ts", "cards/shared/node-flow.ts", "tests/support/node-flow.ts"]) {
        expect(existsSync(join(root, file)), file).toBe(false);
    }
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
    });
    const importers = [...sources(join(root, "cards")), ...sources(join(root, "tests"))]
        .filter((path) => /from\s+["'][^"']*\/node-(question|tile|flow)["']|import\s+["'][^"']*\/node-(question|tile|flow)["']/.test(readFileSync(path, "utf8")));
    expect(importers).toEqual([]);
});

test("a Show more closes the node detail and navigates only once the detail's own Back step has landed", async ({ page }) => {
    await onDashboard(page);
    await loadBundle(page, "node-detail-dialog");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(() => {
        window.history.replaceState({ dashboard: "energy" }, "");
        const detail = document.createElement("node-detail-dialog") as any;
        detail.localize = (key: string) => key;
        detail.hass = { ...window.__mockHass(), states: {}, config: { time_zone: "UTC" } };
        detail.params = { nodeType: "house", item: { id: "house", children: [] } };
        // Any chart's Show more raises the one event; its href is the chart's own.
        detail._renderContent = () => {
            const link = document.createElement("button");
            link.dataset.showMore = "";
            link.addEventListener("click", () => link.dispatchEvent(new CustomEvent("helman-show-history",
                { detail: { href: "/history?entity_id=sensor.house" }, bubbles: true, composed: true })));
            return link;
        };
        detail.open = true;
        detail.addEventListener("closed", () => detail.remove());
        document.body.append(detail);
    });
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId)).toBeTruthy();
    await page.evaluate(() => {
        const detail = document.querySelector("node-detail-dialog") as any;
        detail.shadowRoot.querySelector("[data-dialog='close']").addEventListener("click", () => detail.shadowRoot.querySelector("ha-dialog").close());
        const log: string[] = (window as any).__historyLog = [];
        window.addEventListener("popstate", () => log.push("popstate"));
        window.addEventListener("location-changed", () => log.push(location.pathname + location.search));
    });
    await page.locator("node-detail-dialog [data-show-more]").click();
    await expect(page.locator("node-detail-dialog")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__historyLog)).toEqual(["popstate", "/history?entity_id=sensor.house"]);
    expect(await page.evaluate(() => location.pathname + location.search)).toBe("/history?entity_id=sensor.house");
    await page.evaluate(() => window.history.back());
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe("/lovelace/energy");
    expect(await page.evaluate(() => window.history.state)).toEqual({ dashboard: "energy" });
});

test("a Show more after node jumps unwinds every dialog history entry in one step and navigates", async ({ page }) => {
    await onDashboard(page);
    await loadBundle(page, "node-detail-dialog");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(() => {
        window.history.replaceState({ dashboard: "energy" }, "");
        const detail = document.createElement("node-detail-dialog") as any;
        detail.localize = (key: string) => key;
        detail.hass = { ...window.__mockHass(), states: {}, config: { time_zone: "UTC" } };
        detail.params = { nodeType: "house", item: { id: "house", children: [] } };
        detail._renderContent = () => {
            const link = document.createElement("button");
            link.dataset.showMore = "";
            link.addEventListener("click", () => link.dispatchEvent(new CustomEvent("helman-show-history",
                { detail: { href: "/history?entity_id=" + (detail.params.nodeType === "device" ? detail.params.item.id : detail.params.nodeType) }, bubbles: true, composed: true })));
            return link;
        };
        detail.open = true;
        detail.addEventListener("closed", () => detail.remove());
        document.body.append(detail);
    });
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId)).toBeTruthy();
    const firstId = await page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId);

    // Jump to another node inside the dialog
    await page.evaluate(() => {
        const detail = document.querySelector("node-detail-dialog") as any;
        detail.params = { nodeType: "device", item: { id: "kettle", children: [] } };
    });
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId)).toBeGreaterThan(firstId);

    await page.evaluate(() => {
        const detail = document.querySelector("node-detail-dialog") as any;
        detail.shadowRoot.querySelector("[data-dialog='close']").addEventListener("click", () => detail.shadowRoot.querySelector("ha-dialog").close());
        const log: string[] = (window as any).__historyLog = [];
        window.addEventListener("popstate", () => log.push("popstate"));
        window.addEventListener("location-changed", () => log.push(location.pathname + location.search));
    });

    await page.locator("node-detail-dialog [data-show-more]").click();
    await expect(page.locator("node-detail-dialog")).toHaveCount(0);
    // Unwinds both entries in a single popstate, then navigates to the show-more href
    await expect.poll(() => page.evaluate(() => (window as any).__historyLog)).toEqual(["popstate", "/history?entity_id=kettle"]);
    expect(await page.evaluate(() => location.pathname + location.search)).toBe("/history?entity_id=kettle");
    await page.evaluate(() => window.history.back());
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe("/lovelace/energy");
    expect(await page.evaluate(() => window.history.state)).toEqual({ dashboard: "energy" });
});

test("when an async return is superseded, the new node advances history and subsequent Back steps cleanly", async ({ page }) => {
    await onDashboard(page);
    await loadBundle(page, "node-detail-dialog");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(() => {
        window.history.replaceState({ dashboard: "energy" }, "");
        const detail = document.createElement("node-detail-dialog") as any;
        detail.localize = (key: string) => key;
        detail.hass = { ...window.__mockHass(), states: {}, config: { time_zone: "UTC" } };
        detail._renderContent = () => document.createElement("div");
        detail.params = { nodeType: "house", item: { id: "house", displayName: "House", children: [] } };
        detail.open = true;
        detail.addEventListener("closed", () => detail.remove());
        document.body.append(detail);
    });
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId)).toBeTruthy();
    const firstId = await page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId);

    // Jump to another node (kettle) inside the dialog
    await page.evaluate(() => {
        const detail = document.querySelector("node-detail-dialog") as any;
        detail.params = { nodeType: "device", item: { id: "kettle", displayName: "Kettle", children: [] } };
    });
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId)).toBeGreaterThan(firstId);
    const secondId = await page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId);

    // Host receives Back and starts an async return request for house
    await page.evaluate(() => {
        const detail = document.querySelector("node-detail-dialog") as any;
        detail.shadowRoot.querySelector("[data-dialog='close']").addEventListener("click", () => detail.shadowRoot.querySelector("ha-dialog").close());
        (window as any).__requestedTargets = [];
        detail.addEventListener("helman-node-detail-request", (e: CustomEvent) => {
            (window as any).__requestedTargets.push(e.detail.target);
        });
        window.history.back();
    });
    await expect.poll(() => page.evaluate(() => (window as any).__requestedTargets)).toEqual(["house"]);

    // Stale re-render of old node (kettle) while return is in flight (e.g. live hass update)
    await page.evaluate(() => {
        const detail = document.querySelector("node-detail-dialog") as any;
        detail.hass = { ...detail.hass };
    });

    // Superseded by a newer navigation to node X (solar)
    await page.evaluate(() => {
        const detail = document.querySelector("node-detail-dialog") as any;
        detail.params = { nodeType: "solar" };
    });
    // Node X advances the trail and pushes a new history entry rather than being stuck
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId)).toBeGreaterThan(secondId);
    await expect(page.locator("node-detail-dialog [slot=headerTitle]")).toHaveText("node_detail.title.solar");

    // Subsequent history.back() returns to house cleanly
    await page.evaluate(() => {
        const detail = document.querySelector("node-detail-dialog") as any;
        detail.addEventListener("helman-node-detail-request", (e: CustomEvent) => {
            if (e.detail.target === "house") {
                detail.params = { nodeType: "house", item: { id: "house", displayName: "House", children: [] } };
            }
        });
        window.history.back();
    });
    await expect(page.locator("node-detail-dialog [slot=headerTitle]")).toHaveText("node_detail.title.house");

    // Stepping back once more closes the dialog
    await page.evaluate(() => window.history.back());
    await expect(page.locator("node-detail-dialog")).toHaveCount(0);
    expect(await page.evaluate(() => window.history.state)).toEqual({ dashboard: "energy" });
});
