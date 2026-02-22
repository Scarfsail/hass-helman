from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .storage import HelmanStorage
from .websockets import async_register_websocket_commands


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Helman Energy from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    stor = HelmanStorage(hass)
    await stor.async_load()

    hass.data[DOMAIN]["storage"] = stor
    hass.data[DOMAIN][entry.entry_id] = {}

    async_register_websocket_commands(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a Helman Energy config entry."""
    hass.data[DOMAIN].pop(entry.entry_id, None)
    hass.data[DOMAIN].pop("storage", None)
    return True
