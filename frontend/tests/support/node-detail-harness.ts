import { expect, type Locator, type Page } from "@playwright/test";
import { installMockHass, type MockReplies, type MockRequest } from "./mock-hass";
import { FIXED_NOW_ISO, installFixedClock } from "./fixed-clock";
import { HA_DIALOG_STUB } from "./ha-dialog-stub";
import { CARD_BUNDLE } from "./card-page";
import { cardTree } from "./payload-builders";
export { treeNode } from "./payload-builders";

/** A section payload, or the literal "error" to reject its read. */
type Reply = unknown;
export interface NodeDetailOptions {
    states: Record<string, unknown>;
    tree?: unknown;
    overviews?: Record<string, Reply>;
    sections?: Record<string, Record<string, Reply>>;
    forecast?: Reply;
    schedule?: unknown;
    timeZone?: string;
    /** Browser-side closures for fixtures whose answers change during a test. */
    replies?: MockReplies;
    hass?: Record<string, any>;
}

export function state(value: string, unit?: string, attributes: Record<string, unknown> = {}, at?: string, changedAt = at) {
    return { state: value, attributes: { ...(unit ? { unit_of_measurement: unit } : {}), ...attributes },
        ...(at ? { last_reported: at, last_updated: changedAt, last_changed: changedAt } : {}) };
}

export function inverterOverview(overrides: Record<string, unknown> = {}) {
    return { node: "inverter", asOf: "2026-10-21T12:00:00+00:00", configured: false, profile: null, mode: null,
        entities: {}, maxAllowedExportPower: 9900,
        agreement: { status: "unknown", reason: "no_profile", commanded: null, observedOption: null, observedFrom: [], registers: [] },
        condition: null, sections: [], ...overrides };
}

declare global {
    interface Window {
        __NodeDetailHass: any;
        __NodeDetailRequests: MockRequest[];
        __configureNodeDetail: (options: NodeDetailOptions) => any;
        __nodeDetailState: typeof state;
        __inverterOverview: typeof inverterOverview;
    }
}

/** Install before browser-side fixture construction, keeping node fixtures in their specs. */
export async function prepareNodeDetailPage(page: Page): Promise<void> {
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await installMockHass(page);
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.addScriptTag({ content: `window.__nodeDetailState = ${state.toString()}; window.__inverterOverview = ${inverterOverview.toString()};` });
    await page.evaluate(() => {
        window.__configureNodeDetail = (options) => {
            window.__NodeDetailRequests = [];
            const unwrap = (reply: unknown) => {
                if (reply === "error") throw new Error("backend down");
                return reply;
            };
            const router = window.__mockHass({
                ...(options.tree ? { "helman/get_device_tree": options.tree } : {}),
                "helman/get_history": { entity_history: {} },
                ...(options.schedule ? { "helman/get_schedule": options.schedule } : {}),
                ...(options.forecast !== undefined ? { "helman/get_forecast": () => unwrap(options.forecast) } : {}),
                "helman/get_node_detail": (request: MockRequest) => {
                    const node = String(request.node);
                    const reply = request.section ? options.sections?.[node]?.[String(request.section)] : options.overviews?.[node];
                    if (reply === undefined) throw new Error(`Missing node-detail fixture: ${node}/${request.section ?? "overview"}`);
                    return unwrap(reply);
                },
                ...options.replies,
            }, (request) => window.__NodeDetailRequests.push({ ...request }));
            const extra = options.hass ?? {};
            window.__NodeDetailHass = {
                language: "en", locale: { language: "en-GB" }, config: { time_zone: options.timeZone ?? "UTC" },
                states: options.states, ...router, ...extra,
                connection: { ...router.connection, ...extra.connection },
            };
            return window.__NodeDetailHass;
        };
    });
}

/** With no options, mount the fixtures configured in the browser by the spec. */
export async function mountSimpleCard(page: Page, options?: NodeDetailOptions, tag = "helman-simple-card"): Promise<void> {
    if (options) {
        await prepareNodeDetailPage(page);
        await page.evaluate((config) => window.__configureNodeDetail(config), { tree: cardTree(), ...options });
    }
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction((name) => !!customElements.get(name), tag);
    await page.evaluate(async (name) => {
        const card = document.createElement(name) as any;
        await card.setConfig({ type: `custom:${name}` });
        card.hass = window.__NodeDetailHass;
        document.body.appendChild(card);
    }, tag);
}

