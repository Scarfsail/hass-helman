import { test, expect, type Page } from "@playwright/test";
import { loadBundle } from "./support/card-page";

/**
 * Whether a lane is on autopilot, said on the lane itself.
 *
 * The backend resolves it from the parsed automation config and serves it as
 * `helman/get_automation_coverage` -- which optimizer targets which
 * controllable, and whether it runs (the derivation is pinned in
 * `tests/test_automation_coverage.py`). What is worth pinning here:
 *
 * - **The three states.** Active, disabled-only and untouched are three
 *   different answers, the last one being a lane the payload does not name.
 * - **That the badge opens what it names.** A lane driven by three optimizers
 *   opens three cards, not one of them.
 * - **That it is a control of its own.** Pressing it must not also select the
 *   lane underneath, which is the other thing a press on that row does.
 * - **That every viewer sees it**, and only an admin can press it: the dialog
 *   it opens edits the admin-only config.
 */

const DAY = "2026-07-24";
const DAY_START_MS = Date.parse(`${DAY}T00:00:00Z`);
const HOUR_MS = 3_600_000;

/**
 * Two lanes and four optimizers: the inverter has three (one of them off) and
 * the boiler has one that is off. The pump has none at all. Only the edit
 * dialog reads this; the badge reads {@link COVERAGE}.
 */
const CONFIG = {
    config_version: 4,
    automation: {
        enabled: true,
        appliance_optimizers: [
            { id: "boiler_surplus", kind: "appliance_runtime", target: { controllables: [{ controllable_id: "boiler" }] }, enabled: false },
        ],
        system_optimizers: [
            { id: "charge_hold", kind: "charge_hold", target: { controllable_id: "inverter" }, enabled: true },
            { id: "export_price", kind: "export_price", target: { controllable_id: "inverter" }, enabled: false },
            { id: "night_charge", kind: "night_charge", target: { controllable_id: "inverter" }, enabled: true },
        ],
    },
};

/** What the backend resolves {@link CONFIG} to. */
const COVERAGE = {
    masterEnabled: true,
    controllables: {
        boiler: { state: "disabled_only", optimizerIds: ["boiler_surplus"] },
        inverter: { state: "active", optimizerIds: ["charge_hold", "export_price", "night_charge"] },
    },
};

interface MountOptions {
    coverage?: unknown;
    /** Mount for a viewer without admin rights. */
    nonAdmin?: boolean;
    /** Hold every coverage read open until a test releases it. */
    stallReads?: boolean;
}

async function mountBand(page: Page, options: MountOptions = {}): Promise<void> {
    const {
        coverage = COVERAGE,
        nonAdmin = false,
        stallReads = false,
    } = options;

    await loadBundle(page, "scheduling-entity-day-band");

    await page.evaluate(({ dayStartMs, hourMs, config, coverage, nonAdmin, stallReads }) => {
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
        // Let a test move the served coverage under a mounted band.
        let current = coverage;
        globals.__setCoverage = (next: unknown) => { current = next; };
        // Coverage reads parked mid-flight, for the coalescing tests.
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
            slotMinutes: 60,
        };
        band.lanes = [
            lane("inverter", "Inverter", "inverter"),
            lane("boiler", "Boiler", "boiler"),
            lane("pump", "Pump", "pump"),
        ];
        band.showForecastRows = false;
        band.showAxis = false;
        band.nowMs = dayStartMs;
        band.hass = {
            language: "en",
            locale: { language: "en" },
            user: { is_admin: !nonAdmin },
            states: {},
            connection: {
                subscribeMessage: async (callback: (message: unknown) => void) => {
                    listeners.push(callback);
                    return () => {
                        listeners.splice(listeners.indexOf(callback), 1);
                    };
                },
            },
            callWS: window.__mockHass({
                "helman/get_automation_coverage": async () => {
                    if (stallReads) {
                        await new Promise<void>((release) => { held.push(release); });
                    }
                    return current;
                },
                "helman/get_config": async () => config,
                "helman/get_optimizer_schema": async () => ({ version: 2, kinds: [] }),
                "helman/save_config": async (request: {
                    type: string;
                    config?: unknown;
                }) => {
                    return { success: true, validation: { valid: true, errors: [], warnings: [] }, reloadStarted: true };
                }
            }, (request: {
                type: string;
                config?: unknown;
            }) => {
                calls.push({ type: request.type, config: request.config });
            }).callWS,
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
    }, { dayStartMs: DAY_START_MS, hourMs: HOUR_MS, config: CONFIG, coverage, nonAdmin, stallReads });

    if (stallReads) {
        // No read will land, so there is no badge to wait for.
        return;
    }
    // The first badge only exists once the coverage read has landed.
    await expect(badge(page, "inverter")).toHaveCount(1);
}

