import { defineConfig, devices } from "@playwright/test";

// Component-level rendering tests for the bundled Lovelace card. They mount the
// card's own custom elements (built to
// ../custom_components/helman/frontend_compiled/helman-card.js) in a bare page —
// no running Home Assistant required. `globalSetup` rebuilds the bundle first so
// the tests always exercise the current source.
export default defineConfig({
    testDir: "./tests",
    globalSetup: "./tests/global-setup.ts",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 1,
    reporter: [["html", { open: "never" }], ["list"]],
    timeout: 30_000,
    expect: { timeout: 5_000 },
    use: {
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
});
