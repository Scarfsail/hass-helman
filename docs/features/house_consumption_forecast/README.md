# House Consumption Forecast Proposal

See also: `implementation_plan.md` for the step-by-step backend/frontend rollout.

## Goal

Add a new capability to `hass-helman` that predicts future house consumption and exposes it to `hass-helman-card`.

The practical user-facing outcome should be:

- forecast the next **7 days**
- predict **hourly energy consumption** in `kWh`
- expose both **overall house consumption** and **house consumption without deferrable consumers**
- include a **confidence band for each hour**
- keep the frontend focused on rendering, not heavy forecasting logic

## Agreed decisions

Based on your answers, these choices now look aligned:

| Decision                     | Agreed direction                         | Notes                                                                            |
| ---------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| Forecast target              | **Hourly energy consumption** (`kWh`)    | Not instantaneous power in `W`                                                   |
| Forecast horizon             | **7 days**                               | `168` hourly points                                                              |
| Historical source            | **Home Assistant Recorder / statistics** | Reuse the existing house energy entity if it can provide reliable hourly history |
| Preferred source entity type | **Cumulative / `total_increasing`**      | Required source for v1 house forecast                                            |
| Computation location         | **`hass-helman` backend**                | Extend the existing backend forecast flow                                        |
| Model family for v1          | **Pure statistical baseline**            | No heavy ML framework in v1                                                      |
| Weather / temperature        | **Out of scope for v1**                  | Good candidate for v2                                                            |
| Confidence band              | **Include in v1**                        | Per-hour lower / upper estimate                                                  |
| Deferrable handling          | **Option B**                             | Forecast baseline plus each deferrable separately, then sum                      |
| Card presentation            | **Per-consumer breakdown**               | Show individual deferrable consumers, not only one merged line                   |
| DTO shape                    | **One object per hour**                  | Frontend derives `total` and `deferrableTotal` from the hourly record            |
| Forecast cadence             | **Run every hour**                       | House forecast generation is scheduled in the backend                            |
| Forecast persistence         | **Persist latest snapshot**              | Return stored house forecast data on request and after Home Assistant restart     |
| Visibility threshold         | **14 days minimum history**              | Hide the forecast until enough hourly history exists                             |

## Important note on the history source

Your answer was: use the existing house daily energy consumption if it is enough.

That is a good default, but "enough" depends on what kind of entity it is.

### Best case

The house energy entity is a **cumulative energy sensor** or already backed by Recorder/statistics in a way that allows us to derive **hourly deltas**.

That is the cleanest source for this feature.

### Practical conclusion

The recommendation remains:

- use **Home Assistant Recorder/statistics** as the primary historical source
- require a **statistics-friendly cumulative house energy entity**
- do **not** fall back to the current house daily energy source for v1

If that cumulative source is not configured, the house forecast should be treated as **not configured** and stay hidden.

## New major architecture decision: deferrable consumers

You added an important requirement:

> We should include deferrable energy such as car charging, pool heating, and so on, and expose both overall predicted energy consumption and the prediction without the deferrable consumers.

This changes the architecture in a useful way, because deferrable loads are not just "another part of the house". They are often controllable and should not be mixed into the base household pattern if the goal is future optimization.

## Options for handling deferrable consumers

### Option A - Forecast only one total house series

Forecast house consumption as a single number per hour, with deferrable loads mixed in.

#### Pros

- simplest backend and UI
- easiest first implementation

#### Cons

- not useful for scheduling or shifting flexible loads
- hides the difference between baseline demand and movable demand
- does not satisfy your new requirement well

### Recommendation

Not recommended.

### Option B - Forecast base load and deferrable loads separately, then sum them (recommended)

Treat the feature as a decomposition problem:

- **non-deferrable / base consumption**
- **deferrable consumption**
- **total consumption = base + deferrable**

High-level approach:

1. Configure one house energy source.
2. Configure zero or more **deferrable energy entities** such as EV charging, pool heating, water heating, and similar consumers.
3. Build historical hourly series for:

   - house total
   - each deferrable consumer
4. Derive historical **non-deferrable** consumption as:

```text
house_total - sum(deferrable_consumers)
```

5. Forecast:

    - non-deferrable consumption as one baseline series
    - each configured deferrable consumer as its own series
