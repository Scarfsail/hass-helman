# Node details

Tap any icon on the flow card, or any device in the inspector or a report, and its **node detail** opens. Every node has the same layout, so once you know one you know them all:

1. **Headline**: the live value in large type, and what it means in words (*charging 3.1 kW · used between 10 and 100 %*).
2. **Coming from · now**: which sources feed it at this moment. For a device this is the house's current mix, marked as estimated.
3. **Controls**: what you can do here. Switch a device from its headline icon, and use the **control tile** of everything Helman controls (see [Switching by hand](#switching-by-hand)).
4. **Sections** that open on tap, each with a one-line summary so you rarely need to open them: **Schedule**, **Forecast**, **History & statistics**, **Technical details**.

<div class="shots" markdown>
![Battery](../assets/images/detail-battery.png){ .shot }
![House](../assets/images/detail-house.png){ .shot }
</div>

## Per node

| Node | Headline | Worth knowing |
| --- | --- | --- |
| **Solar** | Production now | Forecast section: the production chart, the [solar day gauge](#solar-day-gauge) for today, the day's total, peak and end of production, and the next days |
| **Battery** | State of charge | Time to full or empty *at the recent rate*. The plan-based estimate is in Forecast. The battery is controlled through the inverter: its control tile is the inverter's, with the inverter's mode picker and a link to the inverter |
| **Grid** | Import or export now | Per-phase bars when phase sensors exist; prices and planned import/export in Forecast |
| **House** | Consumption now | The largest subdevices as bars; the forecast with planned appliance runs drawn on it |
| **Inverter** | Power through the inverter, with its load against the rated power | Two gauges: what flows into it (solar, battery, grid charging the battery) and out of it (house, battery, grid). The control tile adds *Inverter reports* (✓ when the registers match the last command, ✗ when not) and its mode picker: one segmented bar for up to three modes, a dropdown for more. The full *Did the inverter do what the plan asked?* chain (Plan → Helman sent → Inverter reports) is in Technical details, above the register table; Technical details is shown to admins only |
| **Device** | Power now | A breadcrumb back to its parent, subdevices, the switch, its schedule and its learned usage |
| **EV charger** | Charging state | Connection, car SoC and limit, the charging mode in its control tile, and the charging ledger in History |

<div class="shots" markdown>
![Device with schedule](../assets/images/detail-device-schedule.png){ .shot }
![Inverter](../assets/images/detail-inverter.png){ .shot }
</div>

## Solar day gauge

While the solar forecast correction applies (at least 10 usable training days), the solar detail's Forecast section shows a **Today's forecast** gauge between the production chart and the summary rows. The [inspector](inspector.md) shows the same gauge, with the same numbers, in today's daily totals. It answers three questions: how far today's corrected forecast has been from reality so far, how much Helman changed the rest of today, and how far to trust what is left.

- **Grey lane, on top:** the raw forecast from your provider, darker before now and lighter after. Its two values are the raw forecast so far and the raw rest of today.
- **Bar, before now:** what the panels produced so far, in yellow. An orange underline marks a shortfall against the corrected forecast so far, a green fill an overshoot. Below it, *2.0 of 4.9 forecast so far −59 %* reads: 2.0 kWh produced against the 4.9 kWh Helman's corrected forecast expected for the same slots, not the day's total.
- **Bar, after now:** Helman's forecast for the rest of today, hatched, with its value at the end. The box is the likely range, orange when the rest is likely lower, green when likely higher. Below it, *4.6–5.6 −33 %* is that range and how far its middle is from Helman's rest.
- **Steps:** the step at now links the raw forecast so far to the corrected one. The yellow step at the end links the raw rest of today to Helman's rest, so you see how much the correction moved it.
- **Chip:** *Remaining 4.6–5.6 kWh · trust 66 %* and a direction icon: the likely rest of today, the trust, and which way the rest is likely to go against Helman's forecast. An orange ↓ means likely lower, a green ↑ likely higher, the same tones as the range box. A blue ? means no clear direction (within 5 % either way): the rest could land anywhere in the range. Hover or tap the icon for a sentence on what it means for the rest of today, with the range values.

Before now and after now each take at least a quarter of the width and are to scale within their own part, so the rest of today stays readable late in the day and the day so far early in the morning. Hover or tap the gauge for the slot it was computed for and the values on both steps. Every percentage is against the corrected forecast, never the raw one. Before the first measured slot of the day (night, dawn) only the rest of today shows, and the chip reads *trust after first slot*, with no direction icon.

**Trust** is a heuristic from today's data only, not a probability learned from past days. It is 100 % only when Helman's live correction has fully caught up with how the day is going and the day has been steady. It drops for two reasons:

- **The gap Helman has not corrected yet.** The [live day ratio](../concepts/forecasts.md#solar-your-providers-forecast-corrected-for-your-roof) is trusted only partly in the morning and is bounded to 0.3–2, so part of today's miss may still be in the forecast. When that gap is over 5 %, the chip's direction icon shows which way the rest is likely to go: ↓ lower or ↑ higher.
- **Swings.** How much each elapsed hour's production ratio wandered around the day's, weighted by that hour's expected energy. A steady day scores near zero; a day of sun and cloud scores high and widens the likely range.

## Switching by hand

Tapping a device's switch tile switches it right away. That holds **until the next planned change**, then the schedule takes over again.

Everything Helman controls (the inverter, the battery through it, the EV charger and each scheduled device) has a **control tile** on its Overview:

- **Who decides**: Helman's schedule, you until a time, or why nothing is applied (execution off, automation off, not automated).
- **Planned now**: what the plan has it doing and who set it.
- The node's own control: the inverter's mode as a dropdown, the EV charging mode as a segmented bar (up to three choices show as a bar, more as a dropdown). A mode picked here is written at once and holds until Helman's next planned window. While a plan window sets the EV mode, the bar is locked and says until when.
- **Override…** opens the [schedule editor](schedule-editor.md) for just this device, to keep a manual state for a range you pick.
- **Return to plan** appears while your override is running and hands the rest of it back to the automation.

A device that drives several lanes, like one meter shared by two pumps, gets one control tile per lane, each titled with its lane's name. The **Schedule** section shows only the plan: the strip, the coming changes, the execution note and the automations.

## History & statistics

For a device, this section shows what it used over a period you pick, where that energy came from (solar, battery, grid) and what it cost, from the same data as the [device reports](device-reports.md). Money is an estimate from the prices Helman knows, not your bill.
