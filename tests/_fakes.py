"""Small shared doubles for Home Assistant-facing unit tests."""

from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace
from typing import Any


class DummyStore:
    """In-memory replacement for ``homeassistant.helpers.storage.Store``."""

    profile = None

    def __init__(self, hass: Any = None, version: int = 1, key: str = "") -> None:
        self._data: Any = None

    async def async_load(self) -> Any:
        return self._data

    async def async_save(self, data: Any) -> None:
        self._data = data
        self.saved = data


class FakeConnection:
    def __init__(self) -> None:
        self.results: list[tuple[int, Any]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: Any) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class FakeState:
    def __init__(self, state: str, *, attributes: dict | None = None) -> None:
        self.state = state
        self.attributes = attributes or {}


class FakeStates:
    def __init__(self, states: dict[str, FakeState] | None = None) -> None:
        self._states = states or {}

    def get(self, entity_id: str) -> FakeState | None:
        return self._states.get(entity_id)


class FakeBus:
    def __init__(self) -> None:
        self.fired: list[tuple[str, dict]] = []

    def async_fire(self, event_type: str, event_data: dict | None = None) -> None:
        self.fired.append((event_type, dict(event_data or {})))


class FakeServices:
    """Service calls used by schedule execution tests."""

    def __init__(self, hass: FakeHass) -> None:
        self._hass = hass
        self.calls: list[tuple[str, str, dict]] = []
        self.release: asyncio.Event | None = None
        self.entered = asyncio.Event()

    async def async_call(
        self, domain: str, service: str, data: dict, *, blocking: bool, context=None
    ) -> None:
        self.calls.append((domain, service, data))
        if self.release is not None:
            self.entered.set()
            await self.release.wait()
        if domain == "switch" and service == "turn_on":
            self._hass.states._states[data["entity_id"]].state = "on"


class FakeConfigEntry:
    """A Helman config entry; ``runtime_data`` is set only when given."""

    def __init__(
        self, entry_id: str = "helman-entry", *, domain: str = "helman", **attrs: Any
    ) -> None:
        self.entry_id = entry_id
        self.domain = domain
        for name, value in attrs.items():
            setattr(self, name, value)


class FakeConfigEntries:
    def __init__(self, entries: list[Any] | None = None) -> None:
        self.entries = list(entries or [])

    def async_entries(self, domain: str | None = None) -> list[Any]:
        return [e for e in self.entries if domain is None or e.domain == domain]

    def async_get_entry(self, entry_id: str) -> Any:
        return next((e for e in self.entries if e.entry_id == entry_id), None)


class FakeHass:
    def __init__(self, states: dict[str, FakeState] | None = None) -> None:
        self.data: dict = {}
        self.config = SimpleNamespace(config_dir="/tmp", time_zone="Europe/Prague")
        self.states = FakeStates(states)
        self.bus = FakeBus()
        self.services = FakeServices(self)
        self.config_entries = FakeConfigEntries()

    def async_create_task(self, coro):
        return asyncio.create_task(coro)

    def async_create_background_task(self, coro, name):
        return asyncio.create_task(coro, name=name)

    def verify_event_loop_thread(self, what: str) -> None:
        """Lets the real dispatcher send; the tests run on the loop."""


def loaded_config_entries(coordinator: Any) -> FakeConfigEntries:
    """Config entries holding one Helman entry loaded with ``coordinator``."""
    return FakeConfigEntries([FakeConfigEntry(runtime_data=coordinator)])


def hass_with_coordinator(coordinator: Any, **attrs: Any) -> FakeHass:
    """A hass whose loaded Helman entry carries ``coordinator`` as runtime data."""
    hass = FakeHass()
    hass.config_entries = loaded_config_entries(coordinator)
    for name, value in attrs.items():
        setattr(hass, name, value)
    return hass


