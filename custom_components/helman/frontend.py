from __future__ import annotations

import logging
import os

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import (
    CARD_URL,
    CUSTOM_COMPONENTS,
    DOMAIN,
    FRONTEND_COMPILED_FOLDER,
    FRONTEND_URL_BASE,
)

_LOGGER = logging.getLogger(__name__)
_FRONTEND_STATIC_REGISTERED = "frontend_static_registered"
_CARD_RESOURCE_ID = "card_resource_id"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the compiled frontend and auto-register the Lovelace card resource."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    root_dir = os.path.join(hass.config.path(CUSTOM_COMPONENTS), DOMAIN)
    compiled_dir = os.path.join(root_dir, FRONTEND_COMPILED_FOLDER)

    if not domain_data.get(_FRONTEND_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(FRONTEND_URL_BASE, compiled_dir, cache_headers=False)]
        )
        domain_data[_FRONTEND_STATIC_REGISTERED] = True

    await _async_register_card_resource(hass)


async def _async_register_card_resource(hass: HomeAssistant) -> None:
    resources = _get_storage_resources(hass)
    if resources is None:
        _LOGGER.debug(
            "Lovelace storage-mode resources unavailable; skipping card auto-registration"
        )
        return

    integration = await async_get_integration(hass, DOMAIN)
    versioned_url = f"{CARD_URL}?v={integration.version}"

    await resources.async_get_info()  # ensures the collection is loaded
    existing = next(
        (item for item in resources.async_items() if item["url"].startswith(CARD_URL)),
        None,
    )

    domain_data = hass.data.setdefault(DOMAIN, {})
    if existing is not None:
        if existing["url"] != versioned_url:
            await resources.async_update_item(existing["id"], {"url": versioned_url})
        domain_data[_CARD_RESOURCE_ID] = existing["id"]
    else:
        created = await resources.async_create_item(
            {"res_type": "module", "url": versioned_url}
        )
        domain_data[_CARD_RESOURCE_ID] = created["id"]


async def async_unregister_frontend(hass: HomeAssistant) -> None:
    """Remove the auto-registered Lovelace card resource."""
    domain_data = hass.data.get(DOMAIN, {})
    resource_id = domain_data.pop(_CARD_RESOURCE_ID, None)
    if resource_id is None:
        return

    resources = _get_storage_resources(hass)
    if resources is None:
        return

    try:
        await resources.async_delete_item(resource_id)
    except Exception:  # noqa: BLE001 - best effort cleanup on unload
        _LOGGER.debug("Could not remove Helman card Lovelace resource", exc_info=True)


def _get_storage_resources(hass: HomeAssistant):
    """Return the storage-mode Lovelace resource collection, if available."""
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None)
    if resources is None or not hasattr(resources, "async_create_item"):
        return None
    return resources
