import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Every badge in an entity group is legible, on a light theme and a dark one.
 *
 * The severity classes used to set their hue as the *text* colour over a wash
 * of that same hue -- a mid-tone on a pale tint. Measured against the group's
 * ground that was 2.2:1 for a warning on a light theme and 2.8:1 for info on a
 * dark one, against the 4.5:1 that text this size needs; and no change to the
 * wash fixes both at once, because the two grounds move in opposite
 * directions. This asserts the property rather than the fix, so any future
 * repaint of the badges has to keep it.
 *
 * The palettes below set only what a Home Assistant theme is guaranteed to
 * give -- a card background and a text colour -- and deliberately leave the
 * `--rgb-*-color` state variables unset, so what is measured is the fallback
 * the element ships with. That is the one case this bundle fully controls.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const GRID_PATH = ["power_devices", "grid", "entities", "power"];
const GRID_KEY = GRID_PATH.join(".");

const CONFIG = {
    config_version: 7,
    power_devices: { grid: { entities: { power: "sensor.grid_power" } } },
    controllables: [],
};

/** One fact per severity, so every badge class is on screen to be measured. */
const FACTS = ["neutral", "info", "ok", "warn"].map((severity, index) => ({
    id: index === 0 ? "value" : `probe_${severity}`,
    token: "value",
    params: { value: "206", unit: "d" },
    severity,
}));

/** What HA gives a page in each mode; nothing else is assumed. */
const PALETTES = {
    light: { "--card-background-color": "#ffffff", "--primary-text-color": "#141414" },
    dark: { "--card-background-color": "#1c1c1c", "--primary-text-color": "#e1e1e1" },
};

/** WCAG 2.x: text needs 4.5:1 below 18.66px bold, and these render at ~11.5px. */
const AA_NORMAL_TEXT = 4.5;

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, gridKey, facts }) => {
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: any) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") {
                        return { version: 2, kinds: [] };
                    }
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/inspect_entities") {
                        return {
                            results: (request.targets ?? []).map((target: any) => ({
                                key: target.key,
                                draft:
                                    target.key === gridKey
                                        ? {
                                              entityId: "sensor.grid_power",
                                              status: "ok",
                                              facts,
                                          }
                                        : { entityId: null, status: "unset", facts: [] },
                                saved: null,
                            })),
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);

            /**
             * The contrast of each badge's text against what is actually
             * behind it.
             *
             * The fills are translucent, so the ratio has to be taken against
             * the badge composited over the group's own ground -- measuring
             * against the declared `background-color` would compare the text
             * with a colour no pixel on screen ever takes.
             */
            (window as any).measureBadges = function measureBadges(key: string) {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const group = Array.from(
                    root?.querySelectorAll("helman-entity-group") ?? [],
                ).find((candidate: any) => candidate.key === key) as any;
                const box = group?.shadowRoot?.querySelector(".entity-group");
                if (!box) return {};
                const ground = getComputedStyle(box)
                    .backgroundColor.match(/[\d.]+/g)!
                    .map(Number);
                const channel = (value: number) => {
                    const v = value / 255;
                    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
                };
                const luminance = (colour: string) => {
                    const [r, g, b] = colour.match(/[\d.]+/g)!.slice(0, 3).map(Number);
                    return (
                        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
                    );
                };
                const out: Record<string, { contrast: number; fill: string }> = {};
                for (const badge of group.shadowRoot.querySelectorAll(".badge")) {
                    const style = getComputedStyle(badge);
                    const fill = style.backgroundColor.match(/[\d.]+/g)!.map(Number);
                    const alpha = fill.length > 3 ? fill[3] : 1;
                    const composited = [0, 1, 2].map((i) =>
                        Math.round(fill[i] * alpha + ground[i] * (1 - alpha)),
                    );
                    const a = luminance(style.color);
                    const b = luminance(`rgb(${composited.join(",")})`);
                    const ratio =
                        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
                    const severity = Array.from(badge.classList).find((name) =>
                        String(name).startsWith("badge-"),
                    ) as string;
                    out[severity] = {
                        contrast: Math.round(ratio * 100) / 100,
                        fill: `rgb(${composited.join(",")})`,
                    };
                }
                return out;
            };

            (window as any).applyPalette = function applyPalette(
                palette: Record<string, string>,
            ) {
                const host = document.querySelector(
                    "helman-config-editor-panel",
                ) as HTMLElement;
                for (const [name, value] of Object.entries(palette)) {
                    host.style.setProperty(name, value);
                }
            };
        },
        { config: CONFIG, gridKey: GRID_KEY, facts: FACTS },
    );

    await expect
        .poll(() =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim() === "Power devices",
                );
                if (!tab) return false;
                tab.click();
                return true;
            }),
        )
        .toBe(true);

    await expect
        .poll(() =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                Array.from(root?.querySelectorAll("details") ?? []).forEach((section) =>
                    section.setAttribute("open", ""),
                );
                return root?.querySelectorAll("helman-entity-group").length ?? 0;
            }),
        )
        .toBeGreaterThan(0);

    await expect
        .poll(
            () =>
                page.evaluate(
                    (key) => Object.keys((window as any).measureBadges(key)).length,
                    GRID_KEY,
                ),
            { timeout: 5000 },
        )
        .toBe(4);
}

for (const [mode, palette] of Object.entries(PALETTES)) {
    test(`every badge severity meets AA on a ${mode} theme`, async ({ page }) => {
        await mountEditor(page);
        await page.evaluate((values) => (window as any).applyPalette(values), palette);

        const measured = await page.evaluate(
            (key) => (window as any).measureBadges(key),
            GRID_KEY,
        );
        // All four, named, so a failure says which severity went under rather
        // than only that one did.
        expect(Object.keys(measured).sort()).toEqual([
            "badge-info",
            "badge-neutral",
            "badge-success",
            "badge-warning",
        ]);
        for (const [severity, result] of Object.entries(measured)) {
            expect(
                (result as { contrast: number }).contrast,
                `${severity} on ${mode}`,
            ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        }
    });

    test(`the severities stay apart from each other on a ${mode} theme`, async ({
        page,
    }) => {
        await mountEditor(page);
        await page.evaluate((values) => (window as any).applyPalette(values), palette);

        const measured = await page.evaluate(
            (key) => (window as any).measureBadges(key),
            GRID_KEY,
        );
        // Legible is not enough: with the hue moved out of the text and into
        // the fill, four identical fills would read as one badge repeated.
        const fills = Object.values(measured).map((r: any) => r.fill);
        expect(new Set(fills).size).toBe(fills.length);
    });
}
