import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The harness the inspector's aggregate-view specs mount against.
 *
 * Shared rather than duplicated, and shared *here* rather than exported from a
 * spec file: importing one spec from another re-registers its `describe` block
 * in the importer, so every test in it would run twice. A support module
 * carries no tests of its own and can be imported freely.
 *
 * The span answer is generated from the requested window rather than fixed, so
 * a test can assert "one column per day of the month" without hard-coding a
 * month -- which month it is depends on when the suite runs.
 */

export const BUNDLE = resolve(
    __dirname,
    "../../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Toggle stops, narrowest first: three slot widths, then day and month. */
export const STOP_MONTH_VIEW = 3;
export const STOP_YEAR_VIEW = 4;
export const STOP_SLOT_60 = 2;

export async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/**
 * The inspector against a backend that answers both the day read and the span
 * read, recording what each was asked for.
 *
 * The span answer is generated from the requested window rather than fixed, so
 * the test can assert "one column per day of the month" without hard-coding a
 * month — which month it is depends on when the suite runs.
 *
 * `holes` punches two gaps into a day-bucketed span: the fourth bucket keeps
 * only its upper SoC bound, and the fifth has no readings at all. Both are
 * shapes the backend really produces — a battery sensor that started recording
 * mid-day, a day the recorder never saw — and both are drawn by *not* drawing.
 */
export async function mountInspector(
    page: Page,
    holes = false,
    variant: "" | "no-gain" | "over-soc" | "no-energy" = "",
    minDate = "2020-01-01",
    dayMinDate: string | null = null,
): Promise<void> {
    await page.evaluate(([punchHoles, shape, floor, rawDayFloor]: [boolean, string, string, string | null]) => {
        const today = new Date();
        const iso = (date: Date) => date.toISOString().slice(0, 10);
        const date = iso(today);
        // The backend answers the two views with two different floors: the
        // aggregates are bounded by long-term statistics, the day view by the
        // raw states the recorder purges. Same value unless a test says
        // otherwise, so every existing case is unaffected.
        const dayFloor = rawDayFloor ?? floor;

        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const price: Array<{ slot: string; value: number }> = [];
        // Today's own composition, spread flat across the day so that its
        // per-slot parts sum to exactly the figures the span row for today
        // carries. That equality is the point: a day column at D and the whole
        // of that day at 60 are two readings of one measurement, and a test can
        // only hold them to that if the fixture makes them the same.
        const SLOTS_PER_DAY = 96;
        const houseActual: Array<{ timestamp: string; valueWh: number }> = [];
        const houseActualBreakdown: Array<Record<string, unknown>> = [];
        // The day chart resolves a click to the nearest slot the impact series
        // knows, so without these a press in the day view selects nothing at
        // all -- which is not what a bare day payload should mean here.
        const impact: Array<Record<string, unknown>> = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            corrected.push({
                timestamp: `${date}T${hh}:${mm}:00`,
                valueWh: Math.max(0, 400 - Math.abs(m - 720) / 2),
            });
            price.push({ slot: `${hh}:${mm}`, value: 3.5 });
            houseActual.push({
                timestamp: `${date}T${hh}:${mm}:00`,
                valueWh: 18000 / SLOTS_PER_DAY,
            });
            impact.push({
                slot: `${hh}:${mm}`,
                rawWh: null,
                correctedWh: null,
                impactWh: null,
                factor: null,
            });
            houseActualBreakdown.push({
                slot: `${hh}:${mm}`,
                unmeasuredWh: 12000 / SLOTS_PER_DAY,
                appliances: [
                    {
                        entityId: "sensor.washer_energy",
                        label: "Washer",
                        wh: 4000 / SLOTS_PER_DAY,
                        switchEntityId: "switch.washer",
                        powerEntityId: "sensor.washer_power",
                        deferrable: true,
                        controllableId: "washer",
                    },
                    {
                        entityId: "sensor.fridge_energy",
                        label: "Fridge",
                        wh: 2000 / SLOTS_PER_DAY,
                        switchEntityId: null,
                        powerEntityId: null,
                        deferrable: false,
                        controllableId: null,
                    },
                ],
            });
        }

        const dayPayload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            priceUnit: "CZK/kWh",
            range: {
                minDate: dayFloor, maxDate: date, canGoPrevious: true, canGoNext: false,
                isToday: true, isFuture: false,
            },
            series: {
                raw: [], corrected, actual: [], invalidated: [], factors: [], impact,
                houseForecast: [], houseActual,
                houseActualBreakdown, houseForecastBreakdown: [],
                batterySocForecast: [], batterySocActual: [],
                gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
                importPrice: price, exportPrice: [],
            },
            totals: {
                rawWh: null, correctedWh: null, actualWh: null,
                houseForecastWh: null, houseActualWh: null,
                gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false, hasCorrectedForecast: true, hasActuals: false,
                hasInvalidated: false, hasProfile: true, hasHouseForecast: false,
                hasHouseActual: true, hasHouseActualBreakdown: true,
                hasBatterySocForecast: false, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            batterySocBounds: [],
            trainingExplainability: null,
        };

        (window as any).__spanRequests = [];
        (window as any).__dayRequests = [];

        /** Every bucket of the requested window, with plausible numbers. */
        const spanDays = (start: string, end: string, bucket: string, withBreakdown: boolean) => {
            const rows: Array<Record<string, unknown>> = [];
            const cursor = new Date(`${start}T00:00:00Z`);
            const last = new Date(`${end}T00:00:00Z`);
            let index = 0;
            while (cursor <= last) {
                const halfKnown = punchHoles && bucket !== "month" && index === 3;
                const missing = punchHoles && bucket !== "month" && index === 4;
                // An export price entity with no statistics: every bucket is
                // priced on the import side and on neither other.
                const noGain = shape === "no-gain";
                // A BMS that rounds past the top of its own scale, and the same
                // bucket's neighbour sitting exactly on it.
                const overSoc = shape === "over-soc";
                // Energy meters with no statistics at all, SoC and money intact.
                const noEnergy = shape === "no-energy";
                rows.push({
                    date: iso(cursor),
                    solarWh: missing || noEnergy ? null : 20000 + index * 500,
                    gridImportKwh: missing || noEnergy ? null : 4,
                    gridExportKwh: missing || noEnergy ? null : 6,
                    batteryMinSocPct: halfKnown || missing ? null : 20,
                    batteryMaxSocPct: missing
                        ? null
                        : overSoc ? (index === 0 ? 100.4 : 100) : 90,
                    houseWh: missing || noEnergy ? null : 18000,
                    batteryChargeWh: missing || noEnergy ? null : 7000,
                    batteryDischargeWh: missing || noEnergy ? null : 6000,
                    moneyCost: missing ? null : 40,
                    moneyGain: missing || noGain ? null : 12,
                    // What the house was doing that bucket, in the shape the day
                    // slot's breakdown has. The three parts add up to houseWh,
                    // which is what lets a bucket panel be compared against the
                    // same day's slots at 60. Absent where the house meter
                    // reported nothing -- there is no total to split there.
                    houseBreakdown: !withBreakdown || missing || noEnergy ? null : {
                        unmeasuredWh: 12000,
                        appliances: [
                            {
                                entityId: "sensor.washer_energy",
                                label: "Washer",
                                wh: 4000,
                                switchEntityId: "switch.washer",
                                powerEntityId: "sensor.washer_power",
                                deferrable: true,
                                controllableId: "washer",
                            },
                            {
                                entityId: "sensor.fridge_energy",
                                label: "Fridge",
                                wh: 2000,
                                switchEntityId: null,
                                powerEntityId: null,
                                deferrable: false,
                                controllableId: null,
                            },
                        ],
                    },
                });
                index += 1;
                if (bucket === "month") {
                    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
                } else {
                    cursor.setUTCDate(cursor.getUTCDate() + 1);
                }
            }
            return rows;
        };

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 30;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (msg: any) => {
                if (msg.type === "helman/solar_bias/day_aggregates") {
                    (window as any).__spanRequests.push(msg);
                    return {
                        bucket: msg.bucket ?? "day",
                        currency: "CZK",
                        days: spanDays(
                            msg.start_date,
                            msg.end_date,
                            msg.bucket ?? "day",
                            // The composition is served only to a caller that
                            // asked, as the backend serves it -- so a card that
                            // stopped asking would lose the panel here too.
                            msg.house_breakdown === true,
                        ),
                        // The span payload carries its own bounds, which is
                        // what lets the aggregate views navigate without a day
                        // load having happened first -- and what keeps the day
                        // view's shallower floor out of their way.
                        range: { minDate: floor, maxDate: date },
                    };
                }
                if (msg.type === "helman/solar_bias/inspector") {
                    (window as any).__dayRequests.push(msg.date);
                    return { ...dayPayload, date: msg.date };
                }
                return {};
            },
        };
        document.body.appendChild(el);
    }, [holes, variant, minDate, dayMinDate] as [boolean, string, string, string | null]);

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
}

