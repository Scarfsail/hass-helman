# EV charger

An EV charger is a device of kind **EV charger**. It has more to configure than a switch, because a charge can run at full power or follow the solar surplus, and the car has its own battery.

## Configuration

| Part | What it is |
| --- | --- |
| **Charge switch** | Starts and stops charging |
| **Use mode** select and its modes | Each mode maps to a behaviour: *fixed max power* (charge at full power) or *surplus aware* (follow the solar surplus) |
| **Eco gear** select and its gears | Optional current steps for surplus charging, each with its minimum power (6 A = 3.5 kW, 10 A = 6.9 kW) |
| **Max charging power** | The charger's limit in kW |
| **Energy and power** meters | What the charger delivered |
| **Vehicles** | Each car with its SoC entity, charge limit entity, battery capacity and max charging power |

With the **SolaX EV charger** [hardware profile](hardware-profiles.md) all of this except the vehicles is filled in for you.

## Scheduling a charge

A charging action in the schedule names the **vehicle**, the **use mode** and, for a surplus-aware mode, the **eco gear**. Helman projects the vehicle's expected SoC across the plan, and a car at or above its charge limit is not charged.

Charging is usually conditional on the car being there. Put that in a [custom condition](../automation/condition-groups.md#custom-conditions), for example the charger's connection sensor being *connected*. Windows are then planned as candidates and run as soon as the car is plugged in.

## Charging the car from the grid without draining the house

Add [Battery hold while EV charges](../automation/ev-battery-hold.md). While the charger draws power, the house battery does not discharge into the car.

## The charging ledger

The charger's node detail lists every charging session: when, how much, and from which sources. A session is recognised by the charger drawing more than 1 kW.
