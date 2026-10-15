import { test, expect } from "@playwright/test";
import { CARD_BUNDLE } from "./support/card-page";
import { installMockHass } from "./support/mock-hass";
import { cardTree } from "./support/payload-builders";

for (const tag of ["helman-card", "helman-simple-card"] as const) {
    test(`${tag} shares the fresh tree with cards mounted after a config announcement`, async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        await page.evaluate((initial) => {
            const next = structuredClone(initial);
            next.sources[0].powerSensorId = "sensor.new_solar";
            next.sources[0].displayName = "New solar meter";
            const releases: Array<() => void> = [];
            (window as any).__releaseTree = (index: number) => releases[index]();
            (window as any).__hass = {
                ...window.__mockHass({
                    "helman/get_device_tree": () => new Promise((resolve) => {
                        const index = releases.length;
                        releases.push(() => resolve(index === 0 ? initial : next));
                    }),
                    "helman/get_history": { entity_history: {} },
                }),
                language: "en", locale: { language: "en" }, config: { time_zone: "UTC" }, states: {},
            };
        }, cardTree());
        await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
        const mount = (id: string) => page.evaluate(({ name, id }) => {
            const card = document.createElement(name) as any;
            card.id = id;
            card.setConfig({ type: `custom:${name}` });
            card.hass = (window as any).__hass;
            document.body.appendChild(card);
        }, { name: tag, id });
        const treeRequests = () => page.evaluate(() => window.__mockRequests.filter((request) => request.type === "helman/get_device_tree").length);
        const currentTree = (id: string) => page.evaluate(({ name, id }) => {
            const card = document.getElementById(id) as any;
            return name === "helman-card"
                ? card._deviceTree[0]?.children[0]?.name
                : card._entityMap?.solarPowerEntityId;
        }, { name: tag, id });
        const expected = tag === "helman-card" ? "New solar meter" : "sensor.new_solar";

        await mount("first");
        await expect.poll(treeRequests).toBe(1);
        await page.evaluate(() => window.__fireDataChanged("config"));
        await expect.poll(treeRequests).toBe(2);
        await mount("second");
        await page.evaluate(async () => {
            (window as any).__releaseTree(0);
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(await currentTree("second")).toBeFalsy();
        await mount("third");
        expect(await treeRequests()).toBe(2);
        await page.evaluate(() => (window as any).__releaseTree(1));
        await expect.poll(() => currentTree("second")).toBe(expected);
        await expect.poll(() => currentTree("third")).toBe(expected);
    });

    test(`${tag} ignores an older pending tree after a config announcement`, async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        await page.evaluate((initial) => {
            const next = structuredClone(initial);
            next.sources[0].powerSensorId = "sensor.new_solar";
            next.sources[0].displayName = "New solar meter";
            (window as any).__releaseOldTree = () => undefined;
            const hass = window.__mockHass({
                "helman/get_device_tree": () => {
                    if (window.__mockRequests.filter((request) => request.type === "helman/get_device_tree").length === 1) {
                        return new Promise((resolve) => { (window as any).__releaseOldTree = () => resolve(initial); });
                    }
                    return next;
                },
                "helman/get_history": { entity_history: {} },
            });
            (window as any).__hass = {
                ...hass, language: "en", locale: { language: "en" }, config: { time_zone: "UTC" }, states: {},
            };
        }, cardTree());
        await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
        await page.evaluate((name) => {
            const card = document.createElement(name) as any;
            card.setConfig({ type: `custom:${name}` });
            card.hass = (window as any).__hass;
            document.body.appendChild(card);
        }, tag);
        const treeRequests = () => page.evaluate(() => window.__mockRequests.filter((request) => request.type === "helman/get_device_tree").length);
        const currentTree = () => page.evaluate((name) => {
            const card = document.querySelector(name) as any;
            return name === "helman-card"
                ? card._deviceTree[0]?.children[0]?.name
                : card._entityMap?.solarPowerEntityId;
        }, tag);
        const expected = tag === "helman-card" ? "New solar meter" : "sensor.new_solar";
        await expect.poll(treeRequests).toBe(1);
        await page.evaluate(() => window.__fireDataChanged("config"));
        await expect.poll(treeRequests).toBe(2);
        await expect.poll(currentTree).toBe(expected);
        await page.evaluate(async () => {
            (window as any).__releaseOldTree();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await expect.poll(currentTree).toBe(expected);
    });

    test(`${tag} fetches and renders a changed device tree after a config announcement`, async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        await page.evaluate((initial) => {
            const next = structuredClone(initial);
            next.sources[0].powerSensorId = "sensor.new_solar";
            next.sources[0].displayName = "New solar meter";
            (window as any).__hass = {
                language: "en", locale: { language: "en" }, config: { time_zone: "UTC" },
                states: {
                    "sensor.solar": { state: "100", attributes: { unit_of_measurement: "W" } },
                    "sensor.new_solar": { state: "800", attributes: { unit_of_measurement: "W" } },
                    "sensor.house": { state: "100", attributes: { unit_of_measurement: "W" } },
                },
                connection: window.__mockHass().connection,
                callWS: window.__mockHass({
                    "helman/get_device_tree": () => (window as any).__tree,
                    "helman/get_history": { entity_history: {} },
                }).callWS,
            };
            (window as any).__tree = initial;
            (window as any).__nextTree = next;
        }, cardTree());
        await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
        await page.evaluate((name) => {
            const card = document.createElement(name) as any;
            card.setConfig({ type: `custom:${name}` });
            card.hass = (window as any).__hass;
            document.body.appendChild(card);
        }, tag);
        await expect.poll(() => page.evaluate(() => window.__mockRequests.filter((r) => r.type === "helman/get_device_tree").length)).toBe(1);
        await page.evaluate(() => {
            (window as any).__tree = (window as any).__nextTree;
            window.__fireDataChanged("config");
        });
        await expect.poll(() => page.evaluate(() => window.__mockRequests.filter((r) => r.type === "helman/get_device_tree").length)).toBe(2);
        await expect.poll(() => page.evaluate((name) => {
            const card = document.querySelector(name) as any;
            return name === "helman-card"
                ? card._deviceTree[0]?.children[0]?.name
                : card._entityMap?.solarPowerEntityId;
        }, tag)).toBe(tag === "helman-card" ? "New solar meter" : "sensor.new_solar");
        if (tag === "helman-card") {
            await expect(page.locator("helman-card")).toContainText("New solar meter");
        } else {
            await expect.poll(() => page.evaluate(() =>
                (document.querySelector("helman-simple-card")!.shadowRoot!.querySelector("simple-card-solar") as any).power,
            )).toBe(800);
        }

        await page.evaluate((name) => {
            (window as any).__detachedCard = document.querySelector(name)!;
            (window as any).__detachedCard.remove();
            window.__fireDataChanged("config");
        }, tag);
        await page.waitForTimeout(600);
        expect(await page.evaluate(() => window.__mockRequests.filter((r) => r.type === "helman/get_device_tree").length)).toBe(2);
        await page.evaluate(() => document.body.appendChild((window as any).__detachedCard));
        await expect.poll(() => page.evaluate(() => window.__mockRequests.filter((r) => r.type === "helman/get_device_tree").length)).toBe(3);
        await page.evaluate(() => window.__fireDataChanged("config"));
        await expect.poll(() => page.evaluate(() => window.__mockRequests.filter((r) => r.type === "helman/get_device_tree").length)).toBe(4);
    });

    test(`${tag} refreshes its own labels when Home Assistant changes language`, async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
        const labels = await page.evaluate(async ({ name, tree }) => {
            const card = document.createElement(name) as any;
            card.setConfig({ type: `custom:${name}` });
            card.hass = { ...window.__mockHass({
                "helman/get_device_tree": tree,
                "helman/get_history": { entity_history: {} },
            }), language: "en", locale: { language: "en" }, states: {}, config: { time_zone: "UTC" } };
            document.body.appendChild(card);
            if (name === "helman-card") {
                while (!card._deviceTree.length) await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await card.updateComplete;
            const before = card._localize("card.loading");
            const beforeRendered = name === "helman-card" ? card._deviceTree[1]?.name : card.shadowRoot?.textContent ?? "";
            card.hass = { ...card._latestHass, language: "cs", locale: { language: "cs" } };
            await card.updateComplete;
            const after = card._localize("card.loading");
            return { before, after, beforeRendered, rendered: name === "helman-card" ? card._deviceTree[1]?.name : card.shadowRoot?.textContent ?? "" };
        }, { name: tag, tree: cardTree() });
        expect(labels.before).toBe("Loading energy data…");
        expect(labels.after).toBe("Načítání energetických dat…");
        if (tag === "helman-simple-card") expect(labels.rendered).toContain(labels.after);
        if (tag === "helman-card") {
            expect(labels.beforeRendered).toContain("Distribution");
            expect(labels.rendered).toContain("Distribuce");
            await expect(page.locator("helman-card")).toContainText("Distribuce");
        }
    });
}

test("simple card forwards schedule editor watched entity changes", async ({ page }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    await installMockHass(page);
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    const state = await page.evaluate(async () => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        const hass = { ...window.__mockHass(), language: "en", locale: { language: "en" }, states: {
            "sensor.schedule": { state: "off", attributes: {} },
        }, config: { time_zone: "UTC" } };
        card.hass = hass;
        document.body.appendChild(card);
        card.dispatchEvent(new CustomEvent("helman-watched-entities", {
            detail: { entityIds: ["sensor.schedule"] }, bubbles: true, composed: true,
        }));
        const next = { ...hass, states: {
            ...hass.states, "sensor.schedule": { state: "on", attributes: {} },
        } };
        card.hass = next;
        await card.updateComplete;
        return (card._hass as typeof next).states["sensor.schedule"].state;
    });
    expect(state).toBe("on");
});