export async function clickStop(page: Page, index: number): Promise<void> {
    await page.evaluate((i) => {
        const buttons = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelectorAll(".slot-size-toggle .slot-size-button");
        (buttons[i] as HTMLElement).click();
    }, index);
}

/** The aggregate chart's per-bucket hit rects, in order. */
export async function columns(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        if (!chart?.shadowRoot) return [];
        return [...chart.shadowRoot.querySelectorAll(".bucket-column")]
            .map((rect: Element) => rect.getAttribute("data-bucket") || "");
    });
}

/**
 * Press the picker's "more" toggle: the one control that opens and closes the
 * span rows and the month of day pills together.
 */
export async function toggleMore(page: Page): Promise<void> {
    await page.evaluate(() => {
        const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
        (root.querySelector(".nav-more") as HTMLElement).click();
        return (document.querySelector("helman-solar-inspector") as any).updateComplete;
    });
}

/** Whether the picker is expanded, as the toggle reports it. */
export async function isExpanded(page: Page): Promise<boolean> {
    return page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector(".nav-more")?.getAttribute("aria-expanded") === "true");
}

/** The day pills on screen: their dates, in the order the row draws them. */
export async function dayPillDates(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills")?.shadowRoot;
        if (!root) return [];
        return [...root.querySelectorAll(".pill")]
            .map((pill: Element) => pill.getAttribute("data-day") ?? "");
    });
}

