# Appliances

A schedulable device is an **appliance**: Helman plans when it runs and switches it. Two things matter for planning: how to switch it, and how much it draws while on.

## How to switch it

| Kind | Entity | Helman sends |
| --- | --- | --- |
| Generic | `switch`, `light`, `fan` or `media_player` | turn on / turn off |
| Climate | `climate` | the planned HVAC mode (heat, cool…) / off |
| EV charger | charge switch, use mode select, eco gear select | see [EV charger](ev-charger.md) |

The modes offered for a climate appliance are the ones its entity supports. Unsupported modes are not offered in the optimizer.

## How much it draws

To place an appliance and to project the battery, Helman needs its **energy per hour while on**:

- **Fixed**: you enter the kWh per hour, for example 0.75 for a 750 W pump.
- **History average**: Helman learns it every night from the device's meter and the hours its switch or climate entity was on, over the **lookback** (30 days by default). Until it has enough history it uses your fixed value as a fallback.

History average is the better choice for anything whose draw varies with the season, like a heat pump. The figure Helman uses is shown in the device editor and in **Data and learning → Device energy**.

## Manual control still works

You can switch an appliance by hand at any time, from Home Assistant or from its node detail. A manual switch holds until the next planned change. For longer, override the schedule. Hours an appliance ran by hand count toward its [daily minimum](../automation/appliance-runtime.md#daily-minimum-and-skipped-days), because Helman reads the runtime from history.
