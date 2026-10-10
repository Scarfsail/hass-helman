"""Config flow: one entry per device title in the prod registry snapshot."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from . import DOMAIN, load_snapshot


class SolaxStubConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        snapshot = await self.hass.async_add_executor_job(load_snapshot)
        configured = {entry.unique_id for entry in self._async_current_entries()}
        titles = sorted(title for title in snapshot if title not in configured)
        if not titles:
            return self.async_abort(reason="no_devices_left")

        if user_input is not None:
            title = user_input["title"]
            await self.async_set_unique_id(title)
            self._abort_if_unique_id_configured()
            return self.async_create_entry(title=title, data={"name": title})

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required("title"): vol.In(titles)}),
        )
