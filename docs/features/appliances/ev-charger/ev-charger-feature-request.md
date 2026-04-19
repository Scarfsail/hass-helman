I want to add another module which should be integrated with the scheduler. The module (feature) should cover ev charger. 
Specifically, ability to configure entities for the EV charger like:
- switch.ev_nabijeni
- select.solax_ev_charger_charger_use_mode
- select.solax_ev_charger_eco_gear

Then for EV (might be more than one)
- sensor.kona_ev_battery_level
- number.kona_ac_charging_limit

And then have ability to see on FE battery level of my EV cars and their max limit. The config might also contain manually enetered max batt capacity per car in kWh or max charging power in kW. I expect the FE will receive these entity ids from backend to show some visualization. 

Then also be able to schedule charging of the car in combination with the existing action (e.g. stop discharging from battery, so the EV is charged from grid during the night). Also I want to be able to set the use mode (e.g. fast, eco, ..) and eco gear (6A, 10A) in the scheduler slot.

I believe we should extend the action of the slot to invertor action and then ev action and in future maybe more (e.g. appliances actions). Maybe propose few options here. We also don't need to be constraint by backward compatibility as we release both FE and BE at the same time, so we could afford big breaking changes in the contract when needed.

I also would like to see then a forecast for the car SoC if charging is planned. So adding it also to forecast might be useful, but I'm not sure how it fits there.... I'll welcome any proposals.

This is very rough idea of the feature, I expect we refine it together.