/** Click the day pill carrying the given date. */
export async function clickDayPill(page: Page, day: string): Promise<void> {
    await page.evaluate((wanted) => {
        const root = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills").shadowRoot;
        (root.querySelector(`.pill[data-day="${wanted}"]`) as HTMLElement).click();
    }, day);
}

/** One pill to press, named by the row it is in and the span it carries. */
interface SpanPillRef {
    row: "years" | "months";
    key: string;
}

/**
 * The presses that step the span picker one span back, in order.
 *
 * There are no arrows any more: travel is the year row and the month row, so a
 * step back is whichever pill sits before the selected one. In the year view
 * that is one press on the previous year. In the month view it is one press on
 * the previous month -- except across January, where it is two: the rows split
 * a span into two independent choices, and picking a year keeps the month it
 * already had, so reaching the previous December means moving the year and then
 * the month. Empty when the rows offer nothing further back, which is the
 * answer the disabled arrow used to give.
 */
async function previousSpanPresses(page: Page): Promise<SpanPillRef[]> {
    const selected = await selectedSpan(page);
    const match = /^(\d{4})-(\d{2})-01$/.exec(selected);
    if (match === null) {
        return [];
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    // Only the month view lights a month pill, and `selectedSpan` prefers it, so
    // a lit month row is what tells the two views apart here.
    const inMonthView = await page.evaluate(() => !!(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector("helman-solar-span-pills")
        ?.shadowRoot?.querySelector(".pill-row.months .pill.selected"));

    const presses: SpanPillRef[] = inMonthView
        ? (month > 1
            ? [{ row: "months", key: `${year}-${String(month - 1).padStart(2, "0")}-01` }]
            : [{ row: "years", key: `${year - 1}-01-01` }, { row: "months", key: `${year - 1}-12-01` }])
        : [{ row: "years", key: `${year - 1}-01-01` }];

    // Only the first press can be checked up front -- the later ones are in a
    // row that has not been rendered yet -- and it is the one that decides
    // whether the step is on offer at all.
    return (await pillIsTakeable(page, presses[0])) ? presses : [];
}

/** Whether a span pill is on screen and not disabled. */
async function pillIsTakeable(page: Page, ref: SpanPillRef): Promise<boolean> {
    return page.evaluate(({ row, key }) => {
        const pill = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills")
            ?.shadowRoot?.querySelector(`.pill-row.${row} .pill[data-span="${key}"]`) as
            HTMLButtonElement | null;
        return !!pill && !pill.disabled;
    }, ref);
}

/**
 * Press one span pill, named by its row and the span it carries.
 *
 * Awaits the element rather than the page, because a press re-renders the row
 * the next one is in: a caller pressing twice has to have the first render
 * before it can find the second pill.
 */
export async function clickSpanPill(
    page: Page,
    row: "years" | "months",
    key: string,
): Promise<void> {
    await page.evaluate(({ row, key }) => {
        const host = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        (host.shadowRoot.querySelector(
            `.pill-row.${row} .pill[data-span="${key}"]`,
        ) as HTMLElement | null)?.click();
        return host.updateComplete;
    }, { row, key });
}

/** Step the span picker one span back, however many presses that takes. */
export async function pageBack(page: Page): Promise<void> {
    for (const ref of await previousSpanPresses(page)) {
        await clickSpanPill(page, ref.row, ref.key);
    }
}

/** The spans one row of the picker is offering, and whether each is takeable. */
export async function spanPillRow(
    page: Page,
    row: "years" | "months",
): Promise<Array<{ key: string; disabled: boolean }>> {
    return page.evaluate((wanted) => {
        const host = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        if (!host?.shadowRoot) return [];
        return [...host.shadowRoot.querySelectorAll(`.pill-row.${wanted} .pill`)]
            .map((pill: Element) => ({
                key: pill.getAttribute("data-span") ?? "",
                disabled: (pill as HTMLButtonElement).disabled,
            }));
    }, row);
}

/** Fire a pointer enter/leave on one span pill, as the correlation sees it. */
export async function hoverSpanPill(
    page: Page,
    row: "years" | "months",
    key: string | null,
): Promise<void> {
    await page.evaluate(({ row, key }) => {
        const host = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        // One event, on one pill. Sweeping the row and sending `mouseleave` to
        // every other pill would land after the `mouseenter` for any pill that
        // is not last, and the leave would clear the hover the enter just set.
        const pills = [...host.shadowRoot.querySelectorAll(`.pill-row.${row} .pill`)];
        if (key === null) {
            for (const pill of pills) {
                pill.dispatchEvent(new MouseEvent("mouseleave"));
            }
        } else {
            pills.find((pill: Element) => pill.getAttribute("data-span") === key)
                ?.dispatchEvent(new MouseEvent("mouseenter"));
        }
        return (document.querySelector("helman-solar-inspector") as any).updateComplete;
    }, { row, key });
}

/** The span pills in one row carrying the given class, by span key. */
export async function spanPillsWithClass(
    page: Page,
    row: "years" | "months",
    cls: string,
): Promise<string[]> {
    return page.evaluate(({ row, cls }) => {
        const host = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        if (!host?.shadowRoot) return [];
        return [...host.shadowRoot.querySelectorAll(`.pill-row.${row} .pill`)]
            .filter((pill: Element) => pill.classList.contains(cls))
            .map((pill: Element) => pill.getAttribute("data-span") ?? "");
    }, { row, cls });
}

/** The day pills that cannot be clicked, by date. */
export async function unreachableDayPills(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills")?.shadowRoot;
        if (!root) return [];
        return [...root.querySelectorAll(".pill")]
            .filter((pill: Element) => (pill as HTMLButtonElement).disabled)
            .map((pill: Element) => pill.getAttribute("data-day") ?? "");
    });
}

