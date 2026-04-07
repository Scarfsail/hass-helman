# Appliance Icons: FE Handover

`helman/get_appliances` now always returns an icon in `appliance.metadata.icon`.

- If the appliance config contains `icon`, the backend returns that value unchanged.
- If the appliance config omits `icon` or the field is cleared in the editor, the backend returns the default icon `mdi:lightning-bolt`.

Example:

```json
{
  "id": "dishwasher",
  "kind": "generic",
  "metadata": {
    "icon": "mdi:lightning-bolt"
  }
}
```

Frontend can render `appliance.metadata.icon` directly and does not need any local fallback for missing appliance icons.
