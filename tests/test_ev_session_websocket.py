"""``helman/get_node_detail`` for the EV charger's ``history`` section: the charging ledger (#428).

Runs the real websocket handler, the real node registry and the real
coordinator entry point; the ledger service's answer is stubbed, its own
figures being ``test_ev_sessions.py``'s business.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

import pytest

from custom_components.helman import websockets as websockets_module
from custom_components.helman.vendors import PROFILES, DeviceTelemetry
from tests._fakes import FakeConnection, FakeState, hass_with_coordinator, make_coordinator

RUN_MODE = "sensor.solax_ev_charger_run_mode"
METER = "sensor.solax_ev_charger_charge_added_total"
POWER = "sensor.solax_ev_charger_charge_power_total"
SOC = "sensor.kona_soc"
CONSUMPTION = "sensor.kona_average_energy_consumption_kwh"

LEDGER = {
    "unavailable": None,
    "window": {"start": "2026-10-10T12:00:00+00:00", "end": "2026-11-09T12:00:00+00:00"},
    "totals": {"kwh": 12.0, "provisional": False},
    "chargingDays": 3,
    "perWeek": 0.7,
    "paidPerKwh": 2.0,
    "gridPricePerKwh": 5.0,
    "segments": [],
    "complete": False,
    "health": {"error": "read_failed"},
}


def charger(*, profile=True, vehicles=1, power=True):
    device = {
        "id": "garage-ev",
        "kind": "ev_charger",
        "name": "Garage EV",
        "consumption": {"energy_entity_id": METER, **({"power_entity_id": POWER} if power else {})},
        "vehicles": [
            {"id": f"car{index}", "name": f"Car {index}", "telemetry": {"soc_entity_id": SOC if index == 0 else f"sensor.car{index}_soc"}}
            for index in range(vehicles)
        ],
    }
    if profile:
        device["profile"] = {"id": "solax_ev_charger", "device_id": "charger-device"}
    return device


def detail(section=None, *, device_id="garage-ev", device=None, history=None, states=None, registry=None, price_unit="CZK/kWh"):
    coordinator = make_coordinator()
    coordinator._active_config = {"devices": {"consumers": [device or charger(), {"id": "boiler", "kind": "generic"}]}}
    profile = PROFILES["solax_ev_charger"]
    telemetry = {key: None for key in profile.telemetry} | {"run_mode": RUN_MODE}
    coordinator.live._vendor_telemetry = (
        {"garage-ev": DeviceTelemetry(profile=profile, entry=None, entities=telemetry)}
        if (device or charger()).get("profile")
        else {}
    )
    coordinator.ev_sessions.async_history = (
        history if callable(history) else AsyncMock(return_value=LEDGER if history is None else history)
    )
    coordinator._solar_inspector = NS(async_resolve_span_currency=AsyncMock(return_value=price_unit))
    hass = hass_with_coordinator(coordinator)
    hass.states = NS(get={RUN_MODE: FakeState("Charging"), **(states or {})}.get)
    connection = FakeConnection()
    msg = {"id": 7, "type": "helman/get_node_detail", "node": "ev_charger", "device_id": device_id}
    if section:
        msg["section"] = section
    entries = registry or {}
    fake_registry = NS(async_get=lambda entity_id: entries.get(entity_id))
    with patch("homeassistant.helpers.entity_registry.async_get", return_value=fake_registry), patch(
        "homeassistant.helpers.entity_registry.async_entries_for_device",
        side_effect=lambda _registry, device_id: [
            NS(entity_id=entity_id) for entity_id, entry in entries.items() if entry.device_id == device_id
        ],
    ):
        asyncio.run(websockets_module.ws_get_node_detail.__wrapped__(hass, connection, msg))
    return connection, coordinator


def result(connection):
    assert connection.errors == []
    return connection.results[0][1]


@pytest.mark.parametrize("device_id", ["toaster", "boiler"])
def test_the_history_section_validates_its_consumer(device_id):
    connection, coordinator = detail("history", device_id=device_id)

    assert [code for _id, code, _message in connection.errors] == ["invalid_device"]
    coordinator.ev_sessions.async_history.assert_not_called()


def test_a_charger_with_a_run_mode_and_a_power_entity_offers_the_ledger_and_a_custom_one_does_not():
    assert "history" in result(detail()[0])["sections"]
    assert "history" not in result(detail(device=charger(profile=False))[0])["sections"]
    # The ledger follows the charge power: without one there is none.
    assert "history" not in result(detail(device=charger(power=False))[0])["sections"]


def test_a_charger_the_ledger_does_not_follow_has_no_figures():
    payload = result(detail("history", history={"unavailable": "not_tracked"})[0])

    assert payload == {
        "node": "ev_charger",
        "section": "history",
        "deviceId": "garage-ev",
        "asOf": payload["asOf"],
        "unavailable": "not_tracked",
    }


def test_a_partial_ledger_is_served_with_its_price_unit_and_its_failure_named():
    connection, coordinator = detail("history")
    payload = result(connection)

    assert payload["section"] == "history"
    assert payload["priceUnit"] == "CZK/kWh"
    assert payload["complete"] is False
    assert payload["health"] == {"error": "read_failed"}
    assert payload["totals"]["kwh"] == 12.0
    # Nothing proves the car's consumption: no cost per 100 km, the rest usable.
    assert payload["per100km"] is None
    device_id, now = coordinator.ev_sessions.async_history.call_args.args
    assert device_id == "garage-ev" and now.tzinfo is not None


def test_a_ledger_that_raises_is_an_internal_error():
    connection, _ = detail("history", history=AsyncMock(side_effect=RuntimeError("store broken")))

    assert [code for _id, code, _message in connection.errors] == ["internal_error"]


def consumption(value="15.8", unit="kWh/100 km"):
    return {CONSUMPTION: FakeState(value, attributes={"unit_of_measurement": unit})}


CAR_REGISTRY = {SOC: NS(device_id="kona-car"), CONSUMPTION: NS(device_id="kona-car")}


def test_the_cost_per_100_km_uses_the_one_cars_consumption_on_its_own_device():
    payload = result(detail("history", states=consumption(), registry=CAR_REGISTRY)[0])

    assert payload["per100km"] == {
        "entityId": CONSUMPTION,
        "kwhPer100km": 15.8,
        "vehicleId": "car0",
        "vehicleName": "Car 0",
        "amount": pytest.approx(31.6),
    }


@pytest.mark.parametrize(
    ("states", "registry", "device"),
    [
        # Not a finite positive reading.
        (consumption("unknown"), CAR_REGISTRY, None),
        (consumption("0"), CAR_REGISTRY, None),
        # Not in kWh/100 km.
        (consumption(unit="km"), CAR_REGISTRY, None),
        # On another device than the car's SoC.
        (consumption(), {SOC: NS(device_id="kona-car"), CONSUMPTION: NS(device_id="phone")}, None),
        # Two cars: nothing says which one charged.
        (consumption(), CAR_REGISTRY, charger(vehicles=2)),
    ],
    ids=["unknown", "zero", "unit", "other-device", "two-cars"],
)
def test_without_a_provable_consumption_there_is_no_cost_per_100_km(states, registry, device):
    payload = result(detail("history", states=states, registry=registry, device=device)[0])

    assert payload["per100km"] is None
    assert payload["paidPerKwh"] == 2.0


def test_without_a_priced_kwh_there_is_no_cost_per_100_km():
    payload = result(detail("history", history={**LEDGER, "paidPerKwh": None}, states=consumption(), registry=CAR_REGISTRY)[0])

    assert payload["per100km"] is None


def test_without_a_ledger_the_section_is_not_loaded():
    from custom_components.helman.node_details import NodeDetailContext, async_get_node_detail

    ctx = NodeDetailContext(
        config={"devices": {"consumers": [charger()]}}, telemetry={}, device_report=None, house_profile=(None, None)
    )
    payload = asyncio.run(
        async_get_node_detail(
            NS(states=NS(get=lambda _id: None)), ctx, node="ev_charger", device_id="garage-ev",
            section="history", now=datetime(2026, 11, 9, 12, tzinfo=timezone.utc),
        )
    )

    assert payload["unavailable"] == "not_loaded"
