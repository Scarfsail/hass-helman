import { configDoc } from "./support/payload-builders";
import { test, expect, type Page } from "@playwright/test";
import { EDITOR_BUNDLE, loadBundle } from "./support/card-page";
import { FIXED_NOW_ISO, installFixedClock } from "./support/fixed-clock";

/**
 * The Training tab's per-job status panels (issue #305).
 *
 * Everything on screen is read from a fake `helman/training/status`: the
 * fixture below picks each job's normalized `health` and facts, and every
 * assertion traces a treatment back to them. `helman/training/train_now` is
 * faked too, recording what each button sent and answering with whatever the
 * test put in `window.__trainNow`. The solar job's diagnostics ride its
 * `details`: there is no second request for them.
 */

const HOUSE_TRAINED_AT = "2026-09-12T03:00:00+00:00";
const HOUSE_ATTEMPT_AT = "2026-09-19T03:01:00+00:00";

const CONFIG = configDoc({

    energy_nodes: {
        house: { forecast: { total_energy_entity_id: "sensor.house_energy" } },
    },
    devices: { consumers: [
        {
            id: "dishwasher",
            name: "Dishwasher",
            schedulable: true,
            consumption: {
                energy_entity_id: "sensor.dishwasher_energy",
                projection: { strategy: "history_average", lookback_days: 21 },
            },
        },
        {
            id: "boiler",
            name: "Boiler",
            consumption: {
                energy_entity_id: "sensor.boiler_energy",
                projection: { strategy: "fixed", hourly_energy_kwh: 2 },
            },
        },
        {
            id: "fridge",
            name: "Fridge",
            consumption: { energy_entity_id: "sensor.fridge_energy" },
        },
    ] },
    training: {},
});

type Job = Record<string, unknown>;

const SOLAR_DETAILS = {
    minHistoryDays: 10,
    usableDays: 7,
    omittedSlotCount: 3,
    invalidatedSlotCount: 2,
    factorSummary: { min: 0.8, median: 1, max: 1.2 },
    effectiveVariant: "raw",
    fallbackReason: "insufficient_history",
};

function job(id: string, overrides: Job = {}): Job {
    return {
        id,
        ...(id === "solar_bias" ? { details: SOLAR_DETAILS } : {}),
        enabled: true,
        health: "ok",
        lastOutcome: id === "appliance_energy" ? "estimates_trained" : "profile_trained",
        errorReason: null,
        trainedAt: "2026-09-19T03:00:00+00:00",
        lastAttemptAt: "2026-09-19T03:00:00+00:00",
        artifactInUse: true,
        usingOlderArtifact: false,
        isStale: false,
        issues: [],
        ...overrides,
    };
}

function status(
    jobs: Partial<Record<"solar_bias" | "house_consumption" | "appliance_energy", Job>> = {},
    batch: Record<string, unknown> = {},
): Record<string, unknown> {
    const list = (["solar_bias", "house_consumption", "appliance_energy"] as const).map((id) =>
        job(id, jobs[id]),
    );
    return {
        trainingTime: "03:00",
        nextScheduledTrainingAt: "2026-09-20T03:00:00+00:00",
        isRunning: false,
        currentJob: null,
        anyFailed: list.some((entry) => entry.health === "failed"),
        jobs: list,
        ...batch,
    };
}

async function mountEditor(
    page: Page,
    trainingStatus: unknown,
    options: { fakeTimers?: boolean } = {},
): Promise<void> {
    if (options.fakeTimers) {
        await installFixedClock(page, { timers: true });
        // Pause before mounting so setup time cannot consume the poll interval.
        await page.clock.pauseAt(new Date(Date.parse(FIXED_NOW_ISO) + 1_000));
    }
    await loadBundle(page, "helman-config-editor-panel", EDITOR_BUNDLE);

    await page.evaluate(
        ({ config, trainingStatus }) => {
            const w = window as any;
            w.__trainingStatus = trainingStatus;
            w.__trainRequests = [];
            w.__trainNow = { result: { outcomes: {}, status: trainingStatus } };
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: window.__mockHass().connection,
                callWS: window.__mockHass({
                    "helman/get_config": async (request: any) => {
                        return JSON.parse(JSON.stringify(config));
                    },
                    "helman/training/status": async (request: any) => {
                        return JSON.parse(JSON.stringify(w.__trainingStatus));
                    },
                    "helman/training/train_now": async (request: any) => {
                        w.__trainRequests.push(JSON.parse(JSON.stringify(request)));
                        if (w.__trainNow.pending) await w.__trainNow.pending;
                        if (w.__trainNow.error)
                            throw w.__trainNow.error;
                        return JSON.parse(JSON.stringify(w.__trainNow.result));
                    },
                }).callWS,
            };
            document.body.appendChild(element);
        },
        { config: JSON.parse(JSON.stringify(CONFIG)), trainingStatus },
    );

    // The editor renders its tab bar once the config has loaded.
    await expect(page.locator(".tabs button").first()).toBeVisible();
}

