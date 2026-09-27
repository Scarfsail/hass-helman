"""Own energy: a meter's reading minus its metered children's.

One definition, :func:`~custom_components.helman.recorder_hourly_series.own_energy_observations`,
serves every path that reads a carved or shared meter -- the shared-meter
split, the house baseline fit and the forecast actuals. These fixtures are the
two live shapes it exists for: the study breaker with a sub-metered plug, and a
breaker whose meterless children split what its sub-meters do not measure.
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

series = importlib.import_module("custom_components.helman.recorder_hourly_series")
devices = importlib.import_module("custom_components.helman.controllables.config")
house_training = importlib.import_module(
    "custom_components.helman.training.house_consumption"
)
profiles = importlib.import_module(
    "custom_components.helman.consumption_forecast_profiles"
)
forecast_builder = importlib.import_module(
    "custom_components.helman.consumption_forecast_builder"
)
appliance_energy = importlib.import_module(
    "custom_components.helman.training.appliance_energy"
)

HOUSE = "sensor.house_energy"
STUDY = "sensor.study_energy"
PLUG = "sensor.plug_energy"


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 3, 20, hour, minute, tzinfo=timezone.utc)


def _study(*, lamp_schedulable: bool) -> dict:
    """The study breaker: a schedulable sub-metered plug and a meterless lamp."""
    return {
        "devices": [
            {
                "id": "study",
                "consumption": {"energy_entity_id": STUDY},
                "children": [
                    {
                        "id": "plug",
                        "schedulable": True,
                        "consumption": {"energy_entity_id": PLUG},
                    },
                    {
                        "id": "lamp",
                        "schedulable": lamp_schedulable,
                        "controls": {"switch": {"entity_id": "switch.lamp"}},
                    },
                ],
            }
        ]
    }


def _meter(*readings: tuple[datetime, float]) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(
            state=str(value),
            attributes={"unit_of_measurement": "kWh"},
            last_updated=instant,
        )
        for instant, value in readings
    ]


def _switch(*changes: tuple[str, datetime]) -> list[SimpleNamespace]:
    return [SimpleNamespace(state=state, last_updated=at) for state, at in changes]


class OwnEnergyObservationTests(unittest.TestCase):
    def test_a_meter_without_children_is_its_own_energy(self) -> None:
        meter = [(_at(10), 5.0), (_at(11), 6.0), (_at(12), 8.0)]

        self.assertEqual(
            series.own_energy_observations(meter, [], [_at(10), _at(11), _at(12)]),
            {_at(10): 1.0, _at(11): 2.0},
        )

    def test_metered_children_are_subtracted_per_interval(self) -> None:
        meter = [(_at(10), 0.0), (_at(11), 1.0), (_at(12), 3.0)]
        plug = [(_at(10), 0.0), (_at(11), 0.6), (_at(12), 0.6)]

        own = series.own_energy_observations(meter, [plug], [_at(10), _at(11), _at(12)])

        self.assertAlmostEqual(own[_at(10)], 0.4)
        self.assertAlmostEqual(own[_at(11)], 2.0)

    def test_each_series_is_unwrapped_before_subtracting(self) -> None:
        # The plug's counter resets at 11:00; unwrapped it still measured 0.5.
        meter = [(_at(10), 0.0), (_at(11), 1.0), (_at(12), 2.0)]
        plug = [(_at(10), 40.0), (_at(10, 30), 40.5), (_at(11), 0.0), (_at(12), 0.5)]

        own = series.own_energy_observations(meter, [plug], [_at(10), _at(11), _at(12)])

        self.assertAlmostEqual(own[_at(10)], 0.5)
        self.assertAlmostEqual(own[_at(11)], 0.5)

    def test_a_negative_own_delta_is_skipped(self) -> None:
        # The child's reading runs ahead of its parent's: no own energy to give.
        meter = [(_at(10), 0.0), (_at(11), 0.5)]
        plug = [(_at(10), 0.0), (_at(11), 0.7)]

        self.assertEqual(
            series.own_energy_observations(meter, [plug], [_at(10), _at(11)]), {}
        )

    def test_slot_changes_pass_through_without_children(self) -> None:
        changes = {_at(10): 1.25, _at(11): -0.1}

        self.assertEqual(
            series.own_energy_changes(changes, [], slot=timedelta(hours=1)), changes
        )

    def test_slot_changes_subtract_children_on_the_meters_slots(self) -> None:
        # The child has no 11:00 slot (a statistics gap, or a sub-meter newer
        # than its parent): it subtracts nothing there, the parent's slot stays.
        own = series.own_energy_changes(
            {_at(10): 1.0, _at(11): 2.0, _at(13): 1.5},
            [{_at(10): 0.25, _at(13): 0.5}],
            slot=timedelta(hours=1),
        )

        self.assertEqual(set(own), {_at(10), _at(11), _at(13)})
        self.assertAlmostEqual(own[_at(10)], 0.75)
        self.assertAlmostEqual(own[_at(11)], 2.0)
        self.assertAlmostEqual(own[_at(13)], 1.0)

    def test_a_child_without_readings_yet_subtracts_nothing(self) -> None:
        # The plug was installed at 11:00; the breaker's 10:00 interval stays.
        meter = [(_at(10), 0.0), (_at(11), 1.0), (_at(12), 3.0)]
        plug = [(_at(11), 5.0), (_at(12), 5.5)]

        own = series.own_energy_observations(meter, [plug], [_at(10), _at(11), _at(12)])

        self.assertAlmostEqual(own[_at(10)], 1.0)
        self.assertAlmostEqual(own[_at(11)], 1.5)


class SharedMeterOwnEnergyTests(unittest.TestCase):
    """The split of a meter among its meterless children uses own energy."""

    def test_a_meterless_child_trains_on_the_parents_own_share(self) -> None:
        """1,000 W on the parent, 600 W on a metered sibling: 400 W is the child's."""
        parent = _meter((_at(10), 0.0), (_at(11), 1.0), (_at(12), 2.0))
        sibling = _meter((_at(10), 0.0), (_at(11), 0.6), (_at(12), 1.2))

        estimates = series._estimate_shared_meter_hourly_energy_kwh(
            {"lamp": (_switch(("on", _at(10)), ("off", _at(12))), ("on",))},
            parent,
            _at(10),
            _at(12),
            "kWh",
            metered_children=[(sibling, "kWh")],
        )

        self.assertEqual(estimates, {"lamp": 0.4})

    def test_two_children_running_half_an_hour_each_get_their_own_half(self) -> None:
        """0.8 kWh while A ran, 0.2 kWh while B ran -- not 0.5 kWh each."""
        meter = _meter((_at(10), 0.0), (_at(10, 30), 0.8), (_at(11), 1.0))

        estimates = series._estimate_shared_meter_hourly_energy_kwh(
            {
                "a": (_switch(("on", _at(10)), ("off", _at(10, 30))), ("on",)),
                "b": (_switch(("on", _at(10, 30)), ("off", _at(11))), ("on",)),
            },
            meter,
            _at(10),
            _at(11),
            "kWh",
        )

        self.assertEqual(estimates, {"a": 1.6, "b": 0.4})


