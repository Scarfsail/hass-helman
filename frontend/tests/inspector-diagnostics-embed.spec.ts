import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installFakeHass } from "./support/fake-hass";

/**
 * The solar inspector embedded in the Training tab's solar Diagnostics.
 *
 * The inspector is not compiled into the editor bundle -- it cannot be, see
 * `config-editor/solar-inspector-embed.ts` -- so the embed loads the built card
 * *artifact* at runtime, by the version-stamped URL the backend hands down in the
 * panel config. Everything worth asserting here follows from that choice:
 *
 * - **Module identity.** The browser keys an ES module on its URL. Import the
 *   same URL Lovelace imported and nothing is evaluated twice; import a URL that
 *   differs by so much as its query string and every custom element in the card
 *   bundle is defined a second time (which throws) and every card is pushed into
 *   `window.customCards` again. So the tests load *one* URL, from both sides, and
 *   count evaluations rather than merely checking that nothing looks broken.
 * - **Laziness.** A collapsed `details` renders its content, so the section being
 *   closed does not by itself keep the card out. The load hangs off the `toggle`
 *   event instead, and "closed costs nothing" is a claim about a network request
 *   and a day payload, not about pixels.
 *
 * The page is served over http rather than assembled with `setContent`: a
 * dynamic import of a root-relative URL needs a document with a real base URL.
 */

const EDITOR_BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);
const CARD_BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const ORIGIN = "http://helman.test";
/** The one URL under test, stamp included, exactly as the backend builds it. */
const CARD_MODULE_URL = "/helman_frontend/helman-card.js?v=9.9.9";

/** Every card type the bundle registers with the Lovelace card picker. */
const CARD_TYPES = [
    "helman-card",
    "helman-simple-card",
    "helman-solar-inspector-card",
];

interface Served {
    /** How many times the card artifact has been fetched. */
    cardRequests: () => number;
    /** Hold the card artifact's response until `release` is called. */
    hold: () => void;
    release: () => void;
    /** Answer the card artifact with a 404 instead. */
    fail: () => void;
}

/**
 * Serve a page at `ORIGIN` plus the card artifact at its versioned URL.
 *
 * The request count is the measurement the load-order tests turn on: a second
 * module evaluation means a second fetch of the same URL, which is exactly what
 * the browser's module map is supposed to prevent.
 */
async function serve(page: Page): Promise<Served> {
    const card = readFileSync(CARD_BUNDLE, "utf8");
    let cardRequests = 0;
    let gate: Promise<void> | null = null;
    let open: (() => void) | null = null;
    let failing = false;

    await page.route(`${ORIGIN}/`, (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><html><body></body></html>",
        }),
    );
    await page.route(`${ORIGIN}/helman_frontend/*`, async (route) => {
        cardRequests += 1;
        if (gate) await gate;
        if (failing) {
            await route.fulfill({ status: 404, contentType: "text/plain", body: "gone" });
            return;
        }
        await route.fulfill({ contentType: "text/javascript", body: card });
    });
    await page.goto(`${ORIGIN}/`);

    return {
        cardRequests: () => cardRequests,
        hold: () => {
            gate = new Promise<void>((resolve) => {
                open = resolve;
            });
        },
        release: () => {
            open?.();
            gate = null;
        },
        fail: () => {
            failing = true;
        },
    };
}

/**
 * Mount the editor panel on the Training tab, against the inspector's fake backend.
 *
 * The inspector's own fake `hass` is reused and widened with the handful of
 * commands the editor reads at startup, so the mounted card talks to the same
 * backend every other inspector spec uses -- including its held-open day request,
 * which is how "no day payload was asked for" becomes an assertion.
 */
