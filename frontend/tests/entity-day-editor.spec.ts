import { test, expect, type Page } from "@playwright/test";
import { loadBundle } from "./support/card-page";

/**
 * The single-entity day editor, end to end through its own DOM.
 *
 * The contract worth pinning is the translation between the two vocabularies:
 * the user edits *blocks* ("run the boiler 17:00-21:00") while the schedule
 * stores *slots*. These tests drive the dialog the way a person does -- pick a
 * block, move its edge, save -- and assert on the slot patches that come out,
 * which is the only place a mistranslation would be visible.
 */

const DAY_ONE = "2026-07-24";
const DAY_TWO = "2026-07-25";
/** Mid-morning on day one: 05:00-07:00 is behind it, 17:00-19:00 ahead. */
const NOW_MS = Date.parse(`${DAY_ONE}T10:30:00Z`);

async function loadCardBundle(page: Page): Promise<void> {
    // Save reads the wall clock, not the injected `nowMs`, because that is the
    // clock the backend validates the patch against. Pin it to the same
    // fictional morning the fixture is built around, or every drafted slot is
    // long elapsed by the time the press lands.
    await page.clock.setFixedTime(NOW_MS);
    await loadBundle(page, "scheduling-entity-day-editor");
}

/**
 * Two days of hourly slots with the boiler already scheduled twice: a past run
 * the automation owns and an evening run the user owns.
 */
async function mountEditor(
    page: Page,
    options: {
        neighbour?: boolean;
        /** A run at 20:00-22:00 as well, leaving a single free slot at 19:00. */
        oneSlotGap?: boolean;
        /** A manual "off" at 21:00-22:00: a neighbour with a different action. */
        offNeighbour?: boolean;
        /** Half-hour slots and a single 16:00-17:00 run, so a default-length
         *  block spans a slot boundary rather than sitting on one. */
        halfHourSlots?: boolean;
        /** A run on day one's last hour, so day two opens against a neighbour
         *  that ends exactly at its midnight. */
        acrossMidnight?: boolean;
        straddling?: boolean;
        futureAutomation?: boolean;
        multiLane?: boolean;
        /** Hand the editor a backend that answers the explanation query. */
        explainable?: boolean;
        /** Today as the backend serves it: elapsed slots pruned, then padded
         *  back to midnight by the card, with forecast for those hours. */
        pruned?: boolean;
        /** The forecast horizon stops at 13:00 on day two. */
        shortHorizon?: boolean;
    } = {},
): Promise<void> {
    await page.evaluate(({ dayOne, dayTwo, nowMs, neighbour, offNeighbour, oneSlotGap, halfHourSlots, acrossMidnight, straddling, futureAutomation, multiLane, pruned, explainable, shortHorizon }) => {
        const stepMs = halfHourSlots ? 1_800_000 : 3_600_000;
        const buildSlot = (dayKey: string, index: number) => {
            const startMs = Date.parse(`${dayKey}T00:00:00Z`) + index * stepMs;
            const endMs = startMs + stepMs;
            const label = (ms: number) => new Date(ms).toISOString().slice(11, 16);
            return {
                id: new Date(startMs).toISOString(),
                index,
                startMs,
                endMs,
                dayKey,
                timeLabel: label(startMs),
                endLabel: label(endMs),
                rangeLabel: `${label(startMs)}–${label(endMs)}`,
                assignments: {} as Record<string, unknown>,
                runtime: null,
                isCurrent: startMs <= nowMs && endMs > nowMs,
            };
        };

        const perDay = halfHourSlots ? 48 : 24;
        const slots = [
            ...Array.from({ length: perDay }, (_unused, index) => buildSlot(dayOne, index)),
            ...Array.from({ length: shortHorizon ? 13 : perDay }, (_unused, index) => buildSlot(dayTwo, index)),
        ];
        for (const slot of slots) {
            if (slot.dayKey !== dayOne) {
                continue;
            }

            // Half-hour days carry one run and nothing else: they are there for
            // the block that spans a boundary, not for the fixture's cast.
            if (halfHourSlots) {
                if (slot.startMs >= Date.parse(`${dayOne}T16:00:00Z`)
                    && slot.startMs < Date.parse(`${dayOne}T17:00:00Z`)) {
                    slot.assignments.boiler = { action: { on: true }, setBy: "user" };
                }

                continue;
            }

            const hour = slot.index;
            if (hour === 5 || hour === 6) {
                slot.assignments.boiler = { action: { on: true }, setBy: "automation" };
            }
            if (hour === 17 || hour === 18) {
                slot.assignments.boiler = { action: { on: true }, setBy: "user" };
            }
            if (futureAutomation && hour === 13) {
                slot.assignments.boiler = { action: { on: true }, setBy: "automation" };
            }
            if (straddling && hour >= 8 && hour <= 11) {
                slot.assignments.boiler = { action: { on: true }, setBy: "user" };
            }
            if (multiLane && hour === 20) {
                slot.assignments.inverter = { action: { kind: "stop_charging" }, setBy: "automation" };
            }
            if (multiLane && hour === 21) {
                // Same tone as the run before it, different action: only the
                // icon says they are not one run.
                slot.assignments.inverter = { action: { kind: "stop_export" }, setBy: "automation" };
            }
            if (neighbour && hour === 21) {
                slot.assignments.boiler = { action: { on: true }, setBy: "user" };
            }
            if (offNeighbour && hour === 21) {
                slot.assignments.boiler = { action: { on: false }, setBy: "user" };
            }
            if (oneSlotGap && (hour === 20 || hour === 21)) {
                slot.assignments.boiler = { action: { on: true }, setBy: "user" };
            }
            if (acrossMidnight && hour === 23) {
                slot.assignments.boiler = { action: { on: true }, setBy: "user" };
            }
        }

        const saved: unknown[] = [];
        (window as unknown as { savedPatches: unknown[] }).savedPatches = saved;
        document.addEventListener("entity-schedule-save", (event) => {
            saved.push((event as CustomEvent).detail.patches);
        });

        const boiler = {
            id: "boiler",
            name: "Boiler",
            kind: "generic",
            primaryEntityId: "switch.boiler",
            supportsAuthoring: true,
            normalState: "off",
            metadata: { icon: "mdi:water-boiler", scheduleCapabilities: { onOffToggle: true } },
            controls: { switch: { entityId: "switch.boiler" } },
        };
        const pump = {
            ...boiler,
            id: "pump",
            name: "Pump",
            primaryEntityId: "switch.pump",
            metadata: { ...boiler.metadata, icon: "mdi:pump" },
            controls: { switch: { entityId: "switch.pump" } },
        };

        const el = document.createElement("scheduling-entity-day-editor") as any;
        el.localize = (key: string) => key;
        el.target = "boiler";
        el.appliance = boiler;
        el.lanes = [{
            key: "boiler", target: "boiler", name: "Boiler", icon: "mdi:water-boiler",
            appliance: boiler, isAvailable: true, actualSlots: [],
        }];
        if (multiLane) {
            el.lanes = [
                {
                    key: "inverter",
                    target: "inverter",
                    name: "Inverter",
                    icon: "mdi:solar-power",
                    appliance: null,
                    isAvailable: true,
                    actualSlots: [],
                },
                {
                    key: "boiler",
                    target: "boiler",
                    name: "Boiler",
                    icon: "mdi:water-boiler",
                    appliance: boiler,
                    isAvailable: true,
                    actualSlots: [],
                },
                {
                    key: "pump",
                    target: "pump",
                    name: "Pump",
                    icon: "mdi:pump",
                    appliance: pump,
                    isAvailable: false,
                    actualSlots: [],
                },
            ];
            // The boiler really ran 07:00-09:00, and the inverter charged for
            // half of 09:00 before stopping.
            el.lanes[1].actualSlots = [7, 8].map((hour) => ({
                startMs: Date.parse(`${dayOne}T0${hour}:00:00Z`),
                endMs: Date.parse(`${dayOne}T0${hour + 1}:00:00Z`),
                action: { on: true },
                ratio: 1,
            }));
            el.lanes[0].actualSlots = [{
                startMs: Date.parse(`${dayOne}T09:00:00Z`),
                endMs: Date.parse(`${dayOne}T10:00:00Z`),
                action: { kind: "charge_to_target_soc" },
                ratio: 0.5,
            }];
        }
        if (pruned) {
            const elapsed = slots.filter((slot) => slot.dayKey === dayOne && slot.endMs <= nowMs);
            for (const slot of elapsed) {
                slot.id = `elapsed:${new Date(slot.startMs).toISOString()}`;
                slot.assignments = {};
            }
            el.forecastPoints = new Map(slots.map((slot) => [
                slot.id,
                { socPct: 40 + (slot.index % 12) * 4, solarWh: slot.index * 90, price: 2.45 },
            ]));
            el.priceUnit = "CZK/kWh";
        }

        if (explainable) {
            // One condition record per lane, over the day's own slot ids --
            // which is what the band presses hand back. The pump has none at
            // all, which is what drops it out of Explain mode.
            const slotIds = slots
                .filter((slot) => slot.dayKey === dayOne)
                .map((slot) => slot.id);
            const optimizer = (id: string, kind: string, verdict: string, state: string) => ({
                optimizerId: id,
                kind,
                phase: 2,
                status: "ok",
                conditions: [{ key: "max_run_price", operator: "<" }],
                slots: slotIds.map((slotId) => ({
                    slotId,
                    runAt: `${dayOne}T20:15:00Z`,
                    verdict,
                    ...(state === "true" ? { matchedGroupIndex: 0 } : {}),
                    groups: [{
                        index: 0,
                        label: "",
                        paramsSource: "slot_matched",
                        params: { max_price: 2 },
                        customResults: [],
                        conditions: [{
                            key: "max_run_price",
                            scope: "slot",
                            state,
                            value: 2,
                        }],
                    }],
                    gates: [],
                })),
            });
            const payloads: Record<string, unknown> = {
                "boiler": {
                    controllableId: "boiler",
                    date: dayOne,
                    slotIds,
                    optimizers: [
                        optimizer("appliance_runtime:boiler", "appliance_runtime", "execute", "true"),
                        optimizer("charge_hold", "charge_hold", "skip", "false"),
                    ],
                },
                inverter: {
                    controllableId: "inverter",
                    date: dayOne,
                    slotIds,
                    optimizers: [optimizer("export_price", "export_price", "execute", "true")],
                },
                // Nothing recorded: no automation ever touched this lane.
                "pump": null,
            };
            el.hass = {
                config: { time_zone: "UTC" },
                connection: {},
                states: {},
                callWS: window.__mockHass({
                    "helman/get_schedule_explanation": async ({ controllable_id }: {
                        controllable_id: string;
                    }) => {
                        return payloads[controllable_id] ?? null;
                    }
                }).callWS,
            };
        }

        el.slots = slots;
        el.slotMinutes = stepMs / 60_000;
        el.currentDayKey = dayOne;
        el.locale = "cs";
        el.timeZone = "UTC";
        el.nowMs = nowMs;
        el.open = true;
        document.body.appendChild(el);
    }, {
        dayOne: DAY_ONE,
        dayTwo: DAY_TWO,
        nowMs: NOW_MS,
        neighbour: options.neighbour ?? false,
        offNeighbour: options.offNeighbour ?? false,
        oneSlotGap: options.oneSlotGap ?? false,
        halfHourSlots: options.halfHourSlots ?? false,
        acrossMidnight: options.acrossMidnight ?? false,
        straddling: options.straddling ?? false,
        futureAutomation: options.futureAutomation ?? false,
        multiLane: options.multiLane ?? false,
        pruned: options.pruned ?? false,
        explainable: options.explainable ?? false,
        shortHorizon: options.shortHorizon ?? false,
    });

    await page.waitForFunction(() => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        return !!el?.shadowRoot?.querySelector(".edit-panel");
    });
}

