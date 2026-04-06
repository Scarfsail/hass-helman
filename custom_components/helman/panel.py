from __future__ import annotations

import logging
import os

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import (
    CUSTOM_COMPONENTS,
    DOMAIN,
    PANEL_DIST_FOLDER,
    PANEL_FILENAME,
    PANEL_FOLDER,
    PANEL_FRONTEND_URL_PATH,
    PANEL_ICON,
    PANEL_NAME,
    PANEL_TITLE,
    PANEL_URL,
)

_LOGGER = logging.getLogger(__name__)
_PANEL_STATIC_REGISTERED = "panel_static_registered"
_PANEL_REGISTERED = "panel_registered"


async def async_register_panel(hass: HomeAssistant) -> None:
    domain_data = hass.data.setdefault(DOMAIN, {})
    root_dir = os.path.join(hass.config.path(CUSTOM_COMPONENTS), DOMAIN)
    bundle_path = os.path.join(root_dir, PANEL_FOLDER, PANEL_DIST_FOLDER, PANEL_FILENAME)

    if not domain_data.get(_PANEL_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(PANEL_URL, bundle_path, cache_headers=False)]
        )
        domain_data[_PANEL_STATIC_REGISTERED] = True

    if domain_data.get(_PANEL_REGISTERED):
        return

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=PANEL_NAME,
        frontend_url_path=PANEL_FRONTEND_URL_PATH,
        module_url=PANEL_URL,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=True,
        config={},
        config_panel_domain=DOMAIN,
    )
    domain_data[_PANEL_REGISTERED] = True


def async_unregister_panel(hass: HomeAssistant) -> None:
    domain_data = hass.data.setdefault(DOMAIN, {})
    if not domain_data.get(_PANEL_REGISTERED):
        return
    frontend.async_remove_panel(hass, PANEL_FRONTEND_URL_PATH)
    domain_data[_PANEL_REGISTERED] = False
    _LOGGER.debug("Removed Helman config editor panel")
