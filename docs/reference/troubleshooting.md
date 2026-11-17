# Troubleshooting

**The card is missing from the card picker.**
The card registers itself only for dashboards edited in the UI. For a YAML-mode dashboard, add `/helman_frontend/helman-card.js` as a JavaScript module resource. If you used to have `hass-helman-card` installed, remove its resource, or the card is registered twice.

**No devices under the house.**
The device tree needs a house **power** sensor in Energy nodes → House, and devices in the Devices tab.

**The house forecast is missing or only shows a status message.**
Check that a cumulative house energy sensor is set under Energy nodes → House → Forecast, and that Recorder has at least *minimum training window days* (14) of hourly statistics for it. **Data and learning** tells you which.

**Baseline or breakdown numbers look wrong.**
Every device meter must be a true sub-meter of the meter above it and of the house total. A meter counted in two places inflates the baseline. The device editor warns about meters nested inside a schedulable device's meter.

**The solar forecast is not corrected.**
The correction needs at least 10 usable days. Night slots and slots with fewer than 5 usable days are never corrected. See **Data and learning → Solar forecast correction → Diagnostics**.

**An optimizer does nothing.**
Open the schedule editor, switch to **Explain automation** and tap a slot in the window. The diagram shows the failing condition or gate. Common causes: the wrong [day type](../concepts/day-types.md) (*Run on days*), the inverter has no option for the needed action (*Stop export supported* fails), or missing battery settings (*battery parameters are missing*).

**The plan is right but nothing happens.**
**Execute actions** is off. It is in the inspector, next to the scheduled actions, and in every node's schedule section.

**A planned appliance slot did not run.**
If it was a *candidate*, its custom condition was false at execution time. The explanation view shows the last evaluation of the custom conditions.

**The inspector's price rows are empty for past days.**
`sensor.helman_grid_import_price` and your sell price entity must not be excluded from Recorder, and its `purge_keep_days` must cover the days you look at. The import side falls back to your tariff windows; the export side has no fallback.

**A warning banner says the forecast is stale.**
Forecasts have not been rebuilt for over an hour. The Home Assistant log says why. The cards keep the last good forecast meanwhile.

**Home Assistant feels sluggish at 03:00.**
That is the nightly training. Move it under Data and learning → **Training time**, or shorten the house *maximum training window days*. See [Background jobs](background-jobs.md#if-home-assistant-feels-sluggish).