/** Whether the span picker is offering anywhere further back. */
export async function canPageBack(page: Page): Promise<boolean> {
    return (await previousSpanPresses(page)).length > 0;
}

/**
 * The `start_date` of every span asked for with the given bucket, in order.
 *
 * The bucket is the filter because the day pills share this endpoint: they ask
 * for `"day"` over their own seven-day window whatever view is on screen, and
 * those requests are not what a test about span navigation is looking at.
 */
export async function spanStarts(page: Page, bucket: "day" | "month"): Promise<string[]> {
    return page.evaluate((want) =>
        ((window as any).__spanRequests as Array<{ start_date: string; bucket: string }>)
            .filter((msg) => msg.bucket === want)
            .map((msg) => msg.start_date), bucket);
}

/**
 * The span on screen, as the lit pill's key: "2026-08-01" or "2024-01-01".
 *
 * The words that used to head the aggregate views are gone — the pill row names
 * the span and every neighbour with it — so this reads the selection rather
 * than a label. The key is what the card navigates by anyway, and unlike a
 * localized month name it says the same thing under every locale.
 */
export async function selectedSpan(page: Page): Promise<string> {
    return page.evaluate(() => {
        const root = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills")?.shadowRoot;
        // Both rows light up in the month view -- the year *and* the month
        // inside it -- so the month is the narrower answer and the one that
        // says which span is really on screen. The year view lights no month,
        // and there the year is the whole answer.
        const pill = root?.querySelector(".pill-row.months .pill.selected")
            ?? root?.querySelector(".pill-row.years .pill.selected");
        return pill?.getAttribute("data-span") ?? "";
    });
}

