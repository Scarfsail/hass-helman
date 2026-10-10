import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";

/**
 * The grid node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the grid overview and its voltage
 * section), today's span aggregates and the forecast. What is pinned is the
 * shared disclosure contract (compact overview, voltage question first, one
 * open question, answer then evidence, nothing heavy mounted or requested while
 * closed) and the grid's truthfulness: voltages are terminal readings against
 * descriptive references, current is an estimate, and money keeps its coverage.
 */

const BUNDLE = resolve(__dirname, "../../custom_components/helman/frontend_compiled/helman-card.js");
const SCREENS = process.env.P2_SCREENS;

type Variant = {
    profile?: boolean;
    /** L3 voltage is unavailable live and has no sensor in the section. */
    l3Missing?: boolean;
    /** L2 voltage reads 0 V. */
    zeroVoltage?: boolean;
    noLimit?: boolean;
    condition?: "off_grid" | null;
    sectionFails?: boolean;
    /** Only half of today's exported kWh had a rate. */
    exportPartlyPriced?: boolean;
    /** The payload's current import price is from before the 12:00 boundary. */
    staleCurrentPrice?: boolean;
};

declare global {
    interface Window {
        __hass: any;
        __requests: Array<{ type: string; node?: string; section?: string }>;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate((v) => {
        const profile = v.profile !== false;
        const node = (id: string, sensor: string, sourceType: string | null) => ({
            id, displayName: id, powerSensorId: sensor, ratioSensorId: null, switchEntityId: null,
            valueType: "default", sourceConfig: null, sourceType, isSource: sourceType !== null,
            isUnmeasured: false, groups: {}, groupBadgeTexts: [], icon: null, compact: false,
            showAdditionalInfo: false, childrenFullWidth: false, hideChildren: false,
            hideChildrenIndicator: false, sortChildrenByPower: false, deferrable: false,
            controllableIds: [], children: [],
        });
        const tree = {
            sources: [node("solar", "sensor.solar", "solar"), node("grid", "sensor.grid", "grid"), node("battery", "sensor.battery", "battery")],
            consumers: [node("house", "sensor.house", null)],
            consumptionTotalSensorId: null,
            productionTotalSensorId: null,
            uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
        };
        const s = (state: string, unit?: string, friendly?: string) => ({
            state, attributes: { ...(unit ? { unit_of_measurement: unit } : {}), ...(friendly ? { friendly_name: friendly } : {}) },
        });
        // measured_power_l* reads positive while exporting.
        const telemetry: Record<string, [string, string, string?]> = {
            grid_power_l1: ["sensor.solax_measured_power_l1", "-400", "W"],
            grid_power_l2: ["sensor.solax_measured_power_l2", "1200", "W"],
            grid_power_l3: ["sensor.solax_measured_power_l3", "-150", "W"],
            ac_voltage_l1: ["sensor.solax_inverter_voltage_l1", "236.0", "V"],
            ac_voltage_l2: ["sensor.solax_inverter_voltage_l2", v.zeroVoltage ? "0" : "241.5", "V"],
            ac_voltage_l3: ["sensor.solax_inverter_voltage_l3", v.l3Missing ? "unavailable" : "238.2", "V"],
            grid_import: ["sensor.solax_grid_import", "0", "W"],
            grid_export: ["sensor.solax_grid_export", "650", "W"],
            grid_frequency: ["sensor.solax_grid_frequency", "50.01", "Hz"],
            run_mode: ["sensor.solax_run_mode", v.condition === "off_grid" ? "Off-Grid" : "Normal Mode"],
            export_limit: ["number.solax_export_control_user_limit", "9900", "W"],
            main_breaker_limit: ["number.solax_main_breaker_current_limit", v.noLimit ? "unavailable" : "25", "A"],
            grid_mode_runtime: ["sensor.solax_grid_mode_runtime", "32820.0", "h"],
            eps_mode_runtime: ["sensor.solax_eps_mode_runtime", "163.9", "h"],
        };
        const states: Record<string, unknown> = {
            "sensor.solar": s("4200", "W"), "sensor.grid": s("-650", "W"), "sensor.battery": s("-500", "W"),
            "sensor.house": s("1200", "W"),
            "sensor.today_import": s("8.4", "kWh"), "sensor.today_export": s("12600", "Wh"),
        };
        const entities: Record<string, string | null> = { today_import: "sensor.today_import", today_export: "sensor.today_export" };
        if (profile) {
            for (const [key, [entityId, state, unit]] of Object.entries(telemetry)) {
                entities[key] = entityId;
                states[entityId] = s(state, unit, key.replace(/_/g, " "));
            }
        }
        const overview = {
            node: "grid",
            asOf: "2026-10-21T12:00:00+00:00",
            profile: profile ? { id: "solax_inverter", label: "SolaX inverter" } : null,
            entities,
            phasePowerPolarity: profile ? "positive_is_export" : null,
            maxAllowedExportPower: 9900,
            condition: v.condition === "off_grid" ? { kind: "off_grid", runMode: "Off-Grid", entityId: "sensor.solax_run_mode" } : null,
            sections: profile ? ["voltage"] : [],
        };
        const day = "2026-10-21";
        const phaseDay = (phase: number, base: number) => {
            const points = Array.from({ length: 144 }, (_, i) => {
                const minutes = i * 5;
                const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
                const mm = String(minutes % 60).padStart(2, "0");
                const mean = base + 4 * Math.sin((i / 144) * Math.PI * 2 + phase);
                return { start: `${day}T${hh}:${mm}:00+00:00`, mean, min: mean - 1.5, max: mean + 1.5, coverage: 1 };
            }).filter((_, i) => i < 40 || i > 52); // a gap in the morning
            return {
                entityId: `sensor.solax_inverter_voltage_l${phase}`, unit: "V", source: "history", extrema: "recorded",
                bucketMinutes: 5, points, mean: base, min: base - 5.5, minAt: `${day}T03:00:00+00:00`,
                max: base + 5.5, maxAt: `${day}T09:00:00+00:00`, coverage: 0.91,
            };
        };
        const section = {
            node: "grid", section: "voltage", asOf: "2026-10-21T12:00:00+00:00",
            period: { start: `${day}T00:00:00+00:00`, end: "2026-10-22T00:00:00+00:00" },
            phases: { "1": phaseDay(1, 236), "2": phaseDay(2, 240), "3": v.l3Missing ? null : phaseDay(3, 238) },
            spread: { phases: v.l3Missing ? [1, 2] : [1, 2, 3], max: 6.2, maxAt: `${day}T10:30:00+00:00`, coverage: 0.88 },
        };
        const aggregates = {
            bucket: "day",
            currency: "CZK/kWh",
            days: [{
                date: day, gridImportKwh: 8.4, gridExportKwh: 12.6,
                moneyCost: 42.5, moneyGain: v.exportPartlyPriced ? 9.45 : 18.9,
                moneyCostKwh: 8.4, moneyGainKwh: v.exportPartlyPriced ? 6.3 : 12.6,
            }],
        };
        const slot = (iso: string, imported: number, exported: number) => ({
            timestamp: iso, durationHours: 0.25, importedFromGridKwh: imported, exportedToGridKwh: exported,
        });
        const forecast = {
            grid: {
                status: "available", generatedAt: null, unit: "kWh", resolution: "quarter_hour", horizonHours: 48,
                startedAt: null, partialReason: null, coverageUntil: null, scheduleAdjusted: true,
                currentImportPrice: v.staleCurrentPrice ? 3.0 : 4.2, importPriceUnit: "CZK/kWh",
                importPricePoints: [
                    { timestamp: `${day}T12:00:00+00:00`, value: 4.2 },
                    { timestamp: `${day}T13:00:00+00:00`, value: 4.2 },
                    { timestamp: `${day}T14:00:00+00:00`, value: 5.1 },
                ],
                currentExportPrice: 1.5, exportPriceUnit: "CZK/kWh",
                exportPricePoints: [{ timestamp: `${day}T12:00:00+00:00`, value: 1.5 }],
                series: [
                    slot(`${day}T12:00:00+00:00`, 0, 0.3),
                    slot(`${day}T12:15:00+00:00`, 0, 0.3),
                    slot(`${day}T15:00:00+00:00`, 0.4, 0),
                ],
            },
        };
        const inverter = {
            node: "inverter", asOf: "2026-10-21T12:00:00+00:00", configured: false, profile: null, mode: null,
            entities: {}, maxAllowedExportPower: 9900,
            agreement: { status: "unknown", reason: "no_profile", commanded: null, observedOption: null, registers: [] },
            condition: null, sections: [],
        };
        window.__requests = [];
        window.__hass = {
            language: "en",
            // A 24-hour English locale, so times read as the assertions write them.
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async (msg: { type: string }) => {
                    window.__requests.push({ type: msg.type });
                    return msg.type === "helman/get_forecast" ? forecast : {};
                },
                subscribeMessage: async () => () => undefined,
            },
            states,
            callWS: async (msg: { type: string; node?: string; section?: string }) => {
                window.__requests.push({ type: msg.type, node: msg.node, section: msg.section });
                if (msg.type === "helman/get_device_tree") return tree;
                if (msg.type === "helman/get_history") return { buckets: 3, bucket_duration: 60, entity_history: {} };
                if (msg.type === "helman/get_schedule") return { executionEnabled: true, slots: [] };
                if (msg.type === "helman/solar_bias/day_aggregates") return aggregates;
                if (msg.type === "helman/get_node_detail") {
                    if (msg.node === "inverter") return inverter;
                    if (msg.section) {
                        if (v.sectionFails) throw new Error("recorder down");
                        return section;
                    }
                    return overview;
                }
                return {};
            },
        };
    }, variant);
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-simple-card"));
    await page.evaluate(async () => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        card.hass = window.__hass;
        document.body.appendChild(card);
    });
}

