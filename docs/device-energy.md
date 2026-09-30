# Learned device energy

Every night the training batch reads each consumer device's recorder history and stores a small **usage record** for it. That record is what the device detail dialog ("Last N days" tiles), the device editor and the Training tab's device table show.

## Where the numbers come from

| Input | Used for |
| --- | --- |
| **Energy meter** (kWh, cumulative) | Typical day; average while switched on |
| **Power sensor** (W) | Runs: how many, how long, how much, average power while active |
| **Running signal** (a `switch` or `climate` entity) | Average while switched on; limits runs to the times the signal is on |
| **Parent's meter** (for a child device with no meter of its own) | The child's share of that meter, which is then used for everything above |

- **Window:** the last `consumption.projection.lookback_days` days (default 30), counted back from the time of the run. If the recorder has already deleted older history (after 10 days by default), the window is shorter, and the title shows the real number of days.
- **Missing values:** a figure the history can't answer is left out of the record, and the UI shows no tile for it.
- **Failures:** if a device can't be read, it keeps its previous record, and the Training tab lists the reason.

The record, as stored (the washing machine from the examples below, on a smart plug):

```json
{
  "daily_kwh":      {"mean": 1.41, "median": 1.4, "min": 0.0, "max": 2.5, "days": 7},
  "runs_per_day":   1.2,
  "run_minutes":    {"median": 85, "min": 60, "max": 110},
  "run_kwh":        {"median": 0.94, "min": 0.55, "max": 1.3},
  "running_kw":     0.66,
  "on_kwh_per_hour": 0.37
}
```

---

## 1. Typical day — `daily_kwh`

How much the meter went up on each **complete local day** in the window. Days with 0 kWh count too. The record stores the mean, median, min, max and the number of days.

**Example.** A 7-day window. The meter went up by:

| Mon | Tue | Wed | Thu | Fri | Sat | Sun |
| --- | --- | --- | --- | --- | --- | --- |
| 1.2 | 0.0 | 2.5 | 1.8 | 0.9 | 1.4 | 2.1 |

- median = **1.40 kWh** (the middle value of the sorted list), mean = 9.9 / 7 = **1.41 kWh**
- UI: title *Last 7 days*, tile *Typical day* **1.40 kWh**, with the line `0.00–2.50 kWh · mean 1.41 kWh` under it

A device whose meter includes metered children also includes their energy here.

---

## 2. Runs — `runs_per_day`, `run_minutes`, `run_kwh`

These need a **power sensor**. Home Assistant only records changes, so each reading is treated as holding until the next one. An `unavailable` state is a gap: that time is not counted as off.

**When is the device running?**

1. **Standby floor:** the lowest *hourly average* power over the hours the readings fully cover. A single idle hour is enough to set it.
2. **Threshold:** `floor + max(10 W, 5 % × (p95 − floor))`. Here p95 is the time-weighted 95th percentile of power. For a device that runs less than 5 % of the time, p95 is about the same as the floor, so the threshold is simply *floor + 10 W*.
3. **Running** means the power is above the threshold. If the device has a running signal, the signal must also be on.
4. **Clean-up:** off-gaps shorter than **2 min** are treated as part of the run around them, and runs shorter than **1 min** are dropped.
5. **Energy of a run:** the power integrated over the run, including any merged gaps.

**Example — a washing machine** (standby 2 W, so the threshold is 12 W):

| From | To | Power | Result |
| --- | --- | --- | --- |
| 10:05 | 10:25 | 2000 W (heating) | above → 0.667 kWh |
| 10:25 | 10:50 | 150 W (washing) | above → 0.063 kWh |
| 10:50 | 10:51 | 5 W (pause) | below, but only a 1-min gap → merged |
| 10:51 | 11:20 | 150 W | above → 0.073 kWh |
| 11:20 | 11:30 | 800 W (spin) | above → 0.133 kWh |

→ **one run, 10:05–11:30: 85 min, 0.94 kWh**.

