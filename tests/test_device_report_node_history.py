"""``build_node_history``: one node's last 30 days, on hand-built hours.

Pure, on the dataset tests' fixtures: a :class:`SpanHistory` built by hand and
the real dataset, nothing stubbed.
"""

from __future__ import annotations

import dataclasses
import importlib
import unittest
from datetime import timedelta

node_history = importlib.import_module("custom_components.helman.device_reports.node_history")
from tests._fakes import (  # noqa: E402
    DISHWASHER_ENERGY,
    DISHWASHER_KWH,
    DISHWASHER_POWER,
    KITCHEN_ENERGY,
    KITCHEN_OWN_KW,
)
from tests.test_device_report_dataset import (  # noqa: E402
    START,
    WASHER,
    DatasetTestCase,
    estimated,
    history,
    metered,
    tree,
)

EV = "sensor.ev_energy"


def days(span, count: int):
    """``span`` stretched to ``count`` local days."""
    return dataclasses.replace(span, local_end=START + timedelta(days=count))


class NodeHistoryTestCase(DatasetTestCase):
    def payload(self, dataset, node_id, *, floor: float = 0.0, price_unit: str | None = "CZK"):
        return node_history.build_node_history(
            dataset, node_id, hour_floor_kwh=floor, price_unit=price_unit
        )


class TestFloor(NodeHistoryTestCase):
    def test_hours_below_the_floor_are_dropped(self):
        # Standby 0.003 kWh every hour, and two charging hours.
        ev = {index: 0.003 for index in range(24)} | {8: 3.0, 9: 4.0}
        dataset = self.build(
            tree(metered(EV)),
            history({index: {"H": 8, "I": 8} for index in range(24)}, devices={EV: ev}),
        )
        floored = self.payload(dataset, EV, floor=0.1)
        self.assertEqual(floored["totals"]["kwh"], 7.0)
        # The node's own kWh is its whole meter.
        self.assertEqual(floored["kwh"], round(7.0 + 22 * 0.003, 3))
        self.assertEqual(self.payload(dataset, EV)["totals"]["kwh"], round(7.0 + 22 * 0.003, 3))

    def test_the_floor_is_the_ev_chargers_by_its_tree_kind(self):
        device_tree = tree(
            {**metered(EV), "applianceKind": "ev_charger"},
            metered(WASHER, {**metered(KITCHEN_ENERGY), "applianceKind": "climate"}),
        )
        self.assertEqual(node_history.hour_floor_kwh(device_tree, EV), 0.1)
        self.assertEqual(node_history.hour_floor_kwh(device_tree, KITCHEN_ENERGY), 0.0)
        self.assertEqual(node_history.hour_floor_kwh(device_tree, "house_unmeasured"), 0.0)


class TestDays(NodeHistoryTestCase):
    def test_active_days_per_week_and_kwh_per_active_day(self):
        # Ten days recorded; the washer runs on days 0, 3 and 6 (2, 3 and 4 kWh)
        # and draws a sub-threshold 0.04 kWh on day 8.
        washer = {0 * 24 + 10: 2.0, 3 * 24 + 10: 3.0, 6 * 24 + 10: 4.0, 8 * 24 + 10: 0.04}
        washer |= {index: 0.0 for index in range(240) if index not in washer}
        dataset = self.build(
            tree(metered(WASHER)),
            days(history({index: {"H": 5, "I": 5} for index in range(240)}, devices={WASHER: washer}), 10),
            now=START + timedelta(days=11),
        )
        payload = self.payload(dataset, WASHER)
        self.assertEqual(payload["activeDays"], 3)
        self.assertEqual(payload["coveredDays"], 10)
        self.assertAlmostEqual(payload["perWeek"], 3 / 10 * 7)
        self.assertEqual(payload["kwhPerActiveDay"], 3.0)
        self.assertEqual(payload["startDate"], "2026-09-01")
        self.assertEqual(payload["endDate"], "2026-09-10")

    def test_without_an_active_day_there_is_no_kwh_per_day_and_one_covered_day_at_least(self):
        dataset = self.build(tree(metered(WASHER)), history({0: {"H": 1, "I": 1}}, devices={WASHER: {}}))
        payload = self.payload(dataset, WASHER)
        self.assertEqual(payload["activeDays"], 0)
        self.assertEqual(payload["coveredDays"], 1)
        self.assertEqual(payload["perWeek"], 0)
        self.assertIsNone(payload["kwhPerActiveDay"])

    def test_days_are_local_days_not_utc_days(self):
        # Two Prague days (UTC+2): hour 1 is 01:00 local but still 31 Aug in UTC,
        # hour 23 is 23:00 local, 1 Sep in UTC, and hours 46-47 fall on 2 Sep in UTC.
        dataset = self.build(
            tree(metered(WASHER)),
            days(
                history(
                    {index: {"H": 5, "I": 5} for index in range(48)},
                    devices={WASHER: {index: 2.0 if index in (1, 23) else 0.0 for index in range(48)}},
                ),
                2,
            ),
            now=START + timedelta(days=3),
        )
        payload = self.payload(dataset, WASHER)
        self.assertEqual(payload["activeDays"], 1)
        self.assertEqual(payload["coveredDays"], 2)
        self.assertEqual(payload["kwhPerActiveDay"], 4.0)
        self.assertEqual(payload["startDate"], "2026-09-01")
        self.assertEqual(payload["endDate"], "2026-09-02")


