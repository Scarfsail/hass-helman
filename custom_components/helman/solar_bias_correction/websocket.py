from __future__ import annotations

import logging
from typing import Any

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

    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    store = getattr(service, "_store", None) or getattr(coordinator, "_solar_bias_store", None)
    profile_payload = _build_profile_payload(getattr(store, "profile", None))
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


def _build_profile_payload(stored_payload: Any) -> dict[str, Any] | None:
    if not isinstance(stored_payload, dict):
        return None

    raw_metadata = stored_payload.get("metadata")
    if not isinstance(raw_metadata, dict):
        return None

    trained_at = raw_metadata.get("trained_at")
    if not isinstance(trained_at, str) or not trained_at:
        return None

    raw_profile = stored_payload.get("profile")
    if not isinstance(raw_profile, dict):
        return None

    raw_factors = raw_profile.get("factors", raw_profile)
    if not isinstance(raw_factors, dict):
        return None

    factors: dict[str, float] = {}
    for slot, value in raw_factors.items():
        if not isinstance(slot, str):
            continue
        try:
            factors[slot] = float(value)
        except (TypeError, ValueError):
            continue

    raw_omitted_slots = raw_profile.get(
        "omitted_slots",
        raw_profile.get("omittedSlots", []),
    )
    omitted_slots = (
        [slot for slot in raw_omitted_slots if isinstance(slot, str)]
        if isinstance(raw_omitted_slots, list)
        else []
    )

    return {
        "trainedAt": trained_at,
        "factors": factors,
        "omittedSlots": omitted_slots,
    }