**The figures.** Only **complete** runs count here. A run cut off by the start or end of the window has an unknown length, so it is left out.

- `runs_per_day` = complete runs ÷ days of power history. *12 runs in 10 days → **1.2***
- `run_minutes` / `run_kwh` = median, min and max over the complete runs. *Runs of 85 min / 0.94 kWh, 60 min / 0.55 kWh and 110 min / 1.30 kWh → tile* **Typical run 85 min · 0.94 kWh**, *with the line `60–110 min · 0.55–1.30 kWh` under it*

---

## 3. Average power while active — `running_kw`

The total energy of **all** runs (cut-off runs included) divided by the total time they ran. This is the device's average power **while it actually draws power**.

**Example.** For the three runs above: (0.94 + 0.55 + 1.30) kWh ÷ (85 + 60 + 110) min = 2.79 kWh ÷ 4.25 h = **0.66 kW** → shown as *Average power while active* **656 W**.

---

## 4. Average while switched on — `on_kwh_per_hour`

This needs a **running signal** and a **meter**. It is the meter's energy during the times the signal was on, divided by the number of hours the signal was on. Time the signal was on but the device was idle (a thermostat that is satisfied, a charger waiting) is counted too. That is intended: this figure is what a `history_average` forecast projects for each hour the device is planned to be on.

**Example — a water heater on a smart switch.** The switch was on for 6 h in total. During those 6 h the meter went up by 9.6 kWh, but the element was actually heating for only 4 h at 2.4 kW.

- `on_kwh_per_hour` = 9.6 ÷ 6 = **1.6 kWh/h** (what one planned hour costs), shown as *Average while switched on* **1.6 kW**
- `running_kw` = **2.4 kW** (from the power sensor: only the time it was heating), shown as *Average power while active* **2.4 kW**

**How the two relate.** Both figures divide roughly the same energy by a number of hours. `running_kw` divides by the time the device actually drew power. `on_kwh_per_hour` divides by the whole time the signal was on, which is at least as long, because runs only count while the signal is on. So for one device, `on_kwh_per_hour` ≤ `running_kw`. They are equal when the device draws power the whole time it is switched on. *Washing machine above: the plug stays on for about 2.5 h per wash, so 2.79 kWh ÷ 7.5 h = **0.37 kWh/h** while switched on (**370 W**), against **0.66 kW** while active (**656 W**).* The two figures can differ by a little beyond that, because one comes from the meter and the other from the power sensor.

**Example — a breaker as the running signal.** A socket circuit whose running signal is its breaker switch, which is on about 16 h a day. Its meter records **0.55 kWh/day**, so `on_kwh_per_hour` = 0.55 ÷ 16 ≈ **0.034 kWh/h**, shown as *Average while switched on* **34 W**. The power sensor sees only its short active bursts, so `running_kw` is **95 W**, shown as *Average power while active* **95 W**. The meter agrees with 34 W over 16 h, not with 95 W: the two figures answer different questions, and which one matters depends on the device (see *How the UI shows it*).

If the device's projection is `history_average`, this figure becomes its forecast estimate. If it is missing or rounds to zero, the forecast falls back to the configured `hourly_energy_kwh`.

---

## 5. Devices without their own meter (shared meter)

A child device with only a running signal (for example one of several AC units on one breaker meter) gets a **share of its parent's own energy**. The parent's own energy is its meter minus any metered children.

1. **Cut the window into segments** at every on/off edge of every member's signal. Within a segment, the same set of members is running the whole time.
2. **Learn each member's power (its weight):**
   - Segments where no member runs give the parent's standby: *baseline = kWh ÷ hours*.
   - Every other segment says: *(kWh ÷ hours) − baseline = the sum of the running members' powers*.
   - Solve this with a non-negative least-squares fit, where longer segments count more. A member that ran for less than 1 h in total gets no weight and takes the mean of the others.
