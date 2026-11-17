# Reference

Facts to look up rather than read through.

- [Card options](cards.md): every YAML option of every card.
- [Entities](entities.md): the sensors, select and switches Helman creates.
- [Actions](actions.md): `helman.group_action` and `helman.get_group_entities`.
- [Background jobs](background-jobs.md): what Helman does on timers, and what it costs.
- [Troubleshooting](troubleshooting.md): common problems and their causes.
- [Development](development.md): building the frontend and running the tests.

The config itself is documented in the editor: every field has a **?** with its meaning and default. The config is stored as one document with five sections:

| Section | Editor tab |
| --- | --- |
| `energy_nodes` (`inverter`, `solar`, `battery`, `grid`, `house`) | Energy nodes |
| `devices` (`consumers`, `groupings`, naming settings) | Devices |
| `automation` (`enabled`, `system_optimizers`, `appliance_optimizers`) | Automation |
| `data_and_learning` (`training_time`, `solar_bias`, `house_consumption`, `recent_power_history`) | Data and learning |

Older configs are migrated automatically when loaded.

## Deep dives

For the curious, three documents describe the internals in full detail, with worked examples:

- [How a run plans](../automation.md): the three phases of an automation run.
- [Learned device energy](../device-energy.md): how every learned device figure is calculated.
- [Device reports](../device-reports.md): where every number in the reports comes from.
