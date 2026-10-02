# Device reports

The device reports card (`custom:helman-device-reports-card`) shows how the house's devices used energy over a period: how much each one used, where that energy came from (solar, battery, grid), and what it cost. Its reports are **Ranking** (who used it over the whole period) and **Over time** (how that developed).

Everything is computed by the backend from data Home Assistant already records, through one websocket command, `helman/device_report`. The card only picks the period and draws the answer.

## Where the numbers come from

| Input | Used for |
| --- | --- |
| **Device meters** (kWh, hourly long-term statistics) | Each metered device's energy |
| **Share sensors** (`sensor.helman_share_power_*`, W, hourly mean) | Each meterless child's estimated energy (`≈`) |
| **House meter** (Energy nodes → House → Forecast → Total energy) | The house total, and every remainder |
| **Grid import/export, solar, battery charge/discharge meters** | The hourly source mix |
| **Helman's import and export price sensors** | What each hour was bought and sold at |
| **Import price windows** (configured tariff) | The import rate for hours the price sensor has no history for |

- **One read.** The whole period is read once from the hourly statistics table, the same read the inspector's month and year views use. Each meter's hourly energy is the difference between consecutive readings, never the statistics `change` column.
- **Recent hours.** The hourly table lags real time by up to ~2 hours, so when a period ends less than 3 hours ago, its last 3 hours are topped up from the 5-minute table.
- **Requirements.** Reports need the house node of the device tree (it exists only with a house **power** sensor configured) and the house **energy** meter. Without either, the card explains which setting is missing instead of showing an empty report.
- **Period.** Last 7 / 30 / 90 days, this month, last month, this year, or a custom range; at most 366 days. Dates are local days in Home Assistant's time zone. An end date after today is cut to today.

---

## 1. Rows

The rows are the house subtree of the power card's device tree.

- **A row includes its children.** A breaker's row is its own meter, which already includes the devices behind it. Expand it to see them.
- **Unmeasured.** Every metered row with children gets an *Untracked consumption* child: per hour, the row's meter minus its children (metered and estimated), floored at 0. The house gets one too: the house meter minus its top-level devices. This is the same definition as the live unmeasured sensors, but it is built for every metered parent, whether it has a power sensor or not.
- **Over-allocation.** When a row's children measure more than its own meter in an hour, the floor hides it. That excess is summed as `overallocated_kwh`, and the row is marked *"children measure x kWh more than this meter"* when it is more than 1 % of the row. Only hours the row's own meter measured are compared, so children's energy from before that meter existed, or from its gaps, is not called over-allocation; the row's coverage mark says when its meter starts instead. So, per row, over the hours its meter measured: **children + unmeasured − overallocated = row**, exactly.
- **Estimated rows** (`≈`) are meterless children. Their energy is the hourly mean of their share sensor, read as Wh. The hour in progress counts only its elapsed part.

**Not the inspector's breakdown.** The inspector's house breakdown shows a carved meter's *own* energy (its meter minus its metered children). A device report row shows the meter's *whole* energy, children included. The two are different numbers on purpose.

**Example.** A breaker meter read 20 kWh. Behind it, a heater (estimated) used 5 kWh and a sub-meter measured 17 kWh, 2 kWh of that in hours where it exceeded the breaker:

| Row | kWh |
| --- | --- |
| Breaker | 20 |
| ├ Sub-meter | 17 |
| ├ ≈ Heater | 5 |
| └ Untracked consumption | 0 |

17 + 5 + 0 − 2 = 20. The breaker row is marked *"children measure 2.0 kWh more than this meter"*.

---

## 2. Coverage

An hour is **covered** for a row when its source had a statistics value for it: a meter reading, or a share sensor mean. A remainder is covered when its parent is.

`coverage` is covered hours ÷ the period's elapsed hours. A row under 99 % is marked *"data for N % of the period (from <date>)"*, so a small number is not read as "used nothing". The usual causes are a meter added during the period, and share sensors, which only exist since 2026-09-26.

---

## 3. The source split

Every hour, the house's energy is split into **solar**, **battery**, **grid** and **unattributed**. Each device in that hour is split in the same proportions.

The inputs per hour are import **I**, export **E**, solar **S**, battery charge **C**, discharge **D** and house **H**, all from the meters. The measured grid meters fix the grid side. Only two things cannot be told apart from hourly totals: whether charge came from solar or grid, and whether export came from solar or battery. For these, a fixed rule applies: **solar first**.

| Flow | Formula |
| --- | --- |
| solar → grid | `min(S, E)` |
| battery → grid | `min(D, E − solar→grid)` |
| solar → battery | `min(S − solar→grid, C)` |
| grid → battery | `min(I, C − solar→battery)` |
| grid → house | `I − grid→battery` |
| battery → house | `D − battery→grid` |
| solar → house | `clamp(H − grid→house − battery→house, 0, S − solar→grid − solar→battery)` |

Solar is capped by what solar delivered, so a missing or zero solar meter never produces solar.

With `F` = the three `→ house` flows and `D_h = max(H, F)`:

- each source's fraction is `flow / D_h`, and **unattributed** = `(D_h − F) / D_h`: the part of the house meter no measured source explains. It is never assigned to a source;
- when `F > H`, the excess `F − H` is reported as **mismatch** (losses, inverter self-use, meters that disagree);
- **ambiguous** = `min(C, I, S − solar→grid) + min(E, D, S)`: the energy whose source was decided only by the solar-first rule.

