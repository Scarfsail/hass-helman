/**
 * The coarse wall clock the cards mark "now" by.
 *
 * `hass` churn is not a clock (see `cards/README.md`), so anything drawing the
 * moment owns a timer. Three rules hold for every one of them, which is why the
 * timer itself lives here rather than being written out at each site: the
 * resolution is the same everywhere, so two markers on one page never disagree
 * about where "now" is; the timer stops while the page is hidden, because a
 * marker nobody is looking at is not worth a render, let alone a model rebuild;
 * and coming back ticks immediately, so a returning reader sees the current
 * moment rather than the one they left.
 *
 * What a tick is *worth* stays with the caller: a card that marks no moment in
 * the view it is showing drops the tick rather than writing reactive state
 * nothing reads. `helman-solar-inspector`'s `_tickNow` is the worked example.
 */

/** How far the clock has to move before the "now" line is worth redrawing. */
const NOW_RESOLUTION_MS = 30_000;

/**
 * Call `onTick` now, and every {@link NOW_RESOLUTION_MS} the page is visible
 * for. Returns the stop function the caller's `disconnectedCallback` owes it.
 */
export function startNowClock(onTick: () => void): () => void {
    if (typeof window === "undefined" || typeof document === "undefined") {
        onTick();
        return () => undefined;
    }

    let timer: number | undefined;
    const stop = () => {
        if (timer !== undefined) {
            window.clearInterval(timer);
            timer = undefined;
        }
    };
    const start = () => {
        if (timer === undefined) {
            timer = window.setInterval(onTick, NOW_RESOLUTION_MS);
        }
    };

    const onVisibilityChange = () => {
        if (document.hidden) {
            stop();
            return;
        }
        // Catch up before resuming: the clock moved on while the timer was off,
        // and the first thing on screen must not be the moment we went away at.
        onTick();
        start();
    };

    onTick();
    if (!document.hidden) {
        start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
        stop();
        document.removeEventListener("visibilitychange", onVisibilityChange);
    };
}
