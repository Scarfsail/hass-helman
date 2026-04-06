from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .panel import async_register_panel
from .coordinator import HelmanCoordinator
from .storage import HelmanStorage
from .websockets import async_register_websocket_commands

PLATFORMS = ["sensor"]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up Helman Energy (called once per HASS lifetime)."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if "storage" not in domain_data:
        stor = HelmanStorage(hass)
        await stor.async_load()
        domain_data["storage"] = stor
    async_register_websocket_commands(hass)
    await async_register_panel(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Helman Energy from a config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})

    stor = domain_data.get("storage")
    if stor is None:
        stor = HelmanStorage(hass)
        await stor.async_load()
        domain_data["storage"] = stor

    await async_register_panel(hass)
    coordinator = HelmanCoordinator(hass, stor)
    await coordinator.async_setup()

    domain_data["coordinator"] = coordinator
    domain_data[entry.entry_id] = {}

    try:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except Exception:
        await coordinator.async_unload()
        domain_data.pop("coordinator", None)
        domain_data.pop(entry.entry_id, None)
        raise
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
    hass.data[DOMAIN].pop("coordinator", None)
    return unload_ok