/** Step back, and wait for the row to say the view really moved. */
export async function pageBackAndWait(page: Page): Promise<void> {
    const before = await selectedSpan(page);
    await pageBack(page);
    await page.waitForFunction((previous) => {
        const pills = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        const key = pills?.shadowRoot?.querySelector(".pill.selected")
            ?.getAttribute("data-span") ?? "";
        return key !== previous;
    }, before);
}

export async function waitForDayChart(page: Page): Promise<void> {
    await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector(".chart-wrap svg"));
}

export async function waitForAggregateChart(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        return !!chart?.shadowRoot?.querySelector(".bucket-column");
    });
}

/** The vertex count of each path matching `selector`, in document order. */
export async function bandRuns(page: Page, selector: string): Promise<number[]> {
    return page.evaluate((sel) => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        return [...chart.shadowRoot.querySelectorAll(sel)]
            .map((path: Element) => (path.getAttribute("d") || "").match(/[ML]/g)?.length ?? 0);
    }, selector);
}

/** One metrics panel's tiles, as label to value. */
export async function sectionMetrics(page: Page, index: number): Promise<Record<string, string>> {
    return page.evaluate((i) => {
        const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
        const section = root.querySelectorAll(".metrics-section")[i];
        const out: Record<string, string> = {};
        for (const card of section.querySelectorAll(".metric-card")) {
            const label = card.querySelector(".metric-label")?.textContent?.trim() ?? "";
            out[label] = card.querySelector(".metric-value")?.textContent?.trim() ?? "";
        }
        return out;
    }, index);
}

/**
 * Move the pointer onto one aggregate column.
 *
 * `mousemove` rather than `mouseenter`, because that is what the chart listens
 * for -- its popup follows the cursor within a column as well as between them.
 */
export async function hoverColumn(page: Page, index: number): Promise<void> {
    await page.evaluate((i) => {
        const host = (document.querySelector("helman-solar-inspector") as any);
        (host.shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelectorAll(".bucket-column")[i] as SVGElement)
            .dispatchEvent(new MouseEvent("mousemove", {
                bubbles: true,
                composed: true,
                clientX: 10,
                clientY: 10,
            }));
        return host.updateComplete;
    }, index);
}

/** Move the pointer onto one day pill, or off it when `day` is null. */
export async function hoverDayPill(page: Page, day: string | null): Promise<void> {
    await page.evaluate((wanted) => {
        const host = (document.querySelector("helman-solar-inspector") as any);
        const root = host.shadowRoot.querySelector("helman-solar-day-pills").shadowRoot;
        const selector = wanted === null ? ".pill" : `.pill[data-day="${wanted}"]`;
        (root.querySelector(selector) as HTMLElement)
            .dispatchEvent(new MouseEvent(wanted === null ? "mouseleave" : "mouseenter", {
                bubbles: true,
                composed: true,
            }));
        return host.updateComplete;
    }, day);
}