**Example.** H = 1, I = 0.5, S = 1, E = 0.5. Solar → grid = 0.5, grid → house = 0.5, solar → house = 0.5. The hour is **half grid, half solar**. (The power cards' live formula would call it all solar: on hourly totals it erases real grid use.)

The card shows a note when ambiguous, unattributed or mismatch is more than 1 % of the house.

**Missing meters.** A meter that is not configured counts as 0, and the card warns that the source colours are incomplete. Without a grid import meter, nothing says how much of the house the grid carried, so every device's energy is unattributed.

---

## 4. The battery

Battery energy has no price of its own: it costs what charged it. Over the whole period, the charged energy is split by what charged it:

- **g** = grid → battery ÷ charged, split further by the charging hour's import rate: recorded, configured tariff, or none;
- **s** = solar → battery ÷ charged, split by whether the hour has an export rate;
- **u** = 1 − g − s: charge no measured source explains.

The rates are energy-weighted: `paid rate = Σ(grid→battery × import rate) ÷ Σ grid→battery`, over the hours that have a rate, and the same for the export rate on the solar side. A period with no charging has u = 1.

**Example.** 1 kWh charged from the grid at 1 CZK/kWh and 9 kWh at 3 CZK/kWh: the battery's paid rate is (1 + 27) ÷ 10 = **2.8 CZK/kWh**, not the plain average of 2.

---

## 5. Money: paid and forgone

Each row has two money figures:

- **Paid**: what the energy cost. Grid energy at the hour's import rate, plus battery energy at its grid-charging cost.
- **Forgone**: what the energy could have earned. Solar energy at the hour's export rate (it could have been exported instead), plus battery energy at its solar-charging value. Forgone can be **negative** when the export price is.

| Share of a row's kWh `x` | Paid | Forgone |
| --- | --- | --- |
| grid, hour has an import rate | `x × import rate` | 0 (known) |
| grid, no import rate | unpriced | 0 (known) |
| solar, hour has an export rate | 0 (known) | `x × export rate` |
| solar, no export rate | 0 (known) | unpriced |
| battery | rated grid share at the paid rate; solar share 0; the rest unpriced | rated solar share at the forgone rate; grid share 0; the rest unpriced |
| unattributed | unpriced | unpriced |

One rule holds for both figures: **priced kWh + unpriced kWh = the row's kWh**. A known zero counts as priced: a device that ran only on solar paid exactly 0, with nothing unpriced. The amount is empty (—) only when nothing at all was priced.

- **Partial.** When more than 1 % of a row's kWh is unpriced, the figure is drawn hatched and marked *partial*. There is no `≥` or `≤`: a missing rate could have been positive or negative. Hover shows *"priced X of Y kWh"*.
- **Today's tariff.** The import rate comes from the recorded price sensor first. Hours older than the sensor are priced from the configured import windows, which hold no history: **today's** tariff is applied to the past. Hover says how many kWh were priced that way.
- **Export rates** are recorded only. Hours before the export price sensor existed leave the solar share of forgone unpriced.

---

## 6. Freshness

- A report is computed when it is fetched, and says when ("as of HH:MM").
- **Complete** reports are kept for good: the recorder had compiled the whole period when it was fetched, so its hours no longer change. This is recorder progress, not the clock: a report fetched at 00:20 whose 23:00 hour is not compiled yet is incomplete.
- Every other report expires **5 minutes** after it was computed, including one whose period has since ended, and is fetched again when it is next shown.
- The rolling presets (last N days, this month, this year) move at local midnight.

---

## 7. Over time

The **Over time** report shows every top-level device's energy per **day**, **week** or **month** of the period (the 1d / 1w / 1mo selector, shown only on this tab).

- **Buckets are clamped to the period.** A week runs Monday to Sunday and a month is the calendar month, but a bucket the period starts or ends inside covers only the period's part of it. Such a bucket, and one still running (today's), is **partial**: drawn dimmed, and its hover says so. Buckets follow local days, so a week across a daylight-saving change holds 167 or 169 hours.
- **One ranking for the whole period.** The devices are ranked once, by their period total, not per bucket, so a device keeps its place and its colour in every column. Per-bucket ranking would shift colours and make trends unreadable.
- **Top X** (3 / 5 / 10, default 5) picks how many devices are drawn; the rest are folded into *Other devices*. It changes no fetch.
- **Each column** stacks the top devices in rank order, then *Other devices*, then the house's *Untracked consumption*. A tick marks the house meter. Over the hours the house meter measured, **devices + untracked − overallocated = house**, exactly, per bucket.
- **Over-allocation.** When the devices measure more than the house meter, the stack rises above the tick; the excess is hatched and the hover says *"devices measure x kWh more than the house meter"*.

**Example.** A week where the house meter read 25 kWh and the devices 30 kWh in hours where they exceeded it: the stack reaches 30, the tick sits at 25, and 30 + 0 − 5 = 25.

---

## Accepted risks

- **Devices share the house's hourly mix.** A device running at 06:10 and solar arriving at 06:50 share that hour's mix. Whether charge came from solar or grid, and export from solar or battery, within one hour, is settled by the solar-first rule; its size is reported as *ambiguous*. Meter inconsistency is reported as *unattributed* and *mismatch*, not resolved. The house's grid share never exceeds the import meter.
- **The battery's charge origin is one split for the whole period.** Conversion losses make battery energy look about 10 % cheaper than it was, and a short period that starts with a full battery can discharge more than it charged.
- **Coverage follows today's tree.** Share sensors exist only since 2026-09-26, and a meter added during the period starts during the period. Their earlier energy lands in the parent's unmeasured row, and the row is marked. A device removed from the tree is not listed; its energy lands in the remainder.
- **A Home Assistant outage puts the missed energy into one hour**, and that hour's mix and rate price it.
- **Share sensors are slightly biased.** Their hysteresis, and a mean that leaves out unavailable stretches, bias estimated rows slightly.
- **Today's tariff prices the past** wherever the import price sensor has no history (see section 5).
