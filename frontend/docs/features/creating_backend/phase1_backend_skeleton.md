# Phase 1: Backend Skeleton

## Goal
Create a minimal, HACS-installable Home Assistant custom component (`helman`) that
can be set up via the UI. It does nothing functional yet, but establishes all the
structural scaffolding subsequent phases will build upon.

## Deliverables
- New git repository `hass-helman`
- Custom component installable from HACS or by manual copy to `custom_components/`
- Config flow: single-instance, set-up-once UI
- `hass.data[DOMAIN]` entry populated on setup
- Clean unload path

## Files to Create

### `manifest.json`
```json
{
  "domain": "helman",
  "name": "Helman Energy",
  "version": "0.1.0",
  "config_flow": true,
  "dependencies": [],
  "requirements": [],
  "documentation": "https://github.com/Scarfsail/hass-helman",
  "issue_tracker": "https://github.com/Scarfsail/hass-helman/issues",
  "codeowners": ["@Scarfsail"],
  "iot_class": "local_push"
}
```

### `const.py`
```python
DOMAIN = "helman"
NAME = "Helman Energy"
STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.config"
```

### `config_flow.py`
Follows the single-instance pattern from both reference projects:

```python
import secrets
from homeassistant import config_entries
from .const import DOMAIN, NAME

class HelmanConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1
    CONNECTION_CLASS = config_entries.CONN_CLASS_LOCAL_PUSH

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        await self.async_set_unique_id(secrets.token_hex(6))
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title=NAME, data={})
```

No user input form is needed – the integration is a singleton with no setup
parameters (config comes later via storage).

### `__init__.py`
```python
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from .const import DOMAIN

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {}   # placeholder for coordinator
    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data[DOMAIN].pop(entry.entry_id, None)
    return True
```

### `strings.json` + `translations/en.json`
Minimal translations for the config flow and abort reason:

```json
{
  "config": {
    "abort": {
      "single_instance_allowed": "Only one Helman Energy instance is supported."
    },
    "step": {
      "user": {
        "title": "Set up Helman Energy",
        "description": "Helman Energy will read your HA energy configuration automatically. No additional setup required."
      }
    }
  }
}
```

### `hacs.json`
```json
{
  "name": "Helman Energy",
  "render_readme": true
}
```

## Testing This Phase
1. Copy `custom_components/helman` to HA config directory.
2. Restart HA.
3. Go to Settings → Integrations → Add → search "Helman Energy".
4. Click through the single-step flow.
5. Verify entry appears in the integrations list with no errors in logs.
6. Reload the integration → should succeed.
7. Delete the entry → should succeed.

## No Frontend Changes in This Phase
The card continues operating in full legacy (current) mode.

## Commit Sequence
```
feat(helman): initial custom component skeleton with config flow
```
