import { test, expect } from "@playwright/test";
import { CARD_BUNDLE } from "./support/card-page";
import { installMockHass } from "./support/mock-hass";
import { cardTree, treeNode } from "./support/payload-builders";

for (const tag of ["helman-card", "helman-simple-card"] as const) {
    test(`${tag} retains the last inverter when a fresh overview fails, then replaces it`, async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        await page.evaluate((tree) => {
            let overviewRequest = 0;
            (window as any).__hass = {
                ...window.__mockHass({
                    "helman/get_device_tree": tree,
                    "helman/get_history": { entity_history: {} },
                    "helman/get_node_detail": () => {
                        overviewRequest++;
                        if (overviewRequest === 2) throw new Error("temporary inverter failure");
                        return { entities: { link_success_rate: overviewRequest === 1 ? "sensor.old_inverter" : "sensor.new_inverter" } };
                    },
                }),
                language: "en", locale: { language: "en" }, config: { time_zone: "UTC" }, states: {},
            };
        }, cardTree());
        await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
        await page.evaluate((name) => {
            const card = document.createElement(name) as any;
            card.setConfig({ type: `custom:${name}` });
            card.hass = (window as any).__hass;
            document.body.appendChild(card);
        }, tag);
        const overview = () => page.evaluate((name) => {
            const card = document.querySelector(name) as any;
            return {
                id: card._inverter?.entities.link_success_rate,
                oldWatched: card._watchedEntityIds.has("sensor.old_inverter"),
                newWatched: card._watchedEntityIds.has("sensor.new_inverter"),
            };
        }, tag);
        const overviewRequests = () => page.evaluate(() => window.__mockRequests.filter((request) => request.type === "helman/get_node_detail" && request.node === "inverter").length);
        await expect.poll(overview).toEqual({ id: "sensor.old_inverter", oldWatched: true, newWatched: false });
        await page.evaluate(() => window.__fireDataChanged("config"));
        await expect.poll(overviewRequests).toBe(2);
        await expect.poll(() => page.evaluate(() => window.__mockRequests.filter((request) => request.type === "helman/get_history").length)).toBe(2);
        expect(await overview()).toEqual({ id: "sensor.old_inverter", oldWatched: true, newWatched: false });
        await page.evaluate(() => window.__fireDataChanged("config"));
        await expect.poll(overviewRequests).toBe(3);
        await expect.poll(overview).toEqual({ id: "sensor.new_inverter", oldWatched: false, newWatched: true });
    });

    for (const failedRequest of ["tree", "history"] as const) {
        test(`${tag} rejoins a pending inverter after a retained ${failedRequest} refresh fails`, async ({ page }) => {
            await page.setContent("<!doctype html><html><body></body></html>");
            await installMockHass(page);
            await page.evaluate(({ tree, failedRequest }) => {
                let treeRequests = 0;
                let historyRequests = 0;
                let overviewRequests = 0;
                (window as any).__releaseInverter = () => undefined;
                (window as any).__hass = {
                    ...window.__mockHass({
                        "helman/get_device_tree": () => {
                            if (++treeRequests === 3 && failedRequest === "tree") throw new Error("temporary tree failure");
                            return tree;
                        },
                        "helman/get_history": () => {
                            if (++historyRequests === 3 && failedRequest === "history") throw new Error("temporary history failure");
                            return { entity_history: {} };
                        },
                        "helman/get_node_detail": () => {
                            if (++overviewRequests === 1) return { entities: { link_success_rate: "sensor.old_inverter" } };
                            return new Promise((resolve) => {
                                (window as any).__releaseInverter = () => resolve({ entities: { link_success_rate: "sensor.new_inverter" } });
                            });
                        },
                    }),
                    language: "en", locale: { language: "en" }, config: { time_zone: "UTC" }, states: {},
                };
            }, { tree: cardTree(), failedRequest });
            await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
            await page.evaluate((name) => {
                const card = document.createElement(name) as any;
                card.setConfig({ type: `custom:${name}` });
                card.hass = (window as any).__hass;
                document.body.appendChild(card);
            }, tag);
            const requests = (type: string) => page.evaluate((type) =>
                window.__mockRequests.filter((request) => request.type === type).length, type);
            const overview = () => page.evaluate((name) => {
                const card = document.querySelector(name) as any;
                return {
                    id: card._inverter?.entities.link_success_rate,
                    oldWatched: card._watchedEntityIds.has("sensor.old_inverter"),
                    newWatched: card._watchedEntityIds.has("sensor.new_inverter"),
                };
            }, tag);
            const oldOverview = { id: "sensor.old_inverter", oldWatched: true, newWatched: false };
            await expect.poll(overview).toEqual(oldOverview);
            await page.evaluate(() => window.__fireDataChanged("config"));
            await expect.poll(() => requests("helman/get_node_detail")).toBe(2);
            await page.evaluate(() => window.__fireDataChanged("config"));
            await expect.poll(() => requests(failedRequest === "tree" ? "helman/get_device_tree" : "helman/get_history")).toBe(3);
            expect(await overview()).toEqual(oldOverview);
            await page.evaluate(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
                (window as any).__releaseInverter();
            });
            await expect.poll(overview).toEqual({ id: "sensor.new_inverter", oldWatched: false, newWatched: true });
            expect(await requests("helman/get_node_detail")).toBe(2);
        });
    }

    test(`${tag} keeps a refreshed inverter when the older overview resolves last`, async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        await page.evaluate((tree) => {
            const releases: Array<() => void> = [];
            (window as any).__releaseInverter = (index: number) => releases[index]();
            (window as any).__hass = {
                ...window.__mockHass({
                    "helman/get_device_tree": tree,
                    "helman/get_history": { entity_history: {} },
                    "helman/get_node_detail": () => new Promise((resolve) => {
                        const index = releases.length;
                        releases.push(() => resolve({ entities: { link_success_rate: index === 0 ? "sensor.old_inverter" : "sensor.new_inverter" } }));
                    }),
                }),
                language: "en", locale: { language: "en" }, config: { time_zone: "UTC" }, states: {},
            };
        }, cardTree());
        await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
        await page.evaluate((name) => {
            const card = document.createElement(name) as any;
            card.setConfig({ type: `custom:${name}` });
            card.hass = (window as any).__hass;
            document.body.appendChild(card);
        }, tag);
        const inverterRequests = () => page.evaluate(() => window.__mockRequests.filter((request) => request.type === "helman/get_node_detail" && request.node === "inverter").length);
        await expect.poll(inverterRequests).toBe(1);
        await page.evaluate(() => window.__fireDataChanged("config"));
        await expect.poll(inverterRequests).toBe(2);
        await page.evaluate((name) => {
            const card = document.createElement(name) as any;
            card.setConfig({ type: `custom:${name}` });
            card.hass = (window as any).__hass;
            card.id = "late-card";
            document.body.appendChild(card);
        }, tag);
        await expect.poll(() => page.evaluate(() => !!(document.getElementById("late-card") as any)?._historyEngine)).toBe(true);
        expect(await inverterRequests()).toBe(2);
        await page.evaluate(() => (window as any).__releaseInverter(1));
        await expect.poll(() => page.evaluate((name) => (document.querySelector(name) as any)._inverter?.entities.link_success_rate, tag)).toBe("sensor.new_inverter");
        await expect.poll(() => page.evaluate(() => (document.getElementById("late-card") as any)._inverter?.entities.link_success_rate)).toBe("sensor.new_inverter");
        await page.evaluate(() => (window as any).__releaseInverter(0));
        expect(await page.evaluate((name) => {
            const card = document.querySelector(name) as any;
            return { inverter: card._inverter?.entities.link_success_rate, oldWatched: card._watchedEntityIds.has("sensor.old_inverter"), newWatched: card._watchedEntityIds.has("sensor.new_inverter") };
        }, tag)).toEqual({ inverter: "sensor.new_inverter", oldWatched: false, newWatched: true });
    });

    test(`${tag} remaps an open device detail to the refreshed tree`, async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        const initial = cardTree();
        initial.consumers[0].children = [treeNode({ id: "appliance", displayName: "Old appliance", powerSensorId: "sensor.old_appliance", energyEntityId: "sensor.appliance_energy" })];
        await page.evaluate((tree) => {
            (window as any).__tree = tree;
            (window as any).__hass = {
                ...window.__mockHass({ "helman/get_device_tree": () => (window as any).__tree, "helman/get_history": { entity_history: {} } }),
                language: "en", locale: { language: "en" }, config: { time_zone: "UTC" }, states: {},
            };
        }, initial);
        await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
        await page.evaluate((name) => {
            const card = document.createElement(name) as any;
            card.setConfig({ type: `custom:${name}` });
            card.hass = (window as any).__hass;
            document.body.appendChild(card);
        }, tag);
        await expect.poll(() => page.evaluate((name) => {
            const card = document.querySelector(name) as any;
            return name === "helman-card" ? card._deviceTree[1]?.children[0]?.children.length : card._houseNode?.children.length;
        }, tag)).toBe(1);
        await page.evaluate((name) => {
            const card = document.querySelector(name) as any;
            card._dialogRequest = name === "helman-card" ? card._deviceTree[1].children[0].children[0] : card._houseNode.children[0];
            card._detailEntityIds = ["sensor.old_appliance"];
            card._rebuildWatchedEntityIds();
            const next = structuredClone((window as any).__tree);
            next.consumers[0].children[0].displayName = "New appliance";
            next.consumers[0].children[0].powerSensorId = "sensor.new_appliance";
            (window as any).__tree = next;
            window.__fireDataChanged("config");
        }, tag);
        await expect.poll(() => page.evaluate((name) => (document.querySelector(name) as any)._dialogRequest?.name, tag)).toBe("New appliance");
        expect(await page.evaluate((name) => {
            const card = document.querySelector(name) as any;
            return { sensor: card._dialogRequest?.powerSensorId, oldWatched: card._watchedEntityIds.has("sensor.old_appliance"), newWatched: card._watchedEntityIds.has("sensor.new_appliance") };
        }, tag)).toEqual({ sensor: "sensor.new_appliance", oldWatched: false, newWatched: true });
        await page.evaluate(() => {
            const next = structuredClone((window as any).__tree);
            next.consumers[0].children = [];
            (window as any).__tree = next;
            window.__fireDataChanged("config");
        });
        await expect.poll(() => page.evaluate((name) => (document.querySelector(name) as any)._dialogRequest, tag)).toBeNull();
        expect(await page.evaluate((name) => (document.querySelector(name) as any)._watchedEntityIds.has("sensor.new_appliance"), tag)).toBe(false);
    });

    test(`${tag} relocalizes nested unmeasured rows`, async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        const tree = cardTree();
        tree.consumers[0].children = [treeNode({ id: "remainder", displayName: "", isUnmeasured: true })];
        await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
        const names = await page.evaluate(async ({ name, tree }) => {
            const card = document.createElement(name) as any;
            card.setConfig({ type: `custom:${name}` });
            card.hass = { ...window.__mockHass({ "helman/get_device_tree": tree, "helman/get_history": { entity_history: {} } }), language: "en", locale: { language: "en" }, config: { time_zone: "UTC" }, states: {} };
            document.body.appendChild(card);
            const remainder = () => name === "helman-card" ? card._deviceTree[1]?.children[0]?.children[0] : card._houseNode?.children[0];
            while (!remainder()) await new Promise((resolve) => setTimeout(resolve, 10));
            const before = remainder().name;
            card.hass = { ...card._latestHass, language: "cs", locale: { language: "cs" } };
            await card.updateComplete;
            return { before, after: remainder().name };
        }, { name: tag, tree });
        expect(names).toEqual({ before: "👻 Untracked consumption", after: "👻 Nesledovaná spotřeba" });
    });

    if (tag === "helman-card") test("helman-card keeps configured names when nested IDs match section roots", async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        const tree = cardTree();
        tree.consumers[0].children = [
            treeNode({ id: "sources", displayName: "My sources" }),
            treeNode({ id: "consumers", displayName: "My consumers" }),
        ];
        await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
        const names = await page.evaluate(async (tree) => {
            const card = document.createElement("helman-card") as any;
            card.setConfig({ type: "custom:helman-card" });
            card.hass = { ...window.__mockHass({ "helman/get_device_tree": tree, "helman/get_history": { entity_history: {} } }), language: "en", locale: { language: "en" }, config: { time_zone: "UTC" }, states: {} };
            document.body.appendChild(card);
            while (!card._deviceTree[1]?.children[0]?.children.length) await new Promise((resolve) => setTimeout(resolve, 10));
            card.hass = { ...card._latestHass, language: "cs", locale: { language: "cs" } };
            await card.updateComplete;
            return { roots: card._deviceTree.map((root: any) => root.name), nested: card._deviceTree[1].children[0].children.map((child: any) => child.name) };
        }, tree);
        expect(names).toEqual({ roots: ["Zdroje energie", "Distribuce"], nested: ["My sources", "My consumers"] });
    });

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

    test(`${tag} uses fresh history after a config announcement while old history is pending`, async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await installMockHass(page);
        await page.evaluate((initial) => {
            const next = structuredClone(initial);
            next.sources[0].powerSensorId = "sensor.new_solar";
            const releases: Array<() => void> = [];
            (window as any).__releaseHistory = (index: number) => releases[index]();
            (window as any).__hass = {
                ...window.__mockHass({
                    "helman/get_device_tree": () => window.__mockRequests.filter((request) => request.type === "helman/get_device_tree").length === 1 ? initial : next,
                    "helman/get_history": () => new Promise((resolve) => {
                        const index = releases.length;
                        releases.push(() => resolve({ entity_history: index === 0
                            ? { "sensor.old_solar": [4, 5] }
                            : { "sensor.new_solar": [37, 38] } }));
                    }),
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
        const historyRequests = () => page.evaluate(() => window.__mockRequests.filter((request) => request.type === "helman/get_history").length);
        const solarHistory = (id: string) => page.evaluate(({ name, id }) => {
            const card = document.getElementById(id) as any;
            const solar = name === "helman-card" ? card._deviceTree[0]?.children[0] : card._solarNode;
            return { sensor: solar?.powerSensorId, firstBucket: solar?.powerHistory[0] };
        }, { name: tag, id });

        await mount("first");
        await expect.poll(historyRequests).toBe(1);
        await page.evaluate(() => window.__fireDataChanged("config"));
        await expect.poll(historyRequests).toBe(2);
        await mount("second");
        await expect.poll(treeRequests).toBe(3);
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(await historyRequests()).toBe(2);
        await page.evaluate(() => (window as any).__releaseHistory(1));
        await expect.poll(() => solarHistory("first")).toEqual({ sensor: "sensor.new_solar", firstBucket: 37 });
        await expect.poll(() => solarHistory("second")).toEqual({ sensor: "sensor.new_solar", firstBucket: 37 });
        await page.evaluate(() => (window as any).__releaseHistory(0));
        expect(await solarHistory("first")).toEqual({ sensor: "sensor.new_solar", firstBucket: 37 });
        expect(await solarHistory("second")).toEqual({ sensor: "sensor.new_solar", firstBucket: 37 });
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

test("simple card forwards the latest hass when schedule watches arrive late", async ({ page }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    await installMockHass(page);
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.evaluate((tree) => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        card.hass = { ...window.__mockHass({
            "helman/get_device_tree": tree,
            "helman/get_history": { entity_history: {} },
        }), language: "en", locale: { language: "en" }, states: {
            "sensor.schedule": { state: "off", attributes: {} },
            "sensor.solar": { state: "100", attributes: {} },
        }, config: { time_zone: "UTC" } };
        document.body.appendChild(card);
    }, cardTree());
    await expect.poll(() => page.evaluate(() => !!(document.querySelector("helman-simple-card") as any)._entityMap)).toBe(true);
    const state = await page.evaluate(async () => {
        const card = document.querySelector("helman-simple-card") as any;
        const old = card._latestHass;
        card.hass = { ...old, states: {
            ...old.states, "sensor.schedule": { state: "on", attributes: {} },
        } };
        const before = card._hass.states["sensor.schedule"].state;
        card.dispatchEvent(new CustomEvent("helman-watched-entities", {
            detail: { entityIds: ["sensor.schedule"] }, bubbles: true, composed: true,
        }));
        await card.updateComplete;
        return { before, after: card._hass.states["sensor.schedule"].state };
    });
    expect(state).toEqual({ before: "off", after: "on" });
});