const gridCell = (page: Page) => page.locator(".node-cell:has(simple-card-grid)");
const content = (page: Page) => page.locator("node-detail-grid-content");
const question = (page: Page, id: string) => page.locator(`helman-node-question[data-question="${id}"]`);
const header = (page: Page, id: string) => question(page, id).locator("button.header");
const evidence = (page: Page, id: string) => question(page, id).locator("button.evidence-toggle");
const sectionRequests = (page: Page) =>
    page.evaluate(() => window.__requests.filter((r) => r.type === "helman/get_node_detail" && r.node === "grid" && r.section).length);

async function openDetail(page: Page): Promise<void> {
    await gridCell(page).click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

test.describe("the grid overview", () => {
    test("opens compact: a status sentence, two figures, the next price and five closed questions, voltage first", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Exporting 650 W to the grid.");
        await expect(overview.locator(".figure")).toHaveCount(2);
        // 8.4 kWh in, 12 600 Wh out: the units are read, not assumed.
        await expect(overview.locator("[data-figure='net-energy']")).toContainText("Net export today");
        await expect(overview.locator("[data-figure='net-energy']")).toContainText("4.2 kWh");
        await expect(overview.locator("[data-figure='net-money']")).toContainText("Net cost today");
        await expect(overview.locator("[data-figure='net-money']")).toContainText("23.60 CZK");
        await expect(overview.locator("[data-next]")).toHaveText("Next: import price 5.1 CZK/kWh from 14:00");

        const ids = await content(page).locator("helman-node-question").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["voltage", "phases", "money", "next", "outage"]);
        for (const id of ids) {
            await expect(header(page, id!)).toHaveAttribute("aria-expanded", "false");
        }
        await expect(content(page).locator("table, helman-day-line-chart, helman-solar-inspector-card, .bars")).toHaveCount(0);
        expect(await sectionRequests(page)).toBe(0);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        // The tree stays on the card.
        await expect(content(page).locator("helman-tree-item")).toHaveCount(0);
    });

    test("answer previews say the answer", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(question(page, "voltage").locator(".preview")).toHaveText("Now 236.0 V–241.5 V at the inverter");
        await expect(question(page, "phases").locator(".preview")).toHaveText("Highest: L2 exporting 1.2 kW (≈ 5.0 A est.)");
        await expect(question(page, "money").locator(".preview")).toHaveText("cost 42.50 CZK · income 18.90 CZK");
        await expect(question(page, "next").locator(".preview")).toHaveText("import 4.2 CZK/kWh · export 1.5 CZK/kWh");
        await expect(question(page, "outage").locator(".preview")).toHaveText("On grid · Normal Mode");
    });

    test("off-grid operation is the one exception, linked to its answer", async ({ page }) => {
        await mount(page, { condition: "off_grid" });
        await openDetail(page);
        const exception = content(page).locator("[data-exception]");
        await expect(exception).toContainText("off-grid operation (Off-Grid)");
        await exception.locator("button").click();
        await expect(header(page, "outage")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "outage").locator("[data-row='grid-state']")).toContainText("Off-grid (Off-Grid)");
    });
});

