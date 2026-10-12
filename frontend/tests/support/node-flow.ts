import { expect, type Locator, type Page } from "@playwright/test";

/** An element's computed `animation-name`. */
export const animationName = (locator: Locator): Promise<string> =>
    locator.evaluate((element) => getComputedStyle(element).animationName);

/**
 * An active node's flow on Now moves, its ribbons' light band and its pulsing
 * centre, and reduced motion stops both.
 */
export async function expectReducedMotionStill(page: Page, flow: Locator): Promise<void> {
    const band = flow.locator(".band").first();
    const centre = flow.locator("[slot='centre']").first();
    await expect.poll(() => animationName(band)).toBe("sweep");
    await expect.poll(() => animationName(centre)).toBe("pulse");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => animationName(band)).toBe("none");
    await expect.poll(() => animationName(centre)).toBe("none");
}