async function openTrainingTab(page: Page): Promise<void> {
    await page.locator(".tabs button", { hasText: "Training" }).click();
    await expect(page.locator("helman-training-job-status")).toHaveCount(3);
    // The tab's panels start collapsed; open them so their buttons are usable.
    await page.locator("details.section-card").evaluateAll((sections) =>
        sections.forEach((details) => ((details as HTMLDetailsElement).open = true)),
    );
}

/** A job panel's rendered content, inside its shadow root. */
function panel(page: Page, id: string) {
    return page.locator(`helman-training-job-status[data-job="${id}"] .container`);
}

/** A job's parent panel on the tab (#313), holding its status element. */
function jobSection(page: Page, id: string) {
    return page.locator("details.section-card", {
        has: page.locator(`:scope > .section-content > helman-training-job-status[data-job="${id}"]`),
    });
}

/** The health chip in a job panel's header -- the one place health shows. */
function healthBadge(page: Page, id: string) {
    return jobSection(page, id).locator(":scope > summary helman-training-health-badge .badge");
}

function formatted(page: Page, iso: string): Promise<string> {
    return page.evaluate((value) => new Date(value).toLocaleString("en"), iso);
}

test("one panel per job, in batch order", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);

    const ids = await page
        .locator("helman-training-job-status")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-job")));
    expect(ids).toEqual(["solar_bias", "house_consumption", "appliance_energy"]);
    // And the panels read the fixture, not a loading placeholder.
    await expect(healthBadge(page, "solar_bias")).toHaveClass(/health-ok/);
});

test("an older result still served shows both timestamps, the warning and the reason", async ({
    page,
}) => {
    await mountEditor(
        page,
        status({
            house_consumption: {
                health: "failed",
                lastOutcome: "entity_missing",
                errorReason: "sensor.house_energy",
                trainedAt: HOUSE_TRAINED_AT,
                lastAttemptAt: HOUSE_ATTEMPT_AT,
                artifactInUse: true,
                usingOlderArtifact: true,
            },
        }),
    );
    await openTrainingTab(page);

    const house = panel(page, "house_consumption");
    await expect(house.locator(".notice.warning")).toContainText("older result is still being served");
    await expect(house.locator(".notice.error")).toHaveCount(0);
    await expect(healthBadge(page, "house_consumption")).toHaveClass(/health-failed/);
    await expect(house.locator(".result-in-use")).toContainText(
        await formatted(page, HOUSE_TRAINED_AT),
    );
    await expect(house.locator(".last-attempt")).toContainText(
        await formatted(page, HOUSE_ATTEMPT_AT),
    );
    // The raw outcome, as this job's own label.
    await expect(house.locator(".last-attempt")).toContainText("Meter missing");
    await expect(house.locator(".error-reason")).toContainText("sensor.house_energy");
});

test("failed with nothing served gets the stronger treatment", async ({ page }) => {
    await mountEditor(
        page,
        status({
            appliance_energy: {
                health: "failed",
                lastOutcome: "training_failed",
                errorReason: "boom",
                trainedAt: null,
                artifactInUse: false,
                usingOlderArtifact: false,
            },
        }),
    );
    await openTrainingTab(page);

    const appliance = panel(page, "appliance_energy");
    await expect(appliance.locator(".notice.error")).toContainText("no trained result is being served");
    await expect(appliance.locator(".notice.warning")).toHaveCount(0);
    await expect(appliance.locator(".result-in-use")).toHaveCount(0);
});

test("an attempt that was never recorded reads as not recorded", async ({ page }) => {
    await mountEditor(page, status({ house_consumption: { lastAttemptAt: null } }));
    await openTrainingTab(page);

    const lastAttempt = panel(page, "house_consumption").locator(".last-attempt");
    await expect(lastAttempt).toContainText("Not recorded");
    await expect(lastAttempt).not.toContainText("Never");
});