/** The days whose pill carries the given class, in row order. */
export async function dayPillsWithClass(page: Page, cls: string): Promise<string[]> {
    return page.evaluate((wanted) => {
        const root = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills")?.shadowRoot;
        if (!root) return [];
        return [...root.querySelectorAll(`.pill.${wanted}`)]
            .map((pill: Element) => pill.getAttribute("data-day") ?? "");
    }, cls);
}

/**
 * The buckets whose column tint carries the given class, in chart order.
 *
 * Deduped, because a bucket gets one tint rect per hit row -- the SoC row and
 * the money row each carry the pointer as well as the chart does -- and a test
 * about *which* bucket is lit should not have to know how many rows there are.
 */
export async function columnsWithClass(page: Page, cls: string): Promise<string[]> {
    return page.evaluate((wanted) => {
        const root = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart")?.shadowRoot;
        if (!root) return [];
        return [...new Set([...root.querySelectorAll(`.bucket-tint.${wanted}`)]
            .map((rect: Element) => rect.getAttribute("data-bucket") ?? ""))];
    }, cls);
}

/** The modifier keys a column click carries, as the selection reads them. */
export interface ClickModifiers {
    ctrlKey?: boolean;
    shiftKey?: boolean;
}

/**
 * Click a column and wait only for the card to re-render.
 *
 * The difference from `selectColumn` is what is *not* waited for: a click that
 * empties the selection opens no panel at all, and a test about the selection
 * itself must not require one.
 */
export async function clickColumn(
    page: Page,
    index: number,
    modifiers: ClickModifiers = {},
): Promise<void> {
    await page.evaluate(({ i, mods }) => {
        const host = (document.querySelector("helman-solar-inspector") as any);
        (host.shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelectorAll(".bucket-column")[i] as SVGElement)
            .dispatchEvent(new MouseEvent("click", {
                bubbles: true,
                composed: true,
                ctrlKey: mods.ctrlKey === true,
                shiftKey: mods.shiftKey === true,
            }));
        return host.updateComplete;
    }, { i: index, mods: modifiers });
}

/**
 * Where an element inside the card's shadow trees is, in page coordinates.
 *
 * `walk` is handed the inspector's shadow root and returns the node to measure,
 * so a caller can cross as many shadow boundaries as its target sits behind.
 */
async function centreOf(
    page: Page,
    walk: string,
): Promise<{ x: number; y: number }> {
    return page.evaluate((source) => {
        const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
        const node = (new Function("root", `return (${source})(root);`))(root) as Element;
        const box = node.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, walk);
}

/**
 * Double-click where an element is, with a real pointer.
 *
 * Deliberately *not* a synthesised `dblclick` on the node. The gesture is three
 * events the browser decides to emit -- two clicks and then the double -- and
 * it only emits the third if the same element is still under the pointer after
 * the first two. A re-render that replaces the node, or a row that scrolls the
 * pill out from under the cursor, breaks the drill for a reader while leaving a
 * dispatched event passing happily. Driving the mouse is what makes these tests
 * about the gesture rather than about the handler.
 *
 * The box is measured immediately before the press for the same reason: the
 * card re-renders as the tests set the view up, and a stale coordinate would
 * aim at wherever the target used to be.
 */
async function dblClickAt(
    page: Page,
    walk: string,
    modifiers: ClickModifiers = {},
): Promise<void> {
    const keys: string[] = [];
    if (modifiers.ctrlKey === true) keys.push("Control");
    if (modifiers.shiftKey === true) keys.push("Shift");

    const { x, y } = await centreOf(page, walk);
    for (const key of keys) await page.keyboard.down(key);
    await page.mouse.dblclick(x, y);
    for (const key of keys.reverse()) await page.keyboard.up(key);

    await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any).updateComplete);
}

/** Double-click the chart column at `index`. */
export async function dblClickColumn(
    page: Page,
    index: number,
    modifiers: ClickModifiers = {},
): Promise<void> {
    await dblClickAt(
        page,
        `(root) => root.querySelector("helman-solar-aggregate-chart")`
        + `.shadowRoot.querySelectorAll(".bucket-column")[${index}]`,
        modifiers,
    );
}