/** A lane's runs on the band as `range | authorship | past | dirty`, in order. */
async function readBlocks(page: Page, laneKey = "boiler") {
    return page.evaluate((lane) => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
        return [...band.shadowRoot.querySelectorAll(`.lane[data-lane="${lane}"] .segment:not(.actual)`)]
            .map((segment: Element) => ({
                range: /\d\d:\d\d–\d\d:\d\d/.exec(segment.getAttribute("aria-label") ?? "")?.[0] ?? "",
                authorship: /authorship-(user|automation)\b/.exec(segment.className)?.[1] ?? null,
                past: segment.classList.contains("past"),
                dirty: segment.classList.contains("dirty"),
            }));
    }, laneKey);
}

/** The block ranges alone, which is what most edits are about. */
async function readRanges(page: Page, laneKey = "boiler"): Promise<string[]> {
    return (await readBlocks(page, laneKey)).map((block) => block.range);
}

/** The range the edit panel currently shows, as `from|to` ms. */
async function editingRange(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        const from = el.shadowRoot.querySelector(".edit-panel select[data-from]");
        const to = el.shadowRoot.querySelector(".edit-panel select[data-to]");
        return from && to ? `${from.value}|${to.value}` : null;
    });
}

/** Whether Save is offered; `ha-button` carries the attribute the binding sets. */
async function saveDisabled(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        return el.shadowRoot.querySelector("ha-button[slot=primaryAction]").hasAttribute("disabled");
    });
}

/** Page x for a moment on a lane's track, defaulting to the first lane. */
async function trackPoint(
    page: Page,
    atMs: number,
    laneKey?: string,
): Promise<{ x: number; y: number }> {
    return page.evaluate(({ ms, lane }) => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
        const selector = lane === undefined ? ".track" : `.lane[data-lane="${lane}"] .track`;
        const track = band.shadowRoot.querySelector(selector) as HTMLElement;
        const rect = track.getBoundingClientRect();
        const day = band.day;
        const ratio = (ms - day.startMs) / (day.endMs - day.startMs);
        return { x: rect.left + ratio * rect.width, y: rect.top + rect.height / 2 };
    }, { ms: atMs, lane: laneKey });
}

/** Press a lane at a moment without moving: a tap on a block or on free track. */
async function tapAt(page: Page, atMs: number, laneKey?: string): Promise<void> {
    const point = await trackPoint(page, atMs, laneKey);
    await page.mouse.click(point.x, point.y);
}

/** Click the band's free stretch at a moment, the way "add a block here" is done. */
async function clickGapAt(page: Page, atMs: number): Promise<void> {
    await tapAt(page, atMs);
}

