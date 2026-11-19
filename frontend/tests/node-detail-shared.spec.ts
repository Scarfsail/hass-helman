import { expect, test } from "@playwright/test";
import { CARD_BUNDLE, loadBundle } from "./support/card-page";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { onDashboard } from "./support/node-detail-harness";
import { flowGlow } from "../cards/shared/flow-style";

test.beforeEach(async ({ page }) => {
    await page.setContent("<div id='mount' style='width:320px'></div>");
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-flow-gauge"));
});

test("the gauge shows three equal pills in a fixed order, filling the active one and muting the idle ones", async ({ page }) => {
    await page.evaluate(() => {
        (window as any).__target = null;
        const gauge = document.createElement("helman-flow-gauge") as any;
        gauge.of = "house";
        gauge.items = [{ node: "solar", powerW: 800 }];
        gauge.localize = (key: string) => key;
        gauge.addEventListener("helman-node-detail-request", (event: Event) => { (window as any).__target = (event as CustomEvent).detail.target; });
        document.getElementById("mount")!.append(gauge);
    });
    const gauge = page.locator("helman-flow-gauge");
    const buttons = gauge.locator("button");
    await expect(buttons).toHaveCount(3);
    const pills = await gauge.evaluate((el) => Array.from(el.shadowRoot!.querySelectorAll("button")).map((button) => ({
        icon: button.querySelector("ha-icon")!.getAttribute("icon"),
        width: button.getBoundingClientRect().width,
        fill: parseFloat(getComputedStyle(button, "::before").width) / button.getBoundingClientRect().width,
        opacity: getComputedStyle(button.querySelector(".figure")!).opacity,
    })));
    expect(pills.map((pill) => pill.icon)).toEqual(["mdi:white-balance-sunny", "mdi:battery", "mdi:transmission-tower"]);
    expect(pills[1].width).toBeCloseTo(pills[0].width, 0);
    expect(pills[2].width).toBeCloseTo(pills[0].width, 0);
    expect(pills[0].fill).toBeCloseTo(1, 2);
    expect(pills.map((pill) => pill.opacity)).toEqual(["1", "0.4", "0.4"]);
    await expect(gauge.locator(".figure")).toHaveText(["800 W 100 %", "0 W", "0 W"]);
    await expect(gauge.locator(".percent")).toHaveText(["100 %"]);
    await buttons.nth(2).click();
    expect(await page.evaluate(() => (window as any).__target)).toBe("grid");
});

test("an idle gauge pill mutes its content but opens a fully opaque popup", async ({ page }) => {
    await page.evaluate(() => {
        const gauge = document.createElement("helman-flow-gauge") as any;
        gauge.of = "grid";
        gauge.items = [];
        gauge.localize = (key: string) => key;
        document.getElementById("mount")!.append(gauge);
    });
    const gauge = page.locator("helman-flow-gauge");
    const house = gauge.locator("button").first();
    await expect(house).not.toHaveAttribute("data-active");
    await expect(house.locator("ha-icon")).toHaveCSS("opacity", "0.4");
    await expect(house.locator(".figure")).toHaveCSS("opacity", "0.4");
    await house.hover();
    const popup = house.locator(".popup");
    await expect(popup).toBeVisible();
    const opacity = await popup.evaluate((el) => {
        let product = 1;
        for (let node: Element | null = el; node; node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null)) product *= parseFloat(getComputedStyle(node).opacity);
        return product;
    });
    expect(opacity).toBe(1);
});

test("a gauge pill too narrow for power and share drops the share and keeps the power whole", async ({ page }) => {
    await page.evaluate(() => {
        const gauge = document.createElement("helman-flow-gauge") as any;
        gauge.of = "grid";
        gauge.items = [{ node: "battery", powerW: 1000 }, { node: "house", powerW: 100 }];
        gauge.localize = (key: string) => key;
        document.getElementById("mount")!.append(gauge);
    });
    const gauge = page.locator("helman-flow-gauge");
    const pill = gauge.locator("button").nth(1);
    const clipped = () => pill.locator(".figure").evaluate((el) => el.scrollWidth > el.clientWidth);
    await page.evaluate(() => { document.getElementById("mount")!.style.width = "310px"; });
    await expect(pill.locator(".percent")).toBeHidden();
    await expect(pill.locator(".figure")).toHaveText("1.0 kW 91 %");
    expect(await clipped()).toBe(false);
    await page.evaluate(() => { document.getElementById("mount")!.style.width = "360px"; });
    await expect(pill.locator(".percent")).toBeVisible();
    expect(await clipped()).toBe(false);
});

