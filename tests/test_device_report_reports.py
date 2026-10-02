"""Report specs over the device dataset: the Over time report.

Pure -- the dataset and the reports import nothing from Home Assistant, so the
span read is a :class:`SpanHistory` built here and nothing is stubbed. Every
over-time payload goes through :meth:`OverTimeTestCase.over_time`, which checks
the identity each bucket must keep: its series plus the house's remainder minus
the house's over-allocation is the house meter. Like the dataset's own, it holds
over the hours the house meter measured, so a fixture with a house gap opts out.
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

model = importlib.import_module("custom_components.helman.span_history_model")
dataset_mod = importlib.import_module("custom_components.helman.device_reports.dataset")
reports_mod = importlib.import_module("custom_components.helman.device_reports.reports")

PRAGUE = ZoneInfo("Europe/Prague")
#: Tuesday 2026-09-01 to Monday 2026-09-07, inclusive.
START = datetime(2026, 9, 1, tzinfo=PRAGUE)
END = datetime(2026, 9, 8, tzinfo=PRAGUE)
#: Well after the period: every hour of it has elapsed.
AFTER = datetime(2026, 9, 20, tzinfo=PRAGUE)

HOUSE = "sensor.house"
WASHER = "sensor.washer"
FRIDGE = "sensor.fridge"
BREAKER = "sensor.breaker"
HEATER = "sensor.heater"
METERS = model.SpanMeters(
    solar=None,
    grid_import=None,
    grid_export=None,
    house=HOUSE,
    battery_charge=None,
    battery_discharge=None,
)


def hour(day: int, index: int) -> datetime:
    """Hour ``index`` of the period's ``day``-th day (0-based), as a UTC key."""
    local = datetime(2026, 9, 1 + day, index, tzinfo=PRAGUE)
    return local.astimezone(timezone.utc)


def every_hour(kwh: float) -> dict[datetime, float]:
    hours = model.period_hours(START, END)
    return dict.fromkeys(hours, kwh)


def metered(meter: str, *children) -> dict:
    return {
        "id": meter,
        "displayName": meter.split(".")[1].title(),
        "icon": "mdi:power-plug",
        "energyEntityId": meter,
        "powerSensorId": None,
        "isEstimated": False,
        "isUnmeasured": False,
        "children": list(children),
    }


TREE = {
    "consumers": [
        {
            "id": "house",
            "displayName": "",
            "icon": "mdi:home",
            "children": [
                metered(WASHER),
                metered(FRIDGE),
                metered(BREAKER, metered(HEATER)),
            ],
        }
    ]
}


def span(energy: dict[str, dict[datetime, float]]) -> model.SpanHistory:
    return model.SpanHistory(
        meters=METERS,
        local_start=START,
        local_end=END,
        energy_kwh=energy,
        rows={},
        import_rate={},
        import_rate_source={},
        export_rate={},
    )


def default_energy() -> dict[str, dict[datetime, float]]:
    """2 kWh an hour in the house; the fridge 0.25 every hour; the washer 1 kWh
    an hour for ten hours of the first day; the breaker 0.5 an hour, half of it
    the heater. Nothing is over-allocated."""
    return {
        HOUSE: every_hour(2.0),
        FRIDGE: every_hour(0.25),
        WASHER: {hour(0, index): 1.0 for index in range(8, 18)},
        BREAKER: every_hour(0.5),
        HEATER: every_hour(0.25),
    }


class OverTimeTestCase(unittest.TestCase):
    def over_time(
        self,
        energy: dict[str, dict[datetime, float]],
        granularity: str = "day",
        *,
        start: date = date(2026, 9, 1),
        end: date = date(2026, 9, 7),
        now: datetime = AFTER,
        house_measured_throughout: bool = True,
    ) -> dict:
        dataset = dataset_mod.build_device_dataset(TREE, span(energy), local_tz=PRAGUE, now=now)
        payload = reports_mod.build_report(
            "over_time",
            dataset,
            reports_mod.ReportQuery(start_date=start, end_date=end, granularity=granularity),
            currency="CZK",
            navigation_range={"minDate": "2026-01-01", "maxDate": "2026-09-20"},
        )
        for bucket in payload["buckets"] if house_measured_throughout else []:
            self.assertAlmostEqual(
                sum(bucket["values"].values()) + bucket["unmeasured"] - bucket["overallocated"],
                bucket["house"],
                places=9,
                msg=bucket["start"],
            )
        return payload


