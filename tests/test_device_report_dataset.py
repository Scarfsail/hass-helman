"""The device dataset: nodes, the hourly source mix and the money, on hand-built hours.

Pure -- the dataset imports nothing from Home Assistant, so the span read is a
:class:`SpanHistory` built here and nothing is stubbed. Every fixture goes
through :meth:`DatasetTestCase.build`, which checks the two invariants every
dataset must keep whatever its inputs: a parent's children plus its remainder
minus its over-allocation is the parent, and on each money side the priced and
unpriced kWh add up to the node's kWh.
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
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
START = datetime(2026, 9, 1, tzinfo=PRAGUE)
END = START + timedelta(days=1)
#: Well after the period: every hour of it has elapsed.
AFTER = datetime(2026, 9, 10, tzinfo=PRAGUE)

METERS = model.SpanMeters(
    solar="sensor.solar",
    grid_import="sensor.import",
    grid_export="sensor.export",
    house="sensor.house",
    battery_charge="sensor.charge",
    battery_discharge="sensor.discharge",
)
_ROLE = {
    "S": "solar",
    "I": "grid_import",
    "E": "grid_export",
    "H": "house",
    "C": "battery_charge",
    "D": "battery_discharge",
}

WASHER = "sensor.washer_energy"
FRIDGE = "sensor.fridge_energy"
BREAKER = "sensor.breaker_energy"
SHARE = "sensor.helman_share_power_heater"


def hour(index: int) -> datetime:
    """The period's ``index``-th hour, as the UTC key every map uses."""
    return START.astimezone(timezone.utc) + timedelta(hours=index)


def tree(*children) -> dict:
    return {
        "consumers": [
            {"id": "house", "displayName": "", "icon": "mdi:home", "children": list(children)}
        ]
    }


def metered(meter: str, *children, label: str | None = None) -> dict:
    return {
        "id": meter,
        "displayName": label or meter,
        "icon": "mdi:power-plug",
        "energyEntityId": meter,
        "powerSensorId": None,
        "isEstimated": False,
        "isUnmeasured": False,
        "children": list(children),
    }


def estimated(device_id: str, share_sensor: str) -> dict:
    return {
        "id": device_id,
        "displayName": device_id,
        "icon": None,
        "energyEntityId": None,
        "powerSensorId": share_sensor,
        "isEstimated": True,
        "isUnmeasured": False,
        "children": [],
    }


def history(
    flows: dict[int, dict[str, float]],
    *,
    devices: dict[str, dict[int, float]] | None = None,
    rows: dict[str, dict[int, dict]] | None = None,
    import_rate: dict[int, float] | None = None,
    tariff_hours: set[int] = frozenset(),
    export_rate: dict[int, float] | None = None,
    meters: model.SpanMeters = METERS,
    compiled_until: dict[str, datetime] | None = None,
) -> model.SpanHistory:
    """A span read: ``flows`` is ``{hour: {"I": kWh, "S": kWh, ...}}``.

    Every configured meter has a row for each listed hour, as in the real read:
    one left out reads 0, and ``None`` means it has no row for that hour. A
    meter ``meters`` leaves unconfigured reads nothing.
    """
    energy: dict[str, dict[datetime, float]] = {}
    for index, values in flows.items():
        for key, role in _ROLE.items():
            meter = getattr(meters, role)
            kwh = values.get(key, 0.0)
            if meter is not None and kwh is not None:
                energy.setdefault(meter, {})[hour(index)] = kwh
    for meter, by_hour in (devices or {}).items():
        energy[meter] = {hour(index): kwh for index, kwh in by_hour.items()}
    rate = {hour(index): value for index, value in (import_rate or {}).items()}
    return model.SpanHistory(
        meters=meters,
        local_start=START,
        local_end=END,
        energy_kwh=energy,
        rows={
            sensor: {hour(index): row for index, row in by_hour.items()}
            for sensor, by_hour in (rows or {}).items()
        },
        import_rate=rate,
        import_rate_source={
            key: model.RATE_TARIFF if index in tariff_hours else model.RATE_RECORDED
            for index in (import_rate or {})
            for key in [hour(index)]
        },
        export_rate={hour(index): value for index, value in (export_rate or {}).items()},
        compiled_until=compiled_until or {},
    )