test("an active gauge pill glows at its share's level and rate, and holds it still under reduced motion", async ({ page }) => {
    await page.evaluate(() => {
        const gauge = document.createElement("helman-flow-gauge") as any;
        gauge.of = "house";
        gauge.items = [{ node: "solar", powerW: 800 }, { node: "grid", powerW: 100 }];
        gauge.localize = (key: string) => key;
        document.getElementById("mount")!.append(gauge);
    });
    const glows = () => page.locator("helman-flow-gauge").evaluate((el) => Array.from(el.shadowRoot!.querySelectorAll("button")).map((button) => ({
        rate: button.dataset.rate ? Number(button.dataset.rate) : null,
        running: button.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length,
        playbackRates: button.getAnimations({ subtree: true }).map((animation) => animation.playbackRate),
        shadow: getComputedStyle(button, "::after").boxShadow,
        opacity: getComputedStyle(button, "::after").opacity,
    })));
    // Solar carries 8/9 of the gauge, grid 1/9, battery nothing: each glow's rate is its own share's.
    const solar = flowGlow(8 / 9).rate;
    const grid = flowGlow(1 / 9).rate;
    expect(solar).toBeGreaterThan(grid);
    await expect.poll(async () => (await glows()).map((glow) => [glow.rate, glow.running])).toEqual([[solar, 1], [null, 0], [grid, 1]]);
    await expect.poll(async () => (await glows()).map((glow) => glow.playbackRates)).toEqual([[solar], [], [grid]]);
    const live = await glows();
    expect(live[1].shadow).toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => (await glows()).map((glow) => glow.running)).toEqual([0, 0, 0]);
    const still = await glows();
    expect(still[0].shadow).not.toBe("none");
    expect(still[0].opacity).toBe("0.6");
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

test("a pill that shows a watt never reads 0 % or an empty fill", async ({ page }) => {
    await page.evaluate(() => {
        const gauge = document.createElement("helman-flow-gauge") as any;
        gauge.of = "house";
        gauge.items = [{ node: "solar", powerW: 4980 }, { node: "grid", powerW: 15 }];
        gauge.localize = (key: string) => key;
        document.getElementById("mount")!.append(gauge);
    });
    const gauge = page.locator("helman-flow-gauge");
    await expect(gauge.locator("button").nth(2).locator(".figure")).toHaveText("15 W 1 %");
    const fill = await gauge.evaluate((el) => {
        const button = el.shadowRoot!.querySelectorAll("button")[2];
        return parseFloat(getComputedStyle(button, "::before").width);
    });
    expect(fill).toBeGreaterThan(0);
});

/** A select entity's picker, its writes collected in `__picks`. */
async function mountPicker(page: import("@playwright/test").Page, options: string[], state: string): Promise<void> {
    await page.evaluate(({ options, state }) => {
        (window as any).__picks = [];
        const picker = document.createElement("helman-option-segments") as any;
        picker.hass = {
            states: { "select.mode": { entity_id: "select.mode", state, attributes: {} } },
            callWS: async (request: unknown) => { (window as any).__picks.push(request); },
        };
        picker.entityId = "select.mode";
        picker.options = options;
        picker.name = "Mode";
        picker.label = (option: string) => option.toUpperCase();
        document.getElementById("mount")!.append(picker);
    }, { options, state });
}

test("a picker of up to three options is one segmented bar on one line, its live option pressed", async ({ page }) => {
    await mountPicker(page, ["fast", "eco", "stop"], "eco");
    const picker = page.locator("helman-option-segments");
    await expect(picker.locator("select")).toHaveCount(0);
    const buttons = picker.locator(".segments button");
    await expect(buttons).toHaveText(["FAST", "ECO", "STOP"]);
    await expect(picker.locator("[aria-pressed=true]")).toHaveText("ECO");
    expect(new Set(await buttons.evaluateAll((all) => all.map((button) => button.getBoundingClientRect().top))).size).toBe(1);
    await buttons.first().click();
    await expect.poll(() => page.evaluate(() => (window as any).__picks)).toEqual([
        { type: "call_service", domain: "select", service: "select_option", service_data: { entity_id: "select.mode", option: "fast" } },
    ]);
});

test("a picker of more than three options is a named dropdown, its live option picked", async ({ page }) => {
    await mountPicker(page, ["a", "b", "c", "d"], "c");
    const picker = page.locator("helman-option-segments");
    await expect(picker.locator("button")).toHaveCount(0);
    await expect(picker.locator(".dropdown .name")).toHaveText("Mode");
    const select = picker.locator("select");
    await expect(select.locator("option")).toHaveText(["A", "B", "C", "D"]);
    await expect(select).toHaveValue("c");
    await select.selectOption("d");
    await expect.poll(() => page.evaluate(() => (window as any).__picks)).toEqual([
        { type: "call_service", domain: "select", service: "select_option", service_data: { entity_id: "select.mode", option: "d" } },
    ]);
});

test("a picker is disabled while its entity is unreadable, as a bar and as a dropdown", async ({ page }) => {
    await mountPicker(page, ["a", "b"], "unavailable");
    await mountPicker(page, ["a", "b", "c", "d"], "unavailable");
    const pickers = page.locator("helman-option-segments");
    for (const button of await pickers.nth(0).locator("button").all()) await expect(button).toBeDisabled();
    await expect(pickers.nth(1).locator("select")).toBeDisabled();
});

test("a dropdown whose live value is no option shows the placeholder, never the first option", async ({ page }) => {
    await mountPicker(page, ["a", "b", "c", "d"], "unknown_mode");
    await mountPicker(page, ["a", "b", "c", "d"], "unavailable");
    const selects = page.locator("helman-option-segments select");
    for (const select of await selects.all()) {
        await expect.poll(() => select.evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.textContent)).toBe("—");
    }
});