async function mountEditor(page: Page, options: { cardUrl?: string } = {}): Promise<string[]> {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await installFakeHass(page, { pillDays: 4 });
    await page.addScriptTag({ path: EDITOR_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate((cardUrl) => {
        const hass = window.__fakeHass as Record<string, unknown> & {
            callWS: (msg: { type: string }) => Promise<unknown>;
        };
        const inspectorCallWS = hass.callWS;
        hass.user = { is_admin: true };
        hass.callWS = async (msg: { type: string }) => {
            if (msg.type === "helman/get_config") return { config_version: 6 };
            if (msg.type === "helman/get_optimizer_schema") return { version: 2, kinds: [] };
            if (msg.type === "helman/get_appliances") return { appliances: [] };
            return inspectorCallWS(msg);
        };

        const element = document.createElement("helman-config-editor-panel") as HTMLElement &
            Record<string, unknown>;
        // The panel config Home Assistant passes through from
        // `panel_custom.async_register_panel`; an absent URL is its own case.
        element.panel = cardUrl === null ? { config: {} } : { config: { card_module_url: cardUrl } };
        element.hass = hass;
        document.body.appendChild(element);
    }, options.cardUrl === undefined ? CARD_MODULE_URL : options.cardUrl);

    await page.evaluate(async () => {
        const panel = document.querySelector("helman-config-editor-panel") as HTMLElement &
            { _activeTab: string; requestUpdate: () => void; updateComplete: Promise<unknown> };
        await panel.updateComplete;
        panel._activeTab = "training";
        panel.requestUpdate();
        await panel.updateComplete;
    });
    await page.waitForFunction(() => !!solarDiagnosticsDetails());
    return errors;
}

/**
 * Helpers that walk to the solar Diagnostics panel, installed in the page.
 *
 * In the page rather than in `page.evaluate` closures because every assertion
 * below needs them and the walk is three shadow-less levels of template: the
 * `details` is identified by the diagnostics element it contains, which is the
 * one thing about it that cannot be confused with another job's panel.
 */
declare global {
    function solarDiagnosticsDetails(): HTMLDetailsElement | null;
    function embeddedCard(): (HTMLElement & { _latestHass?: unknown }) | null;
    interface Window {
        __fakeHass: Record<string, unknown>;
        __requestedDates: string[];
    }
}

async function installWalkers(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const root = () =>
            document.querySelector("helman-config-editor-panel")?.shadowRoot ?? null;
        (window as unknown as Record<string, unknown>).solarDiagnosticsDetails = () =>
            root()?.querySelector("helman-solar-bias-diagnostics")?.closest("details") ?? null;
        (window as unknown as Record<string, unknown>).embeddedCard = () =>
            solarDiagnosticsDetails()?.querySelector("helman-solar-inspector-card") ?? null;
    });
}

/** Open or close the solar Diagnostics panel, as a click on its summary does. */
async function setDiagnosticsOpen(page: Page, open: boolean): Promise<void> {
    await page.evaluate((next) => {
        solarDiagnosticsDetails()!.open = next;
    }, open);
}

/** Wait for the embedded card to be mounted and upgraded. */
async function waitForCard(page: Page): Promise<void> {
    await page.waitForFunction(
        () => !!customElements.get("helman-solar-inspector-card") && !!embeddedCard(),
    );
}

/** The inline error text the Diagnostics section is showing, if any. */
function errorText(page: Page): Promise<string | null> {
    return page.evaluate(
        () =>
            solarDiagnosticsDetails()?.querySelector(".message.error")?.textContent?.trim() ??
            null,
    );
}

test.beforeEach(async ({ page }) => {
    await installWalkers(page);
});

test("a collapsed Diagnostics panel loads neither the artifact nor a day", async ({ page }) => {
    const served = await serve(page);
    const errors = await mountEditor(page);

    // The section renders its content while collapsed, so this is the whole
    // claim: the card bundle was never asked for, no card is in the section, and
    // nothing asked the backend for a day.
    expect(served.cardRequests()).toBe(0);
    expect(await page.evaluate(() => !!embeddedCard())).toBe(false);
    expect(await page.evaluate(() => window.__requestedDates)).toEqual([]);

    await setDiagnosticsOpen(page, true);
    await waitForCard(page);

    expect(served.cardRequests()).toBe(1);
    expect(await errorText(page)).toBeNull();
    // Mounted *and* live: the card asked the backend for its day.
    await expect
        .poll(() => page.evaluate(() => window.__requestedDates.length))
        .toBeGreaterThan(0);
    // The wrapper, not the bare inspector: it owns the subtree's hass filtering.
    await page.waitForFunction(
        () => !!embeddedCard()?.shadowRoot?.querySelector("helman-solar-inspector"),
    );
    expect(errors).toEqual([]);
});

/** Load the card artifact the way a dashboard does, before the editor exists. */
async function loadCardArtifact(page: Page): Promise<void> {
    await page.evaluate(async (url) => {
        await new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            script.type = "module";
            script.src = url;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`failed to load ${url}`));
            document.head.appendChild(script);
        });
    }, CARD_MODULE_URL);
}

test("a collapsed panel stays empty even once the artifact is already loaded", async ({ page }) => {
    // The ordinary way into this page: Home Assistant loads every Lovelace
    // resource the first time any dashboard renders, and it is a single-page app
    // -- so by the time the reader reaches Settings the card tag is registered
    // and there is nothing left to load. Laziness cannot key on the tag existing.
    const served = await serve(page);
    await loadCardArtifact(page);
    expect(await page.evaluate(() => !!customElements.get("helman-solar-inspector-card")))
        .toBe(true);

    const errors = await mountEditor(page);

    expect(await page.evaluate(() => !!embeddedCard())).toBe(false);
    expect(await page.evaluate(() => window.__requestedDates)).toEqual([]);

    // And it still mounts on the open, with no second fetch to make.
    await setDiagnosticsOpen(page, true);
    await waitForCard(page);
    expect(served.cardRequests()).toBe(1);
    await expect
        .poll(() => page.evaluate(() => window.__requestedDates.length))
        .toBeGreaterThan(0);
    expect(errors).toEqual([]);
});

