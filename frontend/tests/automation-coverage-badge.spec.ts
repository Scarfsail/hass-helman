import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Whether a lane is on autopilot, said on the lane itself.
 *
 * The answer is derived from the config and from nothing else -- which optimizer
 * targets which controllable, and whether it is switched on -- so these tests
 * hand the band documents rather than plans. What is worth pinning:
 *
 * - **The three states, and where each comes from.** Enabled, disabled-only and
 *   untouched are three different answers, and the automation's master switch
 *   overrides every optimizer under it.
 * - **That the badge opens what it names.** A lane driven by three optimizers
 *   opens three cards, not one of them.
 * - **That it is a control of its own.** Pressing it must not also select the
 *   lane underneath, which is the other thing a press on that row does.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-24";
const DAY_START_MS = Date.parse(`${DAY}T00:00:00Z`);
const HOUR_MS = 3_600_000;

/**
 * Two lanes and four optimizers: the inverter has three (one of them off) and
 * the boiler has one that is off. The pump has none at all.
 */
const CONFIG = {
    config_version: 4,
    automation: {
        enabled: true,
        optimizers: [
            { id: "charge_hold", kind: "charge_hold", target: { controllable_id: "inverter" }, enabled: true },
            { id: "export_price", kind: "export_price", target: { controllable_id: "inverter" }, enabled: false },
            { id: "night_charge", kind: "night_charge", target: { controllable_id: "inverter" }, enabled: true },
            { id: "boiler_surplus", kind: "appliance_runtime", target: { controllable_id: "boiler" }, enabled: false },
        ],
    },
};

interface MountOptions {
    config?: unknown;
    /** Labels in their own column, as the scheduling card draws them. */
    columnLabels?: boolean;
    /** What `helman/get_optimizer_schema` answers; the default names no kinds. */
    schema?: unknown;
    /** Refuse `helman/get_config` the way the backend refuses a non-admin. */
    unauthorized?: boolean;
    /** Hold every config read open until a test releases it. */
    stallReads?: boolean;
}

async function mountBand(page: Page, options: MountOptions = {}): Promise<void> {
    const {
        config = CONFIG,
        columnLabels = false,
        schema = { version: 2, kinds: [] },
        unauthorized = false,
        stallReads = false,
    } = options;

    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-entity-day-band"));

    await page.evaluate(({ dayStartMs, hourMs, config, columnLabels, schema, unauthorized, stallReads }) => {
        const calls: { type: string; config?: unknown }[] = [];
        const globals = window as unknown as Record<string, unknown>;
        globals.__calls = calls;
        const events: string[] = [];
        globals.__events = events;

        const listeners: ((event: unknown) => void)[] = [];
        globals.__fireDataChanged = () => {
            for (const listener of listeners) {
                listener({ kind: "config" });
            }
        };
        // Let a test move the stored config under a mounted band.
        let current = config;
        globals.__setConfig = (next: unknown) => { current = next; };
        // Config reads parked mid-flight, for the coalescing tests.
        const held: (() => void)[] = [];
        globals.__releaseReads = () => {
            const waiting = held.splice(0, held.length);
            for (const release of waiting) {
                release();
            }
            return waiting.length;
        };

        const slots = Array.from({ length: 24 }, (_, index) => ({
            id: new Date(dayStartMs + index * hourMs).toISOString(),
            index,
            startMs: dayStartMs + index * hourMs,
            endMs: dayStartMs + (index + 1) * hourMs,
            dayKey: "2026-07-24",
            timeLabel: "",
            endLabel: "",
            rangeLabel: "",
            assignments: {},
            runtime: null,
            isCurrent: false,
        }));

        const lane = (key: string, name: string, target: string) => ({
            key,
            entityId: `switch.${key}`,
            name,
            icon: "mdi:flash-outline",
            target,
            appliance: null,
            isAvailable: true,
            actualSegments: [],
            blocks: [],
            blockProjections: new Map(),
            blockVehicleSoc: new Map(),
        });

        const band = document.createElement("scheduling-entity-day-band") as HTMLElement
            & Record<string, unknown>;
        band.style.width = "900px";
        band.localize = (key: string) => key;
        band.day = {
            dayKey: "2026-07-24",
            label: "today",
            slots,
            startMs: dayStartMs,
            endMs: dayStartMs + 24 * hourMs,
            editableFromMs: dayStartMs,
        };
        band.lanes = [
            lane("inverter", "Inverter", "inverter"),
            lane("boiler", "Boiler", "boiler"),
            lane("pump", "Pump", "pump"),
        ];
        band.laneLabels = columnLabels ? "column" : "track";
        band.showForecastRows = false;
        band.showAxis = false;
        band.nowMs = dayStartMs;
        band.hass = {
            language: "en",
            locale: { language: "en" },
            states: {},
            connection: {
                subscribeMessage: async (callback: (message: unknown) => void) => {
                    listeners.push(callback);
                    return () => {
                        listeners.splice(listeners.indexOf(callback), 1);
                    };
                },
            },
            callWS: async (request: { type: string; config?: unknown }) => {
                calls.push({ type: request.type, config: request.config });
                if (request.type === "helman/get_config") {
                    if (unauthorized) {
                        // The shape the HA websocket client throws; the source
                        // reads the code and nothing else.
                        throw Object.assign(new Error("Admin access required"), { code: "unauthorized" });
                    }
                    if (stallReads) {
                        await new Promise<void>((release) => { held.push(release); });
                    }
                    return current;
                }
                if (request.type === "helman/get_optimizer_schema") return schema;
                if (request.type === "helman/get_appliances") return { appliances: [] };
                if (request.type === "helman/save_config") {
                    return { success: true, validation: { valid: true, errors: [], warnings: [] }, reloadStarted: true };
                }
                return {};
            },
        };
        // The dialog lives in the band's shadow root and its cards in theirs,
        // and `document.querySelector` pierces neither -- so the walk is here,
        // where it can be written once.
        globals.__switches = () => [...(document
            .querySelector("scheduling-entity-day-band")!
            .shadowRoot!.querySelector("helman-optimizer-edit-dialog")
            ?.shadowRoot?.querySelectorAll("helman-optimizer-editor") ?? [])]
            .map((editor) => editor.shadowRoot!.querySelector(".summary-toggle ha-switch")!);

        for (const type of ["entity-day-band-lane-select", "hass-more-info"]) {
            band.addEventListener(type, () => events.push(type));
        }
        document.body.appendChild(band);
    }, { dayStartMs: DAY_START_MS, hourMs: HOUR_MS, config, columnLabels, schema, unauthorized, stallReads });

    if (unauthorized || stallReads) {
        // No read will land, so there is no badge to wait for.
        return;
    }
    // The first badge only exists once the config read has landed.
    await expect(badge(page, "inverter")).toHaveCount(1);
}

