import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.util import slugify

from .const import DOMAIN, SENSOR_UNIQUE_ID_MIGRATIONS, UNMEASURED_POWER_UNIQUE_ID_SUFFIX
from .frontend import async_register_frontend, async_unregister_frontend
from .panel import async_register_panel
from .coordinator import HelmanCoordinator
from .storage import HelmanStorage
from .websockets import async_register_websocket_commands

PLATFORMS = ["sensor"]
_LOGGER = logging.getLogger(__name__)


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Rewrite sensor-platform registry entries onto the unified id scheme.

    Version 1 → 2. Reads :data:`SENSOR_UNIQUE_ID_MIGRATIONS` -- the single
    source of truth for the static renames -- plus a pattern match for the
    dynamically-created unmeasured-power sensors, whose ids are only known
    from the device tree at runtime.

    ``EntityRegistry.async_update_entity`` is the whole move: the recorder listens for
    ``entity_registry_updated`` and carries ``states_meta`` /
    ``statistics_meta`` across a rename on its own, so history and long-term
    statistics follow without any copying here.

    A renamed ``unique_id`` is always applied -- that is what keeps the
    registry entry matched to the entity `sensor.py` creates on the next
    load. The ``entity_id`` is renamed alongside it only when it still equals
    the old default, so a user's manual rename is never clobbered.
    """
    if entry.version and entry.version >= 2:
        return True

    ent_reg = er.async_get(hass)
    prefix = f"{entry.entry_id}_"

    for reg_entry in list(er.async_entries_for_config_entry(ent_reg, entry.entry_id)):
        if reg_entry.domain != "sensor" or not reg_entry.unique_id.startswith(prefix):
            continue
        suffix = reg_entry.unique_id[len(prefix):]

        new_suffix: str | None = None
        migrate_entity_id = False
        old_entity_id: str | None = None

        for old_suffix, mapped_suffix, should_migrate_id in SENSOR_UNIQUE_ID_MIGRATIONS:
            if suffix == old_suffix:
                new_suffix = mapped_suffix
                migrate_entity_id = should_migrate_id
                old_entity_id = f"sensor.helman_{old_suffix}"
                break

        if new_suffix is None and suffix.endswith(UNMEASURED_POWER_UNIQUE_ID_SUFFIX):
            node_id = suffix.removesuffix(UNMEASURED_POWER_UNIQUE_ID_SUFFIX)
            slug = node_id.removeprefix("sensor.")
            new_suffix = f"unmeasured_power_{slug}"
            migrate_entity_id = True
            old_name = f"Helman {node_id.replace('_', ' ').title()} Unmeasured Power"
            old_entity_id = f"sensor.{slugify(old_name)}"

        if new_suffix is None:
            continue

        updates: dict[str, str] = {}
        new_unique_id = f"{entry.entry_id}_{new_suffix}"
        if reg_entry.unique_id != new_unique_id:
            updates["new_unique_id"] = new_unique_id
        if migrate_entity_id:
            new_entity_id = f"sensor.helman_{new_suffix}"
            if reg_entry.entity_id == old_entity_id and reg_entry.entity_id != new_entity_id:
                updates["new_entity_id"] = new_entity_id

        if updates:
            _LOGGER.debug(
                "Migrating Helman entity registry entry %s: %s",
                reg_entry.entity_id,
                updates,
            )
            ent_reg.async_update_entity(reg_entry.entity_id, **updates)

    hass.config_entries.async_update_entry(entry, version=2)
    return True


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up Helman Energy (called once per HASS lifetime)."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if "storage" not in domain_data:
        stor = HelmanStorage(hass)
        await stor.async_load()
        domain_data["storage"] = stor
    async_register_websocket_commands(hass)
    await async_register_panel(hass)
    await async_register_frontend(hass)
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
    await async_register_frontend(hass)
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
    await async_unregister_frontend(hass)
    hass.data[DOMAIN].pop(entry.entry_id, None)
    hass.data[DOMAIN].pop("coordinator", None)
    return unload_ok