class DatasetTestCase(unittest.TestCase):
    def build(self, device_tree, span, *, now: datetime = AFTER):
        dataset = dataset_mod.build_device_dataset(device_tree, span, local_tz=PRAGUE, now=now)
        self.assert_invariants(dataset)
        return dataset

    def assert_invariants(self, dataset) -> None:
        by_id = {node.id: node for node in dataset.nodes}
        for node in dataset.nodes:
            if node.children:
                # Over the hours the node's own meter measured.
                children = sum(
                    kwh
                    for child in node.children
                    for hour_key, kwh in by_id[child].kwh.items()
                    if hour_key in node.kwh
                )
                self.assertAlmostEqual(
                    children - node.overallocated_kwh, node.total_kwh, places=9, msg=node.id
                )
            attribution = dataset_mod.attribute_energy(dataset, node.kwh)
            for side in (attribution.paid, attribution.forgone):
                self.assertAlmostEqual(
                    side.priced_kwh + side.unpriced_kwh, node.total_kwh, places=9, msg=node.id
                )
            self.assertAlmostEqual(
                attribution.solar
                + attribution.battery
                + attribution.grid
                + attribution.unattributed,
                node.total_kwh,
                places=9,
            )

    def house_split(self, flows, **kwargs):
        dataset = self.build(tree(), history(flows, **kwargs))
        return dataset, dataset_mod.attribute_energy(dataset, dataset.house.kwh)

    def node(self, dataset, node_id):
        return next(node for node in dataset.nodes if node.id == node_id)


class TestSourceSplit(DatasetTestCase):
    def test_a_solar_only_hour(self):
        _, split = self.house_split({0: {"H": 1, "S": 3, "E": 2}})
        self.assertAlmostEqual(split.solar, 1)
        self.assertAlmostEqual(split.grid + split.battery + split.unattributed, 0)

    def test_a_battery_night(self):
        _, split = self.house_split({0: {"H": 1, "D": 1}})
        self.assertAlmostEqual(split.battery, 1)
        self.assertAlmostEqual(split.solar + split.grid + split.unattributed, 0)

    def test_a_grid_charging_night(self):
        dataset, split = self.house_split({0: {"H": 1, "I": 3, "C": 2}})
        self.assertAlmostEqual(split.grid, 1)
        self.assertAlmostEqual(dataset.charge_origin.grid, 1)
        self.assertAlmostEqual(dataset.charge_origin.unknown, 0)

    def test_the_mixed_hour_is_half_grid_and_half_solar(self):
        # The live house-first formula would call all of this solar.
        _, split = self.house_split({0: {"H": 1, "I": 0.5, "S": 1, "E": 0.5}})
        self.assertAlmostEqual(split.grid, 0.5)
        self.assertAlmostEqual(split.solar, 0.5)

    def test_battery_discharge_during_export(self):
        dataset, split = self.house_split({0: {"H": 0.5, "S": 0.5, "E": 1, "D": 1}})
        # Solar first to the grid, the rest of the export from the battery.
        self.assertAlmostEqual(split.battery, 0.5)
        self.assertAlmostEqual(split.solar, 0)
        self.assertAlmostEqual(dataset.ambiguous_kwh, 0.5)

    def test_no_solar_meter_never_produces_solar(self):
        no_solar = METERS._replace(solar=None)
        for meters, flows in (
            (no_solar, {0: {"H": 2, "I": 1}}),
            (METERS, {0: {"H": 2, "I": 1, "S": 0}}),
        ):
            with self.subTest(solar=meters.solar):
                _, split = self.house_split(flows, meters=meters)
                self.assertAlmostEqual(split.grid, 1)
                self.assertAlmostEqual(split.unattributed, 1)
                self.assertEqual(split.solar, 0)

    def test_flows_exceeding_the_house_meter_are_a_mismatch(self):
        dataset, split = self.house_split({0: {"H": 1, "I": 1, "D": 0.5}})
        mix = dataset.mix[hour(0)]
        self.assertAlmostEqual(mix.solar + mix.battery + mix.grid + mix.unattributed, 1)
        self.assertAlmostEqual(dataset.mismatch_kwh, 0.5)
        self.assertAlmostEqual(split.unattributed, 0)

    def test_a_missing_grid_meter_attributes_nothing(self):
        dataset, split = self.house_split(
            {0: {"H": 1, "S": 2, "I": 1}}, meters=METERS._replace(grid_import=None)
        )
        self.assertFalse(dataset.meters["grid"])
        self.assertAlmostEqual(split.unattributed, 1)

    def test_a_missing_solar_meter(self):
        dataset, split = self.house_split(
            {0: {"H": 1, "S": 2, "I": 1}}, meters=METERS._replace(solar=None)
        )
        self.assertFalse(dataset.meters["solar"])
        self.assertTrue(dataset.meters["grid"])
        self.assertAlmostEqual(split.grid, 1)

    def test_a_missing_battery_meter(self):
        dataset, split = self.house_split(
            {0: {"H": 1, "D": 1, "I": 0.5}},
            meters=METERS._replace(battery_charge=None, battery_discharge=None),
        )
        self.assertFalse(dataset.meters["battery"])
        self.assertEqual(split.battery, 0)
        self.assertAlmostEqual(split.grid, 0.5)
        self.assertAlmostEqual(split.unattributed, 0.5)


    def test_an_hour_a_source_meter_has_no_row_for_is_unattributed(self):
        # The import meter has no row at hour 0: not a measured zero, so the
        # house is not handed to solar, and the charge is unexplained.
        dataset, split = self.house_split(
            {0: {"H": 1, "S": 3, "C": 1, "I": None}, 1: {"H": 1, "I": 1}}
        )
        self.assertAlmostEqual(split.unattributed, 1)
        self.assertAlmostEqual(split.grid, 1)
        self.assertAlmostEqual(split.solar, 0)
        self.assertAlmostEqual(dataset.charge_origin.unknown, 1)


