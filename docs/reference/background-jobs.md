# Background jobs

Helman runs a handful of jobs on timers. This is what they are, when they fire, and what they cost — useful if you are wondering what the integration is doing when you are not looking at it.

| # | Job | Runs on a timer | Also triggered by | Cost |
|---|---|---|---|---|
| 1 | **Power tick** | every `data_and_learning.recent_power_history.sampling_interval_seconds` s (default **5 s**) | device-tree invalidation (entity registry updates); a config save | Cheap |
| 2 | **Schedule executor reconcile** | every **30 s** | startup; any schedule write; execution enable/disable; restore-normal-state; a config save | Cheap |
| 3 | **Pre-execution reality check** | inside #2, so in practice every **30 s** | — | Cheap |
| 4 | **Forecast rebuild** | **:00, :15, :30, :45** | startup; a config save; solar-bias trained/status events; a completed house-consumption fit from #6 | Moderate |
| 5 | **Automation re-plan** | — | a successful #4 (0.5 s debounce, only when automation has enabled optimizers); a day-editor edit; execution enable; condition drift seen by #3; "run now" | Moderate |
| 6 | **Nightly training batch** | daily at `data_and_learning.training_time` (default **03:00**) | startup or a config save, when the stored profile is missing, no longer matches your config, or is over 48 h old; the manual "train now" button (solar bias only) | **Heavy — off-peak by design** |
| 7 | **Battery capacity forecast** | — (on demand, 300 s cache) | every card read, when its inputs have actually changed | Moderate |

**Opening or refreshing a card never rebuilds the house or solar forecast.** Those are served from the last prepared snapshot, whatever its age; the work that prepares them runs on its own schedule. What a read still computes is the battery projection and the appliance demand projection feeding it (job #7), and only when its inputs have actually changed — it is anchored to the current battery reading, which is what lets the battery curve move the moment you edit a slot. That reading is itself one of the inputs, so on a battery under load the cache turns over well before its 300 s ceiling. Rebuilding reads today's battery history from Recorder, which is bounded by the length of the day.

**No card read issues a multi-day Recorder query.** Appliances that estimate their energy use from history (`consumption.projection.strategy: history_average`) used to have their `lookback_days` window read inside that projection rebuild, so a card refresh or a slot edit could block on a 30-day scan. That estimate is resolved once a night by job #6 now and read from storage here.

If a forecast has not been rebuilt for over an hour, the cards show a warning banner rather than going blank — old data still beats no data, and the banner is what tells you something is wrong. A card *does* go blank when a setting changes such that the stored data no longer answers the question you are now asking; that resolves as soon as the rebuild finishes.

## What each job does

1. **Power tick** — Helman's own live-power sampler, independent of Recorder: it reads your power sensors into ring buffers, works out the "Others" remainder for each parent node, and computes the consumption/production totals and source ratios that colour the bars. Pure state reads and arithmetic, no I/O.
2. **Schedule executor reconcile** — the only job that touches hardware. It finds the slot covering now and makes the inverter and each appliance match it, issuing a service call only when the desired state differs from what was last applied. With execution disabled, planning still runs; only this apply step is skipped. The cards then show the plan and the reality side by side: the schedule strips keep showing what Helman would do, while the forecast curves project the unmanaged house — no scheduled inverter action and no scheduled appliance run, because neither will happen while execution is off.
3. **Pre-execution reality check** — execution conditions ("only when the EV is plugged in") are evaluated at planning time and stamped onto each slot. This re-checks them against live state before anything is applied, and asks for a re-plan if reality has moved.
4. **Forecast rebuild** — rebuilds the house consumption, solar and automation forecasts and publishes them to the cards and sensors. It reads only today's history from Recorder; every multi-day read belongs to job #6.
5. **Automation re-plan** — the optimizer loop that decides what goes into each schedule slot. It never rebuilds forecasts, it reads the ones job #4 cached, which is why it can also run on its own after an edit.
6. **Nightly training batch** — the heavy Recorder work, deliberately parked in the small hours. It runs three jobs one after another (never at the same time — they share Recorder's worker thread): solar bias correction, which learns how your forecast provider is systematically wrong for your roof; the house consumption profile, which fits an hour-of-week model over `data_and_learning.house_consumption.training_window_days` of history; and the device energy records, which learn every consumer device's usage — its typical day, its runs and its power while running, shown in the device detail — and from them how much each `history_average` appliance actually draws while it is running. See [learned device energy](../device-energy.md) for what each learned figure means and how it is calculated, with worked examples. All of it is stored, so a restart reuses it instead of recomputing. Changing a relevant setting recomputes immediately rather than waiting for the next night, so you see your change take effect.
7. **Battery capacity forecast** — projects battery state of charge across the horizon: forecast solar minus forecast demand, with the scheduled action for each slot applied, carried forward from the current live reading. It is what draws the battery curve and why editing a slot moves it right away.

## The knobs that scale the cost

- `data_and_learning.recent_power_history.sampling_interval_seconds` (default 5 s) — how often job #1 samples. Lower means smoother bars and more work; it is the only job on a seconds-level cadence.
- `data_and_learning.training_time` (default `03:00`) — when the nightly batch runs. Pick a quiet hour: these jobs read a lot of Recorder history and you do not want them competing with anything.
- `data_and_learning.house_consumption.training_window_days` (default 56) — how much history the house consumption fit reads. This is the single biggest driver of job #6's cost. It has no effect on the per-quarter-hour work.
- The number of consumer devices, and an appliance's `consumption.projection.lookback_days` (default 30). The device energy records read up to three Recorder queries per device: its energy meter, its power sensor (if it has one) and its switch/climate entity (if it has one). Each entity is read once, over the longest window any device needs it for. A `history_average` appliance reads over its `lookback_days`; every other device, and every shared meter without such an appliance, over the default 30 days. A power sensor that reports every few seconds is the heaviest of these reads. Like `data_and_learning.house_consumption.training_window_days`, this is a **job #6** cost paid once a night, so it scales the nightly run rather than anything you wait for.

## If Home Assistant feels sluggish

All four quarter-hour boundaries behave the same. Job #4 fires at `:00`, `:15`, `:30` and `:45`, and measuring what a card actually waits for across each of them showed no difference between them — and no difference from ordinary background variation either. If you see a stall on the hour or half hour specifically, it is worth looking outside Helman: Home Assistant runs its own periodic Recorder and statistics work on those same boundaries.

Things worth checking, roughly in order:

- **Is it 03:00 (or your `data_and_learning.training_time`)?** That is job #6, and it is meant to be heavy. If it is landing at an awkward time, move it.
- **A very large `data_and_learning.house_consumption.training_window_days`** makes job #6 proportionally more expensive.
- **A very low `data_and_learning.recent_power_history.sampling_interval_seconds`** makes job #1 run more often. It does no I/O, so this costs CPU rather than Recorder time.
- **Lots of deferrable consumers** — job #6 reads the training window once per consumer, so the nightly cost scales with how many you configure.
- **Appliances estimating their energy use from history** — each one adds two multi-day reads to job #6, sized by its `consumption.projection.lookback_days`. Nightly only; nothing on the quarter-hour cadence and nothing a card waits for.
- **A stale-forecast banner on the cards** means rebuilds have been failing for over an hour; the Home Assistant log will say why.

