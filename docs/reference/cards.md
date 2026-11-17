# Card options

No card needs entity configuration: they read the Helman config. All options below are optional, and each card also has a visual editor.

## Energy flow card

```yaml
type: custom:helman-card
collapsed_consumers_count: 5
show_empty_groups: false
show_others_group: true
```

| Option | Default | Meaning |
| --- | --- | --- |
| `collapsed_consumers_count` | 3 | House devices shown before **More** |
| `card_size` | — | Grid rows the card reports to the dashboard layout |
| `show_empty_groups` | `false` | While *Group by* is active, also list groups with no devices |
| `show_others_group` | `true` | While *Group by* is active, list devices outside every group under *Others* |

## Inspector

```yaml
type: custom:helman-solar-inspector-card
slot_minutes: 30
hide_money_strip: false
```

| Option | Default | Meaning |
| --- | --- | --- |
| `slot_minutes` | by width | Slot width at open: `15`, `30` or `60`. A phone opens at 60, a laptop at 30 |
| `daylight_only_default` | `true` | Open cropped to the hours with sun |
| `daylight_threshold_w` | 100 | Solar power from which a slot counts as having sun |
| `show_bias_ratio` | `false` | Show the solar-correction diagnostics from the start: raw forecast, correction strip, per-slot factors |
| `dim_incomplete_slots` | `true` | Dim chart columns whose data is incomplete |
| `hide_schedule_strip` | `false` | Hide the scheduled actions |
| `hide_price_strip` | `false` | Hide the price rows |
| `hide_money_strip` | `false` | Hide the money row and money tiles |
| `hide_aggregate_views` | `false` | Hide the month (**D**) and year (**M**) views |
| `house_focus` | `false` | Judge the house consumption forecast: day pills and totals compare actual with predicted |
| `chart_series` | all | Limit the chart to some series: `raw`, `corrected`, `actual`, `houseForecast`, `houseActual`, `batterySocForecast`, `batterySocActual`, `gridForecast`, `gridActual`, `batteryForecast`… |
| `transparent_background` | `false` | No card background |

A solar-only inspector:

```yaml
type: custom:helman-solar-inspector-card
chart_series: [raw, corrected, actual]
hide_schedule_strip: true
hide_money_strip: true
show_bias_ratio: true
```

## Device reports

```yaml
type: custom:helman-device-reports-card
transparent_background: false
```

## Simple card

```yaml
type: custom:helman-simple-card
width: 200
transparent_background: false
```

| Option | Default | Meaning |
| --- | --- | --- |
| `width` | 200 | Card width in pixels |
| `height` | auto | Card height in pixels |
| `transparent_background` | `false` | No card background |

## Device card

```yaml
type: custom:helman-device-card
device: sensor.pool_filtration_energy
fields: [state, power, energy_today]
hide_when_idle: [power]
```

| Option | Meaning |
| --- | --- |
| `device` | A device, by its energy entity. Use either `device` or `node` |
| `node` | An energy node: `solar`, `battery`, `grid` or `house` |
| `name` | Defaults to the device's or node's name |
| `fields` | Shown fields, in order: `state`, `connection`, `mode`, `power`, `energy_today`, `target_temperature`, `current_temperature`, `soc`, `import_today`, `export_today`. Each target offers the ones that apply to it |
| `hide_when_idle` | Fields hidden while the target is idle |