class HouseBaselineOwnEnergyTests(unittest.TestCase):
    """The baseline subtracts each carved meter's own energy, once."""

    #: One hour: 3 kWh in the house, 1 kWh on the study breaker, 0.6 of it the plug.
    _ROWS = {
        HOUSE: [{"start": _at(10).timestamp(), "change": 3.0}],
        STUDY: [{"start": _at(10).timestamp(), "change": 1.0}],
        PLUG: [{"start": _at(10).timestamp(), "change": 0.6}],
    }

    def _fit(self, config: dict):
        consumers = devices.read_carved_meters(config)
        histories = [
            profiles.ConsumerHistoryData(
                entity_id=consumer["energy_entity_id"],
                label=consumer["label"],
                values_by_ts=house_training._own_values_by_ts(self._ROWS, consumer),
                query_succeeded=True,
            )
            for consumer in consumers
        ]
        profile = profiles.fit_house_profile(
            self._ROWS[HOUSE], histories, today_local=_at(10).date()
        )
        local = profiles.dt_util.as_local(_at(10))
        slot = profiles.HourOfWeekWinsorizedMeanProfile.slot_index(
            local.weekday(), local.hour
        )
        return profile, slot

    def test_a_passive_breaker_leaves_only_the_plug_carved(self) -> None:
        profile, slot = self._fit(_study(lamp_schedulable=False))

        self.assertEqual(set(profile.consumers), {PLUG})
        self.assertAlmostEqual(profile.non_deferrable[slot].value, 2.4)

    def test_a_carved_breaker_subtracts_its_own_energy_not_its_meter(self) -> None:
        profile, slot = self._fit(_study(lamp_schedulable=True))

        # The plug once, the breaker's own 0.4 once: 3 - 0.6 - 0.4.
        self.assertAlmostEqual(profile.non_deferrable[slot].value, 2.0)
        self.assertAlmostEqual(profile.consumers[STUDY][slot].value, 0.4)
        self.assertAlmostEqual(profile.consumers[PLUG][slot].value, 0.6)


class ForecastActualsOwnEnergyTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_carved_meters_actuals_are_its_own_energy(self) -> None:
        slots = {
            STUDY: {_at(10): 1.0, _at(10, 15): 0.5},
            PLUG: {_at(10): 0.6, _at(10, 15): 0.5},
        }

        class _SlotHistory:
            async def async_query_slot_energy_changes(
                self, entity_id, reference_time, *, interval_minutes
            ):
                return slots[entity_id]

        builder = forecast_builder.ConsumptionForecastBuilder(
            SimpleNamespace(), _study(lamp_schedulable=True), _SlotHistory()
        )
        consumers = devices.read_carved_meters(_study(lamp_schedulable=True))

        histories = await builder._query_consumer_slot_histories(
            consumers, reference_time=_at(11)
        )

        by_entity = {history.entity_id: history.values_by_slot for history in histories}
        self.assertAlmostEqual(by_entity[STUDY][_at(10)], 0.4)
        self.assertAlmostEqual(by_entity[STUDY][_at(10, 15)], 0.0)
        self.assertEqual(by_entity[PLUG], slots[PLUG])


class TopologyFingerprintTests(unittest.TestCase):
    """A hierarchy change retrains both the house fit and the appliance estimates."""

    @staticmethod
    def _house_fingerprint(config: dict) -> str:
        return forecast_builder.ConsumptionForecastBuilder._build_config_fingerprint(
            total_energy_entity_id=HOUSE,
            training_window_days=56,
            min_history_days=14,
            consumers_config=devices.read_carved_meters(config),
        )

    @staticmethod
    def _appliance_fingerprint(config: dict) -> str:
        return appliance_energy.ApplianceEnergyTrainingRequest(
            shared_meters={
                meter: appliance_energy.SharedMeter(
                    members=tuple(
                        appliance_energy.SharedMeterMember.for_signal(*member)
                        for member in shared["members"]
                    ),
                    metered_children=tuple(shared["metered_children"]),
                )
                for meter, shared in devices.read_shared_meters(config).items()
            }
        ).fingerprint

    def test_adding_a_sub_meter_changes_both_fingerprints(self) -> None:
        flat = _study(lamp_schedulable=True)
        del flat["devices"][0]["children"][0]
        nested = _study(lamp_schedulable=True)

        self.assertNotEqual(self._house_fingerprint(flat), self._house_fingerprint(nested))
        self.assertNotEqual(
            self._appliance_fingerprint(flat), self._appliance_fingerprint(nested)
        )


if __name__ == "__main__":
    unittest.main()
