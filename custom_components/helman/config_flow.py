import secrets

from homeassistant import config_entries

from .const import DOMAIN, NAME


class HelmanConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Config flow for Helman Energy."""

    VERSION = 1
    CONNECTION_CLASS = config_entries.CONN_CLASS_LOCAL_PUSH

    async def async_step_user(self, user_input=None):
        """Handle a flow initialized by the user."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        await self.async_set_unique_id(secrets.token_hex(6))
        self._abort_if_unique_id_configured()

        return self.async_create_entry(title=NAME, data={})
