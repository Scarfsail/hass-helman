# Actions

Two Home Assistant actions let your automations and scripts work with Helman's [groupings](../devices/groupings.md). Both take the **ids** of the grouping and the group, as shown in the Devices tab, not their names. Both read the config on every call, so editor changes apply at once. An unknown grouping or group is an error.

## `helman.group_action`

Runs `turn_on`, `turn_off` or `toggle` on every entity of a group, in device-tree order. It works whether or not schedule execution is on.

| Field | Required | Meaning |
| --- | --- | --- |
| `grouping` | yes | Grouping id |
| `group` | yes | Group id |
| `action` | yes | `turn_on`, `turn_off` or `toggle` |
| `delay_ms` | no | Pause between two entities, default 500 |
| `continue_on_error` | no | Default `true`: a failing entity is logged and the rest still run. `false` fails the action, naming the entities that did not respond |

```yaml
action: helman.group_action
data:
  grouping: modes
  group: power_off_night
  action: turn_off
```

## `helman.get_group_entities`

Returns the group's entities. Call it with a response variable:

```yaml
action: helman.get_group_entities
data:
  grouping: modes
  group: power_off_away
response_variable: group
# group.entity_ids: [...], group.skipped: [...]
```

## Which entities a group has

A group's entities are those of its **direct members**, devices whose own group assignment names the group. For each member, the entity is its on/off control: its switch or light, else an EV charger's charge switch, else its climate entity. A member without any of these is listed in `skipped` and logged. The inverter is never included.