function lane(page: Page, key: string) {
    return page.locator("scheduling-entity-day-band").locator(`.lane[data-lane="${key}"]`);
}

function badge(page: Page, key: string) {
    return lane(page, key).locator(".automation-badge");
}

function badgeState(page: Page, key: string): Promise<string> {
    return badge(page, key).evaluate((element) => element.className.replace("automation-badge", "").trim());
}

async function readEvents(page: Page): Promise<string[]> {
    return page.evaluate(() => (window as unknown as Record<string, unknown>).__events as never);
}

async function fireDataChanged(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as unknown as Record<string, () => void>).__fireDataChanged();
    });
    // The shared feed collapses a burst before telling its listeners.
    await page.waitForTimeout(600);
}

test.describe("automation coverage on the schedule band", () => {
    test("a lane an enabled optimizer targets reads as automated", async ({ page }) => {
        await mountBand(page);
        // One of the inverter's three is off; the lane is still driven.
        expect(await badgeState(page, "inverter")).toBe("active");
    });

    test("a lane whose only optimizer is switched off is not automated", async ({ page }) => {
        await mountBand(page);
        expect(await badgeState(page, "boiler")).toBe("disabled_only");
    });

    test("a lane no optimizer targets is manual", async ({ page }) => {
        await mountBand(page);
        expect(await badgeState(page, "pump")).toBe("none");
    });

    test("the automation's master switch overrides every optimizer under it", async ({ page }) => {
        await mountBand(page, {
            config: { ...CONFIG, automation: { ...CONFIG.automation, enabled: false } },
        });
        // Its optimizers are still enabled; the pipeline they are in is not.
        expect(await badgeState(page, "inverter")).toBe("disabled_only");
    });

    test("a manual lane's badge is inert -- there is nothing to open", async ({ page }) => {
        await mountBand(page);
        expect(await badge(page, "pump").evaluate((element) => element.tagName)).toBe("SPAN");
        expect(await badge(page, "inverter").evaluate((element) => element.tagName)).toBe("BUTTON");
    });

    test("pressing it opens every automation that drives the lane", async ({ page }) => {
        await mountBand(page);
        await badge(page, "inverter").click();

        const dialog = page.locator("helman-optimizer-edit-dialog");
        await expect(dialog).toHaveCount(1);
        // Three cards, including the one that is switched off: the badge is
        // where a disabled automation gets switched back on.
        await expect(dialog.locator("helman-optimizer-editor")).toHaveCount(3);
    });

    test("pressing it does not also select the lane underneath", async ({ page }) => {
        await mountBand(page, { columnLabels: true });
        await badge(page, "inverter").click();

        expect(await readEvents(page)).toEqual([]);
    });

    test("a config saved elsewhere recolours the badge", async ({ page }) => {
        await mountBand(page);
        expect(await badgeState(page, "boiler")).toBe("disabled_only");

        await page.evaluate(() => {
            const globals = window as unknown as Record<string, (next: unknown) => void>;
            globals.__setConfig({
                config_version: 5,
                automation: {
                    enabled: true,
                    optimizers: [{
                        id: "boiler_surplus",
                        kind: "appliance_runtime",
                        target: { controllable_id: "boiler" },
                        enabled: true,
                    }],
                },
            });
        });
        await fireDataChanged(page);

        expect(await badgeState(page, "boiler")).toBe("active");
        expect(await badgeState(page, "inverter")).toBe("none");
    });

    /**
     * The inverter kinds declare `controllable_id` with a reserved default, so
     * a document may legitimately omit it and still drive the inverter. The
     * default is read from the served schema rather than from a list of kinds
     * kept here, which would be a second answer to the same question.
     */
    test("an optimizer that leans on the schema's default target still counts", async ({ page }) => {
        await mountBand(page, {
            config: {
                config_version: 4,
                automation: {
                    enabled: true,
                    optimizers: [{ id: "charge_hold", kind: "charge_hold", enabled: true }],
                },
            },
            schema: {
                version: 2,
                kinds: [{
                    kind: "charge_hold",
                    target: [{ key: "controllable_id", type: "string", default: "inverter" }],
                    params: [],
                    conditionTypes: [],
                    newDraft: {},
                }],
            },
        });

        expect(await badgeState(page, "inverter")).toBe("active");
    });

    test("a viewer the backend refuses gets no badge, and is not asked again", async ({ page }) => {
        // `helman/get_config` is admin-gated. A refusal is the answer, not a
        // transient failure, so re-announcing a change must not re-ask.
        await mountBand(page, { unauthorized: true });
        await expect(badge(page, "inverter")).toHaveCount(0);
        await fireDataChanged(page);

        const reads = await page.evaluate(
            () => (window as unknown as Record<string, { type: string }[]>).__calls
                .filter((call) => call.type === "helman/get_config").length,
        );
        expect(reads).toBe(1);
        await expect(badge(page, "inverter")).toHaveCount(0);
    });

    test("a change arriving mid-read is not swallowed by the coalescing", async ({ page }) => {
        await mountBand(page, { stallReads: true });

        // The first read is parked. Move the config and announce it while it
        // is still in flight: without a trailing edge this is dropped.
        await page.evaluate(() => {
            (window as unknown as Record<string, (next: unknown) => void>).__setConfig({
                config_version: 5,
                automation: {
                    enabled: true,
                    optimizers: [{
                        id: "pump_surplus",
                        kind: "appliance_runtime",
                        target: { controllable_id: "pump" },
                        enabled: true,
                    }],
                },
            });
        });
        await fireDataChanged(page);

        // Release the parked read, then the trailing one it queued.
        await page.evaluate(() => (window as unknown as Record<string, () => number>).__releaseReads());
        await expect
            .poll(() => page.evaluate(
                () => (window as unknown as Record<string, () => number>).__releaseReads(),
            ))
            .toBeGreaterThan(0);

        await expect.poll(() => badgeState(page, "pump")).toBe("active");
    });

    test("the config is read once however many lanes ask", async ({ page }) => {
        await mountBand(page);

        const calls = await page.evaluate(
            () => (window as unknown as Record<string, { type: string }[]>).__calls,
        );
        expect(calls.filter((call) => call.type === "helman/get_config")).toHaveLength(1);
    });
});

