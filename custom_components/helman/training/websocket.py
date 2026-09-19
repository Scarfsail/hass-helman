from __future__ import annotations

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from ..solar_bias_correction.websocket import _get_coordinator, _require_admin

#: The batch's sub-jobs, in batch order.
_JOB_IDS = ("solar_bias", "house_consumption", "appliance_energy")


@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/training/status",
    }
)
@callback
def ws_get_training_status(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Every training job's status. Admin only: its one consumer is the config
    editor, and it carries entity ids, appliance ids and raw exception text."""
    if not _require_admin(connection, msg):
        return
    coordinator = _get_training_coordinator(hass, connection, msg)
    if coordinator is None:
        return

    connection.send_result(msg["id"], coordinator.build_training_status())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/training/train_now",
        vol.Optional("job"): vol.In(_JOB_IDS),
    }
)
@websocket_api.async_response
async def ws_train_now(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Run one job, or the whole batch when ``job`` is omitted.

    Rejects rather than joins a run already in flight: joining is right for
    startup and config-save triggers, but a click on one job must never be
    answered with the outcome of a different run it happened to join.
    """
    if not _require_admin(connection, msg):
        return
    coordinator = _get_training_coordinator(hass, connection, msg)
    if coordinator is None:
        return

    batch = coordinator._training_batch
    job = msg.get("job")
    # No await from here until the run is dispatched: the busy check and the
    # dispatch are atomic on the event loop.
    if batch.is_running:
        connection.send_error(
            msg["id"],
            "training_in_progress",
            f"Training is already running: {batch.current_job or 'starting'}",
        )
        return
    if (
        job == "solar_bias"
        and not coordinator._solar_bias_service.get_status_payload()["enabled"]
    ):
        connection.send_error(
            msg["id"], "job_disabled", "Solar bias correction is disabled"
        )
        return

    if job is None:
        await batch.async_run(reason="manual")
    elif job == "solar_bias":
        await batch.async_run_solar_bias(reason="manual")
    elif job == "house_consumption":
        await batch.async_run_house_consumption(reason="manual")
    else:
        await batch.async_run_appliance_energy(reason="manual")

    # A config save during a long run reloads Helman, leaving the coordinator
    # this run started on without a batch; report from whichever one is live.
    coordinator = _get_training_coordinator(hass, connection, msg)
    if coordinator is None:
        return

    connection.send_result(
        msg["id"],
        {
            "outcomes": {
                ran: batch.last_outcomes[ran]
                for ran in (_JOB_IDS if job is None else (job,))
            },
            "status": coordinator.build_training_status(),
        },
    )


def _get_training_coordinator(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
):
    coordinator = _get_coordinator(hass, connection, msg)
    if coordinator is None:
        return None
    if getattr(coordinator, "_training_batch", None) is None:
        connection.send_error(
            msg["id"], "not_loaded", "Helman training batch not available"
        )
        return None
    return coordinator
