// Injected before any page script. Counts every websocket message the HA
// frontend sends/receives, and installs the counters the later instrumentation
// step fills in.
(() => {
  const perf = {
    startedAt: Date.now(),
    ws: { sentByType: {}, recvByType: {}, recvEventTypes: {}, sentBytes: 0, recvBytes: 0 },
    el: {},            // tag -> { updates, renderMs, updateMs }
    changed: {},       // "tag.prop" -> count
    hassSets: {},      // tag -> count of hass setter calls
    longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    stateChanges: { messages: 0, entities: 0 },
    changeSets: {},
    setDuringRender: {},
    marks: [],
  };
  window.__perf = perf;

  const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

  const OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    const origSend = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        perf.ws.sentBytes += typeof data === "string" ? data.length : 0;
        const msg = JSON.parse(data);
        const list = Array.isArray(msg) ? msg : [msg];
        for (const m of list) bump(perf.ws.sentByType, m.type || "?");
      } catch { /* non-JSON frame */ }
      return origSend(data);
    };
    ws.addEventListener("message", (ev) => {
      try {
        perf.ws.recvBytes += typeof ev.data === "string" ? ev.data.length : 0;
        const msg = JSON.parse(ev.data);
        const list = Array.isArray(msg) ? msg : [msg];
        for (const m of list) {
          bump(perf.ws.recvByType, m.type || "?");
          if (m.type === "event" && m.event && m.event.event_type) {
            bump(perf.ws.recvEventTypes, m.event.event_type);
          }
          // `subscribe_entities` compressed frames: `a` = full set, `c` = changes.
          if (m.type === "event" && m.event && (m.event.a || m.event.c)) {
            perf.stateChanges.messages += 1;
            perf.stateChanges.entities +=
              Object.keys(m.event.a || {}).length + Object.keys(m.event.c || {}).length;
          }
        }
      } catch { /* non-JSON frame */ }
    });
    return ws;
  }
  PatchedWS.prototype = OrigWS.prototype;
  PatchedWS.CONNECTING = OrigWS.CONNECTING;
  PatchedWS.OPEN = OrigWS.OPEN;
  PatchedWS.CLOSING = OrigWS.CLOSING;
  PatchedWS.CLOSED = OrigWS.CLOSED;
  window.WebSocket = PatchedWS;

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perf.longTasks.count += 1;
        perf.longTasks.totalMs += entry.duration;
        perf.longTasks.maxMs = Math.max(perf.longTasks.maxMs, entry.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* not supported */ }
})();