3. **Split each segment's energy** between the members running in it, in the ratio of their weights. If the parent has `children_tolerance_percent` set, each member's share is capped at *weight × (1 + tolerance)*, and anything above the cap is left unassigned. The live share sensors use the same split.
4. A member's **average while switched on** = the energy it was given ÷ the hours it was running. Its typical day adds up what it was given per local day. Its runs are its signal's on-intervals (segments that touch are joined into one run), each with the energy it was given, so its **average power while active** equals its average while switched on. A device with its own meter but no power sensor gets no average power while active: a parent's power sensor is never used for it.

**Example — two ACs, A and B, on one breaker:**

| Segment | Hours | kWh | kW | − baseline |
| --- | --- | --- | --- | --- |
| nobody | 10 | 1.0 | 0.10 | *baseline* |
| A only | 2 | 3.0 | 1.50 | 1.40 |
| B only | 1 | 0.8 | 0.80 | 0.70 |
| A + B | 1 | 2.4 | 2.40 | 2.30 |

- Fitted weights: **A = 1.44 kW, B = 0.78 kW**
- The A+B segment's 2.4 kWh is split 1.44 : 0.78 → A 1.56 kWh, B 0.84 kWh
- A: (3.0 + 1.56) ÷ 3 h = **1.52 kWh/h** while switched on, shown as **1.5 kW**
- B: (0.8 + 0.84) ÷ 2 h = **0.82 kWh/h** while switched on, shown as **820 W**
- The standby (1.0 kWh while nobody ran) is not given to either AC.

---

## How the UI shows it

Every per-hour figure is shown as **power**, auto-scaled the same way as the helman-card boxes: `XXX W` below 1000 W, `X.X kW` from there. A stored 0.034 kWh/h reads **34 W**, a stored 1.52 kWh/h reads **1.5 kW**. Only *Per day* stays in kWh. The configured `hourly_energy_kwh` is still entered in kWh per hour in the device form; it is only displayed as power.

The **headline** figure depends on whether the device scheduler can plan the device. The device editor, the Training tab's device table and the device detail dialog all choose it the same way:

| Device | Headline | Falls back to | Scheduler note |
| --- | --- | --- | --- |
| schedulable | *Average while switched on* (`on_kwh_per_hour`) | *Daily average* | yes |
| not schedulable | *Average power while active* (`running_kw`) | *Daily average* | no |

- A schedulable device headlines what the scheduler projects for each planned hour. Its hover adds the note *The device scheduler projects with this figure*.
- Any other device is never planned, so what it draws while it runs is the useful figure. The daily-average fallback applies only to a device with its own meter but no power sensor.

Its colour tells you where the number came from:

| Colour | Shown value | When |
| --- | --- | --- |
| green | `on_kwh_per_hour` or `running_kw` | the headline figure above is in the record |
| orange | `daily_kwh.mean ÷ 24` | the headline figure is missing. *Example: 1.41 kWh/day → 59 W* |
| blue | the configured `hourly_energy_kwh` | a schedulable device whose forecast projects with it: `fixed`, or `history_average` with no adopted estimate. The learned value follows in parentheses: `1.0 kW (59 W)`. The scheduler note then belongs to the blue figure |

Hovering over the value shows every measure, in this order: *Average while switched on*, *Average power while active*, *Daily average*, *Per day* (kWh), *Configured* (when the forecast projects with it), then the scheduler note and the reason when there is no estimate.

The device detail tiles map to the sections above. The first learned tile is the headline under its own name, and the other power figure gets a tile of its own, so no figure is shown twice:

| Device | First tile | Last tile |
| --- | --- | --- |
| schedulable | *Average while switched on* (4) | *Average power while active* (3) |
| not schedulable | *Average power while active* (3) | *Average while switched on* (4) |

**Typical day** (1), **Runs per day** and **Typical run** (2) sit between them, unchanged. The dev instance's socket-circuit breaker, for example, is not schedulable: its detail headlines *Průměrný příkon za běhu* **95 W**, with *Průměr při zapnutí* **34 W** beside it.
