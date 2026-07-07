## Current situation
Currently, all the logic of the application is implemented in the frontend. This includes data fetching, processing, and business logic. While this approach allows for a quick development cycle, it can lead to performance issues and a need to configure the card on every page where I put it. I plan to create simpler cards in scope of this one like battery and remaining time, panels power and so on. If I do that, I would need to configure each card on every page where I put it. This is not ideal and can lead to a lot of redundant work.

## Proposed solution
To address these issues, I propose moving the logic to the backend. This would involve creating a backend hass custom component that handles all the data fetching, processing, and business logic. The frontend would then simply fetch the processed data from the backend and display it. This approach would have several benefits:
1. Improved performance: By moving the logic to the backend, we can reduce the amount of processing that needs to be done in the frontend, which can lead to improved performance and a smoother user experience.
2. Centralized logic: By centralizing the logic in the backend, we can ensure that it is consistent across all pages and components. This can help to reduce bugs and make it easier to maintain the application.
3. Easier configuration: By moving the logic to the backend, we can simplify the configuration process for the frontend. Instead of having to configure each card on every page, we can simply configure the backend once, and the frontend can fetch the necessary data without needing to worry about the underlying logic.

Overall, moving the logic to the backend can lead to a more efficient and maintainable application, while also improving the user experience. It allows for better separation of concerns and can make it easier to manage and scale the application in the future.

For the backend custom component, I think about a combination of custom sensors exposing some specific data (e.g. remaining battery time and so on) and use of the native hass websocket API to fetch the data in the frontend (e.g. historical data). This way we can have a more efficient communication between the frontend and backend, and we can also take advantage of the real-time updates provided by the websocket API.


## Example of my current card configuration
```yaml
type: custom:helman-card
power_sensor_name_cleaner_regex: " Výkon$"
history_buckets: 60
history_bucket_duration: 1
sources_title: Zdroje energie
consumers_title: Distribuce energie
device_label_text:
  Jističové skříně:
    Jističe - Technická zálohované z FV: 🔋T
    Jističe - Technická nezálohované: ⚡T
    Jističe - Garáž zálohované z FV: 🔋G
    Jističe - Bazénová zálohované z FV: 🔋B
    Jističe - Bazénová nezálohované: ⚡B
  Režimy:
    Elektřina - Vypnout pryč: ⏻🔒
    Elektřina - Vypnout na noc: ⏻😴
others_group_label: Ostatní
groups_title: "Seskupit:"
power_devices:
  solar:
    source_name: FV Panely
    entities:
      power: sensor.solax_pv_power_total
      today_energy: sensor.solax_today_s_solar_energy
      remaining_today_energy_forecast: sensor.energy_production_today_remaining
  battery:
    source_name: Z baterie
    consumption_name: Nabíjení baterie
    entities:
      power: sensor.solax_battery_power_charge
      capacity: sensor.solax_battery_capacity
      min_soc: sensor.solax_battery_min_soc
      max_soc: number.solax_battery_charge_upper_soc
      remaining_energy: sensor.solax_remaining_battery_capacity
  grid:
    source_name: Import ze sítě
    consumption_name: Export do sítě
    entities:
      power: sensor.solax_grid
      today_import: sensor.solax_today_s_import_energy
      today_export: sensor.solax_today_s_export_energy
  house:
    consumption_name: Spotřeba domu
    power_sensor_label: Měření spotřeby elektřiny
    power_switch_label: Ovládání spotřeby elektřiny
    unmeasured_power_title: 👻 Nesledovaná spotřeba
    entities:
      power: sensor.house_load
```
