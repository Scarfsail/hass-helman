# Solar Bias Correction Engine Tuning - Part 2

## Analysis of Live Data and Performance (April 27, 2026)

Following the implementation of the phase 1 and phase 2 changes from the previous tuning document (switching to 15-minute slot resolution and changing the training aggregation to `trimmed_mean` of daily ratios), the system is exhibiting two key issues:

1. **Morning Ramp-up is still too optimistic:** The corrected forecast does not push the prediction down enough during the early morning obstruction period.
2. **Noon is over-corrected:** Mid-day predictions are heavily inflated compared to the actual production and the raw forecast.

An analysis of the raw historical and training data via the `helman/solar_bias/inspector` websocket reveals exactly why this is happening.

---

### 1. The Quantization Problem (Morning Optimism)

**The Discovery:**
The actual generation data (derived from the inverter's cumulative energy sensors) is heavily quantized. The inverter reports energy in increments of **0.1 kWh (100 Wh)**.

Looking at the 15-minute slot actuals for the early morning of April 27:
- **06:00:** 0 Wh
- **06:15:** 100 Wh
- **06:30:** 100 Wh
- **06:45:** 100 Wh
- **07:00:** 100 Wh
- **07:15:** 100 Wh

Because we increased the resolution to 15 minutes, the actual energy generated in these early slots is very small. The *true* generation is smoothly increasing (e.g., 20 Wh, 40 Wh, 60 Wh), but the sensor reports `0 Wh` until a 100 Wh boundary is crossed, causing a sudden `100 Wh` step.

**Why `trimmed_mean` fails here:**
When the system calculates daily ratios (`daily_actual / daily_forecast`), this quantization causes extreme volatility. 
If the raw forecast for a slot is 30 Wh:
- Day 1 (sensor hasn't ticked over): Actual = 0 Wh $\rightarrow$ Ratio = **0.0**
- Day 2 (sensor ticks over): Actual = 100 Wh $\rightarrow$ Ratio = **3.33**

A `trimmed_mean` or `median` treats these as independent data points. It drops the extremes and averages the remaining percentage spikes. It completely loses the mathematical truth that "over 10 days, 300 Wh were forecasted and 300 Wh were generated." As a result, the engine learns noisy, artificially elevated factors (around `0.75`) for the morning slots instead of the true ratio, keeping the forecast too optimistic.

### 2. The Low-Volume Distortion (Noon Over-Correction)

**The Discovery:**
At 12:00, the raw forecast was `9,359 Wh`, and the actual production was `10,000 Wh` (a ~1.06x ratio). However, the corrected forecast jumped to `10,679 Wh`, indicating a trained factor of roughly **1.14**. At 13:00, it applied a factor of **1.27**.

**Why `trimmed_mean` fails here:**
When you take the mean of daily ratios, **every day gets an equal vote, regardless of its energy volume.**
Consider two days in the training window:
- **Day A (Heavy Overcast):** Forecast = 500 Wh, Actual = 1,000 Wh. Ratio = **2.0**
- **Day B (Clear Sky):** Forecast = 2,500 Wh, Actual = 2,500 Wh. Ratio = **1.0**

The `trimmed_mean` gives them equal weight, pushing the factor up to `1.5`. When a clear day (like April 27) arrives with a massive 10,000 Wh forecast, the engine multiplies it by the inflated factor, predicting a wildly unrealistic 15,000 Wh. 

### 3. Conclusion: 15-Minute Slots Already Solved the Smearing

In the previous tuning document, the "Ratio of Sums" method was blamed for "smearing" the morning surge. However, the data shows that **the root cause of the smearing was the 1-hour resolution, not the aggregation method.**

A 1-hour slot forcibly blended the dark `06:00-06:30` period with the sunny `06:30-07:00` period. Now that the engine operates at 15-minute resolution, the dark `06:00-06:15` slot is physically isolated. If we sum the actuals for just that 15-minute slice across 10 days, the sum will genuinely be near zero, and the ratio will be near zero.

"Ratio of Sums" (`sum(actuals) / sum(forecasts)`) is the mathematical antidote to both current problems:
1. **It inherently filters quantization noise:** Summing the 0s and 100s over 14 days perfectly reconstructs the true generation curve.
2. **It inherently volume-weights:** A 2,500 Wh sunny day will dominate the sum, preventing a 500 Wh cloudy day from distorting the mid-day clear-sky factors.

---

## Proposed Action

1. **Revert Aggregation Method:** Update `trainer.py` to revert from `_trimmed_mean` of daily ratios back to the **Ratio of Sums** (`sum_actual / sum_forecast`).
2. **Maintain 15-Minute Resolution:** Keep the 15-minute slots and the `watts`-weighted interpolation, as this provides the necessary temporal isolation to model the physical shadow. 
3. **Bump Fingerprint:** Ensure `_ALGORITHM_VERSION` in `trainer.py` is updated to force a retrain across the fleet.