6. Represent each forecast hour as one object and let the frontend derive:

```text
total = non_deferrable + sum(deferrable_forecasts)
deferrable_total = sum(deferrable_forecasts)
```

#### Pros

- directly supports your "with / without deferrables" requirement
- keeps the forecast internally consistent
- creates a clean path to future scheduling and optimization
- still works with a simple statistical baseline

#### Cons

- requires reliable energy entities for each deferrable consumer
- adds configuration complexity
- future deferrable behavior can be less stable than base load

### Recommendation

This is the **best v1 architecture** if deferrable consumers are part of the requirement from the start.

### Option C - Forecast base load only, and handle deferrables only through explicit future plans

In this model, the forecast engine predicts only the non-deferrable household baseline. Deferrable loads are not forecast from history. They are added only if the user or automation explicitly schedules them.

#### Pros

- conceptually clean
- better for controllable loads whose future use is highly plan-driven
- very good long-term direction for optimization

#### Cons

- does not give an "overall predicted consumption" unless planning data exists
- requires a scheduling/planning mechanism
- bigger feature scope than v1

### Recommendation

Good long-term direction, but probably **too much for v1**.

Answer: Go with option B

## Recommended v1 architecture

### Proposed combination

- **Forecast target:** hourly house energy consumption
- **Historical source:** Home Assistant Recorder/statistics
- **Computation location:** `hass-helman` backend
- **Model:** hour-of-week statistical baseline
- **Forecast horizon:** 7 days
- **Confidence band:** yes, per hour
- **Deferrables:** supported as configured energy entities

### Recommended modeling strategy

For v1, the cleanest model is:

1. Forecast **non-deferrable household consumption** as the primary baseline.
2. Forecast each configured **deferrable consumer** separately using the same simple statistical approach.
3. Return **one object per forecast hour** containing:
   - `timestamp`
   - `nonDeferrable`
   - per-consumer deferrable values
4. Let the frontend derive aggregated views by summing:

```text
total = non_deferrable + sum(deferrable_forecasts)
deferrable_total = sum(deferrable_forecasts)
```

This is better than exposing separate total series in the DTO, because:

- it guarantees that the numbers add up
- it preserves the useful split between baseline and flexible demand
- it makes future schedule-aware optimization easier
- it naturally supports a per-consumer UI breakdown
- it keeps the backend payload compact and normalized

If no deferrable consumers are configured:

- the hourly object simply contains an empty deferrable list
- `total` and `non_deferrable` are effectively the same in the frontend
- the feature still works without special handling

## Why this still fits the current Helman architecture

This codebase already has several useful extension points:

- `hass-helman` already exposes `helman/get_forecast`
- forecast data is already assembled on the backend and consumed by the card
- the integration already depends on `recorder`
- `hass-helman-card` already has a forecast rendering pattern

Because of that, a natural evolution is:

- extend backend forecast payload with a new `house_consumption` section
- keep Recorder/statistics querying in the integration
- keep the frontend focused on rendering and comparison

## Runtime model and persistence

The house consumption forecast should **not** be recalculated on every websocket request.

Recommended runtime model:

- generate the house forecast in the backend **once per hour**
- persist the latest `house_consumption` snapshot to Home Assistant storage after each successful run
- load the persisted snapshot on startup so `helman/get_forecast` can return immediately after restart
- trigger a non-blocking refresh on startup and then continue with hourly refreshes
- trigger an immediate refresh when the relevant forecast config changes
- return the **persisted / cached** house forecast from `helman/get_forecast`, rather than rebuilding it on demand

This keeps the websocket fast, makes restarts predictable, and ensures the UI always sees one stable forecast snapshot.

## Model options

### Option 1 - Pure statistical baseline (recommended for v1)

This remains the best first version.

Example shape:

- collect the last **4 to 8 weeks** of hourly house energy usage
- build an **hour-of-week profile** (`7 * 24 = 168` slots)
- weight recent history more strongly than older history
- trim outliers where useful
- build a confidence band from the spread of historical values for the matching slot

This same approach can be used for:

- non-deferrable household demand
- aggregated deferrable demand
- or each configured deferrable consumer separately

#### Pros

