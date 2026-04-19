I'm thinking about a new feature - automation. What do I need to automate? House energy flow - solar panels, battery, export to grid, deferrable consumers.

Currently, I need to manually monitor what's SoC of battery in the morning and what's the export price and if there will be enough solar power later. Therefore if it's good idea to export the solar power to grid now and charge battery later or if it's even better to fully discharge battery and charge it later or not at all and charge battery now because there will be not enough solar energy during the day.

The same applies for winter days/nights when there is not enough solar power to even power the house during the day. So we have cheaper import price at night where I need to again manually check what will be solar power tomorrow, set manual charging from grid to desired battery SoC and stop it in the morning when there is higher import price, so house is powered from the battery during the more expensive day time and also we have a capacity in case of grid outage.

Then another use case is deferrable consumers. For example, I have a washing machine and dishwasher. I can run them at night when there is cheaper import price or during the day when there is excess solar power. But I need to manually check the price and solar power forecast and then start the machines at the right time. The same applies for our EV - check battery SoC in the car and decide when to start charging it (night from cheper grid? In the morning from battery before I leave to work as house battery will get charged from solar? Or on the weekned when we are home and there will be enough power from solar? Or something else?).


These are few simple use cases that I can think of. I want to automate all of this. I want to have a system that will monitor the energy flow in the house, the battery SoC, the solar power production, the import/export prices and then make decisions on when to charge/discharge the battery, when to run deferrable consumers and when to export/import power from/to the grid. I could control:

- Force Battery charging/discharging from grid to desired SoC
- Stop battery charging from solar (so the remaining energy is exported to grid)
- Start battery charging from solar
- Switch to normal mode in which battery is charged first and then the excess is exported to grid
- Start deferrable consumers (washing machine, dishwasher, EV charging)
- Get EV SoC