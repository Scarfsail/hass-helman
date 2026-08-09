// Second pass: time the inspector's own render helpers, so the per-render cost
// can be split between re-deriving the day's data and painting the SVG.
(() => {
  const perf = window.__perf;
  perf.fn ||= {};
  const timeIt = (tag, ctor, names) => {
    if (!ctor) return [];
    const proto = ctor.prototype;
    const done = [];
    for (const name of names) {
      const orig = proto[name];
      if (typeof orig !== "function" || orig.__perfTimed) continue;
      const key = `${tag}.${name}`;
      const wrapper = function (...args) {
        const t0 = performance.now();
        try {
          return orig.apply(this, args);
        } finally {
          const s = (perf.fn[key] ||= { calls: 0, ms: 0, maxMs: 0 });
          const dt = performance.now() - t0;
          s.calls += 1; s.ms += dt;
          if (dt > s.maxMs) s.maxMs = dt;
        }
      };
      wrapper.__perfTimed = true;
      proto[name] = wrapper;
      done.push(name);
    }
    return done;
  };

  const out = {};
  out.inspector = timeIt("inspector", customElements.get("helman-solar-inspector"), [
    "_viewForSlot", "_buildStacks", "_computeChartLayout", "_renderContent",
    "_renderChart", "_renderStackSet", "_renderSocSection", "_renderExportPriceStrip",
    "_renderScheduleActionsStrip", "_renderSelectedSlotDetails", "_renderTotals",
    "_renderContributionTable", "_renderNavigation", "_loadDayAggregates",
    "_syncScheduleOwner", "_syncChartResizeObserver", "_solarWindow",
  ]);
  out.band = timeIt("bandStrip", customElements.get("helman-solar-schedule-band-strip"), [
    "_rebuildNormalizedIfNeeded", "_rebuildDerivedIfNeeded", "_buildBandLanes",
    "_buildHighlights", "_buildGridTicks", "_selectedDay",
  ]);
  out.pills = timeIt("dayPills", customElements.get("helman-solar-day-pills"), [
    "_rebuildNormalizedIfNeeded", "_rebuildModelIfNeeded", "_syncOwner", "_revealSelectedPill",
  ]);
  out.priceStrip = timeIt("priceStrip", customElements.get("helman-solar-export-price-strip"), [
    "_load",
  ]);
  out.card = timeIt("helmanCard", customElements.get("helman-card"), [
    "_buildDialogParams", "_rebuildWatchedEntityIds",
  ]);
  return out;
})();
