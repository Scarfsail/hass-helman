from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from ..const import DOMAIN

_LOGGER = logging.getLogger(__name__)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/solar_bias/status",
    }
)
@callback
def ws_get_solar_bias_status(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    service = _get_solar_bias_service(hass, connection, msg)
    if service is None:
        return

    connection.send_result(msg["id"], service.get_status_payload())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/solar_bias/train_now",
    }
)
@websocket_api.async_response
async def ws_train_solar_bias_now(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    training_in_progress_error, bias_not_configured_error = _get_training_error_types()
    service = _get_solar_bias_service(hass, connection, msg)
    if service is None:
        return

    try:
        payload = await service.async_train()
    except training_in_progress_error as err:
        connection.send_error(msg["id"], "training_in_progress", str(err))
        return
    except bias_not_configured_error as err:
        connection.send_error(msg["id"], "bias_correction_not_configured", str(err))
        return
    except Exception:
        _LOGGER.exception("Unexpected solar bias training failure")
        connection.send_error(
            msg["id"], "internal_error", "Unexpected solar bias training failure"
        )
        return

    if payload.get("status") == "training_failed" and payload.get("errorReason"):
        _LOGGER.error(
            "Unexpected solar bias training failure: %s",
            payload["errorReason"],
        )
        connection.send_error(
            msg["id"], "internal_error", "Unexpected solar bias training failure"
        )
        return

    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/solar_bias/profile",
    }
)
@callback
def ws_get_solar_bias_profile(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    service = _get_solar_bias_service(hass, connection, msg)
    if service is None:
        return

    profile_payload = service.get_profile_payload()
    if profile_payload is None:
        connection.send_error(msg["id"], "no_profile", "No solar bias profile available")
        return

    connection.send_result(msg["id"], profile_payload)


def _get_solar_bias_service(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
):
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return None

    service = getattr(coordinator, "_solar_bias_service", None)
    if service is None:
        connection.send_error(
            msg["id"],
            "not_loaded",
            "Helman solar bias correction service not available",
        )
        return None

    return service


def _get_training_error_types():
    from .service import BiasNotConfiguredError, TrainingInProgressError

    return TrainingInProgressError, BiasNotConfiguredError