/** Double-click a span pill: at M the month row is the chart's columns. */
export async function dblClickSpanPill(
    page: Page,
    row: "years" | "months",
    key: string,
): Promise<void> {
    await dblClickAt(
        page,
        `(root) => root.querySelector("helman-solar-span-pills")`
        + `.shadowRoot.querySelector('.pill-row.${row} .pill[data-span="${key}"]')`,
    );
}

/** Double-click a day pill: at D the day row is the chart's columns. */
export async function dblClickDayPill(page: Page, day: string): Promise<void> {
    await dblClickAt(
        page,
        `(root) => root.querySelector("helman-solar-day-pills")`
        + `.shadowRoot.querySelector('.pill[data-day="${day}"]')`,
    );
}

/** The width toggle's stops, grouped as it draws them. */
export async function stopGroups(page: Page): Promise<string[][]> {
    return page.evaluate(() => {
        const toggle = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".slot-size-toggle");
        return [...toggle.querySelectorAll(".stop-group")].map((group: Element) =>
            [...group.querySelectorAll(".slot-size-button")]
                .map((button: Element) => button.textContent?.trim() ?? ""));
    });
}

/** The labels of the stops currently pressed. */
export async function activeStops(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        [...(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelectorAll(".slot-size-toggle .slot-size-button.active")]
            .map((button: Element) => button.textContent?.trim() ?? ""));
}

/**
 * Click the chart outside every column: the axis gutter.
 *
 * Dispatched on the `<svg>` itself, which is what a press in the left margin
 * really lands on -- the hit rects start at the plot's left edge.
 */
export async function clickGutter(page: Page): Promise<void> {
    await page.evaluate(() => {
        const host = (document.querySelector("helman-solar-inspector") as any);
        (host.shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelector("svg.aggregate-chart") as SVGElement)
            .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        return host.updateComplete;
    });
}

/**
 * Click the label strip under a column: inside the plot's x-range, below every
 * hit rect. Not the gutter, so it must leave the selection alone.
 */
export async function clickUnderColumn(page: Page, index: number): Promise<void> {
    await page.evaluate((i) => {
        const host = (document.querySelector("helman-solar-inspector") as any);
        const chart = host.shadowRoot.querySelector("helman-solar-aggregate-chart");
        const svg = chart.shadowRoot.querySelector("svg.aggregate-chart") as SVGSVGElement;
        const column = chart.shadowRoot.querySelectorAll(".bucket-column")[i] as SVGElement;
        const box = column.getBoundingClientRect();
        const svgBox = svg.getBoundingClientRect();
        svg.dispatchEvent(new MouseEvent("click", {
            bubbles: true,
            composed: true,
            clientX: box.left + box.width / 2,
            clientY: svgBox.bottom - 2,
        }));
        return host.updateComplete;
    }, index);
}

/** The selected buckets, as the chart's own columns report them. */
export async function selectedColumns(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        if (!chart?.shadowRoot) return [];
        return [...chart.shadowRoot.querySelectorAll(".bucket-column.selected")]
            .map((rect: Element) => rect.getAttribute("data-bucket") ?? "");
    });
}

/** Click a column, and wait for the selection panel it opens. */
export async function selectColumn(
    page: Page,
    index: number,
    modifiers: ClickModifiers = {},
): Promise<void> {
    await clickColumn(page, index, modifiers);
    await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector(".selection-section"));
}

/* ---------------------------------------------------------------------------
 * The house-composition panel
 *
 * Read through the power card's own shadow roots, as `house-breakdown.spec.ts`
 * reads it in the day view -- the same panel, so the same route to it.
 * ------------------------------------------------------------------------- */

/** The panel's two group rows: base and shiftable, as it lists them shut. */
export async function breakdownGroups(
    page: Page,
): Promise<Array<{ label: string; power: string; collapsed: boolean }>> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const container = el.shadowRoot
            .querySelector(".house-breakdown")
            ?.querySelector("power-devices-container");
        const groups = [...(container?.shadowRoot?.querySelectorAll("power-device") ?? [])];
        return groups.map((group: any) => {
            const content = group.shadowRoot.querySelector(".deviceContent");
            const name = (content.querySelector(".deviceName")?.textContent ?? "").trim();
            const display = content.querySelector("power-device-power-display");
            return {
                label: name.replace(/[\u25ba\u25bc]\s*$/, "").trim(),
                power: (display?.shadowRoot?.querySelector(".powerValue")?.textContent ?? "")
                    .replace(/\s+/g, " ")
                    .trim(),
                collapsed: name.endsWith("\u25ba"),
            };
        });
    });
}

