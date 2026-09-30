from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]


def _install_package_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]


_install_package_stubs()

appliance_energy_module = importlib.import_module(
    "custom_components.helman.training.appliance_energy"
)
recorder_module = importlib.import_module(
    "custom_components.helman.recorder_hourly_series"
)

ApplianceEnergyTrainingJob = appliance_energy_module.ApplianceEnergyTrainingJob
ApplianceEnergyTrainingRequest = appliance_energy_module.ApplianceEnergyTrainingRequest
DeviceSubject = appliance_energy_module.DeviceSubject
SharedMeterMember = appliance_energy_module.SharedMeterMember
SharedMeter = appliance_energy_module.SharedMeter

#: The zone ``conftest`` pins Home Assistant to, where the days are counted.
TZ = ZoneInfo("Europe/Prague")
#: The run's reference time: a one-day lookback is exactly local 2026-03-20.
NOW = datetime(2026, 3, 21, 0, 0, tzinfo=TZ)
_SHARED_METER = "sensor.jistic_klimatizace_energy"


def _metered(
    key: str,
    *,
    controllable_id: str | None = None,
    switch: str | None = None,
    power: str | None = None,
    history_average: bool = False,
    lookback_days: int = 1,
):
    """A device with its own meter, keyed by it."""
    return DeviceSubject(
        device_key=key,
        meter=key,
        controllable_id=controllable_id,
        power_entity_id=power,
        running_signal=(switch, "switch") if switch is not None else None,
        lookback_days=lookback_days,
        history_average=history_average,
    )


def _child(
    device_id: str,
    meter: str = _SHARED_METER,
    *,
    history_average: bool = False,
    lookback_days: int = 1,
):
    """A meterless child of ``meter``, keyed by its id, run by its switch."""
    return DeviceSubject(
        device_key=device_id,
        meter=meter,
        meterless=True,
        controllable_id=device_id,
        running_signal=(f"switch.{device_id}", "switch"),
        lookback_days=lookback_days,
        history_average=history_average,
    )


def _shared(*children, metered_children=(), tolerance=None):
    return SharedMeter(
        tuple(
            SharedMeterMember.for_signal(child.device_key, f"switch.{child.device_key}", "switch")
            for child in children
        ),
        tuple(metered_children),
        tolerance,
    )


class _FakeStore:
    def __init__(self) -> None:
        self.section: dict | None = None
        self.writes: list[str] = []

    @property
    def appliance_energy(self) -> dict | None:
        return self.section

    async def async_record_appliance_energy(
        self,
        *,
        data,
        fingerprint,
        trained_at,
        last_outcome,
        failed_appliances,
        shared_meter_weights,
        devices,
    ) -> None:
        self.section = {
            "data": data,
            "fingerprint": fingerprint,
            "trained_at": trained_at,
            "last_outcome": last_outcome,
            "error_reason": None,
            "failed_appliances": failed_appliances,
            "shared_meter_weights": shared_meter_weights,
            "devices": devices,
        }
        self.writes.append(last_outcome)

    async def async_record_appliance_energy_failure(
        self, *, last_outcome, error_reason, attempted_at
    ) -> None:
        previous = self.section or {}
        self.section = {
            **{key: previous.get(key) for key in ("data", "fingerprint", "trained_at")},
            "last_outcome": last_outcome,
            "error_reason": error_reason,
        }
        self.writes.append(last_outcome)


class _FakeRecorder:
    """Stands in for the one history read per entity: canned states, every call kept.

    A meter comes back with ``kWh`` as its unit, anything else with none, as
    the live states would give them.
    """

    def __init__(self, states: dict[str, list], *, error_ids=()) -> None:
        self._states = states
        self._error_ids = set(error_ids)
        self.calls: list[str] = []

    async def __call__(self, _hass, entity_id, _start, _end, *, meter):
        self.calls.append(entity_id)
        if entity_id in self._error_ids:
            raise RuntimeError("recorder is down")
        return self._states.get(entity_id, []), "kWh" if meter else None


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 3, 20, hour, minute, tzinfo=TZ)


def _switch(*changes: tuple[str, int]) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(state=state, last_updated=_at(hour)) for state, hour in changes
    ]