class TestAmbiguity(DatasetTestCase):
    def test_charge_while_importing_is_ambiguous(self):
        dataset, _ = self.house_split({0: {"H": 2, "I": 2, "S": 1, "C": 1}})
        self.assertAlmostEqual(dataset.ambiguous_kwh, 1)

    def test_export_while_discharging_is_ambiguous(self):
        dataset, _ = self.house_split({0: {"H": 1, "S": 2, "E": 1.5, "D": 0.5}})
        self.assertAlmostEqual(dataset.ambiguous_kwh, 0.5)

    def test_an_hour_the_rule_does_not_decide_is_not_ambiguous(self):
        for flows in (
            {0: {"H": 1, "I": 0.5, "S": 1, "E": 0.5}},
            {0: {"H": 1, "I": 3, "C": 2}},
            {0: {"H": 1, "D": 1}},
        ):
            with self.subTest(flows=flows):
                dataset, _ = self.house_split(flows)
                self.assertEqual(dataset.ambiguous_kwh, 0)


class TestNodes(DatasetTestCase):
    def test_a_remainder_is_synthesised_without_a_power_sensor_and_floored(self):
        # The tree carries no ``isUnmeasured`` node under the breaker: no power
        # sensor. The dataset builds the remainder anyway.
        dataset = self.build(
            tree(metered(BREAKER, metered(WASHER))),
            history(
                {0: {"H": 2}, 1: {"H": 2}},
                devices={BREAKER: {0: 1.0, 1: 0.2}, WASHER: {0: 0.4, 1: 0.5}},
            ),
        )
        remainder = self.node(dataset, "sensor_breaker_energy_unmeasured")
        self.assertTrue(remainder.unmeasured)
        self.assertEqual(remainder.parent_id, BREAKER)
        self.assertAlmostEqual(remainder.kwh[hour(0)], 0.6)
        self.assertEqual(remainder.kwh[hour(1)], 0.0)
        self.assertAlmostEqual(self.node(dataset, BREAKER).overallocated_kwh, 0.3)
        house_remainder = self.node(dataset, "house_unmeasured")
        self.assertAlmostEqual(house_remainder.total_kwh, 1.0 + 1.8)
        self.assertEqual(
            [node.id for node in dataset.nodes],
            ["house", BREAKER, WASHER, "sensor_breaker_energy_unmeasured", "house_unmeasured"],
        )

    def test_the_trees_own_remainders_are_skipped(self):
        tree_remainder = {"id": "sensor_breaker_energy_unmeasured", "isUnmeasured": True}
        dataset = self.build(
            tree(metered(BREAKER, metered(WASHER), tree_remainder)),
            history({0: {"H": 2}}, devices={BREAKER: {0: 1.0}, WASHER: {0: 0.4}}),
        )
        ids = [node.id for node in dataset.nodes]
        self.assertEqual(ids.count("sensor_breaker_energy_unmeasured"), 1)

    def test_children_measuring_more_than_their_parent_are_overallocated(self):
        dataset = self.build(
            tree(metered(BREAKER, metered(WASHER), metered(FRIDGE))),
            history(
                {0: {"H": 20}},
                devices={BREAKER: {0: 10.0}, WASHER: {0: 7.0}, FRIDGE: {0: 5.0}},
            ),
        )
        breaker = self.node(dataset, BREAKER)
        self.assertAlmostEqual(breaker.overallocated_kwh, 2.0)
        self.assertEqual(self.node(dataset, "sensor_breaker_energy_unmeasured").total_kwh, 0)
        self.assertEqual(self.node(dataset, WASHER).total_kwh, 7.0)

    def test_hours_the_parent_did_not_measure_are_not_overallocation(self):
        # The breaker's meter starts at hour 1; its washer was measured before.
        dataset = self.build(
            tree(metered(BREAKER, metered(WASHER))),
            history(
                {0: {"H": 5}, 1: {"H": 5}},
                devices={BREAKER: {1: 2.0}, WASHER: {0: 3.0, 1: 1.5}},
            ),
        )
        breaker = self.node(dataset, BREAKER)
        self.assertEqual(breaker.overallocated_kwh, 0.0)
        self.assertAlmostEqual(
            self.node(dataset, "sensor_breaker_energy_unmeasured").total_kwh, 0.5
        )

    def test_an_estimated_child_reads_its_mean_and_scales_the_hour_in_progress(self):
        now = START + timedelta(hours=1, minutes=15)
        dataset = self.build(
            tree(metered(BREAKER, estimated("heater", SHARE))),
            history(
                {0: {"H": 2}, 1: {"H": 1}},
                devices={BREAKER: {0: 1.0, 1: 0.5}},
                rows={SHARE: {0: {"mean": 500.0}, 1: {"mean": 400.0}}},
            ),
            now=now,
        )
        heater = self.node(dataset, "heater")
        self.assertTrue(heater.estimated)
        self.assertAlmostEqual(heater.kwh[hour(0)], 0.5)
        self.assertAlmostEqual(heater.kwh[hour(1)], 0.1)
        self.assertAlmostEqual(heater.coverage[hour(1)], 0.25)
        self.assertAlmostEqual(dataset.elapsed_hours, 1.25)

    def test_coverage_and_first_hour_for_a_late_meter_and_a_gap(self):
        late = {index: 0.1 for index in range(12, 24)}
        gappy = {index: 0.1 for index in range(24) if index != 6}
        dataset = self.build(
            tree(metered(WASHER), metered(FRIDGE)),
            history(
                {index: {"H": 1} for index in range(24)},
                devices={WASHER: late, FRIDGE: gappy},
            ),
        )
        payload = reports_mod.REPORTS["ranking"].build(
            dataset, reports_mod.ReportQuery(START.date(), START.date())
        )
        rows = {row["id"]: row for row in payload["nodes"]}
        self.assertEqual(rows[WASHER]["coverage"], 0.5)
        self.assertEqual(rows[WASHER]["first_hour"], "2026-09-01T12:00:00+02:00")
        self.assertEqual(rows[FRIDGE]["coverage"], round(23 / 24, 4))
        self.assertEqual(rows[FRIDGE]["first_hour"], "2026-09-01T00:00:00+02:00")
        self.assertEqual(rows["house_unmeasured"]["coverage"], 1.0)
        self.assertEqual(rows["house"]["coverage"], 1.0)


