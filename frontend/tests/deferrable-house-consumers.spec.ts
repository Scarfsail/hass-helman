import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The power card marks shiftable house consumers.
 *
 * A house child whose energy statistic is a deferrable controllable arrives from
 * the device tree with `deferrable: true`, and the card says so twice: the box
 * takes the shared lighter house shade instead of inheriting the section's house
 * tint, and — where the tree also named the controllable — a calendar-clock
 * badge sits at bottom-right tinted by who scheduled the appliance in the slot
 * running right now. The tint of the box follows the flag alone, so an inspector
 * band and a card box for the same appliance are the same colour, which is the
 * point of the flag.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

// DEFERRABLE_HOUSE_COLOR under nodeAccentColor's alpha — the same value the
// inspector's composition panel paints its shiftable rows with.
const DEFERRABLE_TINT = "#e2c6fc60";

// The authorship hooks the scheduling UI already owns; the badge reads exactly
// these, so a theme override moves band, chip and badge together.
const AUTOMATION_COLOR = "var(--schedule-authorship-automation-color, #2563eb)";
const USER_COLOR = "var(--schedule-authorship-user-color, #c49012)";
const MIXED_COLOR = "var(--schedule-authorship-mixed-color, #ea7a18)";
const NONE_COLOR = "var(--schedule-authorship-none-color, #7b8798)";

interface FakeNode {
    id: string;
    name: string;
    deferrable?: boolean;
    controllableId?: string | null;
    customLabelTexts?: string[];
    children?: FakeNode[];
}

interface RenderedRow {
    label: string;
    tint: string;
    /** The `.custom-labels` span, which no longer carries the word "deferrable". */
    tag: string;
    /** The badge's inline colour, or null when the box draws no badge. */
    badgeColor: string | null;
}

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("power-devices-container"));
}

/**
 * A backend with one slot running now, the dishwasher in it by the optimizer and
 * the boiler in it by hand.
 *
 * The badge only colours an action that will actually run, so the rosters matter
 * as much as the schedule: they are what say the resting state is "off", and
 * hence that "on" is a change worth marking.
 */
async function installFakeBackend(page: Page): Promise<void> {
    await page.evaluate(() => {
        window.__wsSeen = [];
        const nowMs = Date.now();
        const slotStartMs = nowMs - nowMs % 3_600_000;
        const slotId = (ms: number) => new Date(ms).toISOString();
        const appliance = (id: string, entityId: string) => ({
            id,
            name: id,
            kind: "generic",
            metadata: { icon: "mdi:flash", scheduleCapabilities: { onOffToggle: true } },
            controls: { switch: { entityId } },
        });

        window.__fakeHass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            connection: {},
            states: {},
            callWS: async (msg: { type: string }) => {
                window.__wsSeen.push(msg.type);
                if (msg.type === "helman/get_schedule") {
                    return {
                        executionEnabled: true,
                        slots: [
                            {
                                id: slotId(slotStartMs - 3_600_000),
                                controllables: {},
                            },
                            {
                                id: slotId(slotStartMs),
                                controllables: {
                                    dishwasher: { on: true, setBy: "automation" },
                                    boiler: { on: true, setBy: "user" },
                                    // A candidate is never executed, so it is
                                    // nothing scheduled — and a stop leaves the
                                    // appliance in its resting state, which is
                                    // nothing scheduled too.
                                    pump: { on: true, conditionMet: false, setBy: "user" },
                                    fan: { on: false, setBy: "automation" },
                                },
                            },
                            {
                                id: slotId(slotStartMs + 3_600_000),
                                controllables: {},
                            },
                        ],
                    };
                }
                if (msg.type === "helman/get_appliances") {
                    return {
                        appliances: [
                            appliance("dishwasher", "switch.dishwasher"),
                            appliance("boiler", "switch.boiler"),
                            appliance("pump", "switch.pump"),
                            appliance("fan", "switch.fan"),
                        ],
                    };
                }
                if (msg.type === "helman/get_controllable_entities") {
                    return {
                        entities: ["dishwasher", "boiler", "pump", "fan"].map((id) => ({
                            kind: "generic",
                            name: id,
                            entityId: `switch.${id}`,
                            normalState: "off",
                        })),
                    };
                }
                return {};
            },
        };
    });
}

/** Mount the house consumers, then read back each box's tint and markers. */
async function renderedRows(page: Page, nodes: FakeNode[]): Promise<RenderedRow[]> {
    await mountRows(page, nodes);
    // The schedule and the two rosters land over three round trips, and until
    // all three are in every badge is honestly grey — so reading before then
    // would race a genuine intermediate state rather than catch a bug.
    await page.waitForFunction(() => window.__wsSeen.length >= 3);
    return readRows(page);
}