function lane(page: Page, key: string) {
    return page.locator("scheduling-entity-day-band").locator(`.lane[data-lane="${key}"]`);
}

function badge(page: Page, key: string) {
    return lane(page, key).locator(".automation-badge");
}

/** Whether each card in the open dialog is expanded, in pipeline order. */
async function cardsOpen(page: Page): Promise<boolean[]> {
    return page.evaluate(() => [...(document
        .querySelector("scheduling-entity-day-band")!
        .shadowRoot!.querySelector("helman-optimizer-edit-dialog")
        ?.shadowRoot?.querySelectorAll("helman-optimizer-editor") ?? [])]
        .map((editor) => !!editor.shadowRoot!.querySelector("details")?.open));
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

    test("several automations open collapsed -- the list is what was asked for", async ({ page }) => {
        // Three cards expanded is several screens of form, and the badge was
        // pressed to see *what* drives the lane, not to edit all three.
        await mountBand(page);
        await badge(page, "inverter").click();
        await expect(page.locator("helman-optimizer-edit-dialog helman-optimizer-editor"))
            .toHaveCount(3);

        expect(await cardsOpen(page)).toEqual([false, false, false]);
    });

    test("a lone automation opens expanded -- it is the whole dialog", async ({ page }) => {
        await mountBand(page);
        await badge(page, "boiler").click();
        await expect(page.locator("helman-optimizer-edit-dialog helman-optimizer-editor"))
            .toHaveCount(1);

        expect(await cardsOpen(page)).toEqual([true]);
    });

    test("pressing it does not also select the lane underneath", async ({ page }) => {
        await mountBand(page);
        await badge(page, "inverter").click();

        expect(await readEvents(page)).toEqual([]);
    });

    test("a config saved elsewhere recolours the badge", async ({ page }) => {
        await mountBand(page);
        expect(await badgeState(page, "boiler")).toBe("disabled_only");

        await page.evaluate(() => {
            const globals = window as unknown as Record<string, (next: unknown) => void>;
            globals.__setCoverage({
                masterEnabled: true,
                controllables: { boiler: { state: "active", optimizerIds: ["boiler_surplus"] } },
            });
        });
        await fireDataChanged(page);

        expect(await badgeState(page, "boiler")).toBe("active");
        expect(await badgeState(page, "inverter")).toBe("none");
    });

    test("a viewer without admin rights sees the badge, but cannot open it", async ({ page }) => {
        await mountBand(page, { nonAdmin: true });

        expect(await badgeState(page, "inverter")).toBe("active");
        expect(await badgeState(page, "boiler")).toBe("disabled_only");
        // Inert, like a lane with nothing to open: the dialog is admin-only.
        expect(await badge(page, "inverter").evaluate((element) => element.tagName)).toBe("SPAN");
        await badge(page, "inverter").dispatchEvent("click");
        await expect(page.locator("helman-optimizer-edit-dialog")).toHaveCount(0);

        const types = await page.evaluate(
            () => (window as unknown as Record<string, { type: string }[]>).__calls.map((call) => call.type),
        );
        expect(types).not.toContain("helman/get_config");
    });

    test("a change arriving mid-read is not swallowed by the coalescing", async ({ page }) => {
        await mountBand(page, { stallReads: true });

        // The first read is parked. Move the coverage and announce it while it
        // is still in flight: without a trailing edge this is dropped.
        await page.evaluate(() => {
            (window as unknown as Record<string, (next: unknown) => void>).__setCoverage({
                masterEnabled: true,
                controllables: { pump: { state: "active", optimizerIds: ["pump_surplus"] } },
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

    test("the coverage is read once however many lanes ask", async ({ page }) => {
        await mountBand(page);

        const calls = await page.evaluate(
            () => (window as unknown as Record<string, { type: string }[]>).__calls,
        );
        expect(calls.filter((call) => call.type === "helman/get_automation_coverage")).toHaveLength(1);
        // The config is the dialog's business, read only once a badge is pressed.
        expect(calls.filter((call) => call.type === "helman/get_config")).toHaveLength(0);
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
        expect(sent.automation.appliance_optimizers.map((entry) => entry.enabled))
            .toEqual([true]);
        expect(sent.automation.system_optimizers.map((entry) => entry.enabled))
            .toEqual([true, false, true]);
        expect(sent.config_version).toBe(CONFIG.config_version);
    });
});