/** Open every group that is shut, since a shut one renders no children. */
export async function expandBreakdownGroups(page: Page): Promise<void> {
    const groups = await breakdownGroups(page);
    for (const [index, group] of groups.entries()) {
        if (!group.collapsed) continue;
        await page.evaluate((i) => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const container = el.shadowRoot
                .querySelector(".house-breakdown")
                .querySelector("power-devices-container");
            const group = container.shadowRoot.querySelectorAll("power-device")[i] as any;
            (group.shadowRoot.querySelector(".deviceName") as HTMLElement).click();
            return el.updateComplete;
        }, index);
    }
}

/** Every consumer box in the panel: its label, its figure, and its bar count. */
export async function breakdownBoxes(
    page: Page,
): Promise<Array<{ label: string; power: string; bars: number }>> {
    await expandBreakdownGroups(page);
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const container = el.shadowRoot
            .querySelector(".house-breakdown")
            ?.querySelector("power-devices-container");
        const groups = [...(container?.shadowRoot?.querySelectorAll("power-device") ?? [])];
        const devices = groups.flatMap((group: any) => [
            ...(group.shadowRoot
                ?.querySelector("power-devices-container")
                ?.shadowRoot?.querySelectorAll("power-device") ?? []),
        ]);
        return devices.map((device: any) => {
            const content = device.shadowRoot.querySelector(".deviceContent");
            const display = content.querySelector("power-device-power-display");
            const bars = content.querySelector("helman-power-history-bars") as any;
            return {
                label: (content.querySelector(".deviceName")?.textContent ?? "").trim(),
                power: (display?.shadowRoot?.querySelector(".powerValue")?.textContent ?? "")
                    .replace(/\s+/g, " ")
                    .trim(),
                // One bar per selected bucket in an aggregate view, one per
                // native sample in the day view. Counted off the values the
                // element was handed rather than off its paths, since a zero
                // bar paints nothing.
                bars: (bars?.historyToRender ?? []).length,
            };
        });
    });
}

/** Whether the panel is on screen at all. */
export async function hasBreakdownPanel(page: Page): Promise<boolean> {
    return page.evaluate(() => !!(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector(".house-breakdown"));
}

/**
 * Select a run of day-view slots by pointer, the way a reader does.
 *
 * The day chart has no per-slot hit rects to dispatch on -- it reads the
 * pointer's x against its own layout -- so the click has to land on a real
 * coordinate, computed from the layout the card exposes for its strips.
 */
export async function selectDaySlots(
    page: Page,
    fromMinutes: number,
    toMinutes: number | null,
    widthMinutes = 60,
): Promise<void> {
    const geom = await page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const svg = el.shadowRoot.querySelector(".chart-wrap svg") as SVGSVGElement;
        const r = svg.getBoundingClientRect();
        const layout = el._lastLayoutForStrip;
        return {
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            viewWidth: layout.width,
            marginLeft: layout.margin.left,
            plotWidth: layout.plotWidth,
            dayStartMinutes: layout.dayStartMinutes,
            dayEndMinutes: layout.dayEndMinutes,
        };
    });
    const point = (minutes: number) => {
        const span = geom.dayEndMinutes - geom.dayStartMinutes;
        const viewX = geom.marginLeft
            + ((minutes + widthMinutes / 2 - geom.dayStartMinutes) / span) * geom.plotWidth;
        return {
            x: geom.rect.left + (viewX / geom.viewWidth) * geom.rect.width,
            y: geom.rect.top + geom.rect.height / 2,
        };
    };
    const first = point(fromMinutes);
    await page.mouse.click(first.x, first.y);
    if (toMinutes === null) return;
    const last = point(toMinutes);
    await page.keyboard.down("Shift");
    await page.mouse.click(last.x, last.y);
    await page.keyboard.up("Shift");
    await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any).updateComplete);
}
