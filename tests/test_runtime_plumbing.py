"""Runtime primitives preserve tree membership and websocket access rules."""

from types import SimpleNamespace

import pytest
from homeassistant.exceptions import Unauthorized
from custom_components.helman import tree_builder, websockets
from custom_components.helman.sensor import HelmanUnmeasuredPowerSensor
from custom_components.helman.training import websocket as training_ws

TREE = {
    "sources": [
        {
            "id": "solar",
            "powerSensorId": "sensor.solar",
            "valueType": "negative",
            "ratioSensorId": "sensor.ratio",
            "children": [],
        }
    ],
    "consumers": [
        {
            "id": "house",
            "powerSensorId": "sensor.house",
            "children": [
                {
                    "id": "meter",
                    "powerSensorId": "sensor.meter",
                    "children": [
                        {
                            "id": "share",
                            "isEstimated": True,
                            "powerSensorId": "sensor.share",
                            "displayName": "Child",
                        },
                        {
                            "id": "remainder",
                            "isUnmeasured": True,
                            "powerSensorId": "sensor.remainder",
                        },
                    ],
                },
                {
                    "id": "virtual",
                    "isVirtual": True,
                    "children": [
                        {
                            "id": "ignored",
                            "isUnmeasured": True,
                            "powerSensorId": "sensor.ignored",
                        }
                    ],
                },
                {
                    "id": "house_remainder",
                    "isUnmeasured": True,
                    "powerSensorId": "sensor.house_remainder",
                },
            ],
        }
    ],
}
EXPECTED = {
    "qualifying_nodes": {"house": "sensor.house", "meter": "sensor.meter"},
    "share_devices": {"share": ("sensor.share", "Child")},
    "power_sensor_ids": {
        "sensor.solar",
        "sensor.house",
        "sensor.meter",
        "sensor.share",
        "sensor.remainder",
        "sensor.ignored",
        "sensor.house_remainder",
    },
    "source_sensor_ids": ("sensor.solar",),
    "source_ratio_entity_ids": {"sensor.solar": "sensor.ratio"},
    "source_value_types": {"sensor.solar": "negative"},
    "virtual_sensor_ids": {
        "sensor.share",
        "sensor.remainder",
        "sensor.ignored",
        "sensor.house_remainder",
    },
    "unmeasured_entity_id_map": {
        "house": "sensor.house_remainder",
        "meter": "sensor.remainder",
    },
}


def test_index_matches_legacy_collector_outputs():
    index = tree_builder.TreeIndex.from_tree(TREE)
    for key, expected in EXPECTED.items():
        assert getattr(index, key) == expected


@pytest.mark.parametrize(
    "node_id",
    [
        "house",
        "sensor.kitchen_power",
        "sensor.sensor.double",
        "switch.a.b",
        "Odd-ID_ü",
        "sensor.",
    ],
)
def test_unmeasured_entity_id_matches_sensor(node_id):
    hass = SimpleNamespace(states=SimpleNamespace(get=lambda _: None))
    sensor = HelmanUnmeasuredPowerSensor(
        SimpleNamespace(), SimpleNamespace(entry_id="test"), hass, node_id, None
    )
    assert tree_builder.unmeasured_power_entity_id(node_id) == sensor.entity_id


@pytest.mark.parametrize(
    "handler",
    [
        websockets.ws_get_config,
        training_ws.ws_get_training_status,
        training_ws.ws_train_now,
    ],
)
def test_real_admin_decorator_rejects_before_scheduling(handler):
    with pytest.raises(Unauthorized):
        handler(
            SimpleNamespace(),
            SimpleNamespace(user=SimpleNamespace(is_admin=False)),
            {"id": 1},
        )


def test_public_commands_allow_non_admin():
    results = []
    connection = SimpleNamespace(
        user=SimpleNamespace(is_admin=False),
        send_result=lambda *args: results.append(args),
        subscriptions={},
    )
    hass = SimpleNamespace(bus=SimpleNamespace(async_listen=lambda *_: None))
    websockets.ws_subscribe_updates(hass, connection, {"id": 1})
    assert results == [(1,)]


def test_schedule_rejects_compact_date_with_invalid_date():
    errors = []
    connection = SimpleNamespace(
        user=SimpleNamespace(is_admin=True),
        send_error=lambda *args: errors.append(args),
    )
    websockets.ws_get_schedule_explanation(
        SimpleNamespace(data={}),
        connection,
        {"id": 1, "date": "20260101", "controllable_id": "inverter"},
    )
    assert errors[0][1] == "invalid_date"


def test_registry_holder_refresh_is_visible_to_executor_and_retains_unchanged_registry():
    from tests._fakes import FakeHass, FakeState, make_coordinator
    from custom_components.helman.appliances._read import ProjectionConfig
    from custom_components.helman.appliances.climate_appliance import (
        ClimateApplianceRuntime,
    )
    from custom_components.helman.appliances.state import AppliancesRuntimeRegistry

    hass = FakeHass(
        {"climate.room": FakeState("heat", attributes={"hvac_modes": ["off", "heat"]})}
    )
    coordinator = make_coordinator(_hass=hass)
    holder = coordinator._appliances_registry
    holder.current = AppliancesRuntimeRegistry.from_appliances(
        [
            ClimateApplianceRuntime(
                "room",
                "Room",
                "climate.room",
                ProjectionConfig(strategy="fixed", hourly_energy_kwh=1.0),
            )
        ]
    )
    original = holder.current
    read_registry = (
        coordinator._schedule_executor._dependencies.read_appliances_registry
    )
    assert read_registry() is original
    holder.refresh()
    assert coordinator._appliances_registry is holder
    assert read_registry() is holder.current
    assert holder.current is not original
    assert holder.current.appliances[0].supported_modes == ("heat",)
    unchanged = holder.current
    holder.refresh()
    assert read_registry() is unchanged
    hass.states._states["climate.room"] = FakeState(
        "cool", attributes={"hvac_modes": ["cool"]}
    )
    holder.refresh()
    assert read_registry().appliances[0].supported_modes == ("cool",)
    assert read_registry().appliances[0].stop_hvac_mode is None


def test_tree_index_membership_is_immutable():
    index = tree_builder.TreeIndex.from_tree(TREE)
    with pytest.raises(TypeError):
        index.qualifying_nodes["other"] = "sensor.other"
    with pytest.raises(AttributeError):
        index.power_sensor_ids.add("sensor.other")


def test_node_detail_uses_explicit_context_without_runtime_or_telemetry_lookups():
    import asyncio
    from datetime import datetime, timezone
    from unittest.mock import AsyncMock, patch
    from custom_components.helman.node_details import (
        NodeDetailContext,
        async_get_node_detail,
    )

    report = AsyncMock(return_value={"unavailable": "no_meters"})
    ctx = NodeDetailContext({}, {}, report, (None, None))
    # No hass.data, config entries or entity registry are available to rediscover inputs.
    hass = SimpleNamespace()
    now = datetime(2026, 10, 10, tzinfo=timezone.utc)
    with patch(
        "custom_components.helman.vendors.resolve_vendor_telemetry",
        side_effect=AssertionError("re-resolved telemetry"),
    ):
        overview = asyncio.run(
            async_get_node_detail(
                hass, ctx, node="solar", device_id=None, section=None, now=now
            )
        )
        section = asyncio.run(
            async_get_node_detail(
                hass, ctx, node="solar", device_id=None, section="destinations", now=now
            )
        )
    assert overview["profile"] is None
    assert section["unavailable"] == "no_meters"
    report.assert_awaited_once()