test.describe("voltage", () => {
    test("one click draws today's three phases against labeled references, requested only then", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        expect(await sectionRequests(page)).toBe(0);
        await header(page, "voltage").click();
        const chart = question(page, "voltage").locator("helman-day-line-chart");
        await expect(chart.locator("svg")).toBeVisible();
        expect(await sectionRequests(page)).toBe(1);
        await expect(chart.locator("path.line")).toHaveCount(3);
        await expect(chart.locator(".legend")).toContainText("L1");
        await expect(chart.locator("rect.band")).toHaveCount(1);
        await expect(chart.locator("text.reference-label")).toHaveText(["207–253 V reference", "230 V nominal"]);
        // The morning gap stays a gap.
        const path = await chart.locator("path.line").first().getAttribute("d");
        expect((path ?? "").split("M").length - 1).toBe(2);

        const rows = question(page, "voltage").locator("[data-voltage-table] tbody tr");
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(1)).toContainText("234.5 V");
        await expect(rows.nth(1)).toContainText("240.0 V");
        await expect(rows.nth(1)).toContainText("245.5 V");
        await expect(question(page, "voltage").locator("[data-row='spread']")).toContainText("6.2 V at 10:30 (88 % of the day compared)");
        // Descriptive references, never a verdict.
        await expect(question(page, "voltage")).toContainText("not a compliance verdict or the inverter's protection setting");

        await evidence(page, "voltage").click();
        await expect(question(page, "voltage").locator("[data-row='sampling-l1']")).toContainText("91 % of the day recorded");
        await expect(question(page, "voltage").locator("[data-source]")).toHaveText(["Read from recorded states: min and max are recorded values, each held until the next."]);
        await expect(question(page, "voltage")).toContainText("inverter's terminal voltages");
        await expect(question(page, "voltage").locator("[data-reference-meaning]")).toContainText("this chart cannot say whether either was met");
    });

    test("an unavailable phase is labeled, not drawn as zero", async ({ page }) => {
        await mount(page, { l3Missing: true });
        await openDetail(page);
        await expect(question(page, "voltage").locator(".preview")).toHaveText("Now 236.0 V–241.5 V at the inverter · L3 unavailable");
        await header(page, "voltage").click();
        await expect(question(page, "voltage").locator("helman-day-line-chart path.line")).toHaveCount(2);
        await expect(question(page, "voltage").locator("[data-voltage-table] tr[data-phase='3']")).toContainText("no sensor");

        await header(page, "phases").click();
        await expect(question(page, "phases").locator("[data-phase-bar='3'] [data-current]")).toHaveText("current not estimable: no voltage");
    });

    test("a failed history request explains itself, retries, and does not block the overview", async ({ page }) => {
        await mount(page, { sectionFails: true });
        await openDetail(page);
        await header(page, "voltage").click();
        await expect(question(page, "voltage")).toContainText("Today's history could not be loaded.");
        await expect(content(page).locator("[data-overview]")).toBeVisible();
        await question(page, "voltage").getByRole("button", { name: "Try again" }).click();
        expect(await sectionRequests(page)).toBe(2);
    });
});