test.describe("switching an automation on from the dialog", () => {
    /**
     * `ha-switch` is a Home Assistant element that is not in this bundle, so it
     * renders as an inert unknown element with no behaviour of its own. What
     * the dialog listens for is its `change`, which is what a test can drive.
     */
    async function flipSwitch(page: Page, index: number, checked: boolean): Promise<void> {
        await page.evaluate(({ index, checked }) => {
            const element = (window as unknown as Record<string, () => Element[]>)
                .__switches()[index] as HTMLElement & { checked: boolean };
            element.checked = checked;
            element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        }, { index, checked });
    }

    test("every card carries its own on/off switch, set from the config", async ({ page }) => {
        await mountBand(page);
        await badge(page, "inverter").click();

        const dialog = page.locator("helman-optimizer-edit-dialog");
        await expect(dialog).toHaveCount(1);
        const checked = await page.evaluate(() => (window as unknown as Record<string, () => Element[]>)
            .__switches()
            .map((element) => (element as unknown as { checked: boolean }).checked));

        // charge_hold on, export_price off, night_charge on — the pipeline's
        // order, not the order the ids happened to arrive in.
        expect(checked).toEqual([true, false, true]);
    });

    test("the switch writes into the draft the Save sends", async ({ page }) => {
        await mountBand(page);
        await badge(page, "boiler").click();
        await expect(page.locator("helman-optimizer-edit-dialog helman-optimizer-editor"))
            .toHaveCount(1);

        await flipSwitch(page, 0, true);
        await page.locator("helman-optimizer-edit-dialog").getByText("Save and reload").click();

        const saved = await page.evaluate(
            () => (window as unknown as Record<string, { type: string; config?: unknown }[]>).__calls
                .filter((call) => call.type === "helman/save_config"),
        );
        expect(saved).toHaveLength(1);
        const sent = saved[0].config as typeof CONFIG;
        // The one optimizer that moved, and nothing else in the document.
        expect(sent.automation.optimizers.map((entry) => entry.enabled))
            .toEqual([true, false, true, true]);
        expect(sent.config_version).toBe(CONFIG.config_version);
    });
});
