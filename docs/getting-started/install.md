# Install

## With HACS

1. In Home Assistant, open **HACS → ⋮ → Custom repositories**.
2. Add `https://github.com/Scarfsail/hass-helman` with the category **Integration**.
3. Install **Helman Energy** and restart Home Assistant.
4. Go to **Settings → Devices & services → Add integration** and add **Helman Energy**.

That is all. The integration registers its Lovelace cards by itself and adds a **Helman Energy Config** panel to the sidebar.

!!! info "YAML-mode dashboards"
    The cards are registered automatically for dashboards edited in the UI. A dashboard kept in YAML mode needs the resource added by hand: `/helman_frontend/helman-card.js` as a JavaScript module.

## Add the cards

Edit a dashboard, add a card and search for *Helman*. No card needs any entity configuration: they all read the Helman config.

| Card | Shows | Good for |
| --- | --- | --- |
| `custom:helman-card` | Live flows and the device tree | The main dashboard |
| `custom:helman-solar-inspector-card` | The day chart: forecast, actuals, battery, prices, money, the plan | A wide view of its own |
| `custom:helman-device-reports-card` | Energy and money per device over a period | An analysis view |
| `custom:helman-simple-card` | Compact flow diagram | Wall tablets, phones |
| `custom:helman-device-card` | One device or node as a tile | Next to other tiles |

A starting dashboard:

```yaml
views:
  - title: Energy
    type: sections
    sections:
      - cards:
          - type: custom:helman-card
      - cards:
          - type: custom:helman-solar-inspector-card
        column_span: 2
  - title: Reports
    type: sections
    sections:
      - cards:
          - type: custom:helman-device-reports-card
        column_span: 3
```

Card options are listed in [Card options](../reference/cards.md).

## Moving from `hass-helman-card`

The card used to be a separate HACS repository, `hass-helman-card`. It is now part of this integration and that repository is archived. If you had it installed:

1. Remove `hass-helman-card` from HACS.
2. Remove any Lovelace resource pointing at `/hacsfiles/hass-helman-card/…` (**Settings → Dashboards → Resources**), or the card is registered twice.
3. Install this integration. The card name `custom:helman-card` did not change, so your dashboards keep working.

Next: [First setup](first-setup.md).