/** Press a lane at one moment and let go at another. */
async function dragAcross(page: Page, fromMs: number, toMs: number, laneKey?: string, offsetX = 0): Promise<void> {
    const from = await trackPoint(page, fromMs, laneKey);
    const to = await trackPoint(page, toMs, laneKey);
    await page.mouse.move(from.x + offsetX, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
}

/** A moment on day one. */
function at(hhmm: string, day = DAY_ONE): number {
    return Date.parse(`${day}T${hhmm}:00Z`);
}

/** A slot id on day one, as a patch names it. */
function slotId(hhmm: string, day = DAY_ONE): string {
    return `${day}T${hhmm}:00.000Z`;
}

async function savedPatches(page: Page) {
    return page.evaluate(() => (window as unknown as { savedPatches: any[] }).savedPatches);
}

test.describe("entity day editor", () => {
    test("generic, climate and EV action choices keep their editor labels and icons", async ({ page }) => {
        await loadCardBundle(page);
        const options = await page.evaluate(async () => {
            const generic = {
                id: "boiler", name: "Boiler", kind: "generic", supportsAuthoring: true,
                metadata: { icon: "mdi:water-boiler", scheduleCapabilities: { onOffToggle: true } },
            };
            const climate = {
                id: "heater", name: "Heater", kind: "climate", supportsAuthoring: true,
                metadata: { icon: "mdi:radiator", scheduleCapabilities: { modes: ["heat", "cool"] } },
            };
            const ev = {
                id: "charger", name: "Charger", kind: "ev_charger", supportsAuthoring: true,
                metadata: { icon: "mdi:ev-station", scheduleCapabilities: {
                    requiresVehicleSelection: false, useModes: ["Fast", "ECO"], ecoGears: ["green"],
                } },
                vehicles: [],
            };
            const result = [];
            for (const appliance of [generic, climate, ev]) {
                const editor = document.createElement("scheduling-entity-action-editor") as any;
                editor.localize = (key: string) => key;
                editor.target = appliance.id;
                editor.appliance = appliance;
                document.body.append(editor);
                await editor.updateComplete;
                const child = editor.shadowRoot.querySelector("scheduling-generic-appliance-editor, scheduling-climate-appliance-editor, scheduling-ev-charger-editor, scheduling-appliance-action-editor") as any;
                await child.updateComplete;
                result.push({
                    kind: appliance.kind,
                    options: [...child.shadowRoot.querySelectorAll(".compact-action-option")].map((option: Element) => ({
                        value: option.querySelector("input")?.getAttribute("value"),
                        label: option.querySelector("input")?.getAttribute("aria-label"),
                        icon: (option.querySelector("ha-icon") as any)?.icon,
                    })),
                });
                editor.remove();
            }
            return result;
        });
        expect(options).toEqual([
            { kind: "generic", options: [
                { value: "none", label: "scheduling.dialog.appliance.no_action", icon: "mdi:circle-outline" },
                { value: "off", label: "scheduling.dialog.appliance.turn_off", icon: "mdi:power-plug-off" },
                { value: "on", label: "scheduling.dialog.appliance.turn_on", icon: "mdi:power-plug" },
            ] },
            { kind: "climate", options: [
                { value: "none", label: "scheduling.dialog.appliance.no_action", icon: "mdi:radiator" },
                { value: "__off__", label: "scheduling.appliance.climate.mode.off", icon: "mdi:radiator" },
                { value: "heat", label: "scheduling.appliance.climate.mode.heat", icon: "mdi:radiator" },
                { value: "cool", label: "scheduling.appliance.climate.mode.cool", icon: "mdi:radiator" },
            ] },
            { kind: "ev_charger", options: [
                { value: "none", label: "scheduling.dialog.appliance.no_action", icon: "mdi:circle-outline" },
                { value: "off", label: "scheduling.dialog.appliance.no_charge", icon: "mdi:car-electric" },
                { value: "charge", label: "scheduling.dialog.appliance.charge", icon: "mdi:car-electric" },
            ] },
        ]);
    });

    test("generic, climate and EV choices emit their scheduled actions and can clear them", async ({ page }) => {
        await loadCardBundle(page);
        const actions = await page.evaluate(async () => {
            const appliances = [
                { id: "boiler", name: "Boiler", kind: "generic", supportsAuthoring: true,
                    metadata: { icon: "mdi:water-boiler", scheduleCapabilities: { onOffToggle: true } } },
                { id: "heater", name: "Heater", kind: "climate", supportsAuthoring: true,
                    metadata: { icon: "mdi:radiator", scheduleCapabilities: { modes: ["heat"] } } },
                { id: "charger", name: "Charger", kind: "ev_charger", supportsAuthoring: true,
                    metadata: { icon: "mdi:ev-station", scheduleCapabilities: {
                        requiresVehicleSelection: true, useModes: ["Fast", "ECO"], ecoGears: ["green"],
                    } }, vehicles: [{ id: "car", name: "Car" }] },
            ];
            const values = [];
            for (const appliance of appliances) {
                const editor = document.createElement("scheduling-entity-action-editor") as any;
                editor.localize = (key: string) => key;
                editor.target = appliance.id;
                editor.appliance = appliance;
                const emitted: unknown[] = [];
                editor.addEventListener("entity-action-change", (event: Event) => emitted.push((event as CustomEvent).detail));
                document.body.append(editor);
                await editor.updateComplete;
                const child = editor.shadowRoot.querySelector("scheduling-appliance-action-editor") as any;
                await child.updateComplete;
                const mode = appliance.kind === "generic" ? "on" : appliance.kind === "climate" ? "heat" : "charge";
                for (const value of [mode, "none"]) {
                    const input = child.shadowRoot.querySelector(`input[value="${value}"]`) as HTMLInputElement;
                    input.checked = true;
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                    await child.updateComplete;
                }
                values.push({ kind: appliance.kind, emitted });
                editor.remove();
            }
            return values;
        });
        expect(actions).toEqual([
            { kind: "generic", emitted: [{ action: { on: true }, valid: true }, { action: null, valid: true }] },
            { kind: "climate", emitted: [{ action: { mode: "heat" }, valid: true }, { action: null, valid: true }] },
            { kind: "ev_charger", emitted: [{ action: {
                charge: true, vehicleId: "car", useMode: "Fast", ecoGear: undefined,
            }, valid: true }, { action: null, valid: true }] },
        ]);
    });

    test("EV charge details follow vehicle, mode and ECO gear selections", async ({ page }) => {
        await loadCardBundle(page);
        const actions = await page.evaluate(async () => {
            const editor = document.createElement("scheduling-entity-action-editor") as any;
            editor.localize = (key: string) => key;
            editor.target = "charger";
            editor.appliance = {
                id: "charger", name: "Charger", kind: "ev_charger", supportsAuthoring: true,
                metadata: { icon: "mdi:ev-station", scheduleCapabilities: {
                    requiresVehicleSelection: true, useModes: ["Fast", "ECO"], ecoGears: ["green", "solar"],
                } },
                vehicles: [{ id: "car-a", name: "Car A" }, { id: "car-b", name: "Car B" }],
            };
            const emitted: unknown[] = [];
            editor.addEventListener("entity-action-change", (event: Event) => emitted.push((event as CustomEvent).detail));
            document.body.append(editor);
            await editor.updateComplete;
            const child = editor.shadowRoot.querySelector("scheduling-appliance-action-editor") as any;
            await child.updateComplete;
            const charge = child.shadowRoot.querySelector('input[value="charge"]') as HTMLInputElement;
            charge.checked = true;
            charge.dispatchEvent(new Event("change", { bubbles: true }));
            await child.updateComplete;
            const selects = () => [...child.shadowRoot.querySelectorAll(".action-detail-fields select")] as HTMLSelectElement[];
            selects()[0].value = "ECO";
            selects()[0].dispatchEvent(new Event("change", { bubbles: true }));
            await child.updateComplete;
            selects()[1].value = "solar";
            selects()[1].dispatchEvent(new Event("change", { bubbles: true }));
            selects()[2].value = "car-b";
            selects()[2].dispatchEvent(new Event("change", { bubbles: true }));
            editor.remove();
            return emitted;
        });
        expect(actions).toEqual([
            { action: { charge: true, vehicleId: "car-a", useMode: "Fast", ecoGear: undefined }, valid: true },
            { action: { charge: true, vehicleId: "car-a", useMode: "ECO", ecoGear: "green" }, valid: true },
            { action: { charge: true, vehicleId: "car-a", useMode: "ECO", ecoGear: "solar" }, valid: true },
            { action: { charge: true, vehicleId: "car-b", useMode: "ECO", ecoGear: "solar" }, valid: true },
        ]);
    });
    test("takes the whole screen, and the content takes the whole dialog", async ({ page }) => {
        // A whole day on one time axis, with a decision diagram under it: both
        // are read across rather than down, and an hour has to be wide enough
        // to point at. Nothing here gains from a margin.
        await loadCardBundle(page);
        await mountEditor(page);

        const layout = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const dialog = el.shadowRoot.querySelector("ha-dialog") as HTMLElement;
            const content = el.shadowRoot.querySelector(".dialog-content") as HTMLElement;
            return {
                width: dialog.getAttribute("width"),
                contentWidth: getComputedStyle(content).width,
            };
        });
        expect(layout.width).toBe("full");
        // Not a width of its own: whatever the dialog hands it.
        expect(layout.contentWidth).not.toMatch(/^9\d\dpx$/);
    });

    test("merges adjacent slots into blocks and locks the past ones", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        expect(await readBlocks(page)).toEqual([
            { range: "05:00–07:00", authorship: "automation", past: true, dirty: false },
            { range: "17:00–19:00", authorship: "user", past: false, dirty: false },
        ]);
    });

    test("extending a block patches only the slots it gained", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // Select the evening block and move its end from 19:00 to 21:00.
        await tapAt(page, at("18:00"));
        await page.locator(".edit-panel select[data-to]").selectOption(String(at("21:00")));

        expect(await readBlocks(page)).toContainEqual(
            { range: "17:00–21:00", authorship: "user", past: false, dirty: true },
        );

        await page.locator("ha-button[slot=primaryAction]").click();

        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([slotId("19:00"), slotId("20:00")]);
        expect(patches[0].controllables.boiler).toEqual({ on: true });
    });

    /**
     * A saved manual block that is deleted is freed rather than handed to
     * anything: the slots are drafted empty, the band draws the stretch
     * dashed, and the automation re-plans it after Save.
     */
    test("deleting a saved manual block drafts its slots empty", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await tapAt(page, at("18:00"));
        await page.locator(".edit-panel [data-delete]").click();
        expect(await readRanges(page)).toEqual(["05:00–07:00"]);
        await expect(page.locator("scheduling-entity-day-band .freed")).toHaveCount(1);

        await page.locator("ha-button[slot=primaryAction]").click();

        const [patches] = await savedPatches(page);
        expect(patches).toEqual([
            { id: slotId("17:00"), controllables: {} },
            { id: slotId("18:00"), controllables: {} },
        ]);
    });

    /**
     * Manual always wins: a paint across the automation's run replaces it,
     * and the slot whose action the paint repeats is still claimed -- holding
     * "on" over the automation's "on" is the user saying "this is mine".
     */
    test("painting across an automation block makes it manual and claims its slots", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { futureAutomation: true });

        await dragAcross(page, at("12:30"), at("14:30"));

        expect(await readBlocks(page)).toContainEqual(
            { range: "12:00–15:00", authorship: "user", past: false, dirty: true },
        );
        expect(await editingRange(page)).toBe(`${at("12:00")}|${at("15:00")}`);

        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches).toEqual([
            { id: slotId("12:00"), controllables: { boiler: { on: true } } },
            { id: slotId("13:00"), controllables: { boiler: { on: true } } },
            { id: slotId("14:00"), controllables: { boiler: { on: true } } },
        ]);
    });

    test("deleting a block painted over the automation brings its run back", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { futureAutomation: true });

        await dragAcross(page, at("12:30"), at("14:30"));
        await page.locator(".edit-panel [data-delete]").click();

        expect(await readBlocks(page)).toContainEqual(
            { range: "13:00–14:00", authorship: "automation", past: false, dirty: false },
        );
        await expect(page.locator("scheduling-entity-day-band .freed")).toHaveCount(0);
        expect(await saveDisabled(page)).toBe(true);
    });

    /**
     * An automation run is read-only: all it offers is to be overridden, and
     * the override is a manual block over the run with the run's own action --
     * a change Save has to send even though no action changed.
     */
    test("overriding an automation run claims it even with its action unchanged", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { futureAutomation: true });

        await tapAt(page, at("13:30"));
        const panel = page.locator("scheduling-entity-day-editor .edit-panel");
        await expect(panel.locator(".authorship-badge.automation")).toHaveCount(1);
        await expect(panel.locator("scheduling-entity-action-editor")).toHaveCount(0);
        expect(await saveDisabled(page)).toBe(true);

        await panel.locator("[data-override]").click();
        await expect(panel.locator(".authorship-badge.user")).toHaveCount(1);
        expect(await editingRange(page)).toBe(`${at("13:00")}|${at("14:00")}`);
        expect(await saveDisabled(page)).toBe(false);

        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches).toEqual([{ id: slotId("13:00"), controllables: { boiler: { on: true } } }]);
    });

    test("automation blocks cannot be dragged, only painted over", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { futureAutomation: true });

        // From the middle of the 13:00 run three hours right: the run stays
        // where it is and a manual range is painted from it instead.
        await dragAcross(page, at("13:30"), at("16:30"));

        expect(await readBlocks(page)).toEqual([
            { range: "05:00–07:00", authorship: "automation", past: true, dirty: false },
            { range: "13:00–17:00", authorship: "user", past: false, dirty: true },
            { range: "17:00–19:00", authorship: "user", past: false, dirty: false },
        ]);
        await expect(page.locator("scheduling-entity-day-band .segment.authorship-automation .handle"))
            .toHaveCount(0);
    });

    test("tapping the selected block again deselects it", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await tapAt(page, at("18:00"));
        expect(await editingRange(page)).toBe(`${at("17:00")}|${at("19:00")}`);

        await tapAt(page, at("18:00"));
        expect(await editingRange(page)).toBeNull();
        await expect(page.locator("scheduling-entity-day-editor .edit-panel [data-start-pick]"))
            .not.toHaveCount(0);
    });

    test("moving a manual block onto another replaces what it lands on", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { offNeighbour: true });

        // 17:00-19:00 "on" three hours right, over the 21:00 "off".
        await dragAcross(page, at("18:00"), at("21:00"));
        expect(await readRanges(page)).toEqual(["05:00–07:00", "20:00–22:00"]);

        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches).toEqual([
            { id: slotId("17:00"), controllables: {} },
            { id: slotId("18:00"), controllables: {} },
            { id: slotId("20:00"), controllables: { boiler: { on: true } } },
            { id: slotId("21:00"), controllables: { boiler: { on: true } } },
        ]);
    });

    test("the From picker carries a block over its neighbour and replaces it", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { offNeighbour: true });

        await tapAt(page, at("18:00"));
        await page.locator(".edit-panel select[data-from]").selectOption(String(at("20:00")));

        // 20:00 + the block's two hours reaches 22:00, through the "off".
        expect(await editingRange(page)).toBe(`${at("20:00")}|${at("22:00")}`);
        expect(await readRanges(page)).toEqual(["05:00–07:00", "20:00–22:00"]);
    });

    test("an end pick sets where the block stops", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { offNeighbour: true });

        await tapAt(page, at("18:00"));
        const picks = page.locator(".edit-panel [data-pick]");
        await expect(picks).toHaveText([
            "scheduling.entity_editor.pick.plus_1h",
            "scheduling.entity_editor.pick.plus_3h",
            "scheduling.entity_editor.pick.end_of_day",
            "scheduling.entity_editor.pick.next_change",
        ]);

        // The saved plan is "on" from 17:00 and changes at 19:00.
        await page.locator('.edit-panel [data-pick="next_change"]').click();
        expect(await editingRange(page)).toBe(`${at("17:00")}|${at("19:00")}`);
        await page.locator('.edit-panel [data-pick="end_of_day"]').click();
        expect(await editingRange(page)).toBe(`${at("17:00")}|${at("00:00", DAY_TWO)}`);
        // What the block now replaces is listed under it.
        await expect(page.locator(".edit-panel .replaced-run")).toHaveCount(1);
    });

    test("Replaces lists only runs the draft changes inside the block", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // Shortening 17:00-19:00 to 17:00-18:00 frees 18:00, outside the
        // block: nothing the block now covers was changed.
        await tapAt(page, at("18:00"));
        await page.locator(".edit-panel select[data-to]").selectOption(String(at("18:00")));
        expect(await editingRange(page)).toBe(`${at("17:00")}|${at("18:00")}`);
        await expect(page.locator(".edit-panel .replaced-run")).toHaveCount(0);
    });

    test("End of day is the last writable boundary, selected or not", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { shortHorizon: true });

        await page.locator(".day-chip").nth(1).click();
        await page.locator('.edit-panel [data-start-pick="end_of_day"]').click();
        expect(await editingRange(page)).toBe(`${at("00:00", DAY_TWO)}|${at("13:00", DAY_TWO)}`);

        await page.locator('.edit-panel [data-pick="plus_1h"]').click();
        await page.locator('.edit-panel [data-pick="end_of_day"]').click();
        expect(await editingRange(page)).toBe(`${at("00:00", DAY_TWO)}|${at("13:00", DAY_TWO)}`);
    });

    test("selecting a block does not change what the next paint starts with", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { offNeighbour: true });

        // Select the saved "off" run, let go, then paint a new block.
        await tapAt(page, at("21:30"));
        await tapAt(page, at("21:30"));
        await dragAcross(page, at("13:30"), at("14:30"));

        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches).toEqual([
            { id: slotId("13:00"), controllables: { boiler: { on: true } } },
            { id: slotId("14:00"), controllables: { boiler: { on: true } } },
        ]);
    });

    /**
     * A new block whose action is not one yet places nothing, so the saved
     * block still drawn under it is its own block: a tap selects it.
     */
    test("a block under a session that places nothing can be selected", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { offNeighbour: true });

        await dragAcross(page, at("20:30"), at("21:30"));
        expect(await editingRange(page)).toBe(`${at("20:00")}|${at("22:00")}`);
        await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            el.shadowRoot.querySelector("scheduling-entity-action-editor").dispatchEvent(new CustomEvent(
                "entity-action-change",
                { bubbles: true, composed: true, detail: { action: { on: true }, valid: false } },
            ));
        });
        expect(await readRanges(page)).toContain("21:00–22:00");

        await tapAt(page, at("21:30"));
        expect(await editingRange(page)).toBe(`${at("21:00")}|${at("22:00")}`);
    });

    test("adding a block on the next day writes that day's slots", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await page.locator(".day-chip").nth(1).click();
        expect(await readRanges(page)).toEqual([]);

        await page.locator('.edit-panel [data-start-pick="plus_1h"]').click();
        await page.locator(".edit-panel select[data-from]").selectOption(String(at("09:00", DAY_TWO)));
        await page.locator(".edit-panel select[data-to]").selectOption(String(at("11:00", DAY_TWO)));

        expect(await readRanges(page)).toEqual(["09:00–11:00"]);

        await page.locator("ha-button[slot=primaryAction]").click();

        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([
            slotId("09:00", DAY_TWO),
            slotId("10:00", DAY_TWO),
        ]);
        expect(patches[0].controllables.boiler).toEqual({ on: true });
    });

    test("clicking another block switches the edit session straight over", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { neighbour: true });

        await tapAt(page, at("18:00"));
        expect(await editingRange(page)).toBe(`${at("17:00")}|${at("19:00")}`);

        // No "done" step: picking the next block is the whole gesture.
        await tapAt(page, at("21:30"));
        expect(await editingRange(page)).toBe(`${at("21:00")}|${at("22:00")}`);
    });

    /**
     * A block is derived from the slots, so one authored right against a run
     * carrying the same action used to fold into it. The edges the user
     * authors here hold the two apart for as long as the dialog is open, which
     * is long enough to give the new block its own parameters.
     */
    test("a block authored right after a run stays its own block", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await clickGapAt(page, at("19:00"));
        expect(await editingRange(page)).toBe(`${at("19:00")}|${at("20:00")}`);
        expect(await readRanges(page)).toEqual(["05:00–07:00", "17:00–19:00", "19:00–20:00"]);

        // Changing the new block reaches the new block alone: the run it was
        // born against keeps its range and stays clean.
        await page.locator(".edit-panel select[data-to]").selectOption(String(at("21:00")));
        const changed = await readBlocks(page);
        expect(changed.map((block) => block.range)).toEqual(["05:00–07:00", "17:00–19:00", "19:00–21:00"]);
        expect(changed[1].dirty).toBe(false);
        expect(changed[2].dirty).toBe(true);
    });

    test("a block authored right before a run stays its own block", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // 16:00-17:00 ends exactly where the evening run begins.
        await clickGapAt(page, at("16:00"));

        expect(await readRanges(page)).toEqual(["05:00–07:00", "16:00–17:00", "17:00–19:00"]);
    });

    /**
     * The one-slot gap is the same defect reached from both sides at once: the
     * gap click clamps the new block to the gap's end, so it touches a run at
     * each edge and used to swallow both.
     */
    test("a one-slot gap between two runs becomes a third block", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { oneSlotGap: true });

        await clickGapAt(page, at("19:00"));

        expect(await readRanges(page)).toEqual(["05:00–07:00", "17:00–19:00", "19:00–20:00", "20:00–22:00"]);
    });

    /**
     * Edges outlive their session, but they must not outlive their block: the
     * two left behind by a deleted block used to cut the next block authored
     * across that stretch in two.
     */
    test("deleting a block takes its edges with it", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { halfHourSlots: true });

        await clickGapAt(page, at("17:30"));
        expect(await readRanges(page)).toHaveLength(2);
        await page.locator(".edit-panel [data-delete]").click();
        expect(await readRanges(page)).toHaveLength(1);

        // Straight after the run, across where the deleted block was: one
        // block, not one per ghost. Pressed just inside the free track, since
        // the run's own edge sits on 17:00 and a tap there selects the run.
        await clickGapAt(page, at("17:10"));

        expect(await readRanges(page)).toEqual(["16:00–17:00", "17:00–18:00"]);
    });

    /**
     * The day's first slot is only "the now-line" on today. On any later day
     * the editable boundary is simply that day's midnight, so a start there is
     * as much a decision as any other.
     */
    test("a block authored at a later day's midnight stays off its neighbour", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { acrossMidnight: true });

        await page.locator(".day-chip").nth(1).click();
        await clickGapAt(page, at("00:00", DAY_TWO));

        expect(await readRanges(page)).toEqual(["00:00–01:00"]);
    });

    test("saving a block authored against a run writes only that block's slots", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await clickGapAt(page, at("19:00"));
        await page.locator("ha-button[slot=primaryAction]").click();

        // The neighbour's 17:00 and 18:00 slots already say what they should
        // say, and the new block never claimed them.
        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([slotId("19:00")]);
        expect(patches[0].controllables.boiler).toEqual({ on: true });
    });

    /**
     * The edge outlives the session that authored it: the split has to survive
     * the user moving on to something else, or the block they just placed would
     * rejoin its neighbour the moment they clicked away.
     */
    test("an authored edge outlives the edit session that made it", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { neighbour: true });

        // The 17:00-19:00 block's end, pulled up to the 21:00 neighbour.
        await dragAcross(page, at("19:00"), at("21:00"), undefined, -2);

        // Close the session by pressing outside it, then reopen the earlier
        // block: both are still there, and editing one is still about one.
        await page.locator(".day-switcher").click();
        expect(await editingRange(page)).toBeNull();
        expect(await readRanges(page)).toEqual(["05:00–07:00", "17:00–21:00", "21:00–22:00"]);

        await tapAt(page, at("18:00"));
        expect(await editingRange(page)).toBe(`${at("17:00")}|${at("21:00")}`);
    });

    /**
     * A block passing over an authored edge must not wear it away: every move
     * replays from the state before the session, edges included, so the two
     * blocks it held apart are still two once the block has moved on.
     */
    test("a block passing over an authored edge leaves it in place", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { offNeighbour: true });

        await clickGapAt(page, at("19:00"));
        await page.locator(".day-switcher").click();
        expect(await readRanges(page)).toEqual(["05:00–07:00", "17:00–19:00", "19:00–20:00", "21:00–22:00"]);

        // The "off" pulled back over the new block, then let go of it again.
        await tapAt(page, at("21:30"));
        const from = page.locator(".edit-panel select[data-from]");
        await from.selectOption(String(at("19:00")));
        expect(await readRanges(page)).toEqual(["05:00–07:00", "17:00–19:00", "19:00–22:00"]);
        await from.selectOption(String(at("21:00")));

        expect(await readRanges(page)).toEqual(["05:00–07:00", "17:00–19:00", "19:00–20:00", "21:00–22:00"]);
    });

    /**
     * A block placed across an authored edge replaces it along with the
     * blocks it held apart: the paint is one block, and Delete takes all of it.
     */
    test("painting across an authored edge makes one block", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await clickGapAt(page, at("19:00"));
        await page.locator(".day-switcher").click();
        expect(await readRanges(page)).toEqual(["05:00–07:00", "17:00–19:00", "19:00–20:00"]);

        await dragAcross(page, at("16:00"), at("20:30"));
        await page.locator(".day-switcher").click();
        expect(await readRanges(page)).toEqual(["05:00–07:00", "16:00–21:00"]);

        await tapAt(page, at("18:30"));
        await page.locator(".edit-panel [data-delete]").click();
        expect(await readRanges(page)).toEqual(["05:00–07:00"]);
    });

    /**
     * A paint whose action is not one yet places nothing, so it authors no
     * edges either: the saved block it lay across is still one block once the
     * session ends, and Delete takes all of it.
     */
    test("a session that places nothing leaves no edges behind", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await dragAcross(page, at("20:30"), at("18:30"));
        expect(await editingRange(page)).toBe(`${at("18:00")}|${at("21:00")}`);
        await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            el.shadowRoot.querySelector("scheduling-entity-action-editor").dispatchEvent(new CustomEvent(
                "entity-action-change",
                { bubbles: true, composed: true, detail: { action: { on: true }, valid: false } },
            ));
        });
        expect(await readRanges(page)).toEqual(["05:00–07:00", "17:00–19:00"]);

        await page.locator(".day-switcher").click();
        expect(await readRanges(page)).toEqual(["05:00–07:00", "17:00–19:00"]);

        await tapAt(page, at("17:30"));
        expect(await editingRange(page)).toBe(`${at("17:00")}|${at("19:00")}`);
        await page.locator(".edit-panel [data-delete]").click();
        expect(await readRanges(page)).toEqual(["05:00–07:00"]);
    });

    test("clicking outside closes the panel and keeps the edit in the draft", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await tapAt(page, at("18:00"));
        await page.locator(".edit-panel select[data-to]").selectOption(String(at("21:00")));

        await page.locator(".day-switcher").click();
        expect(await editingRange(page)).toBeNull();

        // The block keeps its new end, and Save still has something to write.
        expect(await readRanges(page)).toContain("17:00–21:00");
        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([slotId("19:00"), slotId("20:00")]);
    });

    test("editing a block that is already running keeps its running part", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { straddling: true });

        // 08:00-12:00 spans "now" (10:30), so 08:00-10:00 has already elapsed.
        expect(await readRanges(page)).toEqual(["05:00–07:00", "08:00–12:00", "17:00–19:00"]);

        await tapAt(page, at("11:00"));

        // The session starts at the running slot, and the block stays whole on
        // the band rather than losing the hours it has already run.
        expect(await editingRange(page)).toBe(`${at("10:00")}|${at("12:00")}`);
        expect(await readRanges(page)).toEqual(["05:00–07:00", "08:00–12:00", "17:00–19:00"]);
    });

    test("a new block can start in the slot that is running now", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await page.locator('.edit-panel [data-start-pick="plus_1h"]').click();

        // 10:30 sits inside the 10:00 slot, and "start it now" means 10:00 --
        // the backend's write horizon begins at the same floored boundary.
        expect(await editingRange(page)).toBe(`${at("10:00")}|${at("11:00")}`);

        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([slotId("10:00")]);
    });

    /**
     * The render clock lags the wall clock by up to 30s, and the backend
     * agrees with neither: it floors its *own* clock to the slot and refuses
     * anything starting before that. A press just after a boundary therefore
     * used to carry the slot that had just elapsed, and because the request is
     * validated as a whole, the day's entire edit was refused over one slot
     * that was never savable -- silently, with the dialog left open.
     */
    test("a slot that elapsed since the last clock tick is dropped, not sent", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // A block from the slot running now (10:00) through 13:00.
        await page.locator('.edit-panel [data-start-pick="plus_3h"]').click();

        // The wall clock crosses into the next slot. `nowMs` is untouched --
        // that is exactly the window this guards: the card has not ticked yet.
        await page.clock.setFixedTime(at("11:30"));

        await page.locator("ha-button[slot=primaryAction]").click();

        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([slotId("11:00"), slotId("12:00")]);
    });

    /** Nothing writable left is still an answer, not a dead button. */
    test("a draft that elapsed entirely says so rather than doing nothing", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await page.locator('.edit-panel [data-start-pick="plus_1h"]').click();
        await page.clock.setFixedTime(at("11:30"));

        await page.locator("ha-button[slot=primaryAction]").click();

        expect(await savedPatches(page)).toEqual([]);
        await expect(page.locator(".save-error")).toContainText("scheduling.entity_editor.save_elapsed");
    });

    test("clicking a block on the band opens the panel and keeps it open", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // The press re-renders the segment, so the release retargets its click
        // to the dialog body. That click must not read as "clicked outside".
        await page.locator("scheduling-entity-day-band .segment").nth(1).click();

        expect(await editingRange(page)).toBe(`${at("17:00")}|${at("19:00")}`);
    });

    test("dragging the middle of a block moves it whole", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await dragAcross(page, at("18:00"), at("21:00"));

        expect(await readRanges(page)).toEqual(["05:00–07:00", "20:00–22:00"]);

        // The click that ends a drag retargets to the dialog body once the
        // segment has re-rendered; it must not read as "clicked outside" and
        // close the editor the drag just opened.
        expect(await editingRange(page)).toBe(`${at("20:00")}|${at("22:00")}`);
    });

    /**
     * A drag is the one edit made with the pointer instead of with the fields,
     * and a bar sliding along a track cannot say more than "about eight" -- so
     * it says both ends of what it is setting, from the moment it is grabbed.
     */
    test("a drag says which hours it is setting, at both ends", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        const readout = page.locator("scheduling-entity-day-band .drag-readout");
        await expect(readout).toHaveCount(0);

        const from = await trackPoint(page, Date.parse(`${DAY_ONE}T18:00:00Z`));
        const to = await trackPoint(page, Date.parse(`${DAY_ONE}T21:00:00Z`));
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        // Grabbed and not yet moved: it already says where the run stands, so
        // the drag has something to be read against.
        await expect(readout.locator(".drag-readout-range")).toHaveText("17:00–19:00");

        await page.mouse.move(to.x, to.y, { steps: 8 });
        await expect(readout.locator(".drag-readout-range")).toHaveText("20:00–22:00");
        await expect(readout.locator(".drag-readout-duration")).toHaveText(/2/);

        // It belongs to the drag, and goes with it.
        await page.mouse.up();
        await expect(readout).toHaveCount(0);
    });

    /**
     * A running block starts in the past but the session only owns the part
     * still ahead, so a drag has to move that part -- carrying the elapsed hours
     * along would stretch the block by however much of it had already happened.
     */
    test("dragging a running block moves only the part still ahead", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { straddling: true });

        // The block runs 08:00-12:00 and it is 10:30, so the session is
        // 10:00-12:00. One hour to the right must land on 11:00-13:00.
        const from = await trackPoint(page, Date.parse(`${DAY_ONE}T11:00:00Z`));
        const to = await trackPoint(page, Date.parse(`${DAY_ONE}T12:00:00Z`));
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await page.mouse.up();

        expect(await editingRange(page)).toBe(
            `${Date.parse(`${DAY_ONE}T11:00:00Z`)}|${Date.parse(`${DAY_ONE}T13:00:00Z`)}`,
        );
    });

    /**
     * Save must not offer to write a draft that has since elapsed: the patch
     * builder would drop every slot, and the dialog would close over an empty
     * batch as if the day had been saved.
     */
    test("a draft whose slots elapse stops being savable", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        const point = await trackPoint(page, Date.parse(`${DAY_ONE}T11:00:00Z`));
        await page.mouse.click(point.x, point.y);
        // `ha-button` is not a native control here, so ask for the attribute
        // the disabled binding actually sets.
        const saveDisabled = () => page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            return el.shadowRoot.querySelector("ha-button[slot=primaryAction]").hasAttribute("disabled");
        });
        expect(await saveDisabled()).toBe(false);

        // Time moves past the drafted block, as the card's clock tick would.
        await page.evaluate((nowMs) => {
            (document.querySelector("scheduling-entity-day-editor") as any).nowMs = nowMs;
        }, Date.parse(`${DAY_ONE}T12:30:00Z`));

        expect(await saveDisabled()).toBe(true);
    });

    test("each run on the strip carries who put it there", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // 05:00-07:00 is the optimizer's, 17:00-19:00 the user's.
        expect((await readBlocks(page)).map((block) => block.authorship)).toEqual(["automation", "user"]);
    });

    /**
     * The card pads today back to midnight so the forecast rows can show the
     * hours that have gone. Those slots hold no schedule and must stay inert:
     * the day is only wider to look at, not wider to write.
     */
    test("padded elapsed hours are drawn but stay unwritable", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { pruned: true });

        const band = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const bandEl = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            const track = bandEl.shadowRoot.querySelector(".track") as HTMLElement;
            const overlay = bandEl.shadowRoot.querySelector(".track .past-overlay") as HTMLElement;
            return {
                contextRows: bandEl.shadowRoot.querySelectorAll(".context-row").length,
                laneCount: bandEl.shadowRoot.querySelectorAll(".lane").length,
                chartOverlays: bandEl.shadowRoot.querySelectorAll(".context-row .past-overlay").length,
                nowMarkers: bandEl.shadowRoot.querySelectorAll(".now-marker").length,
                // The elapsed hours carry forecast bars of their own.
                barsBeforeNow: [...bandEl.shadowRoot.querySelectorAll(".context-bar")]
                    .filter((bar: Element) => parseFloat((bar as HTMLElement).style.left) < 40).length,
                pastWidthPct: (overlay.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100,
            };
        });

        expect(band.contextRows).toBe(3);
        // The charts say "this is behind us" the same way the tracks do, and
        // carry the same now-line, so the band reads as one day.
        expect(band.chartOverlays).toBe(3);
        expect(band.nowMarkers).toBe(band.contextRows + band.laneCount);
        expect(band.barsBeforeNow).toBeGreaterThan(0);
        // Ten of twenty-four hours have gone.
        expect(band.pastWidthPct).toBeGreaterThan(40);
        expect(band.pastWidthPct).toBeLessThan(43);

        // The morning run went with the pruning, so the evening one is the only
        // block left -- and nothing behind the boundary is on offer for it.
        expect(await readRanges(page)).toEqual(["17:00–19:00"]);
        await tapAt(page, at("18:00"));
        const options = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const select = el.shadowRoot.querySelector(".edit-panel select[data-from]") as HTMLSelectElement;
            return [...select.options].map((option) => Number(option.value));
        });
        expect(Math.min(...options)).toBe(at("10:00"));
    });

    /**
     * The charts are the reason the day is drawn at all, so every hour of them
     * has to be able to say what it is showing -- including the hours with no
     * bar to hang a tooltip on.
     */
    test("every hour of every chart names itself", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { pruned: true });

        const titles = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            const rowTitle = (selector: string, index: number) =>
                band.shadowRoot.querySelectorAll(`${selector} .slot-hit`)[index]?.getAttribute("title");
            // The charts stack solar, battery, price.
            const chartRows = band.shadowRoot.querySelectorAll(".context-row:not(.price)");
            return {
                // 09:00, an hour that has gone: it still answers.
                battery: chartRows[1]?.querySelectorAll(".slot-hit")[9]?.getAttribute("title"),
                price: rowTitle(".context-row.price", 9),
                // 00:00 has no sun and so no bar, and still answers.
                solarAtMidnight: chartRows[0]
                    ?.querySelector(".slot-hit")?.getAttribute("title"),
                hitsPerRow: band.shadowRoot.querySelectorAll(".context-row.price .slot-hit").length,
            };
        });

        expect(titles.battery).toBe("scheduling.forecast.battery_label · 76 % · 09:00–10:00");
        expect(titles.price).toBe("scheduling.forecast.price_label · 2.5 CZK/kWh · 09:00–10:00");
        expect(titles.solarAtMidnight).toBe("scheduling.forecast.solar_label · 0.0 kWh/h · 00:00–01:00");
        expect(titles.hitsPerRow).toBe(24);
    });

    /**
     * A chart of bars answers "which hour is best" and nothing else; the number
     * over each slot is what makes it answer "and by how much", which is the
     * question that decides whether moving a run is worth doing.
     */
    test("every hour of every chart says what it is worth", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { pruned: true });

        // Keyed by the slot's own position rather than by index: an hour whose
        // reading repeats its neighbour's carries no number, so a row's cells
        // are not one-per-hour and counting along them would find the wrong one.
        const values = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            const read = (row: Element) => Object.fromEntries(
                [...row.querySelectorAll(".slot-value")].map((cell) => [
                    Math.round(Number.parseFloat((cell as HTMLElement).style.left) / 100 * 24),
                    cell.textContent?.trim(),
                ]),
            );
            const chartRows = band.shadowRoot.querySelectorAll(".context-row:not(.price)");
            return {
                solar: read(chartRows[0]),
                battery: read(chartRows[1]),
                price: read(band.shadowRoot.querySelector(".context-row.price")),
            };
        });

        // Solar is kWh, the battery is whole percent, the price is its own unit
        // to one decimal -- the units belong to the row, not to the cell.
        // 09:00 is the tenth hour: 0.81 kWh and 76 %.
        expect(values.solar[9]).toBe("0.8");
        expect(values.battery[9]).toBe("76");
        // This fixture prices the whole day at one rate, so the price row says
        // it once and then leaves the bars to say it stayed there.
        expect(values.price).toEqual({ 0: "2.5" });
    });

    /**
     * Hovering an hour is a question about the whole house at that hour, so the
     * mark lands in every lane and in every chart -- while the row the pointer
     * is actually in is marked harder, because that is the one being pointed at.
     */
    test("hovering an hour marks it down the whole stack, charts included", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true, pruned: true });

        const point = await trackPoint(page, Date.parse(`${DAY_ONE}T13:30:00Z`), "boiler");
        await page.mouse.move(point.x, point.y);

        const marked = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            const slots = (selector: string) =>
                [...band.shadowRoot.querySelectorAll(selector)]
                    .map((cell: Element) => cell.getAttribute("data-slot"));
            return {
                pointed: slots(".slot-pick.hovered"),
                alongside: slots(".slot-pick.co-hovered").length,
                charts: band.shadowRoot.querySelectorAll(".context-row .slot-hit.co-hovered").length,
            };
        });

        expect(marked.pointed).toEqual([`${DAY_ONE}T13:00:00.000Z`]);
        expect(marked.alongside).toBeGreaterThan(0);
        // Solar, battery and price all light the same hour.
        expect(marked.charts).toBe(3);
    });

    /**
     * The grid is drawn while a day is being authored too -- a run's edge means
     * nothing until you can see which slot it landed on -- but it must not take
     * the presses and drags the blocks are drawn to invite.
     */
    test("the slot grid is drawn while editing, and does not take the presses", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { pruned: true });

        const band = () => page.locator("scheduling-entity-day-band");
        await expect(band().locator(".slot-pick")).not.toHaveCount(0);
        await expect(band().locator(".slot-pick.pickable")).toHaveCount(0);
        await expect(band().locator(".context-row .time-grid-line")).not.toHaveCount(0);

        // The block underneath still opens for editing, through the grid.
        await band().locator(".segment").first().click();
        expect(await editingRange(page)).not.toBeNull();
    });

    test("a past block cannot be edited from the band either", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // Pressing it is allowed -- that is how its lane gets selected -- but it
        // opens no session, because none of its slots can still be written.
        const pastSegment = page.locator("scheduling-entity-day-band .segment").first();
        await expect(pastSegment).toHaveClass(/\bpast\b/);
        await pastSegment.click();
        expect(await editingRange(page)).toBeNull();
    });

    /**
     * With every controllable entity stacked on one axis, the thing that can
     * quietly go wrong is ownership: which lane an edit lands in, and whether
     * two lanes that touched the same slot both survive the save.
     */
    test.describe("with every entity stacked", () => {
        const laneState = (page: Page) => page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            return {
                lanes: [...band.shadowRoot.querySelectorAll(".lane")].map((lane: Element) => ({
                    key: lane.getAttribute("data-lane"),
                    selected: lane.classList.contains("selected"),
                })),
                panelLane: el.shadowRoot.querySelector(".edit-panel .lane-name")
                    ?.textContent?.trim() ?? null,
            };
        });

        test("opens on the entity that was clicked, with the others as context", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const state = await laneState(page);
            expect(state.lanes).toEqual([
                { key: "inverter", selected: false },
                { key: "boiler", selected: true },
                { key: "pump", selected: false },
            ]);
            expect(state.panelLane).toBe("Boiler");
        });

        /** The selected lane is the control surface, the others shrink to context. */
        test("the selected lane is taller than the muted ones", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const heights = await page.evaluate(() => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
                const height = (lane: string) => band.shadowRoot
                    .querySelector(`.lane[data-lane="${lane}"] .track`).getBoundingClientRect().height;
                return { selected: height("boiler"), muted: height("inverter") };
            });
            expect(heights.selected).toBe(44);
            expect(heights.muted).toBe(26);
        });

        test("pressing a muted lane selects it and nothing else", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            // The inverter's afternoon is free, but on a muted lane a press only
            // says which lane: no block is added.
            await tapAt(page, at("13:00"), "inverter");

            const state = await laneState(page);
            expect(state.lanes.find((lane) => lane.selected)?.key).toBe("inverter");
            expect(state.panelLane).toBe("Inverter");
            expect(await editingRange(page)).toBeNull();
            expect(await readRanges(page, "inverter")).toEqual(["20:00–21:00", "21:00–22:00"]);
        });

        /**
         * Two lanes writing one slot must arrive as one patch. A patch carries
         * the slot's whole set of user domains, so sending one per lane would
         * make the last one win and drop the other entity's edit.
         */
        test("edits on two entities leave in a single patch per slot", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            // The first press selects the lane, the second adds the block.
            await tapAt(page, at("13:00"), "inverter");
            await tapAt(page, at("13:00"), "inverter");
            await tapAt(page, at("13:00"), "boiler");
            await tapAt(page, at("13:00"), "boiler");

            await page.locator("ha-button[slot=primaryAction]").click();
            const [patches] = await savedPatches(page);
            // Both blocks start where the pointer landed, so both land on the
            // 13:00 slot -- and it is patched once, carrying both lanes.
            expect(patches).toHaveLength(1);
            expect(patches[0].id).toBe(slotId("13:00"));
            expect(patches[0].controllables.inverter.kind).toBe("charge_to_target_soc");
            expect(patches[0].controllables.boiler).toEqual({ on: true });
        });

        test("a paint starts with the lane's last placed action", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            await tapAt(page, at("13:00"), "inverter");
            await tapAt(page, at("13:00"), "inverter");
            const pickStopExport = () => page.evaluate(async () => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const editor = el.shadowRoot.querySelector("scheduling-entity-action-editor") as any;
                const card = [...editor.shadowRoot.querySelectorAll("scheduling-action-option-card")]
                    .find((option: any) => option.action.kind === "stop_export") as any;
                card.dispatchEvent(new CustomEvent("schedule-action-option-select", {
                    detail: { actionKind: "stop_export" },
                    bubbles: true,
                    composed: true,
                }));
                await el.updateComplete;
            });
            await pickStopExport();

            await dragAcross(page, at("15:30"), at("16:30"), "inverter");
            await page.locator("ha-button[slot=primaryAction]").click();
            const [patches] = await savedPatches(page);
            expect(patches.map((patch: any) => [patch.id, patch.controllables.inverter.kind])).toEqual([
                [slotId("13:00"), "stop_export"],
                [slotId("15:00"), "stop_export"],
                [slotId("16:00"), "stop_export"],
            ]);
        });

        test("pressing a lane's elapsed stretch selects it, like its name does", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            // 03:00 is behind the editable boundary, so there is no gap button
            // there and the press lands on the bare track.
            const point = await trackPoint(page, Date.parse(`${DAY_ONE}T03:00:00Z`), "inverter");
            await page.mouse.click(point.x, point.y);

            const state = await laneState(page);
            expect(state.lanes.find((lane) => lane.selected)?.key).toBe("inverter");
            expect(await editingRange(page)).toBeNull();
        });

        /**
         * The parent echoes a rebuilt action back after every keystroke, so the
         * SoC field must not re-seed itself from it: it would refill an emptied
         * field with the 0 that "" parses to, and rewrite 05 to 5 mid-entry.
         */
        test("typing a target SoC is not undone by the action echoing back", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            await tapAt(page, at("13:00"), "inverter");
            await tapAt(page, at("13:00"), "inverter");

            // A plain element with a value property would pass the typing checks
            // even if it rendered nothing, so assert the field has a real box.
            const fieldHeight = await page.evaluate(() => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const editor = el.shadowRoot.querySelector("scheduling-entity-action-editor") as any;
                return editor.shadowRoot.querySelector(".target-field input")?.getBoundingClientRect().height ?? 0;
            });
            expect(fieldHeight).toBeGreaterThan(0);

            const typeSoc = (value: string) => page.evaluate((next) => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const editor = el.shadowRoot.querySelector("scheduling-entity-action-editor") as any;
                const field = editor.shadowRoot.querySelector(".target-field input") as any;
                field.value = next;
                field.dispatchEvent(new Event("input", { bubbles: true }));
                return el.updateComplete.then(() => editor.updateComplete).then(() => field.value);
            }, value);

            expect(await typeSoc("8")).toBe("8");
            expect(await typeSoc("")).toBe("");
            expect(await typeSoc("05")).toBe("05");
        });

        /**
         * The past is a different fact from the plan: measured, authorless and
         * finished. It is drawn on the same axis so a run still going meets its
         * scheduled continuation, but it must not become something to edit.
         */
        test("what really ran is drawn behind the now-line, and counts", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const lanes = await page.evaluate(() => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
                return [...band.shadowRoot.querySelectorAll(".lane")].map((lane: Element) => ({
                    key: lane.getAttribute("data-lane"),
                    // Two elapsed hours merge into one run.
                    actual: [...lane.querySelectorAll(".segment.actual")].map((segment: Element) => ({
                        left: Math.round(parseFloat((segment as HTMLElement).style.left)),
                        width: Math.round(parseFloat((segment as HTMLElement).style.width)),
                    })),
                    total: lane.querySelector(".lane-total")?.textContent?.trim() ?? null,
                    totalTitle: lane.querySelector(".lane-total")?.getAttribute("title") ?? null,
                }));
            });

            const boiler = lanes.find((lane) => lane.key === "boiler")!;
            // 07:00-09:00 is one run of two hours, starting seven twenty-fourths in.
            expect(boiler.actual).toHaveLength(1);
            expect(boiler.actual[0].left).toBe(29);
            expect(boiler.actual[0].width).toBe(8);

            // Pointing at it is allowed; editing it is not -- there is nothing
            // left to change about an hour that has gone.
            await page.locator('.lane[data-lane="boiler"] .segment.actual').click();
            expect(await editingRange(page)).toBeNull();
            // Two hours really run, plus the four this fixture still holds in
            // the schedule (the morning block as well as the evening one --
            // today's elapsed slots are pruned in production, not here).
            expect(boiler.total).toBe("6 h");
            expect(boiler.totalTitle).toBe("2 h + 4 h");

            // Half an hour of charging is half an hour, however wide it is
            // drawn -- plus the two hours this lane holds in the evening.
            const inverter = lanes.find((lane) => lane.key === "inverter")!;
            expect(inverter.actual).toHaveLength(1);
            expect(inverter.total).toBe("2,5 h");
            expect(inverter.totalTitle).toBe("0,5 h + 2 h");
        });

        /**
         * Runs of the same kind share a colour, so where one becomes another
         * with no gap the change is invisible -- and when it happened is the
         * one thing a strip of time exists to say.
         */
        test("a run becoming a different one is cut where it changes", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const marked = await page.evaluate(() => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
                const read = (laneKey: string) => [...band.shadowRoot
                    .querySelectorAll(`.lane[data-lane="${laneKey}"] .segment`)]
                    .map((segment: Element) => ({
                        left: Math.round(parseFloat((segment as HTMLElement).style.left)),
                        changed: segment.classList.contains("changed"),
                    }));
                return { inverter: read("inverter"), boiler: read("boiler") };
            });

            // The 09:00 charge it really ran and the 20:00 block both follow a
            // gap; 21:00 follows a run it differs from.
            expect(marked.inverter).toEqual([
                { left: 38, changed: false },
                { left: 83, changed: false },
                { left: 88, changed: true },
            ]);

            // The boiler's morning run continues into what it really did at
            // 07:00 -- same action, so no cut: that seam has to read as one bar.
            expect(marked.boiler.every((segment) => !segment.changed)).toBe(true);
        });

        /**
         * A run you cannot point at cannot tell you what it was, so the past
         * keeps its hit area: hovering names it, pressing selects its lane.
         */
        test("what really ran names itself on hover and selects its lane", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const segment = page.locator('.lane[data-lane="boiler"] .segment.actual');
            await expect(segment).toHaveAttribute(
                "title",
                // Two whole hours really run, said in the same words the
                // scheduled runs use.
                "Boiler · scheduling.appliance.generic.action.on · 07:00–09:00 (2 h)",
            );

            await segment.click();
            const selected = await page.evaluate(() => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
                return band.shadowRoot.querySelector(".lane.selected")?.getAttribute("data-lane");
            });
            expect(selected).toBe("boiler");
        });

        test("an entity that cannot be reached is still a lane", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            await tapAt(page, at("13:00"), "pump");

            const state = await laneState(page);
            expect(state.lanes.find((lane) => lane.selected)?.key).toBe("pump");
            expect(state.panelLane).toBe("Pump");
        });
    });
});

