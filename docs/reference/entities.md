# Entities

Helman publishes its live figures and forecasts as entities, so you can use them in your own dashboards and automations.

## Live power

| Entity | Meaning |
| --- | --- |
| `sensor.helman_house_consumption_power` | House consumption |
| `sensor.helman_house_consumption_power_l1` … `_l3` | House consumption per phase |
| `sensor.helman_house_supply_power` | Total power supplied (solar, battery, grid) |
| `sensor.helman_consumer_total_power` | Total power consumed (house, battery charging, export) |
| `sensor.helman_solar_source_ratio`, `_battery_`, `_grid_` | Share of the supply from each source, % |
| `sensor.helman_battery_time_to_full`, `…_to_empty` | Minutes at the recent rate; attributes `target_time`, `target_soc` |
| `sensor.helman_unmeasured_power_<device>` | A device's untracked consumption (its meter minus its children) |
| `sensor.helman_share_power_<device>`, `sensor.helman_share_energy_<device>` | The estimated share of a device without its own meter |

## Forecasts

| Entity | Meaning |
| --- | --- |
| `sensor.helman_solar_forecast_today`, `_tomorrow`, `_d2` … `_d7` | Corrected solar forecast per day |
| `sensor.helman_solar_forecast_today_remaining` | Corrected solar still to come today |
| `sensor.helman_solar_forecast_current`, `…_current_corrected` | This slot's solar forecast, raw and corrected |
| `sensor.helman_house_consumption_forecast_current` | This slot's house consumption forecast |
| `sensor.helman_battery_soc_forecast_current`, `sensor.helman_battery_net_forecast_current` | This slot's battery forecast |
| `sensor.helman_grid_net_forecast_current`, `…_import_…`, `…_export_…` | This slot's grid forecast |

## Prices

| Entity | Meaning |
| --- | --- |
| `sensor.helman_grid_import_price` | The import price now, from your tariff windows |
| `sensor.helman_grid_export_price` | The export price now and day-ahead, from your price entity |

Keep both in Recorder: the inspector and the reports read past prices from their history.

## Control

| Entity | Meaning |
| --- | --- |
| `select.helman_inverter_mode` | With the SolaX inverter profile: the inverter mode, one option per schedule action |
| `switch.helman_ev_charging_<device>` | With the SolaX EV charger profile: starts and stops charging |
