import { test, expect } from "@playwright/test";
import { loadBundle } from "./support/card-page";
import { cardTree } from "./support/payload-builders";

test("stacked schedule Back closes the schedule before the node detail", async ({ page }) => {
    await loadBundle(page, "node-detail-dialog");
    await page.evaluate(() => {
        window.history.replaceState({ dashboard: "energy" }, "");
        const detail = document.createElement("node-detail-dialog") as any;
        detail.localize = (key: string) => key;
        detail.hass = { ...window.__mockHass(), states: {}, config: { time_zone: "UTC" } };
        detail.params = { nodeType: "house", item: { id: "house", children: [] } };
        // Contents have their own specs; this pins the two real dialog lifecycles.
        detail._renderContent = () => null;
        detail.open = true;
        detail.addEventListener("closed", () => { detail.open = false; });
        document.body.append(detail);
    });
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanNodeDetailDialogId)).toBeTruthy();
    await page.evaluate(() => {
        const detail = document.querySelector("node-detail-dialog") as any;
        detail.shadowRoot.querySelector("[data-dialog='close']").addEventListener("click", () => detail._onClosed());
        const editor = document.createElement("scheduling-entity-day-editor") as any;
        editor.localize = (key: string) => key;
        editor.target = "boiler";
        editor.dayKey = "2026-07-24";
        editor.open = true;
        document.body.append(editor);
    });
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanEntityScheduleDialogId)).toBeTruthy();
    expect(await page.evaluate(() => ({ dashboard: window.history.state.dashboard, detail: !!window.history.state.__helmanNodeDetailDialogId }))).toEqual({ dashboard: "energy", detail: true });
    await page.evaluate(() => window.history.back());
    await expect.poll(() => page.evaluate(() => (document.querySelector("scheduling-entity-day-editor") as any).open)).toBe(false);
    expect(await page.evaluate(() => (document.querySelector("node-detail-dialog") as any).open)).toBe(true);
    await page.evaluate(() => window.history.back());
    await expect.poll(() => page.evaluate(() => (document.querySelector("node-detail-dialog") as any).open)).toBe(false);
    expect(await page.evaluate(() => window.history.state)).toEqual({ dashboard: "energy" });
});

test("a config-filtered power card ignores schedule and reloads config", async ({ page }) => {
    await loadBundle(page, "helman-simple-card");
    await page.evaluate((tree) => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        card.hass = { ...window.__mockHass({ "helman/get_device_tree": tree, "helman/get_history": { entity_history: {} } }), language: "en", states: {}, config: { time_zone: "UTC" } };
        document.body.append(card);
    }, cardTree());
    const reads = () => page.evaluate(() => window.__mockRequests.filter((request) => request.type === "helman/get_device_tree").length);
    await expect.poll(reads).toBe(1);
    await page.evaluate(() => window.__fireDataChanged("schedule"));
    await page.waitForTimeout(550);
    expect(await reads()).toBe(1);
    await page.evaluate(() => window.__fireDataChanged("config"));
    await expect.poll(reads).toBe(2);
});