test("the artifact Lovelace already loaded is not evaluated again", async ({ page }) => {
    const served = await serve(page);
    // Lovelace's load: the same URL, by `script type=module`, before the editor
    // exists at all.
    await loadCardArtifact(page);
    expect(served.cardRequests()).toBe(1);

    const errors = await mountEditor(page);
    await setDiagnosticsOpen(page, true);
    await waitForCard(page);

    // One fetch, one evaluation: the import found the module already in the map.
    expect(served.cardRequests()).toBe(1);
    // What a second evaluation would look like, both halves of it: a duplicate
    // `define` throwing, and the card-picker entries pushed twice.
    expect(errors).toEqual([]);
    expect(await page.evaluate((types) => types.map((type) =>
        ((window as unknown as { customCards: { type: string }[] }).customCards ?? [])
            .filter((card) => card.type === type).length), CARD_TYPES),
    ).toEqual(CARD_TYPES.map(() => 1));
});

test("opening Diagnostics while the artifact is in flight evaluates it once", async ({ page }) => {
    const served = await serve(page);
    const errors = await mountEditor(page);

    // Lovelace's request is started and then held mid-flight, so the editor's
    // import happens while the module is pending rather than after it settled.
    served.hold();
    const lovelaceLoad = page.evaluate((url) => {
        const script = document.createElement("script");
        script.type = "module";
        script.src = url;
        document.head.appendChild(script);
    }, CARD_MODULE_URL);
    await expect.poll(() => served.cardRequests()).toBe(1);
    await setDiagnosticsOpen(page, true);
    served.release();
    await lovelaceLoad;

    await waitForCard(page);
    expect(served.cardRequests()).toBe(1);
    expect(errors).toEqual([]);
});

test("reopening Diagnostics keeps the card it already built", async ({ page }) => {
    const served = await serve(page);
    await mountEditor(page);
    await setDiagnosticsOpen(page, true);
    await waitForCard(page);

    await page.evaluate(() => {
        (window as unknown as Record<string, unknown>).__firstCard = embeddedCard();
    });
    await setDiagnosticsOpen(page, false);
    await setDiagnosticsOpen(page, true);
    await waitForCard(page);

    // The same node, so the day the reader had paged to is still on screen --
    // and no second fetch of the artifact behind it.
    expect(
        await page.evaluate(
            () => embeddedCard() === (window as unknown as { __firstCard: unknown }).__firstCard,
        ),
    ).toBe(true);
    expect(served.cardRequests()).toBe(1);
    expect(
        await page.evaluate(
            () => solarDiagnosticsDetails()!.querySelectorAll("helman-solar-inspector-card").length,
        ),
    ).toBe(1);
});

test("the mounted card receives later hass values", async ({ page }) => {
    await serve(page);
    await mountEditor(page);
    await setDiagnosticsOpen(page, true);
    await waitForCard(page);

    const received = await page.evaluate(async () => {
        const panel = document.querySelector("helman-config-editor-panel") as HTMLElement &
            { hass: unknown; updateComplete: Promise<unknown> };
        // A fresh object with a different `states` map, as a real Home Assistant
        // hands down: the card's own filter passes that through.
        const next = { ...(window.__fakeHass as Record<string, unknown>), states: {} };
        panel.hass = next;
        await panel.updateComplete;
        return embeddedCard()?._latestHass === next;
    });

    expect(received).toBe(true);
});

test("a failed artifact load says so in the section", async ({ page }) => {
    const served = await serve(page);
    served.fail();
    const errors = await mountEditor(page);

    await setDiagnosticsOpen(page, true);

    await expect.poll(() => errorText(page)).toContain("solar inspector card");
    // Visible, and only visible: a rejected import left to itself would surface
    // as an unhandled rejection and a section that stayed blank forever.
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => !!embeddedCard())).toBe(false);
    expect(served.cardRequests()).toBe(1);
});

test("a panel config without the card URL still explains itself", async ({ page }) => {
    // What YAML-mode Lovelace looks like from here: the backend registered no
    // resource of ours, so it passed no URL, so there is nothing safe to import.
    const served = await serve(page);
    const errors = await mountEditor(page, { cardUrl: null as unknown as string });

    await setDiagnosticsOpen(page, true);

    await expect.poll(() => errorText(page)).toContain("card resource");
    expect(served.cardRequests()).toBe(0);
    expect(errors).toEqual([]);
});
