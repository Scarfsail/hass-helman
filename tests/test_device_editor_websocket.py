"""Admin checks precede registry and Energy reads; preview never persists."""

import asyncio
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock, patch
from custom_components.helman.websockets import (
    ws_preview_energy_import,
    ws_suggest_device_entities,
)


def connection(admin):
    return NS(user=NS(is_admin=admin), send_result=Mock(), send_error=Mock())


def test_non_admin_suggestions_never_read_registry():
    conn = connection(False)
    with patch(
        "custom_components.helman.controllables.suggestions.suggest_entities"
    ) as helper:
        ws_suggest_device_entities(
            NS(), conn, {"id": 1, "anchor_entity_id": "sensor.energy", "config": {}}
        )
    helper.assert_not_called()
    conn.send_error.assert_called_once_with(1, "unauthorized", "Admin access required")
    conn.send_result.assert_not_called()


def test_non_admin_preview_never_reads_energy():
    conn = connection(False)
    with patch(
        "homeassistant.components.energy.data.async_get_manager", new_callable=AsyncMock
    ) as manager:
        asyncio.run(
            ws_preview_energy_import.__wrapped__(NS(), conn, {"id": 1, "config": {}})
        )
    manager.assert_not_awaited()
    conn.send_error.assert_called_once_with(1, "unauthorized", "Admin access required")
    conn.send_result.assert_not_called()


def test_preview_uses_editor_draft_and_current_energy_without_saving():
    conn = connection(True)
    config = {
        "devices": [
            {"id": "draft", "consumption": {"energy_entity_id": "sensor.draft"}}
        ]
    }
    storage = NS(async_save=AsyncMock())
    hass = NS(data={"helman": {"storage": storage}})
    with patch(
        "homeassistant.components.energy.data.async_get_manager",
        new_callable=AsyncMock,
        return_value=NS(
            data={"device_consumption": [{"stat_consumption": "sensor.new"}]}
        ),
    ):
        asyncio.run(
            ws_preview_energy_import.__wrapped__(
                hass, conn, {"id": 1, "config": config}
            )
        )
    result = conn.send_result.call_args.args[1]
    assert [device["id"] for device in result["devices"]] == ["draft", "new"]
    assert result["validation"]["valid"]
    assert len(config["devices"]) == 1
    storage.async_save.assert_not_awaited()