class TestChargeOrigin(DatasetTestCase):
    def test_the_battery_rate_is_energy_weighted(self):
        dataset, _ = self.house_split(
            {0: {"H": 0, "I": 1, "C": 1}, 1: {"H": 0, "I": 9, "C": 9}},
            import_rate={0: 1.0, 1: 3.0},
        )
        self.assertAlmostEqual(dataset.charge_origin.paid_rate, 2.8)

    def test_the_no_charge_case(self):
        dataset, split = self.house_split({0: {"H": 1, "D": 1}}, import_rate={0: 2.0})
        self.assertEqual(dataset.charge_origin.unknown, 1.0)
        self.assertEqual(split.paid.unpriced_kwh, 1.0)
        self.assertIsNone(split.paid.known_amount)
        self.assertEqual(split.forgone.unpriced_kwh, 1.0)


class TestMoney(DatasetTestCase):
    def test_a_solar_only_device_paid_nothing_and_nothing_is_unpriced(self):
        _, split = self.house_split({0: {"H": 1, "S": 3, "E": 2}}, export_rate={0: 0.5})
        self.assertEqual(split.paid.known_amount, 0)
        self.assertEqual(split.paid.unpriced_kwh, 0)
        self.assertAlmostEqual(split.forgone.known_amount, 0.5)

    def test_a_grid_only_device_forgoes_nothing_and_nothing_is_unpriced(self):
        _, split = self.house_split({0: {"H": 2, "I": 2}}, import_rate={0: 4.0})
        self.assertAlmostEqual(split.paid.known_amount, 8.0)
        self.assertEqual(split.forgone.known_amount, 0)
        self.assertEqual(split.forgone.unpriced_kwh, 0)

    def test_battery_charged_only_from_solar_paid_a_known_zero(self):
        _, split = self.house_split(
            {0: {"H": 0, "S": 2, "C": 2}, 5: {"H": 1, "D": 1}},
            export_rate={0: 1.5},
        )
        self.assertEqual(split.paid.known_amount, 0)
        self.assertEqual(split.paid.unpriced_kwh, 0)
        self.assertAlmostEqual(split.forgone.known_amount, 1.5)

    def test_window_priced_grid_charge_carries_into_tariff_kwh(self):
        _, split = self.house_split(
            {0: {"H": 0, "I": 2, "C": 2}, 5: {"H": 1, "D": 1}},
            import_rate={0: 3.0},
            tariff_hours={0},
        )
        self.assertAlmostEqual(split.paid.known_amount, 3.0)
        self.assertAlmostEqual(split.paid.tariff_kwh, 1.0)

    def test_unpriced_and_unexplained_charge_stays_unpriced(self):
        # Half the charge from the grid at an hour with no rate, half from
        # nothing any meter shows.
        dataset, split = self.house_split(
            {0: {"H": 0, "I": 1, "C": 1}, 1: {"H": 0, "C": 1}, 5: {"H": 2, "D": 2}},
        )
        self.assertAlmostEqual(dataset.charge_origin.grid_unpriced, 0.5)
        self.assertAlmostEqual(dataset.charge_origin.unknown, 0.5)
        self.assertAlmostEqual(split.paid.unpriced_kwh, 2.0)
        self.assertIsNone(split.paid.known_amount)
        # The grid half is a known zero on forgone; the unexplained half is not.
        self.assertAlmostEqual(split.forgone.priced_kwh, 1.0)
        self.assertAlmostEqual(split.forgone.unpriced_kwh, 1.0)

    def test_a_negative_export_price_makes_forgone_negative(self):
        _, split = self.house_split({0: {"H": 1, "S": 3, "E": 2}}, export_rate={0: -0.2})
        self.assertAlmostEqual(split.forgone.known_amount, -0.2)

    def test_export_prices_for_only_part_of_the_period_leave_the_rest_unpriced(self):
        flows = {index: {"H": 1, "S": 2, "E": 1} for index in range(10)}
        _, split = self.house_split(flows, export_rate={8: 1.0, 9: 1.0})
        self.assertAlmostEqual(split.forgone.priced_kwh, 2.0)
        self.assertAlmostEqual(split.forgone.unpriced_kwh, 8.0)
        self.assertAlmostEqual(split.forgone.known_amount, 2.0)

    def test_nothing_priced_is_none(self):
        _, split = self.house_split({0: {"H": 2, "I": 2}})
        self.assertIsNone(split.paid.known_amount)
        self.assertEqual(split.paid.unpriced_kwh, 2.0)

    def test_a_device_shares_the_hours_mix(self):
        dataset = self.build(
            tree(metered(WASHER)),
            history(
                {0: {"H": 1, "I": 0.5, "S": 1, "E": 0.5}},
                devices={WASHER: {0: 0.4}},
                import_rate={0: 2.0},
                export_rate={0: 1.0},
            ),
        )
        split = dataset_mod.attribute_energy(dataset, self.node(dataset, WASHER).kwh)
        self.assertAlmostEqual(split.grid, 0.2)
        self.assertAlmostEqual(split.solar, 0.2)
        self.assertAlmostEqual(split.paid.known_amount, 0.4)
        self.assertAlmostEqual(split.forgone.known_amount, 0.2)


