from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .coordinator import HelmanCoordinator
from .storage import HelmanStorage
from .websockets import async_register_websocket_commands

PLATFORMS = ["sensor"]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up Helman Energy (called once per HASS lifetime)."""
    async_register_websocket_commands(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Helman Energy from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    stor = HelmanStorage(hass)
    await stor.async_load()

    coordinator = HelmanCoordinator(hass, stor)
    await coordinator.async_setup()

    hass.data[DOMAIN]["storage"] = stor
    hass.data[DOMAIN]["coordinator"] = coordinator
    hass.data[DOMAIN][entry.entry_id] = {}

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a Helman Energy config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if not unload_ok:
        return False

    coordinator = hass.data[DOMAIN].get("coordinator")
    if coordinator:
        await coordinator.async_unload()
    hass.data[DOMAIN].pop(entry.entry_id, None)
    hass.data[DOMAIN].pop("storage", None)
    hass.data[DOMAIN].pop("coordinator", None)
    return unload_ok
