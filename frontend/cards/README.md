# Card rendering discipline

Home Assistant replaces the `hass` object on every state change anywhere in the
house — measured here at 17–24 times a second. Lit decides whether to re-render
by comparing identity. So two habits are forbidden in this codebase.

## A new `hass` is not a change signal

`hass` is a conduit: it carries `connection`, `callWS`, `config.time_zone` and
`language`, and it carries `states`. A component may hold it and read through
it, but it must never re-render merely because it was handed a new one.

The card at the top of each tree decides what a change *is* — the identity of
`connection`, the value of the fields it reads, and the state objects of the
entities it actually looks up — and only then passes the new `hass` down.
`helman-card.set hass` is the worked example; the two predicates in
[`shared/hass-change.ts`](shared/hass-change.ts) are the shared, policy-free
half of it.

What an *empty* watch set means is a per-card policy and stays in that card's
setter. `helman-card` and `helman-simple-card` read it as "the device tree has
not hydrated yet" and pass everything through. `helman-solar-inspector-card`
reads it as "watch nothing" — its subtree can legitimately watch no entity for a
long time, or forever while the schedule band is collapsed, and passing
everything through would mean never filtering at all.

## A value crossing a component boundary keeps its identity while its meaning is unchanged

Object literals, `.map()` results, spread copies and closures returned by
factory functions are new objects every time they are built. Built inside
`render()` or inside a getter, they read as "changed" to the child's dirty check
and to any memo keyed on them, forever.

Build them in `willUpdate` behind a memo, or hoist them to a frozen module
constant (`EMPTY_ARRAY` in `helman-card.ts` is the shape), or keep them as a
bound field (`_localize` in `helman-solar-inspector.ts` is the shape).

Memo keys are compared field by field, never by object identity, and every field
in a key must itself be identity-stable.

## `render()` does not assign to state

Lit appends a property set during render to the same `changedProperties` map and
then discards it, so it schedules nothing and is invisible to every instrument —
but the assignment stands, and the new identity is handed to a child on that very
render. `_loadDayAggregates()` writing `this._historyDays = []` from inside
`render()` is how one memo became structurally incapable of ever hitting, at 69 %
of all browser CPU.

The same rule forbids dispatching derived facts from `render()`: the
`helman-watched-entities` event is dispatched from the load that resolved the
ids, never from the render that draws them.

## Corollary: a pointer is not a data change

A mouse reports far more often than the screen repaints, and what it reports is where the pointer is — never what the day contains. So nothing derived from the data may be built on the pointer's path. `helman-solar-inspector` derives its whole day model in `willUpdate` behind keys naming the inputs each step actually reads (`_rebuildDayModelIfNeeded`), and the strips below it do the same for their columns, cells and lanes; a hover then changes a highlight and a popup and reaches nothing else.

Two habits make that hold. Pointer reports are coalesced to one `requestAnimationFrame`, so a burst between two frames costs one update rather than ten. And the popup's *coordinates* never enter reactive state at all — they are written onto its element directly, because they change with every pixel while what the popup says changes only at a slot boundary.

[`../tests/inspector-hover-cost.spec.ts`](../tests/inspector-hover-cost.spec.ts) is the guard, and like the discipline tests it states hard zeros rather than budgets.

## Corollary: `hass` churn is not a clock

`_nowMs` in `helman-solar-inspector` and `helman-solar-schedule-band-strip` used
to be advanced from the `hass` setter. That works only while the churn exists;
the moment the churn is filtered out, the "now" marker freezes — and in the band
strip `_nowMs` is the only memo key that moves on an idle installation, so its
whole derived model freezes with it while the parts that read `hass.states` keep
repainting. Anything that needs the wall clock owns a timer.

But a timer is not a licence either, and [`shared/now-clock.ts`](shared/now-clock.ts) is where the limits on one live. It does not run while `document.hidden`, and it ticks once on the way back rather than leaving the reader up to half a minute behind. Each tick then has to earn its write: `helman-solar-inspector`'s `_tickNow` moves `_nowMs` only for the two things that read it — today's "now" line and the day rollover — so a past day or a month of totals, which mark no moment anywhere, cost nothing between two midnights. And a model keyed on the clock is keyed on the clock's *meaning* to it: everything `scheduling-day-editor-host` derives is a slot-boundary test, so its memo takes `clockSlotMs`, the edge the clock last reached, and the forecast map, day view, lanes and days stand until the schedule actually moves under them. The marker keeps the fine clock; only the model waits.

---

Measurement lives next door in [`../perf/README.md`](../perf/README.md), which
can count renders per `hass` update and is how the numbers above were obtained.