class TestRankingPayload(DatasetTestCase):
    def test_the_common_fields_and_completeness(self):
        span = history(
            {0: {"H": 1, "I": 1}},
            devices={WASHER: {0: 0.5}},
            compiled_until={METERS.house: END.astimezone(timezone.utc)},
        )
        dataset = self.build(tree(metered(WASHER, label="Washer")), span)
        payload = reports_mod.build_report(
            "ranking",
            dataset,
            reports_mod.ReportQuery(START.date(), START.date()),
            currency="CZK",
            navigation_range={"minDate": "2026-01-01", "maxDate": "2026-09-10"},
        )
        self.assertTrue(payload["complete"])
        self.assertEqual(payload["currency"], "CZK")
        self.assertEqual(
            payload["meters"], {"grid": True, "solar": True, "battery": True, "house": True}
        )
        self.assertEqual(payload["as_of"], AFTER.isoformat())
        washer = next(row for row in payload["nodes"] if row["id"] == WASHER)
        self.assertEqual(washer["label"], "Washer")
        self.assertEqual(washer["depth"], 1)
        self.assertEqual(washer["sources"]["grid"], 0.5)
        self.assertEqual(
            set(washer["money"]["paid"]), {"amount", "priced_kwh", "unpriced_kwh", "tariff_kwh"}
        )

        dataset = self.build(tree(), history({0: {"H": 1}}))
        self.assertFalse(dataset.complete)



class TestPeriodHours(unittest.TestCase):
    def test_a_fractional_offset_day_keys_the_hours_starting_within_it(self):
        kolkata = ZoneInfo("Asia/Kolkata")
        start = datetime(2026, 9, 15, tzinfo=kolkata)
        hours = model.period_hours(start, start + timedelta(days=1))
        # Local midnight is 18:30 UTC: the first whole UTC hour starting in the
        # day is 19:00, and the last is 18:00 the next day.
        self.assertEqual(len(hours), 24)
        self.assertEqual(hours[0], datetime(2026, 9, 14, 19, tzinfo=timezone.utc))
        self.assertEqual(hours[-1], datetime(2026, 9, 15, 18, tzinfo=timezone.utc))

if __name__ == "__main__":
    unittest.main()