def _meter_readings(*readings: tuple[float, int]) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(
            state=str(value),
            attributes={"unit_of_measurement": "kWh"},
            last_updated=_at(hour),
        )
        for value, hour in readings
    ]


def _power(*readings: tuple[float, int]) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(state=str(value), last_updated=_at(hour))
        for value, hour in readings
    ]


class ApplianceEnergyTrainingJobTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._original_read = recorder_module.read_entity_history
        patcher = patch.object(appliance_energy_module.dt_util, "now", return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        recorder_module.read_entity_history = self._original_read

    def _install(self, recorder: _FakeRecorder) -> _FakeRecorder:
        recorder_module.read_entity_history = recorder
        return recorder

    def _make_job(self, store, subjects, *, on_trained=None, shared_meters=None):
        return ApplianceEnergyTrainingJob(
            SimpleNamespace(),
            store,
            read_request=lambda: ApplianceEnergyTrainingRequest(
                subjects=tuple(subjects), shared_meters=shared_meters or {}
            ),
            on_trained=on_trained,
        )

    async def test_a_shared_meter_is_split_among_the_members_running(self) -> None:
        """Both run for the first hour, only A for the second.

        A alone draws 1 kW and both 1.5 kW, so B learns 0.5 kW and the shared
        hour is split 2:1. A learns (1 + 1) / 2 h and B 0.5 / 1 h.
        """
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    "switch.ac-a": _switch(("on", 10), ("off", 12)),
                    "switch.ac-b": _switch(("on", 10), ("off", 11)),
                    _SHARED_METER: _meter_readings((0.0, 10), (1.5, 11), (2.5, 12)),
                }
            )
        )
        a = _child("ac-a", history_average=True)
        b = _child("ac-b", history_average=True)
        job = self._make_job(store, [a, b], shared_meters={_SHARED_METER: _shared(a, b)})

        outcome = await job.async_train()

        self.assertEqual(outcome, "estimates_trained")
        self.assertEqual(store.section["data"], {"ac-a": 1.0, "ac-b": 0.5})
        self.assertEqual(
            store.section["shared_meter_weights"], {"ac-a": 1.0, "ac-b": 0.5}
        )
        self.assertEqual(store.section["devices"]["ac-a"]["running_kw"], 1.0)
        self.assertEqual(store.section["devices"]["ac-b"]["running_kw"], 0.5)

    async def test_a_non_schedulable_metered_device_and_a_passive_child_get_records(
        self,
    ) -> None:
        """Neither is on ``history_average``, yet both learn their usage.

        The fridge meters itself and reports its power; the pump is a passive
        meterless child of the breaker. Neither goes into ``data``.
        """
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    "sensor.fridge_energy": _meter_readings((0.0, 0), (1.0, 12), (2.0, 23)),
                    "sensor.fridge_power": _power((0, 0), (100, 10), (0, 12)),
                    "switch.pump": _switch(("off", 0), ("on", 10), ("off", 11)),
                    _SHARED_METER: _meter_readings((0.0, 0), (0.0, 10), (0.4, 11), (0.4, 23)),
                }
            )
        )
        fridge = _metered("sensor.fridge_energy", power="sensor.fridge_power")
        pump = _child("pump")
        job = self._make_job(
            store, [fridge, pump], shared_meters={_SHARED_METER: _shared(pump)}
        )

        outcome = await job.async_train()

        self.assertEqual(outcome, "estimates_trained")
        self.assertEqual(store.section["data"], {})
        self.assertEqual(store.section["failed_appliances"], {})
        fridge_record = store.section["devices"]["sensor.fridge_energy"]
        self.assertEqual(fridge_record["daily_kwh"]["mean"], 2.0)
        self.assertEqual(fridge_record["running_kw"], 0.1)
        self.assertNotIn("on_kwh_per_hour", fridge_record)
        pump_record = store.section["devices"]["pump"]
        self.assertEqual(pump_record["running_kw"], 0.4)
        self.assertEqual(pump_record["on_kwh_per_hour"], 0.4)

    async def test_the_estimate_is_the_records_switch_on_figure(self) -> None:
        """On 10:00-12:00 over 3 kWh: 1.5 kWh per switched-on hour, as the lone
        estimator has always answered for the same history."""
        switch = _switch(("off", 0), ("on", 10), ("off", 12))
        meter = _meter_readings((0.0, 0), (0.0, 10), (3.0, 12), (3.0, 23))
        store = _FakeStore()
        self._install(
            _FakeRecorder({"switch.dishwasher": switch, "sensor.dishwasher_energy": meter})
        )
        dishwasher = _metered(
            "sensor.dishwasher_energy",
            controllable_id="dishwasher",
            switch="switch.dishwasher",
            history_average=True,
        )

        await self._make_job(store, [dishwasher]).async_train()

        lone = recorder_module._estimate_shared_meter_hourly_energy_kwh(
            {"": (switch, ("on",))}, meter, _at(0), NOW, "kWh"
        ).estimates[""]
        self.assertEqual(lone, 1.5)
        self.assertEqual(store.section["data"], {"dishwasher": 1.5})
        self.assertEqual(
            store.section["devices"]["sensor.dishwasher_energy"]["on_kwh_per_hour"], 1.5
        )

    async def test_a_meter_owning_appliance_gets_a_lone_estimate(self) -> None:
        """A boiler that owns the meter its pump shares is a metered device.

        It learns from its whole meter by its own switch -- never routed into
        the shared split it is no member of, which left it with no history.
        """
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    "switch.boiler": _switch(("off", 0), ("on", 10), ("off", 12)),
                    "switch.pump": _switch(("off", 0)),
                    _SHARED_METER: _meter_readings((0.0, 0), (0.0, 10), (4.0, 12), (4.0, 23)),
                }
            )
        )
        boiler = _metered(
            _SHARED_METER,
            controllable_id="boiler",
            switch="switch.boiler",
            history_average=True,
        )
        pump = _child("pump")
        job = self._make_job(
            store, [boiler, pump], shared_meters={_SHARED_METER: _shared(pump)}
        )

        await job.async_train()

        self.assertEqual(store.section["data"], {"boiler": 2.0})
        self.assertEqual(store.section["failed_appliances"], {})

    async def test_a_childs_days_begin_where_its_meters_history_does(self) -> None:
        """The recorder has purged all but the last day of a 30-day window.

        The purged days are unknown, not zero: the pump's typical day is the
        one day its meter still covers.
        """
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    "switch.pump": _switch(("off", 0), ("on", 10), ("off", 11)),
                    _SHARED_METER: _meter_readings((0.0, 0), (0.0, 10), (0.4, 11), (0.4, 23)),
                }
            )
        )
        pump = _child("pump")
        job = self._make_job(store, [pump], shared_meters={_SHARED_METER: _shared(pump)})

        await job.async_train()

        self.assertEqual(
            store.section["devices"]["pump"]["daily_kwh"],
            {"mean": 0.4, "median": 0.4, "min": 0.4, "max": 0.4, "days": 1},
        )

    async def test_a_meter_without_history_records_no_zero_days(self) -> None:
        """No meter rows at all is no evidence the pump idled: it learns
        nothing new, and keeps what it learned before."""
        store = _FakeStore()
        previous = {"daily_kwh": {"mean": 0.4, "median": 0.4, "min": 0.4, "max": 0.4, "days": 1}}
        store.section = {"data": {}, "fingerprint": "old", "devices": {"pump": previous}}
        self._install(
            _FakeRecorder({"switch.pump": _switch(("off", 0), ("on", 10), ("off", 11))})
        )
        pump = _child("pump")
        job = self._make_job(store, [pump], shared_meters={_SHARED_METER: _shared(pump)})

        outcome = await job.async_train()

        self.assertEqual(outcome, "no_history")
        self.assertEqual(store.section["devices"], {"pump": previous})

    async def test_an_estimate_that_rounds_to_nothing_is_a_failure(self) -> None:
        """Stored, a 0.0 would be dropped on adoption without a word; listed
        as failed, the appliance's fixed fallback is visible."""
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    "switch.dishwasher": _switch(("off", 0), ("on", 1), ("off", 23)),
                    "sensor.dishwasher_energy": _meter_readings(
                        (0.0, 0), (0.0, 1), (0.00001, 23)
                    ),
                }
            )
        )
        dishwasher = _metered(
            "sensor.dishwasher_energy",
            controllable_id="dishwasher",
            switch="switch.dishwasher",
            history_average=True,
        )

        await self._make_job(store, [dishwasher]).async_train()

        self.assertEqual(store.section["data"], {})
        self.assertEqual(
            store.section["failed_appliances"],
            {"dishwasher": "non-positive estimate: 0.0"},
        )

    async def test_every_entity_is_read_exactly_once(self) -> None:
        """The heater's meter is a device of its own and the breaker's metered
        child; its switch is its signal. Each is still read once."""
        store = _FakeStore()
        recorder = self._install(
            _FakeRecorder(
                {
                    _SHARED_METER: _meter_readings((0.0, 0), (5.0, 23)),
                    "sensor.heater_energy": _meter_readings((0.0, 0), (3.0, 23)),
                }
            )
        )
        breaker = _metered(_SHARED_METER, power="sensor.breaker_power")
        heater = _metered(
            "sensor.heater_energy",
            controllable_id="heater",
            switch="switch.heater",
            power="sensor.heater_power",
            history_average=True,
            lookback_days=7,
        )
        pump = _child("pump")
        job = self._make_job(
            store,
            [breaker, heater, pump],
            shared_meters={
                _SHARED_METER: _shared(pump, metered_children=["sensor.heater_energy"])
            },
        )

        await job.async_train()

        self.assertEqual(
            sorted(recorder.calls),
            sorted(
                [
                    _SHARED_METER,
                    "sensor.breaker_power",
                    "sensor.heater_energy",
                    "sensor.heater_power",
                    "switch.heater",
                    "switch.pump",
                ]
            ),
        )

    async def test_a_parents_daily_energy_includes_its_metered_children(self) -> None:
        """The breaker read 5 kWh, 3 of them the heater's own meter: its record
        is its total, as its power sensor and its today tile are."""
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    _SHARED_METER: _meter_readings((0.0, 0), (5.0, 23)),
                    "sensor.heater_energy": _meter_readings((0.0, 0), (3.0, 23)),
                }
            )
        )
        # Neither learns a forecast figure, so both read the default window.
        breaker = _metered(_SHARED_METER, lookback_days=30)
        heater = _metered("sensor.heater_energy", lookback_days=30)
        pump = _child("pump")
        job = self._make_job(
            store,
            [breaker, heater, pump],
            shared_meters={
                _SHARED_METER: _shared(pump, metered_children=["sensor.heater_energy"])
            },
        )

        await job.async_train()

        devices = store.section["devices"]
        self.assertEqual(devices[_SHARED_METER]["daily_kwh"]["mean"], 5.0)
        self.assertEqual(devices["sensor.heater_energy"]["daily_kwh"]["mean"], 3.0)

    async def test_a_failing_read_costs_only_that_device(self) -> None:
        """The dishwasher's switch cannot be read: it keeps its previous record,
        drops to its fixed figure, and the washer learns as usual."""
        store = _FakeStore()
        previous_record = {"daily_kwh": {"mean": 1.1}}
        store.section = {
            "data": {"dishwasher": 0.9},
            "fingerprint": "old",
            "devices": {"sensor.dishwasher_energy": previous_record, "gone": {}},
        }
        self._install(
            _FakeRecorder(
                {
                    "switch.washer": _switch(("off", 0), ("on", 10), ("off", 11)),
                    "sensor.washer_energy": _meter_readings((0.0, 0), (0.0, 10), (0.8, 11), (0.8, 23)),
                },
                error_ids=("switch.dishwasher",),
            )
        )
        dishwasher = _metered(
            "sensor.dishwasher_energy",
            controllable_id="dishwasher",
            switch="switch.dishwasher",
            history_average=True,
        )
        washer = _metered(
            "sensor.washer_energy",
            controllable_id="washer",
            switch="switch.washer",
            history_average=True,
        )

        with self.assertLogs(appliance_energy_module._LOGGER, level="ERROR"):
            outcome = await self._make_job(store, [dishwasher, washer]).async_train()

        self.assertEqual(outcome, "estimates_trained")
        # Out of ``data``: the reader falls back to its configured figure.
        self.assertEqual(store.section["data"], {"washer": 0.8})
        self.assertEqual(
            store.section["failed_appliances"], {"dishwasher": "recorder is down"}
        )
        self.assertEqual(
            store.section["devices"]["sensor.dishwasher_energy"], previous_record
        )
        self.assertIn("sensor.washer_energy", store.section["devices"])
        self.assertNotIn("gone", store.section["devices"])
        self.assertEqual(appliance_energy_module.health_for(store.section), "degraded")

    async def test_a_fixed_sharer_takes_its_share_but_is_no_estimate(self) -> None:
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    "switch.ac-a": _switch(("on", 10), ("off", 11)),
                    "switch.ac-fixed": _switch(("on", 10), ("off", 11)),
                    _SHARED_METER: _meter_readings((0.0, 10), (1.0, 11), (2.0, 12)),
                }
            )
        )
        a = _child("ac-a", history_average=True)
        fixed = _child("ac-fixed")
        job = self._make_job(
            store, [a, fixed], shared_meters={_SHARED_METER: _shared(a, fixed)}
        )

        await job.async_train()

        self.assertEqual(store.section["data"], {"ac-a": 0.5})
        self.assertIn("ac-fixed", store.section["devices"])

    async def test_a_failed_shared_read_fails_every_member_under_its_key(self) -> None:
        """Passive members too: the run must not look healthy on stale weights."""
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    "switch.dishwasher": _switch(("off", 0), ("on", 10), ("off", 11)),
                    "sensor.dishwasher_energy": _meter_readings((0.0, 0), (0.0, 10), (0.8, 11), (0.8, 23)),
                },
                error_ids=(_SHARED_METER,),
            )
        )
        dishwasher = _metered(
            "sensor.dishwasher_energy",
            controllable_id="dishwasher",
            switch="switch.dishwasher",
            history_average=True,
        )
        a = _child("ac-a", history_average=True)
        pump = _child("pump")
        job = self._make_job(
            store,
            [dishwasher, a, pump],
            shared_meters={_SHARED_METER: _shared(a, pump)},
        )

        with self.assertLogs(appliance_energy_module._LOGGER, level="WARNING") as logs:
            outcome = await job.async_train()

        self.assertEqual(outcome, "estimates_trained")
        self.assertEqual(store.section["data"], {"dishwasher": 0.8})
        self.assertTrue(any("ac-a, pump" in line for line in logs.output))
        self.assertEqual(
            store.section["failed_appliances"],
            {"ac-a": "recorder is down", "pump": "recorder is down"},
        )
        self.assertEqual(appliance_energy_module.health_for(store.section), "degraded")

    async def test_a_meter_whose_children_are_all_passive_gets_their_weights(
        self,
    ) -> None:
        """No appliance learns, yet the live split needs the weights."""
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    "switch.pump": _switch(("on", 10), ("off", 11)),
                    "switch.lamp": _switch(("off", 10), ("on", 11), ("off", 12)),
                    _SHARED_METER: _meter_readings((0.0, 10), (2.0, 11), (2.5, 12)),
                }
            )
        )
        pump, lamp = _child("pump"), _child("lamp")
        job = self._make_job(
            store,
            [pump, lamp],
            shared_meters={_SHARED_METER: _shared(pump, lamp, tolerance=0.2)},
        )

        outcome = await job.async_train()

        self.assertEqual(outcome, "estimates_trained")
        self.assertEqual(store.section["data"], {})
        self.assertEqual(
            store.section["shared_meter_weights"], {"pump": 2.0, "lamp": 0.5}
        )

    async def test_a_member_that_learns_nothing_keeps_its_previous_weight(
        self,
    ) -> None:
        """Air conditioners idle all winter have not changed their power."""
        store = _FakeStore()
        store.section = {
            "data": {},
            "fingerprint": "old",
            "shared_meter_weights": {"pump": 9.0, "lamp": 0.7},
        }
        self._install(
            _FakeRecorder(
                {
                    "switch.pump": _switch(("on", 10), ("off", 12)),
                    "switch.lamp": _switch(("off", 10)),
                    _SHARED_METER: _meter_readings((0.0, 10), (4.0, 12)),
                }
            )
        )
        pump, lamp = _child("pump"), _child("lamp")
        job = self._make_job(
            store, [pump, lamp], shared_meters={_SHARED_METER: _shared(pump, lamp)}
        )

        await job.async_train()

        self.assertEqual(
            store.section["shared_meter_weights"], {"pump": 2.0, "lamp": 0.7}
        )

    async def test_a_failing_meter_read_keeps_its_members_previous_weights_and_records(
        self,
    ) -> None:
        """The section is replaced whole; one bad read must not reset the split.

        Only the failing meter's members carry over: a member no longer on any
        meter is dropped with the rest of the old section.
        """
        store = _FakeStore()
        store.section = {
            "data": {},
            "fingerprint": "old",
            "shared_meter_weights": {"ac-a": 1.2, "ac-b": None, "gone": 3.0},
            "devices": {"ac-a": {"running_kw": 1.2}},
        }
        self._install(_FakeRecorder({}, error_ids=(_SHARED_METER,)))
        a, b = _child("ac-a"), _child("ac-b")
        job = self._make_job(store, [a, b], shared_meters={_SHARED_METER: _shared(a, b)})

        with self.assertLogs(appliance_energy_module._LOGGER, level="ERROR"):
            await job.async_train()

        self.assertEqual(
            store.section["shared_meter_weights"], {"ac-a": 1.2, "ac-b": None}
        )
        self.assertEqual(store.section["devices"], {"ac-a": {"running_kw": 1.2}})

    async def test_no_subjects_records_not_configured_without_reading(self) -> None:
        """Nothing to learn, and nothing read.

        Recorded rather than skipped so the stored fingerprint matches what
        startup computes — otherwise every restart would schedule a refit.
        """
        store = _FakeStore()
        recorder = self._install(_FakeRecorder({}))

        outcome = await self._make_job(store, []).async_train()

        self.assertEqual(outcome, "not_configured")
        self.assertEqual(store.section["data"], {})
        self.assertEqual(store.section["devices"], {})
        self.assertEqual(recorder.calls, [])

    async def test_an_appliance_without_usable_history_is_a_failure(self) -> None:
        """Leaving its id out is what makes the reader use its configured figure."""
        store = _FakeStore()
        self._install(_FakeRecorder({}))
        dishwasher = _metered(
            "sensor.dishwasher_energy",
            controllable_id="dishwasher",
            switch="switch.dishwasher",
            history_average=True,
        )

        outcome = await self._make_job(store, [dishwasher]).async_train()

        self.assertEqual(outcome, "no_history")
        self.assertEqual(store.section["data"], {})
        self.assertEqual(
            store.section["failed_appliances"], {"dishwasher": "no usable history"}
        )
        self.assertEqual(appliance_energy_module.health_for(store.section), "degraded")

    async def test_a_clean_run_records_no_failures(self) -> None:
        store = _FakeStore()
        self._install(
            _FakeRecorder(
                {
                    "switch.dishwasher": _switch(("off", 0), ("on", 10), ("off", 11)),
                    "sensor.dishwasher_energy": _meter_readings((0.0, 0), (0.0, 10), (0.8, 11), (0.8, 23)),
                }
            )
        )
        dishwasher = _metered(
            "sensor.dishwasher_energy",
            controllable_id="dishwasher",
            switch="switch.dishwasher",
            history_average=True,
        )

        await self._make_job(store, [dishwasher]).async_train()

        self.assertEqual(store.section["failed_appliances"], {})
        self.assertEqual(appliance_energy_module.health_for(store.section), "ok")

    async def test_a_request_that_cannot_be_built_is_recorded_as_a_failure(
        self,
    ) -> None:
        """Building the request reads live config; its failure is a failed run,
        persisted like any other rather than escaping to the batch."""
        store = _FakeStore()
        store.section = {
            "data": {"dishwasher": 0.8},
            "fingerprint": "old",
            "trained_at": "2026-08-01T03:00:00+02:00",
            "last_outcome": "estimates_trained",
            "error_reason": None,
            "failed_appliances": {"boiler": "gone"},
        }

        def _raise():
            raise RuntimeError("registry is broken")

        calls: list[int] = []

        async def _on_trained() -> None:
            calls.append(1)

        job = ApplianceEnergyTrainingJob(
            SimpleNamespace(), store, read_request=_raise, on_trained=_on_trained
        )

        with self.assertLogs(appliance_energy_module._LOGGER, level="ERROR"):
            outcome = await job.async_train()

        self.assertEqual(outcome, "training_failed")
        self.assertEqual(store.writes, ["training_failed"])
        self.assertEqual(store.section["error_reason"], "registry is broken")
        self.assertEqual(store.section["data"], {"dishwasher": 0.8})
        self.assertEqual(len(calls), 1)

    async def test_store_failure_preserves_the_previous_estimates(self) -> None:
        store = _FakeStore()
        store.section = {
            "data": {"dishwasher": 0.8},
            "fingerprint": "old",
            "trained_at": "2026-08-01T03:00:00+02:00",
            "last_outcome": "estimates_trained",
            "error_reason": None,
        }

        async def _explode(*_args, **_kwargs):
            raise RuntimeError("store is broken")

        store.async_record_appliance_energy = _explode
        self._install(_FakeRecorder({}))
        job = self._make_job(store, [_metered("sensor.dishwasher_energy")])

        with self.assertLogs(appliance_energy_module._LOGGER, level="ERROR"):
            outcome = await job.async_train()

        self.assertEqual(outcome, "training_failed")
        self.assertEqual(store.section["data"], {"dishwasher": 0.8})
        self.assertEqual(store.section["error_reason"], "store is broken")

    async def test_on_trained_is_announced(self) -> None:
        store = _FakeStore()
        self._install(_FakeRecorder({}))
        calls: list[int] = []

        async def _on_trained() -> None:
            calls.append(1)

        job = self._make_job(
            store, [_metered("sensor.dishwasher_energy")], on_trained=_on_trained
        )

        await job.async_train()

        self.assertEqual(len(calls), 1)