/**
 * Explain mode: the same day, asked "why" instead of "what".
 *
 * The two modes share the band and nothing else. What has to hold is that the
 * mode is a *view* of the day, not a second dialog: the editing surface goes
 * away entirely, the lanes narrow to the ones an automation actually touched,
 * and a press anywhere on the stack names one slot of one appliance -- there is
 * no "first select a lane" step, because the slot already says which lane it is
 * in.
 */
test.describe("entity day editor, explain mode", () => {
    /** Wait for the day's records to land, which is what settles the lanes. */
    async function enterExplain(page: Page): Promise<void> {
        await page.locator("scheduling-entity-day-editor")
            .locator('.mode-button[data-mode="explain"]')
            .click();
        await expect(page.locator("scheduling-entity-day-editor").locator(".explain-hint"))
            .toHaveCount(1);
        await page.waitForFunction(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            return band?.shadowRoot?.querySelectorAll(".lane").length === 2;
        });
    }

    /** Press the slot covering `atMs` in one lane, as a reader does. */
    async function pressSlot(page: Page, atMs: number, laneKey: string): Promise<void> {
        const point = await trackPoint(page, atMs, laneKey);
        await page.mouse.click(point.x, point.y);
    }

    function editor(page: Page) {
        return page.locator("scheduling-entity-day-editor");
    }

    test("opens in edit mode, with the editing surface intact", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true, explainable: true });

        await expect(editor(page).locator('.mode-button[data-mode="edit"]')).toHaveClass(/selected/);
        await expect(editor(page).locator(".edit-panel")).toHaveCount(1);
        await expect(editor(page).locator("scheduling-explanation-panel")).toHaveCount(0);
    });

    test("explaining hides the editing controls and the lanes with no automation", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true, explainable: true });
        await enterExplain(page);

        // Nothing to author here: the panel is the edit mode's whole surface,
        // and it goes, legend and all.
        await expect(editor(page).locator(".edit-panel")).toHaveCount(0);
        await expect(editor(page).locator(".legend")).toHaveCount(0);

        // The pump's record is null: no optimizer ever touched it, so there is
        // nothing to press it for.
        const lanes = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            return [...band.shadowRoot.querySelectorAll(".lane")]
                .map((lane: Element) => lane.getAttribute("data-lane"));
        });
        expect(lanes).toEqual(["inverter", "boiler"]);
    });

    test("reopening the editor reuses one explanation for the same lane and date", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true, explainable: true });
        await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const original = el.hass.callWS;
            (window as any).explanationCalls = 0;
            el.hass.callWS = (message: any) => {
                if (message.type === "helman/get_schedule_explanation" && message.controllable_id === "boiler") {
                    (window as any).explanationCalls++;
                }
                return original(message);
            };
        });
        await enterExplain(page);
        await page.waitForFunction(() => (window as any).explanationCalls === 1);
        await page.evaluate(async () => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            el.open = false;
            await el.updateComplete;
            el.open = true;
            await el.updateComplete;
            el._setMode("explain");
        });
        expect(await page.evaluate(() => (window as any).explanationCalls)).toBe(1);
    });

    test("typing in the editor keeps the derived days", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true });
        await tapAt(page, at("13:00"), "inverter");
        await tapAt(page, at("13:00"), "inverter");
        const sameDays = await page.evaluate(async () => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const before = el._days();
            const actionEditor = el.shadowRoot.querySelector("scheduling-entity-action-editor") as any;
            const field = actionEditor.shadowRoot.querySelector(".target-field input") as HTMLInputElement;
            field.value = "75";
            field.dispatchEvent(new Event("input", { bubbles: true }));
            await el.updateComplete;
            return el._days() === before;
        });
        expect(sameDays).toBe(true);
    });

    test("the lanes are split into the day's slots, and nothing is preselected", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true, explainable: true });
        await enterExplain(page);

        const picks = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            return band.shadowRoot.querySelectorAll('.lane[data-lane="inverter"] .slot-pick').length;
        });
        expect(picks).toBe(24);

        // A diagram nobody asked for would be about a slot nobody pressed.
        await expect(editor(page).locator(".explain-hint")).toHaveCount(1);
        await expect(editor(page).locator("scheduling-explanation-panel")).toHaveCount(0);
    });

    test("pressing a slot in any lane explains that lane's slot", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true, explainable: true });
        await enterExplain(page);

        // The dialog was opened on the boiler; the inverter is a lane the user
        // never selected, and one press is still all it takes.
        await pressSlot(page, Date.parse(`${DAY_ONE}T13:00:00Z`), "inverter");

        const panel = editor(page).locator("scheduling-explanation-panel");
        await expect(panel).toHaveCount(1);
        await expect(panel.locator("scheduling-logic-diagram")).toHaveCount(1);
        // One optimizer on this lane, so no strip: a lone chip would restate
        // what the diagram under it is already about.
        await expect(panel.locator(".tab-strip")).toHaveCount(0);
        await expect(editor(page).locator(".explain-hint")).toHaveCount(0);
    });

    test("a lane two automations write gets a tab each, named and resulted", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true, explainable: true });
        await enterExplain(page);

        await pressSlot(page, Date.parse(`${DAY_ONE}T13:00:00Z`), "boiler");

        const tabs = editor(page).locator("scheduling-explanation-panel").locator(".tab");
        await expect(tabs).toHaveCount(2);
        await expect(tabs.nth(0)).toHaveAttribute("data-outcome", "wrote");
        await expect(tabs.nth(1)).toHaveAttribute("data-outcome", "not_eligible");
        // The name of the automation, and what it did with the slot.
        await expect(tabs.nth(0)).toContainText("appliance_runtime");
        await expect(tabs.nth(1)).toContainText("charge_hold");
    });

    test("the answered slot stays marked, and switching back restores the editor", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true, explainable: true });
        await enterExplain(page);
        await pressSlot(page, Date.parse(`${DAY_ONE}T13:00:00Z`), "boiler");

        const marked = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            return [...band.shadowRoot.querySelectorAll(".slot-pick.selected")]
                .map((pick: Element) => [
                    pick.closest(".lane")?.getAttribute("data-lane"),
                    pick.getAttribute("data-slot"),
                ]);
        });
        // The lane that was pressed, and no other: the diagram below is about
        // one appliance at one hour.
        expect(marked).toEqual([["boiler", `${DAY_ONE}T13:00:00.000Z`]]);

        await editor(page).locator('.mode-button[data-mode="edit"]').click();
        await expect(editor(page).locator(".edit-panel")).toHaveCount(1);
        await expect(editor(page).locator("scheduling-explanation-panel")).toHaveCount(0);
        // The lane that was being edited is still the lane being edited.
        await expect(editor(page).locator(".edit-panel .lane-name")).toHaveText("Boiler");
    });

    test("snapshotDraftState captures and restoreDraftState restores unsaved drafts and lane selection", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { multiLane: true });

        const result = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            el._drafts = { boiler: { "slot-1": { kind: "switch", on: true } } };
            el._blockSplits = { boiler: new Set([12345]) };
            el._selectedLaneKey = "boiler";
            el._dayIndex = 1;

            const snapshot = el.snapshotDraftState();

            // Re-seed to empty
            el._seedFromSlots();

            // Restore for different target
            el.restoreDraftState(snapshot, "inverter", null);
            const forInverter = {
                drafts: el._drafts,
                selected: el._selectedLaneKey,
                dayIndex: el._dayIndex,
            };

            // Restore for same target
            el.restoreDraftState(snapshot, "boiler", null);
            const forBoiler = {
                drafts: el._drafts,
                selected: el._selectedLaneKey,
                dayIndex: el._dayIndex,
            };

            return { snapshot, forInverter, forBoiler };
        });

        expect(result.snapshot.drafts).toEqual({ boiler: { "slot-1": { kind: "switch", on: true } } });
        expect(result.forInverter.drafts).toEqual({ boiler: { "slot-1": { kind: "switch", on: true } } });
        expect(result.forInverter.selected).toBe("inverter");
        expect(result.forInverter.dayIndex).toBe(1);
        expect(result.forBoiler.selected).toBe("boiler");
    });
});