test.describe("phases", () => {
    test("directional bars and an estimated current against the configured limit", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "phases").click();
        const phases = question(page, "phases");
        await expect(phases.locator("[data-phase-bar]")).toHaveCount(3);
        await expect(phases.locator("[data-phase-bar='1'] [data-power]")).toHaveText("importing 400 W");
        await expect(phases.locator("[data-phase-bar='2'] [data-power]")).toHaveText("exporting 1.2 kW");
        await expect(phases.locator("[data-phase-bar='1'] [data-current]")).toHaveText("≈ 1.7 A of 25.0 A setting (est.)");
        await expect(phases).toContainText("not a measured current or breaker headroom");

        await evidence(page, "phases").click();
        // Import positive, whichever way the meter signs it.
        await expect(phases.locator("[data-phase-table] tbody tr").first()).toContainText("400 W");
        await expect(phases.locator("[data-phase-table] tbody tr").nth(1)).toContainText("-1200 W");
        await expect(phases.locator("[data-row='main_breaker_limit']")).toContainText("25 A");
        await expect(phases).toContainText("assuming a power factor of 1");
    });

    test("a zero voltage or a missing limit leaves out only that comparison", async ({ page }) => {
        await mount(page, { zeroVoltage: true, noLimit: true });
        await openDetail(page);
        await header(page, "phases").click();
        const phases = question(page, "phases");
        await expect(phases.locator("[data-phase-bar='2'] [data-current]")).toHaveText("current not estimable: no voltage");
        await expect(phases.locator("[data-phase-bar='1'] [data-current]")).toHaveText("≈ 1.7 A (est.)");
        await expect(phases.locator("[data-phase-bar='2'] [data-power]")).toHaveText("exporting 1.2 kW");
    });
});