test("issues render as a list for solar and appliance", async ({ page }) => {
    await mountEditor(
        page,
        status({
            solar_bias: {
                health: "degraded",
                lastOutcome: "insufficient_history",
                artifactInUse: false,
                issues: [
                    { subject: "2026-09-15", reason: "day_ratio_out_of_band" },
                    { subject: "2026-09-16", reason: "day_forecast_too_low" },
                ],
            },
            appliance_energy: {
                health: "degraded",
                issues: [{ subject: "washer", reason: "no recorder history" }],
            },
        }),
    );
    await openTrainingTab(page);

    // Under each job's Diagnostics now (#313), not in its status block.
    const issues = (id: string) => jobSection(page, id).locator("helman-training-issues ul.issues");
    const solarIssues = issues("solar_bias").locator("li");
    await expect(solarIssues).toHaveCount(2);
    await expect(solarIssues.first()).toContainText("2026-09-15");
    await expect(solarIssues.first()).toContainText("day_ratio_out_of_band");

    const applianceIssues = issues("appliance_energy").locator("li");
    await expect(applianceIssues).toHaveCount(1);
    await expect(applianceIssues).toContainText("washer");
    await expect(applianceIssues).toContainText("no recorder history");

    await expect(issues("house_consumption")).toHaveCount(0);
});

test("stale shows the marker, unknown staleness a quiet note, fresh nothing", async ({
    page,
}) => {
    await mountEditor(
        page,
        status({
            solar_bias: { isStale: true },
            house_consumption: { isStale: null },
            appliance_energy: { isStale: false },
        }),
    );
    await openTrainingTab(page);

    await expect(panel(page, "solar_bias").locator(".stale")).toContainText("configuration has changed");
    await expect(panel(page, "solar_bias").locator(".staleness-unknown")).toHaveCount(0);

    await expect(panel(page, "house_consumption").locator(".staleness-unknown")).toHaveText(
        "Staleness unknown",
    );
    await expect(panel(page, "house_consumption").locator(".stale")).toHaveCount(0);

    await expect(panel(page, "appliance_energy").locator(".stale, .staleness-unknown")).toHaveCount(0);
});

test("Train all now sends no job, a panel button sends its own", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);

    await page.locator("helman-training-status button.train-all").click();
    await expect.poll(() => page.evaluate(() => (window as any).__trainRequests.length)).toBe(1);

    await page
        .locator('helman-training-job-status[data-job="house_consumption"] button.train-job')
        .click();
    await expect.poll(() => page.evaluate(() => (window as any).__trainRequests.length)).toBe(2);

    const requests = await page.evaluate(() => (window as any).__trainRequests);
    expect(requests[0]).toEqual({ type: "helman/training/train_now" });
    expect(requests[1]).toEqual({ type: "helman/training/train_now", job: "house_consumption" });
});

test("unsaved changes disable every training command", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);

    await page.locator("helman-config-editor-panel").evaluate((element: any) => {
        element._dirty = true;
    });

    await expect(page.locator("helman-training-status button.train-all")).toBeDisabled();
    const jobButtons = page.locator("helman-training-job-status button.train-job");
    await expect(jobButtons).toHaveCount(3);
    for (const button of await jobButtons.all()) await expect(button).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as any).__trainRequests.length)).toBe(0);
});

test("the status train_now returns replaces the displayed one", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);

    const after = status({ house_consumption: { health: "degraded" } }, { trainingTime: "04:30" });
    await page.evaluate((next) => {
        (window as any).__trainNow = {
            result: {
                outcomes: {
                    solar_bias: "profile_trained",
                    house_consumption: "insufficient_history",
                    appliance_energy: "estimates_trained",
                },
                status: next,
            },
        };
    }, after);
    await page.locator("helman-training-status button.train-all").click();

    await expect(page.locator("helman-training-status .container")).toContainText("04:30");
    await expect(healthBadge(page, "house_consumption")).toHaveClass(/health-degraded/);
});

test("while running every button is disabled and the running job is named", async ({ page }) => {
    await mountEditor(page, status({}, { isRunning: true, currentJob: "house_consumption" }));
    await openTrainingTab(page);

    await expect(page.locator("helman-training-status .running-job")).toHaveText("House consumption");
    await expect(page.locator("helman-training-status button.train-all")).toBeDisabled();
    const jobButtons = page.locator("helman-training-job-status button.train-job");
    await expect(jobButtons).toHaveCount(3);
    for (const button of await jobButtons.all()) {
        await expect(button).toBeDisabled();
    }
});

