import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The power card marks shiftable house consumers.
 *
 * A house child whose energy statistic is a deferrable controllable arrives from
 * the device tree with `deferrable: true`, and the card says so twice: the box
 * takes the shared lighter house shade instead of inheriting the section's house
 * tint, and the badge channel names the shade. Both decisions are made off that
 * one flag, so an inspector band and a card box for the same appliance are the
 * same colour — which is the point of the flag.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

// DEFERRABLE_HOUSE_COLOR under nodeAccentColor's alpha — the same value the
// inspector's composition panel paints its shiftable rows with.
const DEFERRABLE_TINT = "#e2c6fc60";

interface FakeNode {
    id: string;
    name: string;
    deferrable?: boolean;
    customLabelTexts?: string[];
}

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("power-devices-container"));
}

/** Mount the house consumers and read back each box's tint and badge text. */
async function renderedRows(
    page: Page,
    nodes: FakeNode[],
): Promise<Array<{ label: string; tint: string; tag: string }>> {
    return page.evaluate(async (fakeNodes) => {
        const el = document.createElement("power-devices-container") as any;
        el.hass = { states: {}, locale: { language: "en" }, language: "en" };
        el.devices = fakeNodes.map((n: any) => ({
            children: [],
            valueType: "default",
            isSource: false,
            isUnmeasured: false,
            powerValue: 100,
            powerHistory: [100],
            historyBuckets: 1,
            ...n,
        }));
        el.historyBuckets = 1;
        el.historyBucketDuration = 1;
        el.devices_full_width = true;
        document.body.appendChild(el);
        await el.updateComplete;

        const rows = [...el.shadowRoot!.querySelectorAll("power-device")] as any[];
        const out = [];
        for (const row of rows) {
            await row.updateComplete;
            const content = row.shadowRoot.querySelector(".deviceContent");
            const info = content.querySelector("power-device-info");
            if (info) await info.updateComplete;
            out.push({
                label: (content.querySelector(".deviceName")?.textContent ?? "").trim(),
                tint: content.style.getPropertyValue("--device-tint").trim(),
                tag: (info?.shadowRoot?.querySelector(".custom-labels")?.textContent ?? "").trim(),
            });
        }
        return out;
    }, nodes);
}

test.describe("deferrable house consumers on the power card", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("only the shiftable consumer is tinted and tagged", async ({ page }) => {
        const rows = await renderedRows(page, [
            { id: "sensor.dishwasher_energy", name: "Dishwasher", deferrable: true },
            { id: "sensor.fridge_energy", name: "Fridge" },
        ]);

        expect(rows.map((r) => r.label)).toEqual(["Dishwasher", "Fridge"]);
        // The ordinary consumer sets no tint of its own, so it keeps inheriting
        // the house section's colour exactly as it did before this existed.
        expect(rows.map((r) => r.tint)).toEqual([DEFERRABLE_TINT, ""]);
        expect(rows.map((r) => r.tag)).toEqual(["deferrable", ""]);
    });

    test("a device with a label badge keeps it alongside the tag", async ({ page }) => {
        const rows = await renderedRows(page, [
            {
                id: "sensor.boiler_energy",
                name: "Boiler",
                deferrable: true,
                customLabelTexts: ["heating"],
            },
        ]);

        expect(rows[0].tag).toBe("heating • deferrable");
    });
});