def capture_signal(hass: Any, signal: str, entry_id: str = "helman-entry") -> list:
    """Record every payload sent on this entry's ``signal``, through the real dispatcher."""
    from homeassistant.core import callback
    from homeassistant.helpers.dispatcher import async_dispatcher_connect

    from custom_components.helman.const import entry_signal

    sent: list = []
    async_dispatcher_connect(
        hass, entry_signal(signal, entry_id), callback(lambda payload: sent.append(payload))
    )
    return sent


def make_coordinator(**overrides):
    """Build a coordinator through its real constructor, then set test state."""
    from custom_components.helman.coordinator import HelmanCoordinator

    hass = overrides.pop("_hass", None)
    storage = overrides.pop("_storage", None)
    entry = overrides.pop("_entry", None)
    if hass is None:
        hass = FakeHass()
    if storage is None:
        storage = FakeStorage(
            schedule_document={"executionEnabled": False, "slotMinutes": 15, "slots": {}}
        )
    if entry is None:
        entry = FakeConfigEntry()
    coordinator = HelmanCoordinator(hass, storage, entry)
    for name, value in overrides.items():
        setattr(coordinator, name, value)
    return coordinator


def _valid_config() -> dict:
    return {
        "visualization": {
            "show_empty_groups": False,
            "show_others_group": True,
            "history_buckets": 60,
            "history_bucket_duration": 5,
        },
        "energy_nodes": {
            "inverter": _inverter_controllable(),
            "house": {
                "entities": {
                    "power": "sensor.house_power",
                },
                "forecast": {
                    "total_energy_entity_id": "sensor.house_energy_total",
                },
            },
            "solar": {
                "entities": {
                    "power": "sensor.solar_power",
                    "today_energy": "sensor.solar_today",
                },
                "forecast": {
                    "daily_energy_entity_ids": [
                        "sensor.solar_day_1",
                        "sensor.solar_day_2",
                    ],
                    "total_energy_entity_id": "sensor.solar_total",
                },
            },
            "battery": {
                "entities": {
                    "power": "sensor.battery_power",
                    "remaining_energy": "sensor.battery_remaining",
                    "capacity": "sensor.battery_soc",
                    "min_soc": "sensor.battery_min_soc",
                    "max_soc": "sensor.battery_max_soc",
                },
                "forecast": {
                    "charge_efficiency": 0.95,
                    "discharge_efficiency": 0.95,
                    "max_charge_power_w": 5000,
                    "max_discharge_power_w": 5000,
                },
            },
            "grid": {
                "entities": {
                    "power": "sensor.grid_power",
                },
                "forecast": {
                    "sell_price_entity_id": "sensor.grid_sell_price",
                    "import_price_unit": "CZK/kWh",
                    "import_price_windows": [
                        {"start": "00:00", "end": "06:00", "price": 2.5},
                        {"start": "06:00", "end": "00:00", "price": 3.5},
                    ],
                },
            },
        },
        "training": {
            "house_consumption": {
                "min_history_days": 14,
                "training_window_days": 56,
            },
        },
        "devices": {"name_cleaner_regex": r"\s+", "groupings": [
            {
                "id": "rooms",
                "name": "Rooms",
                "groups": [{"id": "garage", "name": "Garage", "short_name": "G"}],
            }
        ], "consumers": [
            {
                "kind": "ev_charger",
                "schedulable": True,
                "id": "garage-ev",
                "name": "Garage EV",
                "groups": {"rooms": "garage"},
                "limits": {
                    "max_charging_power_kw": 11.0,
                },
                "controls": {
                    "charge": {
                        "entity_id": "switch.ev_nabijeni",
                    },
                    "use_mode": {
                        "entity_id": "input_select.ev_use_mode",
                        "values": {
                            "Fast": {"behavior": "fixed_max_power"},
                            "ECO": {"behavior": "surplus_aware"},
                        },
                    },
                    "eco_gear": {
                        "entity_id": "input_select.ev_eco_gear",
                        "values": {
                            "6A": {"min_power_kw": 1.4},
                            "10A": {"min_power_kw": 2.3},
                        },
                    },
                },
                "vehicles": [
                    {
                        "id": "kona",
                        "name": "Kona",
                        "telemetry": {
                            "soc_entity_id": "sensor.kona_soc",
                            "charge_limit_entity_id": "number.kona_charge_limit",
                        },
                        "limits": {
                            "battery_capacity_kwh": 64.0,
                            "max_charging_power_kw": 11.0,
                        },
                    }
                ],
                "consumption": {"energy_entity_id": "sensor.ev_energy_total"},
            }
        ]},
    }