class ApplianceEnergyFingerprintTests(unittest.TestCase):
    @staticmethod
    def _fingerprint(*subjects, shared_meters=None) -> str:
        return ApplianceEnergyTrainingRequest(
            subjects, shared_meters=shared_meters or {}
        ).fingerprint

    def test_lookback_change_moves_the_fingerprint(self) -> None:
        self.assertNotEqual(
            self._fingerprint(_metered("sensor.a", lookback_days=30)),
            self._fingerprint(_metered("sensor.a", lookback_days=60)),
        )

    def test_entity_change_moves_the_fingerprint(self) -> None:
        self.assertNotEqual(
            self._fingerprint(_metered("sensor.a", power="sensor.a_power")),
            self._fingerprint(_metered("sensor.a", power="sensor.other")),
        )

    def test_the_forecast_strategy_moves_the_fingerprint(self) -> None:
        """Whether a device's figure goes into ``data`` changes the answer."""
        self.assertNotEqual(
            self._fingerprint(_metered("sensor.a", controllable_id="a")),
            self._fingerprint(
                _metered("sensor.a", controllable_id="a", history_average=True)
            ),
        )

    def test_adding_a_sharer_moves_the_fingerprint(self) -> None:
        """A new device on the meter shrinks everyone else's share."""
        a, b, c = _child("ac-a"), _child("ac-b"), _child("ac-c")

        self.assertNotEqual(
            self._fingerprint(a, b, shared_meters={_SHARED_METER: _shared(a, b)}),
            self._fingerprint(a, b, shared_meters={_SHARED_METER: _shared(a, b, c)}),
        )

    def test_changing_a_parents_tolerance_moves_the_fingerprint(self) -> None:
        """The tolerance caps what the members are handed, so their figures."""
        a = _child("ac-a")

        def _with(tolerance):
            return self._fingerprint(
                a, shared_meters={_SHARED_METER: _shared(a, tolerance=tolerance)}
            )

        self.assertNotEqual(_with(None), _with(0.1))
        self.assertNotEqual(_with(0.1), _with(0.2))

    def test_subject_order_does_not_move_the_fingerprint(self) -> None:
        self.assertEqual(
            self._fingerprint(_metered("sensor.a"), _metered("sensor.b")),
            self._fingerprint(_metered("sensor.b"), _metered("sensor.a")),
        )


if __name__ == "__main__":
    unittest.main()