test.describe("money and what comes next", () => {
    test("money: cost, income, net and the priced coverage; the focused embed only behind the evidence", async ({ page }) => {
        await mount(page, { exportPartlyPriced: true });
        await openDetail(page);
        await header(page, "money").click();
        const money = question(page, "money");
        await expect(money.locator("[data-row='period']")).toContainText("Today 00:00–12:00");
        await expect(money.locator("[data-row='import-cost']")).toContainText("42.50 CZK");
        await expect(money.locator("[data-row='export-income']")).toContainText("9.45 CZK");
        await expect(money.locator("[data-row='net']")).toContainText("Net cost");
        await expect(money.locator("[data-row='net']")).toContainText("33.05 CZK");
        await expect(money.locator("[data-row='coverage']")).toHaveText(/import 100 % of 8\.4 kWh · export 50 % of 13 kWh/);
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);

        await evidence(page, "money").click();
        await expect(money.locator("helman-solar-inspector-card")).toHaveCount(1);
        await expect(money).toContainText("the totals above price each hour");

        // Another question shows its own embed, never both.
        await header(page, "next").click();
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);
        await evidence(page, "next").click();
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(1);
        await expect(question(page, "next").locator("helman-solar-inspector-card")).toHaveCount(1);
    });

    test("next: the rates now and next, and the plan's grid flow", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "next").click();
        const next = question(page, "next");
        await expect(next.locator("[data-row='import-now']")).toContainText("4.2 CZK/kWh");
        await expect(next.locator("[data-row='import-next']")).toContainText("5.1 CZK/kWh from 14:00");
        await expect(next.locator("[data-row='export-next']")).toContainText("no change known");
        await expect(next.locator("[data-row='planned-now']")).toContainText("exporting 0.30 kWh");
        await expect(next.locator("[data-row='planned-change']")).toContainText("from 15:00: importing");
        await expect(next).toContainText("with the schedule applied, an estimate rather than a commitment");
    });
});

