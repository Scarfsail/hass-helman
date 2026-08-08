// Run once the cards are on screen. Wraps each Helman custom element's Lit
// update/render and its `hass` setter so every re-render is counted with the
// property that caused it and the time it cost.
(() => {
  const TAGS = [
    "helman-card",
    "helman-simple-card",
    "helman-solar-inspector-card",
    "helman-solar-inspector",
    "helman-solar-day-pills",
    "helman-solar-schedule-band-strip",
    "helman-solar-export-price-strip",
    "helman-forecast-health-banner",
    "helman-power-history-bars",
    "power-device",
    "power-devices-container",
    "power-house-devices-section",
    "power-flow-arrows",
    "power-device-icon",
    "power-device-info",
    "power-device-power-display",
    "simple-card-solar",
    "simple-card-battery",
    "simple-card-grid",
    "simple-card-house",
    "scheduling-entity-day-band",
    "helman-day-aggregate-gauge",
    "helman-slot-gridlines",
    "helman-soc-columns",
  ];

  const perf = window.__perf;
  perf.changeSets ||= {};
  perf.setDuringRender ||= {};
  const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

  const stat = (tag) => (perf.el[tag] ||= {
    updates: 0, updateMs: 0, maxUpdateMs: 0, renders: 0, renderMs: 0, instances: 0,
  });

  const wrapped = [];
  for (const tag of TAGS) {
    const ctor = customElements.get(tag);
    if (!ctor) continue;
    const proto = ctor.prototype;
    if (proto.__perfWrapped) continue;
    proto.__perfWrapped = true;
    wrapped.push(tag);

    const origUpdate = proto.update;
    proto.update = function (changed) {
      // Read the keys BEFORE rendering: a property set during render() is
      // appended to this same map and then discarded by Lit, so counting
      // afterwards would credit the render with a change it never acted on.
      const keys = changed && typeof changed.keys === "function"
        ? Array.from(changed.keys()).map(String)
        : [];
      const t0 = performance.now();
      try {
        return origUpdate.call(this, changed);
      } finally {
        const dt = performance.now() - t0;
        const s = stat(tag);
        s.updates += 1;
        s.updateMs += dt;
        if (dt > s.maxUpdateMs) s.maxUpdateMs = dt;
        for (const k of keys) bump(perf.changed, `${tag}.${k}`);
        if (keys.length === 0) bump(perf.changed, `${tag}.<none>`);
        bump(perf.changeSets, `${tag}: ${keys.sort().join(",") || "<none>"}`);
        // Properties set during render and then swallowed by Lit's markUpdated.
        if (changed && typeof changed.keys === "function") {
          for (const k of Array.from(changed.keys()).map(String)) {
            if (!keys.includes(k)) bump(perf.setDuringRender, `${tag}.${k}`);
          }
        }
      }
    };

    const origRender = proto.render;
    if (typeof origRender === "function") {
      proto.render = function () {
        const t0 = performance.now();
        try {
          return origRender.call(this);
        } finally {
          const s = stat(tag);
          s.renders += 1;
          s.renderMs += performance.now() - t0;
        }
      };
    }

    // The `hass` setter, wherever on the chain it lives.
    let node = proto;
    while (node && node !== HTMLElement.prototype) {
      const desc = Object.getOwnPropertyDescriptor(node, "hass");
      if (desc && typeof desc.set === "function") {
        const origSet = desc.set;
        Object.defineProperty(node, "hass", {
          ...desc,
          set(value) {
            bump(perf.hassSets, tag);
            return origSet.call(this, value);
          },
        });
        break;
      }
      node = Object.getPrototypeOf(node);
    }
  }

  // Count live instances of each tag by walking every shadow root.
  window.__perfCountInstances = () => {
    const counts = {};
    const seen = new Set();
    const walk = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      const all = root.querySelectorAll("*");
      for (const el of all) {
        const t = el.localName;
        if (t.includes("-")) counts[t] = (counts[t] || 0) + 1;
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    const out = {};
    for (const tag of TAGS) if (counts[tag]) out[tag] = counts[tag];
    out["__totalCustomElements"] = Object.values(counts).reduce((a, b) => a + b, 0);
    return out;
  };

  window.__perfSnapshot = () => JSON.parse(JSON.stringify(window.__perf));
  window.__perfReset = () => {
    perf.ws.sentByType = {}; perf.ws.recvByType = {}; perf.ws.recvEventTypes = {};
    perf.ws.sentBytes = 0; perf.ws.recvBytes = 0;
    perf.el = {}; perf.changed = {}; perf.hassSets = {};
    perf.changeSets = {}; perf.setDuringRender = {};
    perf.longTasks = { count: 0, totalMs: 0, maxMs: 0 };
    perf.stateChanges = { messages: 0, entities: 0 };
    perf.fn = {};
    for (const tag of TAGS) if (customElements.get(tag)) stat(tag);
    perf.startedAt = Date.now();
  };

  return wrapped;
})();
