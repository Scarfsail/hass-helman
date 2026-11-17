# Day types

Whether an appliance should run on solar, or whether the battery should hold back charging, depends on what kind of day it is. Helman classifies each day of the horizon by one number:

```
ratio = forecast solar energy of the day / forecast consumption of the day
```

| Day type | Ratio (defaults) | Meaning |
| --- | --- | --- |
| **Surplus** | ≥ 1.3, and the battery reaches full | The sun covers the house and fills the battery, with energy left over |
| **Tight** | between 0.7 and 1.3 | Roughly balanced; there is no energy to waste |
| **Deficit** | ≤ 0.7 | The sun does not cover the house |

A day whose ratio passes 1.3 but whose projected battery never gets full counts as **tight**: "surplus" means there really is energy to spare.

## How it is used

Optimizers gate on the day type with the **Run on days** condition (`run_when`):

- [Charge hold](../automation/charge-hold.md) defaults to *surplus* days only, because holding back charging on a tight day risks an evening with an empty battery.
- [Appliance runtime](../automation/appliance-runtime.md) defaults to *surplus* and *tight*. A heater that should run only on sunshine gets *surplus* alone.

## Details worth knowing

- **Today counts the whole day.** For today, the energy already produced and consumed is added to the forecast for the rest of the day, so the type does not decay toward deficit as the afternoon passes.
- **Each optimizer sees its own day.** The ratio is computed over the house as that optimizer plans against it. An appliance's own planned run is left out of the consumption that decides whether it may run.
- **No flapping.** A ratio sitting right at a threshold keeps the type it already had. It has to move clearly past the threshold to change.
- **Adjustable.** The two thresholds are **Deficit below ratio** and **Surplus above ratio** under **Automation → Automation settings**.
