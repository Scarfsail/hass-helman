import { test, expect, type Page } from "@playwright/test";
import { prepareNodeDetailPage, mountSimpleCard } from "./support/node-detail-harness";
import { treeNode, treePayload } from "./support/payload-builders";
import type { SchedulePayload } from "../cards/helman-api";

/**
 * The Control tab of the inverter and battery details, on the real simple
 * card against a fake backend.
 *
 * What is pinned: who owns the inverter lane now and how that is worked out
 * (execution, the user's run in progress, the automation coverage, and
 * loading or unavailable before any of it is known); that an override is a
 * bounded user-authored stretch of the schedule written through the shared
 * slot patches, claiming its slots even where the automation planned the
 * same, keeping every other lane's user action and never copying an
 * automation's; that returning to automatic clears only the run in progress;
 * that an admin's automation switch saves one flag against the revision it
 * read; and the tabs and nested dialogs' keyboard and Back behaviour.
 */

declare global {
    interface Window {
        __schedule: SchedulePayload;
        __toasts: string[];
        __setScheduleFails: boolean;
        __releaseNodeSave: (() => void) | null;
        __detailClosed: boolean;
        __coverageFails: boolean;
        __configFails: boolean;
        __scheduleWrite: Promise<void> | null;
    }
}

const DAY = "2026-10-21";
const auto = (kind: string, extra: object = {}) => ({ kind, setBy: "automation", ...extra });
const user = (kind: string, extra: object = {}) => ({ kind, setBy: "user", ...extra });

type Stretch = [from: string, to: string, lanes: Record<string, object>];

/**
 * 15-minute slots from `start` for `hours`, the inverter planned "normal"
 * by the automation throughout unless a stretch says otherwise; a time in
 * `skip` (HH:MM, UTC) is a gap. A stretch's times are HH:MM today, UTC, or
 * full ISO instants.
 */
function plan(stretches: Stretch[] = [], { start = `${DAY}T12:00:00Z`, hours = 24, skip = [] as string[], executionEnabled = true } = {}): SchedulePayload {
    const instant = (value: string) => Date.parse(value.includes("T") ? value : `${DAY}T${value}:00Z`);
    const slots = [];
    for (let ms = Date.parse(start); ms < Date.parse(start) + hours * 3_600_000; ms += 900_000) {
        const id = new Date(ms).toISOString().replace(".000Z", "+00:00");
        if (skip.includes(id.slice(11, 16))) continue;
        const controllables: Record<string, object> = { inverter: auto("normal") };
        for (const [from, to, lanes] of stretches) {
            if (ms >= instant(from) && ms < instant(to)) Object.assign(controllables, lanes);
        }
        slots.push({ id, controllables });
    }
    return { executionEnabled, slotMinutes: 15, slots } as unknown as SchedulePayload;
}

const OPTIMIZERS = [
    { id: "export_price", kind: "export_price", enabled: true },
    { id: "charge_hold", kind: "charge_hold", enabled: true },
];