export async function sectionRequestLog(page: Page, node: string, section?: string): Promise<MockRequest[]> {
    return page.evaluate(({ node, section }) => window.__NodeDetailRequests.filter((r) =>
        r.type === "helman/get_node_detail" && r.node === node && r.section && (section === undefined || r.section === section)), { node, section });
}

/**
 * How often each section of `node` was read: a node-detail section by its
 * name, and each of `commands` (a section read through another command) by
 * its type.
 */
export async function sectionReads(page: Page, node: string, commands: string[] = []): Promise<Record<string, number>> {
    return page.evaluate(({ node, commands }) => {
        const counts: Record<string, number> = {};
        for (const r of window.__NodeDetailRequests) {
            const key = r.type === "helman/get_node_detail" && r.node === node && r.section ? String(r.section)
                : commands.includes(r.type) ? r.type : null;
            if (key) counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
    }, { node, commands });
}

/** Hold a real section read while live power updates keep reaching the open dialog. */
export async function holdSection(page: Page, node: string, section: string): Promise<void> {
    await page.evaluate(async ({ node, section }) => {
        const hass = window.__NodeDetailHass;
        const original = hass.callWS;
        const payload = await original({ type: "helman/get_node_detail", node, section, ...(node === "ev_charger" ? { device_id: "garage-ev" } : {}) });
        const pending: Array<(payload: unknown) => void> = [];
        (window as any).__releaseSection = (nextDay = false) => {
            const answer = { ...payload, asOf: "2026-10-22T00:00:09+00:00",
                ...(nextDay ? { period: { start: "2026-10-22T00:00:00+00:00", end: "2026-10-23T00:00:00+00:00" } } : {}) };
            pending.shift()?.(answer);
        };
        hass.callWS = (request: MockRequest) => {
            if (request.type !== "helman/get_node_detail" || request.node !== node || request.section !== section) {
                return original(request).then((answer: any) => {
                    // Other day sections follow the clock, so the test isolates the held section.
                    if (!request.section || !answer?.period) return answer;
                    const day = new Date().toISOString().slice(0, 10);
                    return { ...answer, period: { ...answer.period, start: `${day}T00:00:00Z` } };
                });
            }
            window.__NodeDetailRequests.push({ ...request });
            return new Promise((resolve) => pending.push(resolve));
        };
    }, { node, section });
}

/** Make every later read of a section fail, as while the recorder is down. */
export async function failSection(page: Page, node: string, section: string): Promise<void> {
    await page.evaluate(({ node, section }) => {
        const hass = window.__NodeDetailHass;
        const original = hass.callWS;
        hass.callWS = (request: MockRequest) => {
            if (request.type !== "helman/get_node_detail" || request.node !== node || request.section !== section) return original(request);
            window.__NodeDetailRequests.push({ ...request });
            return Promise.reject(new Error("recorder down"));
        };
    }, { node, section });
}

/**
 * The one keep rule on the section `field` of the open detail: a refresh
 * within the day keeps its figures until the new ones land, a failed refresh
 * keeps them, and a refresh on a new day replaces them.
 */
export async function expectKeepRule(page: Page, selector: string, node: string, section: string, field: string): Promise<void> {
    const content = page.locator(selector);
    const status = () => content.evaluate((element: any, field) => element[field].state?.status, field);
    const reads = async () => (await sectionRequestLog(page, node, section)).length;
    /** Announce a data change and wait for the section's read it brings. */
    const refresh = async () => {
        const before = await reads();
        await page.evaluate(() => window.__fireDataChanged("config"));
        await expect.poll(reads).toBeGreaterThan(before);
    };
    await expect.poll(status).toBe("ready");
    await holdSection(page, node, section);
    await refresh();
    expect(await status()).toBe("ready");
    await page.evaluate(() => (window as any).__releaseSection());
    await failSection(page, node, section);
    await refresh();
    await content.evaluate(async (element: any) => { await element.updateComplete; });
    expect(await status()).toBe("ready");
    // Past midnight the shown figures are yesterday's: the failed read replaces them.
    await page.clock.setFixedTime(new Date("2026-10-22T00:01:00Z"));
    await content.evaluate((element: any) => element.requestUpdate());
    await expect.poll(status).toBe("error");
}

/** Deliver one real hass power tick and wait for the dialog's resulting render. */
export async function powerTick(page: Page, contentSelector: string, second: number): Promise<void> {
    await page.evaluate(async ({ second }) => {
        const hass = window.__NodeDetailHass;
        const states = { ...hass.states, "sensor.house": { state: String(8000 + second), attributes: { unit_of_measurement: "W" } },
            "sensor.ev_power": { ...hass.states["sensor.ev_power"], state: String(6400 + second) } };
        window.__NodeDetailHass = { ...hass, states };
    }, { second });
    await page.locator("helman-simple-card, helman-card").evaluate(async (card: any) => {
        card.hass = { ...window.__NodeDetailHass };
        await card.updateComplete;
    });
    await expect.poll(() => page.locator(contentSelector).evaluate((element: any) => element.hass.states["sensor.house"].state)).toBe(String(8000 + second));
    await page.locator(contentSelector).evaluate(async (element: any) => { await element.updateComplete; });
}

/** Reconnect the detail, returning the state of its section `field` while it was out of the page. */
export async function reconnectDetail(page: Page, selector: string, field: string): Promise<unknown> {
    return page.locator(selector).evaluate((element: any, field) => {
        const parent = element.parentNode!;
        element.remove();
        const state = element[field].state;
        parent.appendChild(element);
        return state;
    }, field);
}

/**
 * The live figures one node shows in three places: the power card's node,
 * its detail's headline and the sum of its detail's gauge, W. `node` names
 * the power card's node; a device has none, so its card figure is `null`.
 */
export async function liveFigures(page: Page, content: string, node: "solar" | "grid" | "house" | "battery" | null): Promise<{ card: number | null; headline: string; gauge: number }> {
    return page.evaluate(({ content, node }) => {
        const deepAll = (root: ParentNode, selector: string, out: Element[] = []): Element[] => {
            for (const element of Array.from(root.querySelectorAll("*"))) {
                if (element.matches(selector)) out.push(element);
                if (element.shadowRoot) deepAll(element.shadowRoot, selector, out);
            }
            return out;
        };
        const card = node ? (deepAll(document, `simple-card-${node}`)[0] as any)?.power ?? null : null;
        const detail = deepAll(document, content)[0].shadowRoot!;
        const headline = deepAll(detail, "helman-detail-headline")[0];
        const gauge = deepAll(detail, "helman-flow-gauge")[0];
        return {
            card,
            headline: (headline?.shadowRoot?.textContent ?? "").replace(/\s+/g, " ").trim(),
            // The parts the gauge draws, none while it is hidden.
            gauge: !gauge || (gauge as HTMLElement).hidden ? 0 : Math.round(((gauge as any)._shown as Array<{ powerW: number }>)
                .reduce((sum, item) => sum + item.powerW, 0)),
        };
    }, { content, node });
}

/** The dashboard a spec's card sits on: a real origin, so a Show more link can navigate within it. */
const DASHBOARD_URL = "http://helman.test/lovelace/energy";

/** Serve the page from the dashboard's URL; call before mounting, whose `setContent` keeps it. */
export async function onDashboard(page: Page): Promise<void> {
    await page.route("http://helman.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
    await page.goto(DASHBOARD_URL);
}

/**
 * Click a Show more link of the open detail and pin what it does: the detail
 * closes, HA's router is told the page is now HA's history of exactly
 * `entities` from 24 hours before now, and Back returns to the dashboard. The
 * page has to be on the dashboard (`onDashboard`).
 */
export async function expectShowMore(page: Page, link: Locator, entities: string[]): Promise<void> {
    await page.locator("node-detail-dialog").evaluate((detail: any) => {
        // HA's dialog closes on its footer's close button; the stub leaves that to the spec.
        detail.shadowRoot.querySelector("[data-dialog='close']").addEventListener("click", () => detail.shadowRoot.querySelector("ha-dialog").close());
        const log: string[] = (window as any).__historyLog = [];
        window.addEventListener("popstate", () => log.push("popstate"));
        window.addEventListener("location-changed", () => log.push(location.pathname + location.search));
    });
    await link.click();
    await expect(page.locator("node-detail-dialog")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__historyLog.length)).toBe(2);
    const [back, changed] = await page.evaluate(() => (window as any).__historyLog as string[]);
    // The dialog's own Back step lands first: navigating before it would have it undo the navigation.
    expect(back).toBe("popstate");
    const url = new URL(changed, DASHBOARD_URL);
    expect(url.pathname).toBe("/history");
    expect(Object.fromEntries(url.searchParams)).toEqual({
        entity_id: entities.join(","),
        start_date: new Date(Date.parse(FIXED_NOW_ISO) - 86_400_000).toISOString(),
    });
    expect(await page.evaluate(() => location.pathname + location.search)).toBe(changed);
    await page.evaluate(() => new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
    }));
    expect(await page.evaluate(() => location.href)).toBe(DASHBOARD_URL);
}
