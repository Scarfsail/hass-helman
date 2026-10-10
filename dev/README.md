# Dev-only helpers

Nothing under `dev/` ships: the release zip is built from `custom_components/helman` alone.

## `solax_modbus/` — SolaX Modbus stub for the dev container

Hardware profiles (inverter, EV charger) resolve their vendor entities through the entity registry: the domain and `solax_modbus` unique id within the chosen `solax_modbus` config entry, or, for the EV charger, on the chosen HA device of it. The dev container has no `solax_modbus` integration; it mirrors prod's entities through `remote_homeassistant`, whose registry rows carry platform `remote_homeassistant`, no config entry and unique ids of their own. Without help, the editor on dev offers no SolaX entry and every profile slot reads "not found".

The stub is a `solax_modbus` integration with a config flow and no entities. Setting up an entry creates one HA device under it per device the snapshot names (prod's device names), and re-labels the mirror's registry rows for that entry as `solax_modbus` rows under the entry, with prod's unique ids, each on its device, taken from `registry_snapshot.json`. The entity ids don't change, so the mirrored states and their dev recorder history stay where they are, and helman resolves profiles on dev exactly as on prod.

> **Warning: writes from dev reach the real device.** The mirror forwards every service call that targets a mirrored entity id to prod, so anything dev helman executes drives the real inverter and charger.

> **Warning: never let dev and prod helman execute at once.** Turn execution off on prod while dev executes, or test on dev by picking modes by hand.

### Mount

hass-core's `.devcontainer/devcontainer.json` bind-mounts the stub beside helman:

```
"source=${localWorkspaceFolder}/../hass-helman/dev/solax_modbus,target=/workspaces/hass-core/config/custom_components/solax_modbus,type=bind,consistency=cached"
```

Rebuild the dev container after adding the mount, then restart Home Assistant.

### Add the integration

Settings → Devices & services → Add integration → "SolaX Modbus (dev stub)". Add one entry per device; the flow offers the snapshot's device titles that don't have an entry yet (prod today: "SolaX" and "SolaX_EV_Charger"). Each entry logs one line with its claimed, already-claimed and skipped counts and the skipped entity ids.

Only rows that exist when the entry is set up are claimed. If new mirrored entities appear later, reload the entry to claim them. A reload also moves rows the entry claimed before the stub created devices onto their devices.

### Refresh the snapshot

`registry_snapshot.json` is prod's truth: `{"<entry title>": {"<entity_id>": {"unique_id": "…", "device": "<device name>"}}}` for every `solax_modbus` row on prod. It is keyed by entity id because one unique id can be registered in several domains: the EV charger's `control_command` is both a sensor and a select. Refresh it after the SolaX integration on prod changes, and commit the result:

```
HASS_PROD_TOKEN=… .venv/bin/python -I scripts/snapshot_solax_registry.py
```

The token is a prod long-lived access token; it is read from the environment and never written anywhere. The snapshot holds only ids and device names.

### Expected side effect: `…_2` rows

Once a row is claimed, the mirror's next `async_get_or_create` for that entity finds no row under its own unique id and registers a new, empty `…_2` row (for example `sensor.solax_pv_power_total_2`). It stays unavailable; the mirrored states still land on the original entity id, which the stub claimed. The `…_2` rows are harmless and can be ignored.

### Remove

Delete the stub's entries under Settings → Devices & services. Removing an entry deletes its claimed rows with it. The mirror's unique ids then still sit on the `…_2` rows, so delete those by hand and restart Home Assistant; the mirror re-registers its rows under the original entity ids. Drop the mount from `devcontainer.json` and rebuild to remove the stub entirely.