async function mountRows(page: Page, nodes: FakeNode[]): Promise<void> {
    await page.evaluate(async (fakeNodes) => {
        const hydrate = (node: any): any => ({
            children: [],
            valueType: "default",
            isSource: false,
            isUnmeasured: false,
            powerValue: 100,
            powerHistory: [100],
            historyBuckets: 1,
            ...node,
            ...(node.children ? { children: node.children.map(hydrate) } : {}),
        });

        const el = document.createElement("power-devices-container") as any;
        el.hass = window.__fakeHass;
        el.devices = fakeNodes.map(hydrate);
        el.historyBuckets = 1;
        el.historyBucketDuration = 1;
        el.devices_full_width = true;
        document.body.appendChild(el);
        await el.updateComplete;
    }, nodes);
}

async function readRows(page: Page): Promise<RenderedRow[]> {
    return page.evaluate(async () => {
        const el = document.querySelector("power-devices-container") as any;
        await el.updateComplete;
        const out = [];
        for (const row of [...el.shadowRoot.querySelectorAll("power-device")] as any[]) {
            await row.updateComplete;
            const content = row.shadowRoot.querySelector(".deviceContent");
            const info = content.querySelector("power-device-info");
            if (info) await info.updateComplete;
            const badge = info?.shadowRoot?.querySelector("helman-schedule-badge");
            if (badge) await badge.updateComplete;
            const icon = badge?.shadowRoot?.querySelector("ha-icon") ?? null;
            out.push({
                label: (content.querySelector(".deviceName")?.textContent ?? "").trim(),
                tint: content.style.getPropertyValue("--device-tint").trim(),
                tag: (info?.shadowRoot?.querySelector(".custom-labels")?.textContent ?? "").trim(),
                badgeColor: icon ? icon.style.color : null,
            });
        }
        return out;
    });
}

test.describe("deferrable house consumers on the power card", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
        await installFakeBackend(page);
    });

    test("only the shiftable consumer is tinted, and only a controllable is badged", async ({ page }) => {
        const rows = await renderedRows(page, [
            {
                id: "sensor.dishwasher_energy",
                name: "Dishwasher",
                deferrable: true,
                controllableId: "dishwasher",
            },
            { id: "sensor.fridge_energy", name: "Fridge" },
            // Scheduled, but opted out of being shiftable: the forecast
            // breakdown still names its controllable, and it still belongs in
            // the base-load group unbadged — the way it reads on the power card,
            // whose tree hands it no controllable at all.
            { id: "sensor.pump_energy", name: "Pump", controllableId: "pump" },
        ]);

        expect(rows.map((r) => r.label)).toEqual(["Dishwasher", "Fridge", "Pump"]);
        // The ordinary consumer sets no tint of its own, so it keeps inheriting
        // the house section's colour exactly as it did before this existed.
        expect(rows.map((r) => r.tint)).toEqual([DEFERRABLE_TINT, "", ""]);
        expect(rows.map((r) => r.badgeColor)).toEqual([AUTOMATION_COLOR, null, null]);
    });

    test("the badge names the current slot's author, and nothing else", async ({ page }) => {
        const rows = await renderedRows(page, [
            { id: "s1", name: "Dishwasher", deferrable: true, controllableId: "dishwasher" },
            { id: "s2", name: "Boiler", deferrable: true, controllableId: "boiler" },
            { id: "s3", name: "Pump", deferrable: true, controllableId: "pump" },
            { id: "s4", name: "Fan", deferrable: true, controllableId: "fan" },
            { id: "s5", name: "Dryer", deferrable: true, controllableId: "dryer" },
        ]);

        expect(rows.map((r) => r.badgeColor)).toEqual([
            AUTOMATION_COLOR,
            USER_COLOR,
            // A candidate action will not run, so the slot has nothing planned.
            NONE_COLOR,
            // Nor does a scheduled "off" on an appliance already resting.
            NONE_COLOR,
            // A controllable the schedule says nothing at all about.
            NONE_COLOR,
        ]);
    });

    test("a device with a label badge keeps the label and loses the word", async ({ page }) => {
        const rows = await renderedRows(page, [
            {
                id: "sensor.boiler_energy",
                name: "Boiler",
                deferrable: true,
                controllableId: "boiler",
                customLabelTexts: ["heating"],
            },
        ]);

        expect(rows[0].tag).toBe("heating");
        expect(rows[0].badgeColor).toBe(USER_COLOR);
    });

    test("a deferrable group folds its children, orange when they disagree", async ({ page }) => {
        const rows = await renderedRows(page, [
            {
                id: "group:deferrable",
                name: "Deferrable consumption",
                deferrable: true,
                children: [
                    { id: "s1", name: "Dishwasher", deferrable: true, controllableId: "dishwasher" },
                    { id: "s2", name: "Boiler", deferrable: true, controllableId: "boiler" },
                ],
            },
        ]);

        expect(rows[0].badgeColor).toBe(MIXED_COLOR);
    });
});

declare global {
    interface Window {
        __fakeHass: Record<string, unknown>;
        /** Every websocket command the badges' shared source has asked for. */
        __wsSeen: string[];
    }
}