class TestMoney(NodeHistoryTestCase):
    def test_rates_and_every_money_side(self):
        # Half solar, half grid; only hour 0 has an export price.
        dataset = self.build(
            tree(metered(WASHER)),
            history(
                {0: {"H": 2, "I": 1, "S": 1}, 1: {"H": 2, "I": 1, "S": 1}},
                devices={WASHER: {0: 2.0, 1: 2.0}},
                import_rate={0: 4.0, 1: 4.0},
                export_rate={0: 1.5},
            ),
        )
        payload = self.payload(dataset, WASHER)
        totals = payload["totals"]
        self.assertEqual(totals["sources"], {"solar": 2.0, "battery": 0.0, "grid": 2.0, "unknown": 0.0})
        self.assertEqual(totals["knownKwh"], 4.0)
        self.assertEqual(totals["paid"], {"amount": 8.0, "pricedKwh": 4.0, "unpricedKwh": 0.0})
        self.assertEqual(totals["gridPaid"], {"amount": 8.0, "pricedKwh": 2.0, "unpricedKwh": 0.0})
        self.assertEqual(totals["solarForgone"], {"amount": 1.5, "pricedKwh": 1.0, "unpricedKwh": 1.0})
        self.assertEqual(totals["virtual"], {"amount": 9.5, "pricedKwh": 3.0, "unpricedKwh": 1.0})
        self.assertEqual(set(totals["forgone"]), {"amount", "pricedKwh", "unpricedKwh"})
        self.assertEqual(totals["batteryPaid"], {"amount": None, "pricedKwh": 0.0, "unpricedKwh": 0.0})
        self.assertEqual(payload["paidPerKwh"], 2.0)
        self.assertEqual(payload["gridPricePerKwh"], 4.0)
        self.assertIsNone(payload["batteryPricePerKwh"])
        self.assertEqual(payload["solarForgonePerKwh"], 1.5)
        self.assertAlmostEqual(payload["virtualPerKwh"], round(9.5 / 3, 6))
        self.assertEqual(payload["priceUnit"], "CZK")

    def test_without_an_export_price_there_is_no_virtual_rate(self):
        dataset = self.build(
            tree(metered(WASHER)),
            history({0: {"H": 2, "I": 1, "S": 1}}, devices={WASHER: {0: 2.0}}, import_rate={0: 4.0}),
        )
        payload = self.payload(dataset, WASHER)
        self.assertEqual(payload["paidPerKwh"], 2.0)
        self.assertIsNone(payload["virtualPerKwh"])

    def test_sources_are_null_when_nothing_is_attributed(self):
        # The import meter has no row: the hour has no mix.
        dataset = self.build(
            tree(metered(WASHER)),
            history({0: {"H": 2, "I": None}}, devices={WASHER: {0: 1.0}}, import_rate={0: 4.0}),
        )
        payload = self.payload(dataset, WASHER)
        self.assertIsNone(payload["totals"]["sources"])
        self.assertEqual(payload["totals"]["kwh"], 1.0)
        self.assertIsNone(payload["paidPerKwh"])
        self.assertEqual(payload["totals"]["paid"], {"amount": None, "pricedKwh": 0.0, "unpricedKwh": 1.0})


class TestNodes(NodeHistoryTestCase):
    def test_an_estimated_node_and_partial_coverage(self):
        dishwasher = {index: DISHWASHER_KWH for index in range(12, 24)}
        dataset = self.build(
            tree(metered(KITCHEN_ENERGY, estimated(DISHWASHER_ENERGY, DISHWASHER_POWER))),
            history(
                {index: {"H": 2, "I": 2} for index in range(24)},
                devices={
                    KITCHEN_ENERGY: {index: KITCHEN_OWN_KW for index in range(24)},
                    DISHWASHER_ENERGY: dishwasher,
                },
            ),
        )
        payload = self.payload(dataset, DISHWASHER_ENERGY)
        self.assertTrue(payload["estimated"])
        self.assertEqual(payload["coverage"], 0.5)
        self.assertEqual(payload["firstHour"], "2026-09-01T12:00:00+02:00")
        self.assertEqual(payload["totals"]["kwh"], round(12 * DISHWASHER_KWH, 3))

    def test_the_unmeasured_remainder(self):
        dataset = self.build(
            tree(metered(WASHER)),
            history({0: {"H": 3, "I": 3}}, devices={WASHER: {0: 1.0}}, import_rate={0: 2.0}),
        )
        payload = self.payload(dataset, "house_unmeasured")
        self.assertTrue(payload["unmeasured"])
        self.assertEqual(payload["totals"]["kwh"], 2.0)
        self.assertEqual(payload["totals"]["paid"]["amount"], 4.0)
        self.assertEqual(payload["activeDays"], 1)

    def test_an_unknown_node(self):
        dataset = self.build(tree(), history({0: {"H": 1}}))
        self.assertEqual(self.payload(dataset, "sensor.nope"), {"unavailable": "unknown_node"})


if __name__ == "__main__":
    unittest.main()