test("next: a rate whose boundary has passed is the rate now, from the price points", async ({ page }) => {
    await mount(page, { staleCurrentPrice: true });
    await openDetail(page);
    await header(page, "next").click();
    const next = question(page, "next");
    await expect(next.locator("[data-row='import-now']")).toContainText("4.2 CZK/kWh");
    await expect(next.locator("[data-row='import-next']")).toContainText("5.1 CZK/kWh from 14:00");
});

test.describe("disclosure", () => {
    test("one open question at a time, evidence by keyboard, and a reopened dialog starts at the overview", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "voltage").focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "voltage")).toHaveAttribute("aria-expanded", "true");
        await expect(header(page, "voltage")).toBeFocused();
        await evidence(page, "voltage").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "voltage").locator("[data-reference-meaning]")).toBeVisible();

        await header(page, "outage").click();
        await expect(header(page, "voltage")).toHaveAttribute("aria-expanded", "false");
        await expect(question(page, "voltage").locator("helman-day-line-chart")).toHaveCount(0);
        await expect(question(page, "outage").locator("[data-row='export-limit']")).toContainText("9.9 kW");
        await expect(question(page, "outage").locator("[data-row='eps_mode_runtime']")).toContainText("163.9 h");
        await evidence(page, "outage").click();
        await expect(question(page, "outage").locator("[data-row='grid_frequency']")).toContainText("50.01 Hz");

        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await openDetail(page);
        await expect(header(page, "outage")).toHaveAttribute("aria-expanded", "false");
    });

    test("live readings reach the open detail", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await page.evaluate(() => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = window.__hass;
            card.hass = {
                ...hass,
                states: { ...hass.states, "sensor.solax_inverter_voltage_l2": { state: "244.0", attributes: { unit_of_measurement: "V" } } },
            };
        });
        await expect(question(page, "voltage").locator(".preview")).toHaveText("Now 236.0 V–244.0 V at the inverter");
    });
});

test.describe("a Custom inverter", () => {
    test("keeps the core questions with a short unavailable answer, and hides the off-grid one", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        await expect(question(page, "outage")).toHaveCount(0);
        await expect(question(page, "voltage").locator(".preview")).toHaveText("Needs a hardware profile with phase readings.");
        await header(page, "voltage").click();
        await expect(question(page, "voltage")).toContainText("this one is Custom");
        await expect(question(page, "voltage").locator("helman-day-line-chart")).toHaveCount(0);
        expect(await sectionRequests(page)).toBe(0);
        // Money and the plan do not depend on the profile.
        await expect(question(page, "money").locator(".preview")).toHaveText("cost 42.50 CZK · income 18.90 CZK");
    });
});

test.describe("screenshots", () => {
    test.skip(!SCREENS, "set P2_SCREENS to a directory to capture the review screenshots");
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        test(`overview and an expanded answer at ${name}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await mount(page);
            await openDetail(page);
            await page.screenshot({ path: `${SCREENS}/${name}-overview.png`, fullPage: true });
            await header(page, "voltage").click();
            await expect(question(page, "voltage").locator("helman-day-line-chart svg")).toBeVisible();
            await page.screenshot({ path: `${SCREENS}/${name}-voltage.png`, fullPage: true });
            await evidence(page, "voltage").click();
            await page.screenshot({ path: `${SCREENS}/${name}-voltage-evidence.png`, fullPage: true });
            await header(page, "phases").click();
            await evidence(page, "phases").click();
            await page.screenshot({ path: `${SCREENS}/${name}-phases.png`, fullPage: true });
            await header(page, "money").click();
            await page.screenshot({ path: `${SCREENS}/${name}-money.png`, fullPage: true });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    }
});
