"""Report specs over the device dataset: the Over time and Daily profile reports.

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
from datetime import date, datetime, timedelta, timezone
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


def span(
    energy: dict[str, dict[datetime, float]],
    *,
    start: datetime = START,
    end: datetime = END,
    rows: dict[str, dict[datetime, dict]] | None = None,
    import_rate: dict[datetime, float] | None = None,
    export_rate: dict[datetime, float] | None = None,
) -> model.SpanHistory:
    import_rate = import_rate or {}
    return model.SpanHistory(
        meters=METERS,
        local_start=start,
        local_end=end,
        energy_kwh=energy,
        rows=rows or {},
        import_rate=import_rate,
        import_rate_source=dict.fromkeys(import_rate, model.RATE_RECORDED),
        export_rate=export_rate or {},
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


SHARE = "sensor.lamp_share"


def estimated(node_id: str, share_sensor: str) -> dict:
    return {
        "id": node_id,
        "displayName": node_id.title(),
        "icon": None,
        "energyEntityId": None,
        "powerSensorId": share_sensor,
        "isEstimated": True,
        "isUnmeasured": False,
        "children": [],
    }


def local_hours(start: datetime, end: datetime) -> list[datetime]:
    return model.period_hours(start, end)


class TestDailyProfile(unittest.TestCase):
    def daily_profile(
        self,
        history: model.SpanHistory,
        *,
        tree: dict = TREE,
        now: datetime = AFTER,
    ) -> dict:
        dataset = dataset_mod.build_device_dataset(tree, history, local_tz=PRAGUE, now=now)
        start = history.local_start.date()
        end = (history.local_end - timedelta(days=1)).date()
        payload = reports_mod.build_report(
            "daily_profile",
            dataset,
            reports_mod.ReportQuery(start_date=start, end_date=end, granularity="week"),
            currency="CZK",
            navigation_range={},
        )
        for row in payload["rows"]:
            self.assertEqual(len(row["watts"]), 24)
        self.assertEqual(len(payload["import_rate"]), 24)
        self.assertEqual(len(payload["export_rate"]), 24)
        return payload

    @staticmethod
    def row(payload: dict, node_id: str) -> dict:
        return next(row for row in payload["rows"] if row["id"] == node_id)

    def test_rows_are_the_top_level_devices_and_the_remainder_in_kwh_order(self):
        payload = self.daily_profile(span(default_energy()))
        # The house's remainder is 7 × 48 − 84 − 42 − 10 = 200 kWh.
        self.assertEqual(
            [row["id"] for row in payload["rows"]],
            ["house_unmeasured", BREAKER, FRIDGE, WASHER],
        )
        self.assertEqual([row["unmeasured"] for row in payload["rows"]], [True, False, False, False])
        self.assertNotIn("granularity", payload)
        self.assertFalse(reports_mod.REPORTS["daily_profile"].uses_granularity)

    def test_a_device_averages_its_power_per_local_hour(self):
        energy = default_energy()
        # On at 1 kW for 08:00-17:59 on one day of seven, measured every hour.
        energy[WASHER] = {**every_hour(0.0), **energy[WASHER]}
        payload = self.daily_profile(span(energy))
        washer = self.row(payload, WASHER)
        self.assertEqual(washer["watts"][:8], [0.0] * 8)
        self.assertAlmostEqual(washer["watts"][8], 1000.0 / 7, places=1)
        self.assertEqual(self.row(payload, BREAKER)["watts"], [500.0] * 24)
        self.assertEqual(washer["coverage"], 1.0)

    def test_a_share_sensor_averages_over_its_observed_days_only(self):
        start = datetime(2026, 9, 1, tzinfo=PRAGUE)
        end = datetime(2026, 10, 1, tzinfo=PRAGUE)
        hours = local_hours(start, end)
        observed = [key for key in hours if key >= datetime(2026, 9, 24, tzinfo=PRAGUE)]
        tree = {"consumers": [{**TREE["consumers"][0], "children": [estimated("lamp", SHARE)]}]}
        payload = self.daily_profile(
            span(
                {HOUSE: dict.fromkeys(hours, 1.0)},
                start=start,
                end=end,
                rows={SHARE: {key: {"mean": 600.0} for key in observed}},
            ),
            tree=tree,
            now=datetime(2026, 10, 5, tzinfo=PRAGUE),
        )
        lamp = self.row(payload, "lamp")
        # 600 W for the 7 days it has data for, not a quarter of it over 30.
        self.assertEqual(lamp["watts"], [600.0] * 24)
        self.assertAlmostEqual(lamp["coverage"], 7 / 30, places=4)
        self.assertEqual(lamp["first_hour"], "2026-09-24T00:00:00+02:00")

    def test_a_gap_is_none_and_a_measured_zero_is_zero(self):
        energy = default_energy()
        # The fridge has no reading at 03:00 any day, and reads 0 at 04:00.
        energy[FRIDGE] = {
            key: (0.0 if key.astimezone(PRAGUE).hour == 4 else kwh)
            for key, kwh in energy[FRIDGE].items()
            if key.astimezone(PRAGUE).hour != 3
        }
        fridge = self.row(self.daily_profile(span(energy)), FRIDGE)
        self.assertIsNone(fridge["watts"][3])
        self.assertEqual(fridge["watts"][4], 0.0)
        self.assertEqual(fridge["watts"][5], 250.0)
        self.assertAlmostEqual(fridge["coverage"], 23 / 24, places=4)

    def test_the_hour_in_progress_weighs_its_elapsed_fraction(self):
        now = datetime(2026, 9, 7, 12, 15, tzinfo=PRAGUE)
        hours = [key for key in local_hours(START, END) if key < now]
        energy = default_energy()
        # 1 kW at noon every day; the quarter of today's noon so far read 0.25 kWh.
        energy[WASHER] = {key: 1.0 for key in hours if key.astimezone(PRAGUE).hour == 12}
        energy[WASHER][hour(6, 12)] = 0.25
        payload = self.daily_profile(span(energy), now=now)
        # (6 × 1 + 0.25) ÷ (6 + 0.25) h, not 6.25 kWh over 7 hours.
        self.assertEqual(self.row(payload, WASHER)["watts"][12], 1000.0)
        # Hours that have not started yet weigh nothing, though the fixture has kWh for them.
        self.assertEqual(self.row(payload, BREAKER)["watts"][20], 500.0)

    def test_the_fall_back_days_repeated_hour_is_not_doubled(self):
        # 2026-10-25 lives 02:00 twice in Prague.
        start = datetime(2026, 10, 20, tzinfo=PRAGUE)
        end = datetime(2026, 11, 1, tzinfo=PRAGUE)
        hours = local_hours(start, end)
        self.assertEqual(sum(1 for key in hours if key.astimezone(PRAGUE).hour == 2), 13)
        payload = self.daily_profile(
            span({HOUSE: dict.fromkeys(hours, 2.0), FRIDGE: dict.fromkeys(hours, 0.25)}, start=start, end=end),
            now=datetime(2026, 11, 5, tzinfo=PRAGUE),
        )
        self.assertEqual(self.row(payload, FRIDGE)["watts"], [250.0] * 24)
        self.assertEqual(self.row(payload, "house_unmeasured")["watts"], [1750.0] * 24)

    def test_the_spring_forward_days_missing_hour_is_not_diluted(self):
        # 2026-03-29 has no 02:00 in Prague.
        start = datetime(2026, 3, 25, tzinfo=PRAGUE)
        end = datetime(2026, 4, 1, tzinfo=PRAGUE)
        hours = local_hours(start, end)
        self.assertEqual(sum(1 for key in hours if key.astimezone(PRAGUE).hour == 2), 6)
        payload = self.daily_profile(
            span({HOUSE: dict.fromkeys(hours, 2.0), FRIDGE: dict.fromkeys(hours, 0.25)}, start=start, end=end),
            now=datetime(2026, 11, 5, tzinfo=PRAGUE),
        )
        self.assertEqual(self.row(payload, FRIDGE)["watts"], [250.0] * 24)

    def test_an_hour_without_a_rate_is_left_out_of_its_mean_price(self):
        rates = {key: 1.0 for key in local_hours(START, END)}
        rates[hour(0, 18)] = 4.0
        del rates[hour(1, 18)]
        # No rate at all at 05:00.
        for day in range(7):
            del rates[hour(day, 5)]
        payload = self.daily_profile(
            span(default_energy(), import_rate=rates, export_rate={hour(0, 18): -0.5})
        )
        # (4 + 5 × 1) ÷ 6 rated hours, not ÷ 7.
        self.assertAlmostEqual(payload["import_rate"][18], 1.5, places=6)
        self.assertEqual(payload["import_rate"][17], 1.0)
        self.assertIsNone(payload["import_rate"][5])
        self.assertEqual(payload["export_rate"][18], -0.5)
        self.assertIsNone(payload["export_rate"][17])

    def test_a_rate_for_an_hour_still_ahead_is_left_out(self):
        now = datetime(2026, 9, 4, 0, 0, tzinfo=PRAGUE)
        # Today's tariff fills the hours ahead too; they have not happened.
        rates = {key: (1.0 if key < now else 9.0) for key in local_hours(START, END)}
        payload = self.daily_profile(span(default_energy(), import_rate=rates), now=now)
        self.assertEqual(payload["import_rate"], [1.0] * 24)


if __name__ == "__main__":
    unittest.main()