- simple, explainable, and local
- no heavy dependencies
- easy to debug when numbers look wrong
- strong fit for household baseline behavior
- good match for a Home Assistant custom integration

#### Cons

- weaker on unusual one-off days
- deferrable consumers may be less predictable than base load
- does not use external context such as weather or occupancy

### Option 2 - Hybrid contextual model

Start from the statistical baseline and add a few extra signals later, for example:

- season / month
- weekday / weekend / holiday
- occupancy / home-away mode
- battery strategy mode
- temperature

#### Pros

- likely the highest value next step after v1
- still explainable
- can improve heating-heavy or schedule-heavy households

#### Cons

- more configuration
- more validation work
- more edge cases around missing data

### Recommendation

Good **v2 direction**.

### Option 3 - Full ML model inside the integration

Use a local ML library such as `scikit-learn` and train a richer regression model.

#### Pros

- highest theoretical ceiling
- can combine many signals more flexibly

#### Cons

- much more complexity
- more difficult packaging for a Home Assistant custom integration
- harder to explain and debug
- unclear whether it will beat a strong statistical baseline enough to justify the cost

### Recommendation

Do **not** start here.

## High-level API direction

The current backend forecast payload could grow in this direction:

```json
{
  "solar": { "...": "existing" },
  "grid": { "...": "existing" },
  "house_consumption": {
    "status": "available",
    "generatedAt": "2026-03-12T08:05:00+01:00",
    "unit": "kWh",
    "resolution": "hour",
    "horizonHours": 168,
    "trainingWindowDays": 42,
    "model": "hour_of_week_baseline",
    "series": [
      {
        "timestamp": "2026-03-12T08:00:00+01:00",
        "nonDeferrable": {
          "value": 1.2,
          "lower": 0.9,
          "upper": 1.6
        },
        "deferrableConsumers": [
          {
            "entityId": "sensor.ev_charging_energy_total",
            "label": "EV Charging",
            "value": 0.3,
            "lower": 0.0,
            "upper": 1.0
          },
          {
            "entityId": "sensor.pool_heating_energy_total",
            "label": "Pool Heating",
            "value": 0.1,
            "lower": 0.0,
            "upper": 0.4
          }
        ]
      }
    ]
  }
}
```

This is still intentionally high level. The important part is the shape:

- forecast metadata
- persisted snapshot metadata such as `generatedAt`
- one object per forecast hour
- lower / upper confidence for the baseline and each deferrable consumer
- per-consumer deferrable breakdown
- entity ID used as the stable deferrable consumer identifier
- frontend-derived totals

## High-level rollout

### Phase 1 - Strong v1

- use Recorder/statistics as the historical source
- build a 7-day hourly forecast
- run the house forecast generation every hour in the backend
- persist the latest forecast snapshot and serve it from storage / cache
- use the pure statistical baseline
- include a confidence band
- support configured deferrable consumers
- expose hourly records with non-deferrable and per-consumer deferrable values
- derive total and deferrable-total views in the frontend

### Phase 2 - Better deferrable handling

- optionally forecast each deferrable consumer separately in the UI
- allow a schedule-aware mode for planned deferrables
- improve the confidence band using more consumer-specific heuristics

### Phase 3 - Context-aware improvements

- add optional temperature and calendar effects
- re-evaluate whether a hybrid model is enough before considering ML

## Recommendation to align on

If we want a strong first implementation, I would align on this:

> **Build a backend forecast in `hass-helman` that predicts 7 days of hourly house energy consumption from Home Assistant Recorder/statistics using a simple hour-of-week statistical baseline, runs every hour, persists the latest snapshot, and returns one object per hour with non-deferrable values and a per-consumer deferrable breakdown plus confidence bands.**

That gives:

- a useful result immediately
- minimal architectural risk
- no premature ML dependency
- a clean path to future scheduling / optimization

## Visibility rule for v1

We now have a concrete rule for insufficient history:

- if less than **14 days** of usable hourly history is available, **hide the forecast**
- once at least **14 days** is available, show the forecast normally

Why `14 days` is a good v1 default:

- it gives at least two weekly cycles for the hour-of-week baseline
- it is more robust than a 7-day minimum
- it becomes available much sooner than waiting for 28 days

At this point, the document is largely aligned and ready for implementation planning.