class TestOverTime(OverTimeTestCase):
    def test_series_are_ranked_by_the_period_total_not_per_bucket(self):
        payload = self.over_time(default_energy())
        # Over the period the breaker has 84 kWh, the fridge 42 and the washer
        # 10; on the first day the washer's 10 beats the fridge's 6, and it
        # still ranks behind the fridge in that column too.
        self.assertEqual(
            [series["id"] for series in payload["series"]], [BREAKER, FRIDGE, WASHER]
        )
        first_day = payload["buckets"][0]["values"]
        self.assertGreater(first_day[WASHER], first_day[FRIDGE])
        self.assertEqual(
            payload["series"][0],
            {
                "id": BREAKER,
                "label": "Breaker",
                "icon": "mdi:power-plug",
                "estimated": False,
                "first_hour": START.isoformat(),
            },
        )

    def test_only_top_level_devices_are_series(self):
        payload = self.over_time(default_energy())
        ids = {series["id"] for series in payload["series"]}
        self.assertNotIn(HEATER, ids)
        for bucket in payload["buckets"]:
            self.assertEqual(set(bucket["values"]), ids)

    def test_day_buckets_carry_the_house_and_its_remainder(self):
        payload = self.over_time(default_energy())
        self.assertEqual(payload["granularity"], "day")
        self.assertEqual(len(payload["buckets"]), 7)
        first, second = payload["buckets"][:2]
        self.assertEqual(
            first,
            {
                "start": "2026-09-01",
                "end": "2026-09-01",
                "partial": False,
                "house": 48.0,
                "values": {BREAKER: 12.0, FRIDGE: 6.0, WASHER: 10.0},
                "unmeasured": 20.0,
                "overallocated": 0.0,
            },
        )
        self.assertEqual(second["values"][WASHER], 0.0)
        self.assertEqual(second["unmeasured"], 30.0)

    def test_overallocation_is_the_house_level_excess_per_bucket(self):
        energy = default_energy()
        # 20:00 on the third day: 7 + 0.25 + 0.5 under a 2 kWh house is 5.75 over.
        energy[WASHER][hour(2, 20)] = 7.0
        payload = self.over_time(energy)
        third = payload["buckets"][2]
        self.assertAlmostEqual(third["overallocated"], 5.75)
        self.assertEqual(payload["buckets"][1]["overallocated"], 0.0)

    def test_a_child_measured_while_the_house_was_not_is_not_overallocation(self):
        energy = default_energy()
        # The house meter starts on the second day.
        energy[HOUSE] = {key: kwh for key, kwh in energy[HOUSE].items() if key >= hour(1, 0)}
        payload = self.over_time(energy, house_measured_throughout=False)
        self.assertEqual(payload["buckets"][0]["overallocated"], 0.0)
        self.assertEqual(payload["buckets"][0]["house"], 0.0)

    def test_week_buckets_are_clamped_to_the_period(self):
        payload = self.over_time(default_energy(), "week")
        self.assertEqual(payload["granularity"], "week")
        self.assertEqual(
            [(b["start"], b["end"], b["partial"]) for b in payload["buckets"]],
            [("2026-09-01", "2026-09-06", True), ("2026-09-07", "2026-09-07", True)],
        )
        self.assertEqual(payload["buckets"][0]["house"], 6 * 48.0)

    def test_a_month_bucket_over_the_period_equals_the_period(self):
        payload = self.over_time(default_energy(), "month")
        (bucket,) = payload["buckets"]
        self.assertEqual(bucket["house"], 7 * 48.0)
        self.assertEqual(bucket["house"], payload["house_kwh"])
        self.assertTrue(bucket["partial"])

    def test_todays_bucket_is_partial(self):
        now = datetime(2026, 9, 7, 12, 0, tzinfo=PRAGUE)
        payload = self.over_time(default_energy(), now=now)
        self.assertEqual([b["partial"] for b in payload["buckets"]], [False] * 6 + [True])

    def test_the_ranking_carries_no_granularity(self):
        dataset = dataset_mod.build_device_dataset(
            TREE, span(default_energy()), local_tz=PRAGUE, now=AFTER
        )
        payload = reports_mod.build_report(
            "ranking",
            dataset,
            reports_mod.ReportQuery(
                start_date=date(2026, 9, 1), end_date=date(2026, 9, 7), granularity="week"
            ),
            currency=None,
            navigation_range={},
        )
        self.assertNotIn("granularity", payload)
        self.assertFalse(reports_mod.REPORTS["ranking"].uses_granularity)
        self.assertTrue(reports_mod.REPORTS["over_time"].uses_granularity)


if __name__ == "__main__":
    unittest.main()
