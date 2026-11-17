# Getting started

Helman reads and writes ordinary Home Assistant entities. It never talks to hardware itself: your inverter, charger and switch integrations do that, and Helman tells them what to do. Setup therefore has three parts:

1. **Install** the integration. It brings the cards and a config editor panel along. → [Install](install.md)
2. **Point Helman at your entities**: the inverter, the four energy nodes (solar, battery, grid, house), prices and your devices. → [First setup](first-setup.md)
3. **Let it learn, then let it act.** Training needs a few days of history. Planning starts immediately, but Helman only touches hardware after you switch execution on. → [First setup, step 6](first-setup.md#6-turn-on-automation-then-execution)

## Before you start

Check that you have these. Each item says what Helman uses it for, so you can tell what you lose without it.

| Item | Used for | Without it |
| --- | --- | --- |
| **Solar power** sensor (W) and **today's solar energy** (kWh) | Live flows, the solar forecast correction | Nothing works; this is the core |
| **Battery power** (W), **state of charge** (%), **min/max SoC** | Live flows, battery projection, every battery optimizer | No battery planning |
| **Grid power** (W, signed) and today's import/export | Live flows, detecting curtailed solar | No grid figures, weaker forecast correction |
| **House power** (W) and a **cumulative house energy** sensor (kWh) | Device tree, house consumption forecast, reports | No device tree, no consumption forecast |
| A **mode select** on the inverter (or a helper) | Executing the battery plan | Plans are shown but never applied |
| A **solar forecast** with daily energy sensors | All planning | No plan |
| **Export price** entity with the day-ahead prices | Price-driven optimizers, money figures | Export is valued at zero |
| **Import price windows** (your tariff, entered in Helman) | Cheap/expensive windows, money figures | No battery reserve planning |
| **Recorder** history | Training, inspector, reports | No learning |

!!! tip "SolaX owners"
    With a SolaX hybrid inverter on the `solax_modbus` integration, pick the **SolaX inverter** [hardware profile](../devices/hardware-profiles.md) and Helman finds the entities itself, including the mode control. Skip the [supporting entities](../supporting-entities.md) chapter.

!!! note "Other inverters"
    Some values have to be built by hand, for example a house load sensor, battery SoC bounds, a signed grid power sensor, and a mode selector that turns schedule actions into inverter settings. [Supporting entities](../supporting-entities.md) explains each one and gives a working example.

## One inverter, one battery

Helman manages a single battery inverter. Several inverters are not supported.