def _inverter_controllable() -> dict:
    return {
        "controls": {
            "mode": {
                "entity_id": "input_select.fv_mode",
                "options": {
                    "normal": "Normal",
                    "charge_to_target_soc": "Charge",
                    "discharge_to_target_soc": "Discharge",
                    "stop_charging": "Stop charging",
                    "stop_discharging": "Stop discharging",
                    "stop_export": "Stop export",
                },
            }
        },
    }


def _generic_appliance(*, strategy: str = "fixed") -> dict:
    appliance = {
        "kind": "generic",
        "schedulable": True,
        "id": "dishwasher",
        "name": "Dishwasher",
        "controls": {
            "switch": {"entity_id": "switch.dishwasher"},
        },
        "consumption": {
            "energy_entity_id": "sensor.dishwasher_energy_total",
            "projection": {
                "strategy": strategy,
                "hourly_energy_kwh": 1.2,
            },
        },
    }
    if strategy == "history_average":
        appliance["consumption"]["projection"]["lookback_days"] = 30
    return appliance


def _climate_appliance(*, strategy: str = "fixed") -> dict:
    appliance = {
        "kind": "climate",
        "schedulable": True,
        "id": "living-room-hvac",
        "name": "Living Room HVAC",
        "controls": {
            "climate": {
                "entity_id": "climate.living_room",
            }
        },
        "consumption": {
            "energy_entity_id": "sensor.living_room_hvac_energy_total",
            "projection": {
                "strategy": strategy,
                "hourly_energy_kwh": 1.5,
            },
        },
    }
    if strategy == "history_average":
        appliance["consumption"]["projection"]["lookback_days"] = 30
    return appliance


def _ac_breaker() -> dict:
    """The live AC breaker: a passive meter owner, four climate children behind it.

    The children have no meter of their own and draw from the breaker's; the
    breaker names a power sensor, which the live split of those children needs.
    """
    children = []
    for index in range(4):
        climate = _climate_appliance(strategy="history_average")
        climate["id"] = f"ac-{index}"
        climate["name"] = f"AC {index}"
        climate["controls"]["climate"]["entity_id"] = f"climate.ac_{index}"
        del climate["consumption"]["energy_entity_id"]
        children.append(climate)
    # A fixed child is allowed too: it still counts toward the divisor.
    children[3]["consumption"]["projection"] = {
        "strategy": "fixed",
        "hourly_energy_kwh": 1.5,
    }
    return {
        "id": "jistic_klimatizace_energy",
        "consumption": {
            "energy_entity_id": "sensor.jistic_klimatizace_energy",
            "power_entity_id": "sensor.jistic_klimatizace_power",
        },
        "children": children,
    }


def _study_breaker(*, plug_power: bool = True) -> dict:
    """A passive breaker with one sub-metered schedulable plug and one meterless lamp."""
    plug = _generic_appliance(strategy="history_average")
    plug["id"] = "study-plug"
    plug["consumption"]["energy_entity_id"] = "sensor.study_plug_energy"
    if plug_power:
        plug["consumption"]["power_entity_id"] = "sensor.study_plug_power"
    return {
        "id": "study",
        "consumption": {
            "energy_entity_id": "sensor.study_energy",
            "power_entity_id": "sensor.study_power",
        },
        "children": [
            plug,
            {"id": "study-lamp", "controls": {"switch": {"entity_id": "switch.lamp"}}},
        ],
    }



REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"

def _domains_payload(kind: str, target_soc: int | None = None) -> dict:
    inverter = {"kind": kind}
    if target_soc is not None:
        inverter["targetSoc"] = target_soc
    return {
        "inverter": inverter,
    }


class FakeStorage:
    def __init__(
        self,
        *,
        schedule_document: dict,
        config: dict | None = None,
        forecast_snapshot: dict | None = None,
    ) -> None:
        self.config = config or {}
        self.schedule_document = schedule_document
        self.forecast_snapshot = forecast_snapshot
        self.saved_schedule_documents: list[dict] = []

    async def async_save_schedule_document(self, schedule_document: dict) -> None:
        self.schedule_document = schedule_document
        self.saved_schedule_documents.append(schedule_document)


class FakeExecutor:
    def __init__(self) -> None:
        self.is_running = True
        self.events: list[str] = []
        self.start_calls = 0
        self.stop_calls = 0
        self.unload_calls = 0
        self.reset_runtime_calls = 0
        self.reconcile_calls: list[str] = []
        self.requested_reconciles: list[str] = []
        self.restore_calls: list[str] = []
        self.reconcile_error: Exception | None = None
        self.restore_error: Exception | None = None
        from custom_components.helman.scheduling.runtime_status import (
            ScheduleExecutionStatus,
        )
        self.execution_status = ScheduleExecutionStatus()
        self.get_status_calls = 0

    async def async_start(self) -> None:
        self.events.append("start")
        self.start_calls += 1

    async def async_stop(self) -> None:
        self.events.append("stop")
        self.stop_calls += 1

    async def async_unload(self) -> None:
        self.events.append("unload")
        self.unload_calls += 1

    async def async_reconcile_and_wait(self, *, reason: str) -> None:
        self.events.append(f"reconcile:{reason}")
        self.reconcile_calls.append(reason)
        if self.reconcile_error is not None:
            raise self.reconcile_error

    def request_reconcile(self, *, reason: str) -> None:
        self.events.append(f"request_reconcile:{reason}")
        self.requested_reconciles.append(reason)

    async def async_restore_normal(self, *, reason: str) -> None:
        self.events.append(f"restore:{reason}")
        self.restore_calls.append(reason)
        if self.restore_error is not None:
            raise self.restore_error

    def get_execution_status(self):
        self.events.append("get_execution_status")
        self.get_status_calls += 1
        return self.execution_status

    def reset_runtime(self) -> None:
        self.events.append("reset_runtime")
        self.reset_runtime_calls += 1

    def clear_appliance_memories(self) -> None:
        self.events.append("clear_appliance_memories")


