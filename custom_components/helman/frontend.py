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
_CARD_RESOURCE_URL = "card_resource_url"


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


def registered_card_module_url(hass: HomeAssistant) -> str | None:
    """The card URL Lovelace is known to load, or ``None`` if we cannot tell.

    Only a resource this integration registered itself, in storage mode, is a
    URL we can promise a dashboard will import verbatim. Under YAML-mode
    Lovelace the resource list is the user's, so the spelling they used is
    unknown to us -- and importing a *differently spelled* URL for the same file
    is what evaluates the bundle twice, which registers every custom element a
    second time and kills the dashboard's Helman cards for that page session.
    Better no embedded chart than a broken dashboard, so callers that would hand
    the URL onwards get nothing here instead of a guess.

    This reads a *snapshot*: whatever ``async_register_frontend`` managed to
    register, which is nothing at all if Lovelace had not been set up yet. The
    panel is registered once and carries its config for the lifetime of the
    install, so ``manifest.json`` declares ``lovelace`` in ``after_dependencies``
    to put that setup before ours. Without it a storage-mode install that raced
    us would show the editor's "unavailable" message for good.
    """
    return hass.data.get(DOMAIN, {}).get(_CARD_RESOURCE_URL)


async def async_card_module_url(hass: HomeAssistant) -> str:
    """The card bundle's public URL, version-stamped.

    The one place this string is built. The config editor lazily imports the
    very same URL to embed the solar inspector, and the browser keys module
    identity on the URL -- so an unversioned or independently assembled URL
    would evaluate a second copy of the bundle, registering every custom
    element twice and pushing every card into ``window.customCards`` again.
    """
    integration = await async_get_integration(hass, DOMAIN)
    return f"{CARD_URL}?v={integration.version}"


async def _async_register_card_resource(hass: HomeAssistant) -> None:
    resources = _get_storage_resources(hass)
    if resources is None:
        _LOGGER.debug(
            "Lovelace storage-mode resources unavailable; skipping card auto-registration"
        )
        return

    versioned_url = await async_card_module_url(hass)

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
        domain_data[_CARD_RESOURCE_URL] = versioned_url
    else:
        created = await resources.async_create_item(
            {"res_type": "module", "url": versioned_url}
        )
        domain_data[_CARD_RESOURCE_ID] = created["id"]
        domain_data[_CARD_RESOURCE_URL] = versioned_url


async def async_unregister_frontend(hass: HomeAssistant) -> None:
    """Remove the auto-registered Lovelace card resource."""
    domain_data = hass.data.get(DOMAIN, {})
    domain_data.pop(_CARD_RESOURCE_URL, None)
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
