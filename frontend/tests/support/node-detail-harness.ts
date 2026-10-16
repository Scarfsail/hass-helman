import { expect, type Page } from "@playwright/test";
import { installMockHass, type MockReplies, type MockRequest } from "./mock-hass";
import { installFixedClock } from "./fixed-clock";
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
        agreement: { status: "unknown", reason: "no_profile", commanded: null, observedOption: null, registers: [] },
        condition: null, sections: [], ...overrides };
}

export function flowsSection(node: string, overrides: Record<string, unknown> = {}) {
    return { node, section: "flows", asOf: "2026-10-21T12:00:00+00:00",
        period: { start: "2026-10-21T00:00:00+00:00", end: "2026-10-22T00:00:00+00:00" },
        priceUnit: "CZK/kWh", complete: false, unavailable: null,
        flows: { solarToHouse: 5.1, solarToBattery: 4.2, solarToGrid: 5.8, solarUnresolved: 0.4,
            gridToBattery: 1.5, unknownToBattery: 0.3, gridToBatteryCost: 4.0,
            batteryToHouse: 3.6, gridToHouse: 1.2, unknownToHouse: 0.1, batteryToGrid: 0 }, ...overrides };
}

declare global {
    interface Window {
        __NodeDetailHass: any;
        __NodeDetailRequests: MockRequest[];
        __configureNodeDetail: (options: NodeDetailOptions) => any;
        __nodeDetailState: typeof state;
        __flowsSection: typeof flowsSection;
        __inverterOverview: typeof inverterOverview;
    }
}

/** Install before browser-side fixture construction, keeping node fixtures in their specs. */
export async function prepareNodeDetailPage(page: Page): Promise<void> {
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await installMockHass(page);
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.addScriptTag({ content: `window.__nodeDetailState = ${state.toString()}; window.__flowsSection = ${flowsSection.toString()}; window.__inverterOverview = ${inverterOverview.toString()};` });
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

export const nodeDetailLocators = (node: string) => {
    const content = (page: Page) => page.locator(`node-detail-${node}-content`);
    const question = (page: Page, id: string) => page.locator(`helman-node-question[data-question="${id}"]`);
    const flow = (page: Page) => content(page).locator("helman-node-flow");
    return { content, question, flow,
        header: (page: Page, id: string) => question(page, id).locator("button.header"),
        evidence: (page: Page, id: string) => question(page, id).locator("button.evidence-toggle"),
        tile: (page: Page, id: string) => page.locator(`helman-node-tile[data-question="${id}"]`),
        flowLabel: (page: Page, side: "in" | "out", id: string) => flow(page).locator(`[data-side="${side}"] [data-flow="${id}"]`),
    };
};

export async function sectionRequestLog(page: Page, node: string, section?: string): Promise<MockRequest[]> {
    return page.evaluate(({ node, section }) => window.__NodeDetailRequests.filter((r) =>
        r.type === "helman/get_node_detail" && r.node === node && r.section && (section === undefined || r.section === section)), { node, section });
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

export async function reconnectDetail(page: Page, selector: string, field: string): Promise<unknown> {
    return page.locator(selector).evaluate((element: any, field) => {
        const parent = element.parentNode!;
        element.remove();
        const state = element[field];
        parent.appendChild(element);
        return state;
    }, field);
}