def _bias_service_config(
    cfg,
    *,
    house=None,
    grid_import=None,
    grid_export=None,
    battery_charge=None,
    battery_discharge=None,
    price=None,
    soc=None,
    soc_bounds=None,
    carved=(),
    scheduled=(),
):
    """A service's real config document for inspector fixtures."""
    forecast = {}
    if price is not None:
        forecast = {
            "import_price_unit": price.unit,
            "import_price_windows": [
                {
                    "start": f"{w.start_minutes // 60:02d}:{w.start_minutes % 60:02d}",
                    "end": f"{w.end_minutes // 60:02d}:{w.end_minutes % 60:02d}",
                    "price": w.price,
                }
                for w in price.windows
            ],
        }
    devices = []
    for consumer in carved:
        ids = consumer.get("ids", [])
        device = {
            "name": consumer.get("label"),
            "consumption": {"energy_entity_id": consumer.get("energy_entity_id")},
        }
        if len(ids) <= 1:
            device.update(schedulable=True)
            if ids:
                device["id"] = ids[0]
        else:
            device["children"] = [{"id": key, "schedulable": True} for key in ids]
        device.setdefault("children", []).extend(
            {"consumption": {"energy_entity_id": meter}}
            for meter in consumer.get("metered_children", [])
        )
        devices.append(device)
    for consumer in scheduled:
        devices.append(
            {
                "id": consumer.get("id"),
                "name": consumer.get("label"),
                "schedulable": True,
                "consumption": {"energy_entity_id": consumer.get("energy_entity_id")},
            }
        )
    battery_entities = {
        "today_charge_energy": battery_charge,
        "today_discharge_energy": battery_discharge,
    }
    if soc is not None:
        battery_entities.update(
            capacity=soc,
            remaining_energy="sensor.remaining",
            min_soc="sensor.min_soc",
            max_soc="sensor.max_soc",
        )
    if soc_bounds is not None:
        battery_entities.update(min_soc=soc_bounds[0], max_soc=soc_bounds[1])
    return {
        "devices": {"consumers": devices},
        "training": {
            "solar_bias": {"total_energy_entity_id": cfg.total_energy_entity_id}
        },
        "energy_nodes": {
            "solar": {
                "forecast": {"daily_energy_entity_ids": cfg.daily_energy_entity_ids}
            },
            "house": {"forecast": {"total_energy_entity_id": house}},
            "grid": {
                "entities": {"today_import": grid_import, "today_export": grid_export},
                "forecast": forecast,
            },
            "battery": {"entities": battery_entities},
        },
    }


class FakeInspectorLiveSources:
    """Fake implementing InspectorLiveSources protocol for inspector tests."""

    def __init__(
        self,
        *,
        canonical_solar_forecast: Any = None,
        battery_forecast: Any = None,
        house_forecast_snapshot: Any = None,
        house_forecast_composition: Any = None,
        house_device_consumers: Any = None,
        battery_soc_bounds: Any = None,
        grid_price_snapshot: Any = None,
    ) -> None:
        self._canonical_solar_forecast = canonical_solar_forecast
        self._battery_forecast = battery_forecast
        self._house_forecast_snapshot = house_forecast_snapshot
        self._house_forecast_composition = house_forecast_composition
        self._house_device_consumers = house_device_consumers
        self._battery_soc_bounds = battery_soc_bounds
        self._grid_price_snapshot = grid_price_snapshot

    async def canonical_solar_forecast(
        self, *, reference_time: datetime
    ) -> dict[str, Any] | None:
        target = self._canonical_solar_forecast
        if target is None:
            return None
        if callable(target):
            try:
                res = target(reference_time=reference_time)
            except TypeError:
                res = target()
        else:
            res = target
        if asyncio.iscoroutine(res):
            return await res
        return res

    async def battery_forecast(self) -> dict[str, Any] | None:
        target = self._battery_forecast
        if target is None:
            return None
        res = target() if callable(target) else target
        if asyncio.iscoroutine(res):
            return await res
        return res

    def house_forecast_snapshot(self) -> dict[str, Any] | None:
        target = self._house_forecast_snapshot
        if target is None:
            return None
        return target() if callable(target) else target

    def house_forecast_composition(self) -> dict[str, Any] | None:
        target = self._house_forecast_composition
        if target is None:
            return None
        return target() if callable(target) else target

    async def house_device_consumers(self) -> list[dict[str, Any]]:
        target = self._house_device_consumers
        if target is None:
            return []
        res = target() if callable(target) else target
        if asyncio.iscoroutine(res):
            return await res
        return res

    def battery_soc_bounds(self) -> tuple[float, float] | None:
        target = self._battery_soc_bounds
        if target is None:
            return None
        return target() if callable(target) else target

    def grid_price_snapshot(
        self, reference_time: datetime | None = None
    ) -> dict[str, Any]:
        target = self._grid_price_snapshot
        if target is None:
            return {}
        if callable(target):
            try:
                res = target(reference_time=reference_time)
            except TypeError:
                res = target()
            return res or {}
        return target or {}