test("a run with no current job yet reads as starting", async ({ page }) => {
    await mountEditor(page, status({}, { isRunning: true, currentJob: null }));
    await openTrainingTab(page);

    await expect(page.locator("helman-training-status .running-job")).toHaveText("Starting");
    await expect(page.locator("helman-training-status button.train-all")).toBeDisabled();
});

test("a training_in_progress rejection is shown as did not run", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);

    await page.evaluate(() => {
        (window as any).__trainNow = {
            error: {
                code: "training_in_progress",
                message: "Training is already running: solar_bias",
            },
        };
    });
    const house = page.locator('helman-training-job-status[data-job="house_consumption"]');
    await house.locator("button.train-job").click();

    const message = house.locator(".message");
    await expect(message).toContainText("did not run");
    await expect(message).toContainText("House consumption");
    await expect(message).not.toHaveClass(/success/);
});

test("a resolved request with a failed outcome is shown as an error", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);

    await page.evaluate((next) => {
        (window as any).__trainNow = {
            result: {
                outcomes: { house_consumption: "entity_missing" },
                status: next,
            },
        };
    }, status({ house_consumption: { health: "failed", lastOutcome: "entity_missing" } }));
    const house = page.locator('helman-training-job-status[data-job="house_consumption"]');
    await house.locator("button.train-job").click();

    const message = house.locator(".message");
    await expect(message).toHaveClass(/error/);
    await expect(message).toContainText("House consumption failed: Meter missing");
    await expect(message).not.toContainText("Training finished");
});

test("the Training tab carries a badge for a failed job without being open", async ({ page }) => {
    await mountEditor(
        page,
        status({
            house_consumption: { health: "failed", lastOutcome: "entity_missing" },
            appliance_energy: { health: "failed", lastOutcome: "training_failed" },
        }),
    );

    // The editor opens on Energy nodes; the badge reads the same poll anyway.
    await expect(page.locator(".tabs button.active")).not.toContainText("Training");
    const badge = page.locator(".tabs button", { hasText: "Training" }).locator(".tab-warning-dot");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("aria-label", /2/);
});

test("a degraded-only status puts no badge on the Training tab", async ({ page }) => {
    await mountEditor(
        page,
        status({
            solar_bias: { health: "degraded", lastOutcome: "insufficient_history" },
            appliance_energy: { health: "degraded", lastOutcome: "no_history" },
        }),
    );
    // Wait for the status poll to have landed before asserting an absence.
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (document.querySelector("helman-config-editor-panel") as any)._trainingStatus !==
                    null,
            ),
        )
        .toBe(true);

    await expect(page.locator(".tabs button.active")).not.toContainText("Training");
    await expect(page.locator(".tab-warning-dot")).toHaveCount(0);
});

test("the appliance panel lists every consumer device", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);

    const section = jobSection(page, "appliance_energy");
    const rows = section.locator(".training-depth-table tbody tr");
    // Every device learns its usage record, a fixed and a passive one too.
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Dishwasher");
    await expect(rows.nth(0)).toContainText("sensor.dishwasher_energy");
    // Its own lookback, read from the device, in the Lookback column; the
    // others read the default 30 days.
    await expect(rows.nth(0).locator("td").nth(2)).toHaveText("21 d");
    await expect(rows.nth(1)).toContainText("Boiler");
    await expect(rows.nth(1).locator("td").nth(2)).toHaveText("30 d");
    await expect(rows.nth(2)).toContainText("Fridge");
    await expect(section).toContainText("Devices tab");
});

/** How many times the editor has asked for the training status so far. */
function statusRequests(page: Page): Promise<number> {
    return page.evaluate(
        () => window.__mockRequests.filter((request) => request.type === "helman/training/status").length,
    );
}