/** The full card's tree, as its inverter spec mounts it. */
const FULL_CARD_TREE = treePayload({
    sources: [
        treeNode({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar" }),
        treeNode({ id: "battery", displayName: "Battery", powerSensorId: "sensor.battery", isSource: true, sourceType: "battery" }),
    ],
    consumers: [treeNode({ id: "house", displayName: "House", powerSensorId: "sensor.house" })],
    consumptionTotalSensorId: null,
    productionTotalSensorId: null,
    uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
});

interface Setup {
    schedule?: SchedulePayload | "pending" | "error";
    coverage?: "active" | "disabled_only" | "none";
    /** Every coverage read fails until `__coverageFails` is cleared. */
    coverageFails?: boolean;
    /** The roster read fails. */
    rosterFails?: boolean;
    /** Every config read fails until `__configFails` is cleared. */
    configFails?: boolean;
    /** Every config save stores the document but its reload fails. */
    reloadFails?: boolean;
    admin?: boolean;
    /** Answer every save with a conflict and this newer document. */
    conflict?: object;
    /** Hold every config save until `__releaseNodeSave`. */
    holdSave?: boolean;
    timeZone?: string;
    /** The page's clock, before anything mounts. */
    now?: string;
}

async function mount(page: Page, setup: Setup = {}, card = "helman-simple-card"): Promise<void> {
    await prepareNodeDetailPage(page);
    if (setup.now) await page.clock.setFixedTime(new Date(setup.now));
    await page.evaluate(({ o, schedule, optimizers, tree }) => {
        const s = window.__nodeDetailState;
        window.__toasts = [];
        window.__setScheduleFails = false;
        window.__scheduleWrite = null;
        window.__releaseNodeSave = null;
        window.__coverageFails = !!o.coverageFails;
        window.__configFails = !!o.configFails;
        window.addEventListener("hass-notification", (event) => window.__toasts.push((event as CustomEvent).detail.message));
        if (typeof schedule === "object") window.__schedule = schedule;
        const kinds = ["normal", "stop_charging", "stop_discharging", "charge_to_target_soc", "discharge_to_target_soc", "stop_export"];
        const coverage = o.coverage ?? "active";
        window.__configureNodeDetail({
            ...(tree ? { tree } : {}),
            states: {
                "sensor.solar": s("4200", "W"), "sensor.grid": s("-300", "W"), "sensor.battery": s("-500", "W"), "sensor.house": s("1200", "W"),
                "select.helman_inverter_mode": s("normal", undefined, { friendly_name: "Helman inverter mode" }),
            },
            overviews: { inverter: window.__inverterOverview({ configured: true }) },
            timeZone: o.timeZone,
            hass: { user: { is_admin: !!o.admin } },
            replies: {
                "helman/get_schedule": schedule === "pending" ? () => new Promise(() => undefined)
                    : schedule === "error" ? () => { throw new Error("schedule down"); }
                    : () => window.__schedule,
                "helman/set_schedule": async () => {
                    await window.__scheduleWrite;
                    if (window.__setScheduleFails) throw new Error("write refused");
                    return window.__schedule;
                },
                "helman/get_appliances": () => { if (o.rosterFails) throw new Error("roster down"); return { appliances: [{
                    id: "inverter", name: "Inverter", kind: "inverter", primaryEntityId: "select.helman_inverter_mode",
                    supportsAuthoring: true, normalState: "normal", actionOptions: Object.fromEntries(kinds.map((kind) => [kind, kind])),
                }] }; },
                "helman/get_automation_coverage": () => {
                    if (window.__coverageFails) throw new Error("coverage down");
                    return {
                        masterEnabled: true,
                        controllables: coverage === "none" ? {} : { inverter: { state: coverage, optimizerIds: optimizers.map((entry) => entry.id) } },
                    };
                },
                "helman/get_config": () => {
                    if (window.__configFails) throw new Error("config down");
                    return { automation: { enabled: true, system_optimizers: optimizers, appliance_optimizers: [] } };
                },
                ...(o.reloadFails ? { "helman/save_config": () => ({
                    success: false, validation: { valid: true, errors: [], warnings: [] }, reloadStarted: true, reloadError: "reload exploded",
                }) } : {}),
                ...(o.conflict ? { "helman/save_config": () => ({ success: false, conflict: true, config: o.conflict, revision: "newer" }) } : {}),
                ...(o.holdSave ? { "helman/save_config": () => new Promise((resolve) => {
                    window.__releaseNodeSave = () => resolve({ success: true, validation: { valid: true, errors: [], warnings: [] }, reloadStarted: true });
                }) } : {}),
            },
        });
    }, { o: setup, schedule: setup.schedule ?? plan(), optimizers: OPTIMIZERS, tree: card === "helman-card" ? FULL_CARD_TREE : undefined });
    await mountSimpleCard(page, undefined, card);
}

const control = (page: Page) => page.locator("helman-node-control");
const status = (page: Page) => control(page).locator("[data-status]");
const tab = (page: Page, name: "overview" | "control") => page.locator(`node-detail-dialog [data-tab="${name}"]`);
const overrideDialog = (page: Page) => page.locator("control-override-dialog");
const requests = (page: Page, type: string) => page.evaluate((type) => window.__NodeDetailRequests.filter((r) => r.type === type), type);

async function openControl(page: Page, node: "inverter" | "battery" = "inverter"): Promise<void> {
    await (node === "inverter" ? page.locator(".inverter-cell") : page.locator(".node-cell:has(simple-card-battery)")).click();
    await tab(page, "control").click();
    await expect(control(page)).toBeVisible();
}

/** The shared clock's tick, as the page becoming visible again delivers it. */
async function tickAt(page: Page, iso: string): Promise<void> {
    await page.clock.setFixedTime(new Date(iso));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

/** Deliver the data changes collected so far, as the page becoming visible again does. */
async function flushDataChanged(page: Page): Promise<void> {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

async function openOverride(page: Page): Promise<void> {
    await control(page).locator("[data-change]").click();
    await expect(overrideDialog(page).locator("[data-to]")).toBeVisible();
}

async function save(page: Page): Promise<void> {
    await overrideDialog(page).locator("[data-save]").click();
}

const setScheduleSlots = async (page: Page) => (await requests(page, "helman/set_schedule")).map((r) => r.slots as Array<{ id: string; controllables: unknown }>);

test.describe("who owns the lane", () => {
    for (const [coverage, text, kind] of [
        ["active", "Automatic", "automatic"],
        ["disabled_only", "Automation off", "automation_off"],
        ["none", "Not automated", "not_automated"],
    ] as const) {
        test(`coverage ${coverage} reads ${text}`, async ({ page }) => {
            await mount(page, { coverage });
            await openControl(page);
            await expect(status(page)).toHaveText(text);
            await expect(status(page)).toHaveAttribute("data-status", kind);
        });
    }

    test("the user's run in progress is manual until it ends, in the user's authorship tone", async ({ page }) => {
        await mount(page, { schedule: plan([["12:00", "13:00", { inverter: user("stop_export") }]]) });
        await openControl(page);
        await expect(status(page)).toHaveText("Manual until Today 13:00");
        await expect(status(page)).toHaveClass(/authorship-user/);
    });

    test("execution off wins over a manual run and says no hardware changes", async ({ page }) => {
        await mount(page, { schedule: plan([["12:00", "13:00", { inverter: user("stop_export") }]], { executionEnabled: false }) });
        await openControl(page);
        await expect(status(page)).toHaveText("Execution off");
        await expect(control(page).locator("[data-execution-off]")).toContainText("no hardware change");
        // The run can still be released.
        await expect(control(page).locator("[data-return]")).toBeVisible();
    });

    test("loading until the schedule answers, never read as no automation", async ({ page }) => {
        await mount(page, { schedule: "pending" });
        await openControl(page);
        await expect(status(page)).toHaveText("Loading…");
        await expect(control(page).locator("[data-change]")).toHaveCount(0);
    });

    test("unavailable once the schedule's read failed", async ({ page }) => {
        await mount(page, { schedule: "error" });
        await openControl(page);
        await expect(status(page)).toHaveText("Control state unavailable");
    });

    test("unavailable, not loading, once the coverage's read failed, and recovered by the next good read", async ({ page }) => {
        await mount(page, { coverageFails: true });
        await openControl(page);
        await expect(status(page)).toHaveText("Control state unavailable");
        await page.evaluate(() => { window.__coverageFails = false; window.__fireDataChanged("config"); });
        await flushDataChanged(page);
        await expect(status(page)).toHaveText("Automatic");
    });

    test("a failed roster read is unavailable, never read as no controllable", async ({ page }) => {
        await mount(page, { rosterFails: true });
        await openControl(page);
        await expect(control(page).locator("[data-roster-failed]")).toHaveText("Control state unavailable");
        await expect(control(page).locator("[data-not-on-roster]")).toHaveCount(0);
        await expect(control(page).locator("[data-change]")).toHaveCount(0);
    });

    test("a manual run ending tomorrow names its day", async ({ page }) => {
        await mount(page, { schedule: plan([["12:00", "2026-10-22T01:00:00Z", { inverter: user("stop_export") }]]) });
        await openControl(page);
        await expect(status(page)).toHaveText("Manual until Tomorrow 01:00");
    });

    test("a manual run carries differing user actions and stops at the first automation slot", async ({ page }) => {
        await mount(page, { schedule: plan([
            ["12:00", "12:30", { inverter: user("normal") }],
            ["12:30", "13:00", { inverter: user("charge_to_target_soc", { targetSoc: 80 }) }],
            ["13:15", "14:00", { inverter: user("stop_export") }],
        ]) });
        await openControl(page);
        await expect(status(page)).toHaveText("Manual until Today 13:00");
    });

    test("a manual run stops at a gap in the schedule", async ({ page }) => {
        await mount(page, { schedule: plan([["12:00", "14:00", { inverter: user("stop_export") }]], { skip: ["12:30"] }) });
        await openControl(page);
        await expect(status(page)).toHaveText("Manual until Today 12:30");
    });

    test("the status moves on at the slot boundary", async ({ page }) => {
        await mount(page, { schedule: plan([["12:00", "12:15", { inverter: user("stop_export") }]]) });
        await openControl(page);
        await expect(status(page)).toHaveText("Manual until Today 12:15");
        await tickAt(page, `${DAY}T12:15:30Z`);
        await expect(status(page)).toHaveText("Automatic");
    });

    test("the hardware's live state and the scheduled action are shown apart", async ({ page }) => {
        await mount(page, { schedule: plan([["12:00", "13:00", { inverter: user("stop_export") }]]) });
        await openControl(page);
        await expect(control(page).locator("[data-now]")).toContainText("Normal");
        await expect(control(page).locator("[data-scheduled]")).toContainText("Stop export");
    });

    test("the battery is controlled on the inverter's lane, and says so", async ({ page }) => {
        await mount(page, { schedule: plan([["12:00", "13:00", { inverter: user("stop_export") }]]) });
        await openControl(page, "battery");
        await expect(control(page).locator("[data-lane-note]")).toContainText("inverter");
        await expect(status(page)).toHaveText("Manual until Today 13:00");
    });
});

test.describe("the tabs", () => {
    test("open on Overview, unmount the hidden tab and reset on reopening", async ({ page }) => {
        await mount(page);
        await page.locator(".inverter-cell").click();
        await expect(tab(page, "overview")).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("node-detail-inverter-content")).toHaveCount(1);
        await expect(control(page)).toHaveCount(0);

        await tab(page, "control").click();
        await expect(tab(page, "control")).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("node-detail-inverter-content")).toHaveCount(0);
        await expect(control(page)).toHaveCount(1);

        // Reopened, then another node: each starts on Overview.
        await page.locator("node-detail-dialog").evaluate((detail: any) => { detail.open = false; });
        await page.locator("node-detail-dialog").evaluate((detail: any) => { detail.open = true; });
        await expect(tab(page, "overview")).toHaveAttribute("aria-selected", "true");
        await tab(page, "control").click();
        await page.locator(".node-cell:has(simple-card-battery)").click();
        await expect(tab(page, "overview")).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("node-detail-battery-content")).toHaveCount(1);
    });

    test("are a keyboard tab list: arrows, Home and End move the selection and focus", async ({ page }) => {
        await mount(page);
        await page.locator(".inverter-cell").click();
        await expect(page.locator("node-detail-dialog [role=tablist]")).toBeVisible();
        await expect(tab(page, "control")).toHaveAttribute("tabindex", "-1");
        await tab(page, "overview").focus();
        await page.keyboard.press("ArrowRight");
        await expect(tab(page, "control")).toHaveAttribute("aria-selected", "true");
        await expect(tab(page, "control")).toBeFocused();
        await expect(control(page)).toBeVisible();
        await page.keyboard.press("Home");
        await expect(tab(page, "overview")).toBeFocused();
        await page.keyboard.press("End");
        await expect(tab(page, "control")).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("ArrowLeft");
        await expect(tab(page, "overview")).toHaveAttribute("aria-selected", "true");
    });

    test("Back closes the override first, then the node detail", async ({ page }) => {
        await mount(page);
        await openControl(page);
        await page.locator("node-detail-dialog").evaluate((detail: any) => {
            window.__detailClosed = false;
            detail.shadowRoot.querySelector("[data-dialog='close']").addEventListener("click", () => { window.__detailClosed = true; });
        });
        await openOverride(page);
        await expect.poll(() => page.evaluate(() => window.history.state?.__helmanNodeControlDialogId)).toBeTruthy();
        await page.evaluate(() => window.history.back());
        await expect(overrideDialog(page)).toHaveCount(0);
        expect(await page.evaluate(() => window.__detailClosed)).toBe(false);
        await expect(control(page)).toBeVisible();
        await page.evaluate(() => window.history.back());
        await expect.poll(() => page.evaluate(() => window.__detailClosed)).toBe(true);
    });
});

test.describe("the override", () => {
    test("writes the chosen range as user slots, keeping another lane's user action and no automation's", async ({ page }) => {
        await mount(page, { schedule: plan([
            ["12:00", "12:30", { boiler: { on: true, setBy: "user" } }],
            ["12:00", "14:00", { heater: { on: true, setBy: "automation" } }],
        ]) });
        await openControl(page);
        await openOverride(page);
        await expect(overrideDialog(page).locator("[data-from]")).toHaveText("Today 12:00");
        await expect(overrideDialog(page).locator("[data-save]")).toHaveJSProperty("disabled", true);
        // The option's radio is visually hidden: a reader presses its chip.
        await overrideDialog(page).locator('scheduling-action-option-card:has(input[value="stop_export"])').click();
        await expect(page.getByRole("radio", { name: "Stop export" })).toBeChecked();
        await overrideDialog(page).locator('[data-pick="plus_1h"]').click();
        await expect(overrideDialog(page).locator("[data-to]")).toHaveValue(String(Date.parse(`${DAY}T13:00:00Z`)));
        await save(page);
        await expect(overrideDialog(page)).toHaveCount(0);
        expect(await setScheduleSlots(page)).toEqual([[
            { id: `${DAY}T12:00:00+00:00`, controllables: { boiler: { on: true }, inverter: { kind: "stop_export" } } },
            { id: `${DAY}T12:15:00+00:00`, controllables: { boiler: { on: true }, inverter: { kind: "stop_export" } } },
            { id: `${DAY}T12:30:00+00:00`, controllables: { inverter: { kind: "stop_export" } } },
            { id: `${DAY}T12:45:00+00:00`, controllables: { inverter: { kind: "stop_export" } } },
        ]]);
        expect(await page.evaluate(() => window.__toasts)).toEqual(["Override saved until Today 13:00."]);
    });

    test("holding the automation's own action still takes the slots over", async ({ page }) => {
        await mount(page);
        await openControl(page);
        await openOverride(page);
        // Seeded with the action in progress: the automation's "normal".
        await expect(page.getByRole("radio", { name: "Normal" })).toBeChecked();
        await overrideDialog(page).locator('[data-pick="plus_1h"]').click();
        await save(page);
        const [slots] = await setScheduleSlots(page);
        expect(slots).toHaveLength(4);
        expect(slots.every((slot) => JSON.stringify(slot.controllables) === JSON.stringify({ inverter: { kind: "normal" } }))).toBe(true);
    });

    test("offers only the quick picks the loaded schedule has an edge for", async ({ page }) => {
        // Two hours of schedule: no +3 h, no end of day; the plan changes at 13:00.
        await mount(page, { schedule: plan([["13:00", "14:00", { inverter: auto("stop_export") }]], { hours: 2 }) });
        await openControl(page);
        await openOverride(page);
        const picks = overrideDialog(page).locator("[data-pick]");
        await expect(picks).toHaveCount(2);
        await expect(picks.nth(0)).toHaveAttribute("data-pick", "plus_1h");
        await expect(picks.nth(1)).toHaveAttribute("data-pick", "next_change");
        await picks.nth(1).click();
        await expect(overrideDialog(page).locator("[data-to]")).toHaveValue(String(Date.parse(`${DAY}T13:00:00Z`)));
        // The last edge is the horizon.
        await expect(overrideDialog(page).locator("[data-to] option").last()).toHaveText("Today 14:00");
    });

    test("spans midnight and the repeated hour as daylight saving ends, telling the two apart", async ({ page }) => {
        // 23:30 in Prague on the night the clocks go back: 02:00–03:00 happens twice.
        await mount(page, { now: "2026-10-24T21:30:00Z", timeZone: "Europe/Prague", schedule: plan([], { start: "2026-10-24T21:30:00Z", hours: 6 }) });
        await openControl(page);
        await openOverride(page);
        await expect(overrideDialog(page).locator("[data-from]")).toHaveText("Today 23:30");
        const options = await overrideDialog(page).locator("[data-to] option").allTextContents();
        expect(options.filter((label) => label.includes("02:15"))).toEqual(["Tomorrow 02:15 (UTC+02:00)", "Tomorrow 02:15 (UTC+01:00)"]);
        await overrideDialog(page).locator('[data-pick="end_of_day"]').click();
        await expect(overrideDialog(page).locator("[data-to]")).toHaveValue(String(Date.parse("2026-10-24T22:00:00Z")));
        // To the second 02:15: 15 slots, across midnight and both 02:00 hours.
        await overrideDialog(page).locator("[data-to]").selectOption(String(Date.parse("2026-10-25T01:15:00Z")));
        await save(page);
        const [slots] = await setScheduleSlots(page);
        expect(slots.map((slot) => slot.id)).toEqual(Array.from({ length: 15 }, (_, i) =>
            new Date(Date.parse("2026-10-24T21:30:00Z") + i * 900_000).toISOString().replace(".000Z", "+00:00")));
    });

    test("a range that elapsed before the press saves nothing and stays open", async ({ page }) => {
        await mount(page);
        await openControl(page);
        await openOverride(page);
        await overrideDialog(page).locator("[data-to]").selectOption(String(Date.parse(`${DAY}T12:15:00Z`)));
        await page.clock.setFixedTime(new Date(`${DAY}T12:16:00Z`));
        await save(page);
        await expect(overrideDialog(page).locator("[data-error]")).toContainText("Nothing to save");
        expect(await requests(page, "helman/set_schedule")).toHaveLength(0);
    });

    test("a refused write is shown and keeps the dialog open", async ({ page }) => {
        await mount(page);
        await openControl(page);
        await openOverride(page);
        await page.evaluate(() => { window.__setScheduleFails = true; });
        await overrideDialog(page).locator('[data-pick="plus_1h"]').click();
        await save(page);
        await expect(overrideDialog(page).locator("[data-error]")).toContainText("write refused");
        expect(await page.evaluate(() => window.__toasts)).toEqual([]);
    });

    test("the dialog's own close waits for the write, so a refused write is still shown", async ({ page }) => {
        await mount(page);
        await openControl(page);
        await openOverride(page);
        await page.evaluate(() => {
            window.__setScheduleFails = true;
            window.__scheduleWrite = new Promise((resolve) => { window.__releaseNodeSave = resolve; });
        });
        await overrideDialog(page).locator('[data-pick="plus_1h"]').click();
        await save(page);
        await expect(overrideDialog(page).locator("[data-save]")).toHaveText("Saving…");
        await overrideDialog(page).evaluate((dialog) => (dialog.shadowRoot!.querySelector("ha-dialog") as any).close());
        await page.evaluate(() => window.__releaseNodeSave!());
        await expect(overrideDialog(page).locator("[data-error]")).toContainText("write refused");
    });

    test("with execution off it is saved but never claimed to run", async ({ page }) => {
        await mount(page, { schedule: plan([], { executionEnabled: false }) });
        await openControl(page);
        await openOverride(page);
        await expect(overrideDialog(page).locator("[data-execution-off]")).toContainText("does not change the hardware");
        await overrideDialog(page).locator('[data-pick="plus_1h"]').click();
        await save(page);
        await expect(overrideDialog(page)).toHaveCount(0);
        expect(await page.evaluate(() => window.__toasts)).toEqual(["Override saved until Today 13:00. Execution is off, so the hardware does not change."]);
    });
});

test("Return to automatic clears only the run in progress and keeps a later override and other lanes", async ({ page }) => {
    await mount(page, { schedule: plan([
        ["12:00", "12:15", { inverter: user("stop_export"), boiler: { on: true, setBy: "user" } }],
        ["12:15", "12:30", { inverter: user("normal") }],
        ["13:00", "13:30", { inverter: user("stop_charging") }],
    ]) });
    await openControl(page);
    await control(page).locator("[data-return]").click();
    await expect.poll(() => setScheduleSlots(page)).toEqual([[
        { id: `${DAY}T12:00:00+00:00`, controllables: { boiler: { on: true } } },
        { id: `${DAY}T12:15:00+00:00`, controllables: {} },
    ]]);
    expect(await page.evaluate(() => window.__toasts)).toEqual(["Returned to automatic."]);
});

test.describe("the automation rows", () => {
    const toggle = (page: Page, id: string) => control(page).locator(`[data-optimizer="${id}"] ha-switch`);
    const flip = (page: Page, id: string, checked: boolean) => toggle(page, id).evaluate((element: any, checked) => {
        element.checked = checked;
        element.dispatchEvent(new Event("change"));
    }, checked);

    test("an admin's switch saves only its optimizer's flag with the revision read, disabled while writing", async ({ page }) => {
        await mount(page, { admin: true, holdSave: true });
        await openControl(page);
        await expect(control(page).locator("[data-optimizer]")).toHaveCount(2);
        await expect(toggle(page, "export_price")).toHaveJSProperty("checked", true);
        await expect(toggle(page, "export_price")).toHaveJSProperty("disabled", false);
        await flip(page, "export_price", false);
        await expect.poll(() => requests(page, "helman/save_config").then((list) => list.length)).toBe(1);
        await expect(toggle(page, "export_price")).toHaveJSProperty("disabled", true);
        await expect(toggle(page, "charge_hold")).toHaveJSProperty("disabled", true);
        const [saved] = await requests(page, "helman/save_config");
        expect(saved.config).toEqual({ automation: { enabled: true, appliance_optimizers: [], system_optimizers: [
            { id: "export_price", kind: "export_price", enabled: false },
            { id: "charge_hold", kind: "charge_hold", enabled: true },
        ] } });
        expect(saved.expected_revision).toBe(await page.evaluate(() => window.__configRevision({
            automation: { enabled: true, system_optimizers: [{ id: "export_price", kind: "export_price", enabled: true }, { id: "charge_hold", kind: "charge_hold", enabled: true }], appliance_optimizers: [] },
        })));
        await page.evaluate(() => window.__releaseNodeSave!());
        await expect(toggle(page, "export_price")).toHaveJSProperty("disabled", false);
        await expect(toggle(page, "export_price")).toHaveJSProperty("checked", false);
        expect(await page.evaluate(() => window.__toasts)).toEqual(["Config saved. Helman reload started."]);
    });

    test("a conflict shows the newer document and saves nothing more", async ({ page }) => {
        const newer = { automation: { enabled: true, appliance_optimizers: [], system_optimizers: [
            { id: "export_price", kind: "export_price", enabled: true },
            { id: "charge_hold", kind: "charge_hold", enabled: false },
        ] } };
        await mount(page, { admin: true, conflict: newer });
        await openControl(page);
        await expect(toggle(page, "export_price")).toHaveJSProperty("disabled", false);
        await flip(page, "export_price", false);
        await expect.poll(() => page.evaluate(() => window.__toasts)).toEqual(["The stored config changed elsewhere — reload to see it"]);
        await expect(toggle(page, "export_price")).toHaveJSProperty("checked", true);
        await expect(toggle(page, "charge_hold")).toHaveJSProperty("checked", false);
        expect(await requests(page, "helman/save_config")).toHaveLength(1);
    });

    test("a save whose reload failed says so, not that it saved", async ({ page }) => {
        await mount(page, { admin: true, reloadFails: true });
        await openControl(page);
        await expect(toggle(page, "export_price")).toHaveJSProperty("disabled", false);
        await flip(page, "export_price", false);
        await expect.poll(() => page.evaluate(() => window.__toasts)).toEqual(["reload exploded"]);
    });

    test("a failed config read is shown and the next data change reads again", async ({ page }) => {
        await mount(page, { admin: true, configFails: true });
        await openControl(page);
        await expect(control(page).locator("[data-config-error]")).toContainText("config down");
        await expect(toggle(page, "export_price")).toHaveJSProperty("disabled", true);
        await page.evaluate(() => { window.__configFails = false; window.__fireDataChanged("config"); });
        await flushDataChanged(page);
        await expect(control(page).locator("[data-config-error]")).toHaveCount(0);
        await expect(toggle(page, "export_price")).toHaveJSProperty("disabled", false);
    });

    test("a non-admin gets the schedule controls without reading the config", async ({ page }) => {
        await mount(page, { admin: false });
        await openControl(page);
        await expect(status(page)).toHaveText("Automatic");
        await expect(control(page).locator("[data-automations]")).toHaveCount(0);
        await openOverride(page);
        await overrideDialog(page).locator('[data-pick="plus_1h"]').click();
        await save(page);
        await expect.poll(() => requests(page, "helman/set_schedule").then((list) => list.length)).toBe(1);
        expect(await requests(page, "helman/get_config")).toHaveLength(0);
    });
});

test.describe("on both cards and a phone", () => {
    test("the full card opens the same Control tab", async ({ page }) => {
        await mount(page, { schedule: plan([["12:00", "13:00", { inverter: user("stop_export") }]]) }, "helman-card");
        await openControl(page);
        await expect(status(page)).toHaveText("Manual until Today 13:00");
    });

    test("fits 360 px without sideways scrolling, the override dialog too", async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 800 });
        await mount(page, { admin: true });
        await openControl(page);
        // Every box inside stays within the screen and none scrolls sideways.
        const fits = (selector: string) => page.locator(selector).evaluate((root) => [root, ...root.shadowRoot!.querySelectorAll("*")]
            .every((element) => element.getBoundingClientRect().right <= 360
                && (element.clientWidth === 0 || element.scrollWidth <= element.clientWidth + 1)));
        expect(await fits("helman-node-control")).toBe(true);
        await openOverride(page);
        expect(await fits("control-override-dialog")).toBe(true);
    });
});
