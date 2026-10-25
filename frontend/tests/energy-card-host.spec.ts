import { test, expect } from "@playwright/test";
import { mountSimpleCard, state, inverterOverview, flowsSection } from "./support/node-detail-harness";
import { cardTree } from "./support/payload-builders";
import { installMockHass } from "./support/mock-hass";
import { CARD_BUNDLE } from "./support/card-page";

test.describe("EnergyCardHost", () => {
    for (const tag of ["helman-card", "helman-simple-card"] as const) {
        test(`inverter Overview receives live readings and renders when opened from ${tag}`, async ({ page }) => {
            const states = {
                "sensor.solar": state("4200", "W"),
                "sensor.battery": state("-500", "W"),
                "sensor.house": state("1200", "W"),
                "sensor.grid": state("-300", "W"),
                "number.min_soc": state("10", "%"),
                "number.max_soc": state("100", "%"),
                "select.helman_inverter_mode": state("normal", undefined, { friendly_name: "Helman inverter mode" }),
            };

            const modes = {
                node: "inverter",
                section: "modes",
                asOf: "2026-10-21T12:00:00+00:00",
                period: { start: "2026-10-21T00:00:00+00:00", end: "2026-10-22T00:00:00+00:00" },
                modes: [],
            };

            await mountSimpleCard(page, {
                states,
                overviews: {
                    inverter: inverterOverview({
                        configured: true,
                        mode: { entityId: "select.helman_inverter_mode", actionOptions: { normal: "normal" } },
                        entities: { battery_min_soc: "number.min_soc", battery_max_soc: "number.max_soc" },
                    }),
                },
                sections: {
                    inverter: {
                        modes,
                        flows: flowsSection("inverter"),
                    },
                },
            }, tag);

            // Open the inverter detail from the card's inverter cell
            await page.locator(".inverter-cell").click();
            const content = page.locator("node-detail-inverter-content");
            await expect(content).toBeVisible();

            // Verify the params passed into the inverter detail match the live sensor readings
            const params = await content.evaluate((el: any) => ({
                solarPower: el.params.solarPower,
                batteryPower: el.params.batteryPower,
            }));
            expect(params).toEqual({
                solarPower: 4200,
                batteryPower: -500,
            });

            await expect(content.locator("[data-overview]")).toContainText("Helman last commanded: Normal");
            await expect(content.locator("helman-detail-headline")).toBeVisible();
            await expect(content.locator("[data-chain] [data-box]")).toHaveCount(3);
            await expect(content.locator("[data-chain] [data-box='command'] .box-value")).toHaveText("Normal");
        });
    }

    for (const tag of ["helman-card", "helman-simple-card"] as const) {
        test(`two sources announcing watched entities do not overwrite each other (replace-per-source semantics) on ${tag}`, async ({ page }) => {
            await mountSimpleCard(page, {
                states: {
                    "sensor.solar": state("4200", "W"),
                },
            }, tag);

            const watched = () => page.evaluate((selector) => {
                const card = document.querySelector(selector) as any;
                return [...card._host.watchedEntityIds];
            }, tag);

            // Source A announces watched entities
            await page.evaluate((selector) => {
                const card = document.querySelector(selector)!;
                card.dispatchEvent(new CustomEvent("helman-watched-entities", {
                    bubbles: true,
                    composed: true,
                    detail: { source: "source-a", entityIds: ["sensor.source_a_1", "sensor.source_a_2"] },
                }));
            }, tag);

            let current = await watched();
            expect(current).toContain("sensor.source_a_1");
            expect(current).toContain("sensor.source_a_2");

            // Source B announces watched entities - should NOT overwrite Source A
            await page.evaluate((selector) => {
                const card = document.querySelector(selector)!;
                card.dispatchEvent(new CustomEvent("helman-watched-entities", {
                    bubbles: true,
                    composed: true,
                    detail: { source: "source-b", entityIds: ["sensor.source_b_1"] },
                }));
            }, tag);

            current = await watched();
            expect(current).toContain("sensor.source_a_1");
            expect(current).toContain("sensor.source_a_2");
            expect(current).toContain("sensor.source_b_1");

            // Source A replaces its watched entities
            await page.evaluate((selector) => {
                const card = document.querySelector(selector)!;
                card.dispatchEvent(new CustomEvent("helman-watched-entities", {
                    bubbles: true,
                    composed: true,
                    detail: { source: "source-a", entityIds: ["sensor.source_a_3"] },
                }));
            }, tag);

            current = await watched();
            expect(current).not.toContain("sensor.source_a_1");
            expect(current).not.toContain("sensor.source_a_2");
            expect(current).toContain("sensor.source_a_3");
            expect(current).toContain("sensor.source_b_1");

            // Source B clears its entities
            await page.evaluate((selector) => {
                const card = document.querySelector(selector)!;
                card.dispatchEvent(new CustomEvent("helman-watched-entities", {
                    bubbles: true,
                    composed: true,
                    detail: { source: "source-b", entityIds: [] },
                }));
            }, tag);

            current = await watched();
            expect(current).toContain("sensor.source_a_3");
            expect(current).not.toContain("sensor.source_b_1");
        });
    }

    for (const tag of ["helman-card", "helman-simple-card"] as const) {
        test(`a failed load on ${tag} is not retried on every hass push`, async ({ page }) => {
            await page.setContent("<!doctype html><html><body></body></html>");
            await installMockHass(page);
            await page.evaluate(() => {
                (window as any).__hass = {
                    ...window.__mockHass({
                        "helman/get_device_tree": () => { throw new Error("backend down"); },
                        "helman/get_history": { entity_history: {} },
                    }),
                    language: "en", locale: { language: "en" }, config: { time_zone: "UTC" },
                    states: { "sensor.solar": { state: "0", attributes: {} } },
                };
            });
            await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
            await page.evaluate((name) => {
                const card = document.createElement(name) as any;
                card.setConfig({ type: `custom:${name}` });
                card.hass = (window as any).__hass;
                document.body.appendChild(card);
            }, tag);
            const treeRequests = () => page.evaluate(() => window.__mockRequests.filter((request) => request.type === "helman/get_device_tree").length);
            await expect.poll(treeRequests).toBe(1);

            // Home Assistant hands a new hass on every state change anywhere in the house.
            await page.evaluate(async (name) => {
                const card = document.querySelector(name) as any;
                for (let i = 1; i <= 20; i++) {
                    const hass = (window as any).__hass;
                    card.hass = { ...hass, states: { ...hass.states, "sensor.solar": { state: String(i), attributes: {} } } };
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
            }, tag);
            expect(await treeRequests()).toBe(1);

            // A config event still reloads.
            await page.evaluate(() => window.__fireDataChanged("config"));
            await expect.poll(treeRequests).toBeGreaterThan(1);
        });
    }

    test("a config refresh keeps an open node detail on the simple card", async ({ page }) => {
        await mountSimpleCard(page, {
            states: {
                "sensor.solar": state("4200", "W"),
                "select.helman_inverter_mode": state("normal", undefined, { friendly_name: "Helman inverter mode" }),
            },
            overviews: {
                inverter: inverterOverview({
                    configured: true,
                    mode: { entityId: "select.helman_inverter_mode", actionOptions: { normal: "normal" } },
                }),
            },
            sections: { inverter: { flows: flowsSection("inverter") } },
        });
        await page.locator(".inverter-cell").click();
        await expect(page.locator("node-detail-inverter-content")).toBeVisible();
        await page.locator("node-detail-dialog").evaluate((dialog: any) => { dialog.__beforeRefresh = true; });
        await page.evaluate(() => {
            (window as any).__engineBeforeRefresh = (document.querySelector("helman-simple-card") as any)._host.historyEngine;
            window.__fireDataChanged("config");
        });
        await expect.poll(() => page.evaluate(() =>
            (document.querySelector("helman-simple-card") as any)._host.historyEngine !== (window as any).__engineBeforeRefresh)).toBe(true);

        // The same dialog element, never torn down for a loading placeholder.
        expect(await page.locator("node-detail-dialog").evaluate((dialog: any) => dialog.__beforeRefresh === true)).toBe(true);
        await expect(page.locator("node-detail-inverter-content")).toBeVisible();
    });

    test("a config reload reads the new tree from the latest hass even when the inverter request fails", async ({ page }) => {
        await mountSimpleCard(page, {
            states: { "sensor.solar": state("4200", "W") },
            overviews: { inverter: "error" },
        });
        const moved = cardTree();
        moved.sources[0].powerSensorId = "sensor.solar_moved";
        await page.evaluate((tree) => {
            const hass = window.__NodeDetailHass;
            window.__setMockReply(hass, "helman/get_device_tree", tree);
            // An unwatched entity changes: the card filters this push out.
            const pushed = { ...hass, states: { ...hass.states, "sensor.solar_moved": window.__nodeDetailState("7100", "W") } };
            (document.querySelector("helman-simple-card") as any).hass = pushed;
            window.__NodeDetailHass = pushed;
            window.__fireDataChanged("config");
        }, moved);
        await expect.poll(() => page.evaluate(() =>
            (document.querySelector("helman-simple-card") as any)._host.readings.solarPower)).toBe(7100);
    });
});
