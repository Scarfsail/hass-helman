import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The controllable entity list on the card.
 *
 * The rows are icons and times with almost no words, so the one thing worth
 * pinning here is that each state still says who scheduled it: the ring the
 * chip draws, and the tooltip that names the author for anyone who has not
 * learned the colours.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const NOW_MS = Date.parse("2026-07-25T10:30:00Z");

async function mountRows(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-running-entities"));

    await page.evaluate((nowMs) => {
        const stateObj = (entityId: string, state: string) => ({
            entity_id: entityId,
            state,
            attributes: { friendly_name: entityId },
            last_changed: new Date(nowMs).toISOString(),
        });
        const boiler = { id: "boiler", name: "Boiler", kind: "generic", icon: "mdi:water-boiler" };

        const el = document.createElement("scheduling-running-entities") as any;
        el.localize = (key: string) => key;
        el.executionEnabled = true;
        el.nowMs = nowMs;
        el.entities = [
            {
                // Running because the user asked for it, and nothing after.
                entityId: "switch.boiler",
                name: "Boiler",
                stateObj: stateObj("switch.boiler", "on"),
                isAvailable: true,
                isNormal: false,
                sinceMs: nowMs - 3_600_000,
                current: { domain: "appliance", appliance: boiler, action: { on: true }, setBy: "user" },
                next: {
                    atMs: nowMs + 3_600_000,
                    view: { domain: "appliance", appliance: boiler, action: null, setBy: null },
                },
                scheduleTarget: { kind: "appliance", applianceId: "boiler" },
            },
            {
                // At rest now, with a charge the optimizer scheduled later.
                entityId: "select.inverter",
                name: "Inverter",
                stateObj: stateObj("select.inverter", "Normal"),
                isAvailable: true,
                isNormal: true,
                sinceMs: null,
                current: { domain: "inverter", action: { kind: "normal" }, setBy: null },
                next: {
                    atMs: nowMs + 9_000_000,
                    view: {
                        domain: "inverter",
                        action: { kind: "charge_to_target_soc", targetSoc: 90 },
                        setBy: "automation",
                    },
                },
                scheduleTarget: { kind: "inverter" },
            },
        ];
        document.body.appendChild(el);
    }, NOW_MS);

    await page.waitForFunction(() => {
        const el = document.querySelector("scheduling-running-entities") as any;
        return !!el?.shadowRoot?.querySelector("scheduling-appliance-chip");
    });
}

/** Each chip as `authorship-state | title`, in row order. */
async function readChips(page: Page) {
    return page.evaluate(() => {
        const el = document.querySelector("scheduling-running-entities") as any;
        const chips = el.shadowRoot.querySelectorAll("scheduling-action-chip, scheduling-appliance-chip");
        return [...chips].map((chip: any) => {
            const className = chip.shadowRoot.querySelector(".chip")?.className ?? "";
            const state = /authorship-(user|automation|mixed)\b/.exec(className)?.[1] ?? null;
            return { state, title: chip.titleText ?? "" };
        });
    });
}

test.describe("controllable entity rows", () => {
    test("each scheduled state says who set it, in colour and in words", async ({ page }) => {
        await mountRows(page);

        const chips = await readChips(page);
        expect(chips.map((chip) => chip.state)).toEqual([
            // Boiler: running by the user's hand, then nothing scheduled.
            "user",
            null,
            // Inverter: at rest with nobody's action, then the optimizer's charge.
            null,
            "automation",
        ]);
        expect(chips[0].title).toContain("scheduling.authorship.set_by_user");
        expect(chips[3].title).toContain("scheduling.authorship.set_by_automation");
        // A state nobody scheduled is left undecorated and unattributed.
        expect(chips[1].title).not.toContain("scheduling.authorship");
    });
});
