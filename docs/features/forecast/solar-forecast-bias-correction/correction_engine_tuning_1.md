# Solar Bias Correction Engine Tuning

## 1. The Morning Ramp-up Problem and Data Resolution (Hourly vs. 15-Minute)

### User's Comment
> "Would the change to 15-minute source data even help with the original problem? Also I miss a bit more analysis of the original problem in the md file including examples from the real data."

### Analysis of the Original Problem (with Real Data)

The core issue you are observing—where the forecast predicts steady early morning generation, but reality stays at zero longer and then abruptly surges—is a classic symptom of a physical obstacle (like a hill, trees, or a neighbor's roof) blocking the sun early in the day. 

Let's look at your actual data from the system for **April 26, 2026**:

**Raw Forecast (Hourly):**
- **06:00:** 364 Wh
- **07:00:** 1292.5 Wh
- **08:00:** 3010.75 Wh

**Real Production (15-min Actuals currently gathered by the system):**
- **06:00 - 06:45:** 0 Wh (Total for 06:00 hour: 0 Wh)
- **07:00:** 0 Wh
- **07:15:** 600 Wh   <-- *The sun clears the obstacle!*
- **07:30:** 200 Wh
- **07:45:** 200 Wh   (Total for 07:00 hour: 1000 Wh)
- **08:00:** 300 Wh
- **08:15:** 400 Wh
- **08:30:** 800 Wh
- **08:45:** 900 Wh   (Total for 08:00 hour: 2400 Wh)

**What the Correction Engine Does Today:**
Because the raw forecast is only provided in 1-hour chunks, the training engine is forced to "zoom out" and aggregate your 15-minute actuals into 1-hour blocks to compare them.
For the `07:00` hour, it compares the total actuals (`1000 Wh`) to the forecast (`1292.5 Wh`) and calculates a single factor: `0.77x`. 

When it applies this factor to tomorrow's forecast, it simply multiplies the whole hour by 0.77. It tells the UI that the generation at 07:00 will be roughly `995 Wh`. 

**Why this fails to capture the pattern:**
A single hourly factor completely destroys the true "shape" of the morning. It smears the 0 Wh period (07:00) and the massive surge (07:15) into one flat average. You will never see the "slower ramp-up followed by a fast surge" in the corrected forecast as long as the correction is applied at a 1-hour resolution.

### Would 15-Minute Source Data Help?

**Changing the Actuals Source (e.g., to `sensor.power_production_now`)?**
No. As shown in the data above, the system's actuals gathering engine is *already* perfectly capturing generation in 15-minute energy slots using your cumulative energy sensors. Switching to `power_production_now` would not give us better data; it would actually be worse because we'd have to mathematically integrate instantaneous Watts into Watt-hours, which is computationally heavier and error-prone.

**Having 15-Minute Forecast Data?**
**Yes, absolutely.** This is the real bottleneck. If the raw forecast was available in 15-minute slots (let's say evenly distributed as ~323 Wh per 15-min for the 07:00 hour), the engine would calculate four separate correction factors:
- `07:00`: 0 / 323 = **0.0x** (Slower ramp-up learned)
- `07:15`: 600 / 323 = **1.85x** (Fast surge learned)
- `07:30`: 200 / 323 = **0.61x**
- `07:45`: 200 / 323 = **0.61x**

### Conclusion on Point 1

15-minute source data is precisely what is needed to solve the shape of the morning ramp-up. The actuals are already at 15-min resolution; the trainer just needs to be fed a 15-min forecast as well. As it turns out, the upstream entity already exposes the 15-min shape we need — see the next subsection.

#### Picking the interpolation method (the source already has 15-min shape!)

The upstream `sensor.energy_production_today` *already exposes a 15-minute shape*: the entity has a `wh_period` attribute (24 hourly Wh values, currently consumed by the trainer) **and** a `watts` attribute (96 instantaneous-power values at 15-minute spacing). Verified live: 24 vs 96 entries on the running entity.

**Recommended approach: watts-weighted split.** Use the existing `watts` attribute to allocate each hourly `wh_period[h]` across the four sub-slots in proportion to the watts the source itself predicts at those 15-min boundaries:

`wh_15[t] = wh_period[h] * watts[t] / sum(watts[h..h+45])`

This preserves the hourly Wh total exactly while inheriting the sun-elevation curve that the upstream forecast already encodes — no separate astronomical model, no uniform `/4` split (which would be wrong near sunrise/sunset), and no extra dependencies. The data is already on the entity; the change is purely in `forecast_history.py:load_historical_per_slot_forecast`, which currently keys off `wh_period` and would also need to read `watts` and emit four sub-slot values per hour.


## 2. Hardcoded Correction Limits (`clamp_min` and `clamp_max`)

### Analysis & Findings

In `custom_components/helman/const.py`, there are fixed clamps applied to the computed bias correction factor:
- `SOLAR_BIAS_DEFAULT_CLAMP_MIN = 0.3`
- `SOLAR_BIAS_DEFAULT_CLAMP_MAX = 2.0`

The purpose of these clamps is to protect the system against extreme forecast errors or bad actuals data (e.g. an internet outage causing the inverter to report 0 Wh for an hour). By default, the system restricts the correction factor to a band between 30% and 200% of the raw forecast.

However, in your specific use case—a physical obstruction causing zero generation early in the morning, followed by a sudden burst of energy—these clamps actively fight against the physical reality.

#### Existing safeguards already protect against full-day outages
Two filters in `trainer.py` are relevant when reasoning about how aggressive the clamps need to be:
- **Day-level filter `_DAY_RATIO_MIN = 0.05`** (`trainer.py:18,118`): if a whole day's `sum(actual) / day_forecast` falls below 5% (or above `_DAY_RATIO_MAX = 5.0`), the entire day is dropped from training. An inverter outage that reports `0 Wh` for the whole day is therefore *not* learned — the day is filtered out before it can poison any slot.
- **Slot floor `_SLOT_FORECAST_SUM_FLOOR_WH = 50.0`** (`trainer.py:20,182`): slots whose summed forecast across the training window is below 50 Wh are omitted from the profile entirely (no correction applied). This is non-binding for the 06:00 example in spring (forecast sums to ~2 kWh over 14 days), but matters at dawn/dusk slots in winter.

The implication for the clamp discussion is that **lowering `clamp_min` below `0.3` is safer than it sounds**: the most-cited failure mode ("the inverter dropped offline and the system learned 0") is already prevented at the *day* level by `_DAY_RATIO_MIN`. The remaining risk is a *partial* outage where most of the day looks normal but a single slot is suspiciously zero — which the existing slot-invalidation pipeline (`slot_invalidation.py`, also tracked in `metadata.invalidated_slots_by_date`) is designed to handle independently.

#### The Impact of `clamp_min`
If you have a physical obstruction completely blocking the sun early in the morning, your real production is `0`. The "true" factor should be `0.0`. However, the algorithm enforces the `0.3` clamp. This means the corrected forecast will *never* go below 30% of the raw forecast. 

**Simulation & Extreme Values:**
- **If `clamp_min` = 0.0:** The system can learn to perfectly predict exactly `0 Wh` during blocked hours. The historical concern with this setting was an inverter outage falsely teaching the system "this hour produces nothing", but as noted in the safeguards subsection above, that failure mode is already prevented at the day level (`_DAY_RATIO_MIN`) and at the slot level (slot-invalidation pipeline). With those guardrails in place, `0.0` is the correct setting for your physical-obstruction case.
- **Your Current State (0.3):** **Permanently too optimistic in the early morning** for your blocked panels — the corrected forecast can never go below 30% of the raw, even when the panels are physically dark.

#### The Impact of `clamp_max`

**Important caveat — at the current 1-hour resolution, `clamp_max` is mostly inactive for the morning ramp.** The trainer aggregates 15-min actuals into the *hour* before computing a ratio. For 07:00 on April 26 the hour totals to `0+600+200+200 = 1000 Wh` actual against `1292.5 Wh` forecast — that's a ratio of `0.77`, comfortably inside `[0.3, 2.0]`. The 07:15 surge `600 / 323 ≈ 1.86` only becomes a number the engine can *see* once the trainer also operates at 15-minute resolution (see Point 1). So this section's argument should be read as **conditional on adopting 15-min resolution first** — it is the constraint that will start to bite *after* that change, not the constraint that is biting today.

When the sun finally clears the obstacle, production surges rapidly. We saw in the real data that at 07:15, production spiked to 600 Wh while the hourly forecast rate was only ~323 Wh per 15 minutes. The true ratio compared to the baseline forecast might be `2.5x` or even `3.0x` for that short period, but the algorithm caps the correction at `2.0x` — once the trainer can resolve sub-hour slots.

(Side note: the 18:00 slot in your current profile is already pinned at the existing `2.0` cap and the 07:00 / 08:00 slots show factors below 1.0, consistent with the analysis above — `clamp_max` already binds *somewhere* in the day, just not on the morning surge.)

**Simulation & Extreme Values:**
- **If `clamp_max` = 5.0 or 10.0 (Extreme High):**
  - *Pros:* Allows the algorithm to perfectly model massive post-obstacle surges.
  - *Cons:* If the base forecast severely underpredicts (e.g., predicts 100 Wh but you produce 500 Wh due to cloud edge effect), the system learns a 5.0x multiplier. If the next day the forecast is 2000 Wh, the system multiplies it by 5.0, resulting in a wildly unrealistic 10,000 Wh prediction.
- **Your Current State (2.0):** It **underpredicts the speed and height of the surge**, flattening out the "catch-up" phase of the morning.

### Proposed Settings for Your Use Case

Since you have a predictable, daily physical obstruction rather than random anomalies, you should tune these values to allow the engine to trust your daily 0 Wh actuals and the subsequent surge:

- **`clamp_min`: 0.0** (Allows the system to confidently predict exactly zero generation while the panels are blocked. Outage-style failure modes are already covered by `_DAY_RATIO_MIN` at the day level and by the slot-invalidation pipeline at the slot level — see the safeguards subsection above — so the historical justification for a non-zero floor no longer applies.)
- **`clamp_max`: 3.0** (Relaxing this from 2.0 to 3.0 gives the engine enough headroom to model the fast morning surge without being so high that a single bad day causes massive hallucinations).

*Note: As long as the trainer uses "Ratio of Sums" (Point 3) and 1-hour resolution (Point 1), changing these clamps won't fully solve the problem, because the hourly sum dilutes the extremes anyway. But once those are fixed, proper clamps will be essential.*


## 3. "Ratio of Sums" vs "Median of Ratios"

### Analysis & Findings

In `custom_components/helman/solar_bias_correction/trainer.py`, the training algorithm currently calculates the profile factor for each slot using the **Ratio of Sums** method:
`factor = sum(actuals over N days) / sum(forecasts over N days)`

To verify the mathematical impact on the `06:00` slot, the actual stored profile and historical recorder data were inspected directly. The current trained profile (`.storage/helman.solar_bias_correction`) records:
- `factors["06:00"] = 0.418`
- `usable_days = 8`

Querying `sensor.energy_production_today` (`wh_period` attribute) and `sensor.solax_total_solar_energy` over the last 14 days reproduces the same training set: 8 usable days at this slot. The per-day ratios for `06:00` are:

| Date       | Forecast (Wh) | Actual (Wh) | Ratio |
|------------|--------------:|------------:|------:|
| 2026-04-15 |          97.2 |       200.0 | 2.057 |
| 2026-04-16 |         198.8 |         0.0 | 0.000 |
| 2026-04-17 |         231.2 |       300.0 | 1.297 |
| 2026-04-21 |         115.0 |         0.0 | 0.000 |
| 2026-04-22 |         313.2 |       300.0 | 0.958 |
| 2026-04-23 |         370.5 |         0.0 | 0.000 |
| 2026-04-25 |         364.0 |         0.0 | 0.000 |
| 2026-04-26 |         385.8 |         0.0 | 0.000 |

Sum of forecasts ≈ 2076 Wh, sum of actuals ≈ 800 Wh, **Ratio of Sums ≈ 0.39** (the small discrepancy vs the stored `0.418` is explained by the cumulative-energy edge-attribution rules in `_aggregate_actuals_into_forecast_slot` and `query_cumulative_slot_energy_changes`, not by the algorithm itself).

#### The Problem with "Ratio of Sums"
Five of the eight days produced exactly `0 Wh` at `06:00` (panels still blocked) and three days produced significantly more than the forecast. Because the algorithm sums raw Watt-hours, the three above-forecast days carry enough total energy (≈ 800 Wh against ≈ 824 Wh of forecast on those three days) to drag the combined ratio up to ~0.39 — even though the *typical* outcome at 06:00 is "zero generation".
- **Resulting factor (Ratio of Sums): ~0.39 (stored: 0.418)**
The engine learns a blended, conservative factor that forces tomorrow's early-morning forecast to be ~40% of the raw prediction—even though your panels are almost certainly going to produce 0 Wh at 06:00. This is a classic case of mean/sum mathematics failing to filter out noise.

#### The Alternative: "Median of Ratios"
Instead of summing the raw Watt-hours, the system could first calculate the ratio for *each individual day* (`daily_actual / daily_forecast`), and then take the **Median** of those daily ratios.
Lining up the eight daily ratios above:
`[0.000, 0.000, 0.000, 0.000, 0.000, 0.958, 1.297, 2.057]`
With `n = 8`, the median is the average of the 4th and 5th values: `(0.000 + 0.000) / 2 = 0.000`.

### Expected Impact & Proposal

Switching from "Ratio of Sums" to "Median of Ratios" fundamentally changes how the correction engine "learns":

**Pros (Expected Impact):**
- **Extreme Robustness to Outliers:** The engine will completely ignore anomalous days (like a day with sudden cloud cover or an internet dropout) as long as they represent less than 50% of the training window.
- **Accurate "Zero" Tracking:** It will correctly learn and lock onto `0.0` for hours where your panels are consistently blocked by physical objects.
- **Sharper Curves:** It prevents the morning surge from being "smeared" backward into the zero-generation hours.

**Cons/Risks:**
- **Slower to Adapt to Real Changes:** If a seasonal shadow slowly starts encroaching on a new hour of the morning, a median approach requires the shadow to affect the panels for *more than half* of the training days (e.g., 8 out of 14 days) before the median suddenly "snaps" to the new lower ratio. The "Ratio of Sums" approach would have gradually smoothly blended the change over those two weeks.
- **Discontinuous "snap" behaviour with small N.** The median is a step function of the underlying daily ratios. With a small training window (current config: `min_history_days = 6`, max window 60), a single day flipping from "blocked" to "produces something" can cause the median to jump from `0.0` to a positive value in one training run — and then back the next day. The `0.0` case in the 06:00 example is benign (median stays at 0.0 unless 5 of 8 days produce), but slots near the median boundary will visibly oscillate.
- **Mitigation: trimmed mean.** A useful middle ground is a *trimmed mean of ratios* — sort the daily ratios, drop the top and bottom 1–2, and average the rest. With 8 days, dropping the highest 1 (`2.057`) and lowest 1 (`0.000`) gives `mean(0,0,0,0,0.958,1.297) = 0.376`. With 14 days, dropping 2 each side absorbs almost all single-day noise without the snap behaviour. This recovers most of the outlier-robustness of the median while remaining continuous in the data.

**Recommended path:** Try the trimmed mean first (less footgun risk) and reserve pure median for slots where binary "blocked vs not blocked" behaviour dominates and oscillation is acceptable. The choice could even be configurable per-deployment.

### Proposed Change for Your Use Case
**Switch the training engine away from "Ratio of Sums". Start with a trimmed mean of daily ratios; fall back to a pure median only if the trimmed mean still smears the morning ramp.**
For physical obstructions (which are a structural, binary state: either the sun is blocked or it isn't), any per-day-ratio aggregator is vastly superior to summing raw Watt-hours. The current "Ratio of Sums" approach is better suited for slowly drifting, generalized bias (like panel degradation), but it is actively sabotaging your system's ability to model sharp morning shadows.

---

## 4. Phasing the Rollout

The three changes proposed above (resolution, aggregation method, clamps) are **independent** and have different blast radii. Bundling them into one release makes attribution of regressions hard. Suggested phased rollout:

| Phase | Change | Risk | How to verify |
|------:|:-------|:-----|:--------------|
| 1 | Switch slot aggregation from Ratio-of-Sums to Median (or trimmed mean) of daily ratios. | Low — affects *which* number is learned, not *what data* is consumed. Day-level filters still apply. | Compare per-slot factor_min/median/max in metadata before/after a re-train; expect the dawn/dusk slots to drop toward 0 and the mid-day slots to barely move. |
| 2 | Move trainer to 15-min resolution using `watts`-weighted interpolation of hourly `wh_period`. | Medium — ~4× more slots in the profile, more storage, more chances for data sparsity at night. `_SLOT_FORECAST_SUM_FLOOR_WH` should keep zero-forecast night slots out of the profile automatically. | Inspect the morning hours via the `helman/solar_bias/inspector` websocket; the corrected curve should show the 07:00→07:15 step instead of a flat hourly average. |
| 3 | Relax `clamp_min` (`0.3 → 0.0`) and `clamp_max` (`2.0 → 3.0`). | Medium — only meaningful *after* phase 2, since current 1-hour aggregation rarely hits the existing clamps for the morning ramp. The day-level filter and slot-invalidation pipeline already protect against the most-cited failure modes (Section 2). | Watch `metadata.factor_min`, `factor_max`, and check that no slot pins to the new extremes for multiple consecutive training runs without a physical explanation. |

Each phase ships behind its own training-fingerprint bump (`compute_fingerprint` already covers `clamp_min`/`clamp_max`, and a code change to the aggregation method or resolution should also be reflected in the fingerprint so a re-train is forced). Per-slot RMSE on a one-day holdout, computed via the inspector data, is a lightweight regression metric that can be inspected manually after each phase.