test("the solar panel shows its diagnostics under a neutral heading", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);

    const diagnostics = page.locator("helman-solar-bias-diagnostics .container");
    await expect(diagnostics).toContainText("Solar bias diagnostics");
    await expect(diagnostics).toContainText("7 / 10 required");
    await expect(diagnostics).toContainText("min 0.80 / median 1.00 / max 1.20");
    // Dropped days arrive as the job's issues, never repeated here.
    await expect(diagnostics).not.toContainText("2026-09-15");
    // Read from the training status the tab already has: one request, no second.
    const commands = await page.evaluate(() => window.__mockRequests.map((request) => request.type));
    expect([...new Set(commands.filter((command) => command.endsWith("/status")))]).toEqual(["helman/training/status"]);
});

test("a training event reloads the status", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);
    await expect(healthBadge(page, "house_consumption")).toHaveClass(/health-ok/);

    await page.evaluate((next) => {
        (window as any).__trainingStatus = next;
        window.__fireDataChanged("training");
    }, status({ house_consumption: { health: "degraded" } }));

    await expect(healthBadge(page, "house_consumption")).toHaveClass(/health-degraded/);
});

test("a config event reloads the solar diagnostics with the status", async ({ page }) => {
    await mountEditor(page, status());
    await openTrainingTab(page);
    const diagnostics = page.locator("helman-solar-bias-diagnostics .container");
    await expect(diagnostics).toContainText("7 / 10 required");

    await page.evaluate((next) => {
        (window as any).__trainingStatus = next;
        window.__fireDataChanged("config");
    }, status({ solar_bias: { details: { ...SOLAR_DETAILS, minHistoryDays: 14 } } }));

    await expect(diagnostics).toContainText("7 / 14 required");
});

test("with no run in progress the status is never polled", async ({ page }) => {
    await mountEditor(page, status(), { fakeTimers: true });
    await openTrainingTab(page);
    // Once on mount, once on opening the tab.
    await expect.poll(() => statusRequests(page)).toBe(2);

    await page.clock.runFor(5 * 60_000);

    expect(await statusRequests(page)).toBe(2);
});

test("opening the Training tab reloads the status", async ({ page }) => {
    await mountEditor(page, status());
    await expect.poll(() => statusRequests(page)).toBe(1);

    // A run started elsewhere: no event announces it.
    await page.evaluate((next) => {
        (window as any).__trainingStatus = next;
    }, status({}, { isRunning: true, currentJob: "house_consumption" }));
    await openTrainingTab(page);

    await expect(page.locator("helman-training-status .running-job")).toHaveText("House consumption");
});

test("Train now shows the run in progress and polls until it settles", async ({ page }) => {
    await mountEditor(page, status(), { fakeTimers: true });
    await openTrainingTab(page);
    await expect.poll(() => statusRequests(page)).toBe(2);

    await page.evaluate((running) => {
        const w = window as any;
        w.__trainingStatus = running;
        w.__trainNow.pending = new Promise((resolve) => (w.__releaseTrainNow = resolve));
    }, status({}, { isRunning: true, currentJob: "house_consumption" }));
    await page.locator("helman-training-status button.train-all").click();

    // Shown running at once, before any status answer says so.
    await expect(page.locator("helman-training-status .running-job")).toHaveText("Starting");
    expect(await statusRequests(page)).toBe(2);
    await page.clock.runFor(15_000);
    await expect.poll(() => statusRequests(page)).toBe(3);
    await expect(page.locator("helman-training-status .running-job")).toHaveText("House consumption");

    // The run ends: train_now answers with a status that is not running.
    await page.evaluate(() => (window as any).__releaseTrainNow());
    await expect(page.locator("helman-training-status .running-job")).toHaveCount(0);
    await page.clock.runFor(5 * 60_000);
    expect(await statusRequests(page)).toBe(3);
});

test("while a run is in progress the status is polled every 15 s, until it ends", async ({ page }) => {
    await mountEditor(page, status({}, { isRunning: true, currentJob: "solar_bias" }), { fakeTimers: true });
    await openTrainingTab(page);
    await expect.poll(() => statusRequests(page)).toBe(2);

    await page.clock.runFor(14_000);
    expect(await statusRequests(page)).toBe(2);
    await page.clock.runFor(1_000);
    await expect.poll(() => statusRequests(page)).toBe(3);

    await page.evaluate((next) => {
        (window as any).__trainingStatus = next;
    }, status());
    await page.clock.runFor(15_000);
    await expect.poll(() => statusRequests(page)).toBe(4);
    await expect(page.locator("helman-training-status .running-job")).toHaveCount(0);

    await page.clock.runFor(5 * 60_000);
    expect(await statusRequests(page)).toBe(4);
});
