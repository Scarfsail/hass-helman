"""The span aggregates read hourly long-term statistics, and read them once.

A month or a year of history is affordable only because of what this endpoint
does *not* do: it does not read raw states (millions of rows for a few hundred
numbers), and it does not issue a query per bucket. What it does instead has
three ways of being quietly wrong, each of which returns numbers rather than an
error, so each gets a test here:

* trusting the statistics ``change`` column, which the compiler's own reset
  detection corrupts whenever a ``total_increasing`` meter blinks -- it adds the
  meter's entire lifetime total into that hour;
* dropping the hour before the window, leaving the first real hour with no
  earlier reading to be differenced against;
* folding float timestamps by arithmetic instead of by local time, which loses a
  25-hour day.

The recorder is faked at ``statistics_during_period`` itself, so the module
under test -- ``recorder_statistics_span`` -- is really exercised, in the style
of ``test_inspector_recorder_query_count.py``.
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]

#: Every ``statistics_during_period`` call the fake recorder saw, in order.
STATISTICS_CALLS: list[dict] = []
#: What that fake hands back, keyed by statistic id. Tests rewrite it in place.
STATISTICS_ROWS: dict[str, list[dict]] = {}


def _install_import_stubs() -> None:
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
        (
            "custom_components.helman.solar_bias_correction",
            ROOT / "custom_components" / "helman" / "solar_bias_correction",
        ),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg

    ha_mod = types.ModuleType("homeassistant")
    ha_mod.__path__ = []
    sys.modules["homeassistant"] = ha_mod

    components_mod = types.ModuleType("homeassistant.components")
    components_mod.__path__ = []
    sys.modules["homeassistant.components"] = components_mod

    async def _run_in_executor(func, *args):
        return func(*args)

    recorder_mod = types.ModuleType("homeassistant.components.recorder")
    recorder_mod.get_instance = lambda hass: SimpleNamespace(
        async_add_executor_job=_run_in_executor
    )
    sys.modules["homeassistant.components.recorder"] = recorder_mod

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    history_mod.get_significant_states = lambda *args, **kwargs: {}
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    def _fake_statistics_during_period(
        hass, start_time, end_time, statistic_ids, period, units, types_
    ):
        STATISTICS_CALLS.append(
            {
                "start_time": start_time,
                "end_time": end_time,
                "statistic_ids": set(statistic_ids or ()),
                "period": period,
                "units": units,
                "types": set(types_),
            }
        )
        return {
            statistic_id: rows
            for statistic_id, rows in STATISTICS_ROWS.items()
            if statistic_ids is None or statistic_id in statistic_ids
        }

    statistics_mod = types.ModuleType("homeassistant.components.recorder.statistics")
    statistics_mod.statistics_during_period = _fake_statistics_during_period
    sys.modules["homeassistant.components.recorder.statistics"] = statistics_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.now = lambda: NOW
    dt_mod.as_local = lambda value: value.astimezone(PRAGUE)
    dt_mod.as_utc = lambda value: value.astimezone(timezone.utc)
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    sys.modules.pop("custom_components.helman.recorder_statistics_span", None)
    sys.modules.pop("custom_components.helman.solar_bias_correction.service", None)


PRAGUE = ZoneInfo("Europe/Prague")
#: The clock every test runs against. A span is cut at today, so this bounds it.
NOW = datetime(2026, 5, 25, 10, 0, tzinfo=PRAGUE)

_install_import_stubs()

import importlib  # noqa: E402

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)
price_builder = importlib.import_module(
    "custom_components.helman.grid_price_forecast_builder"
)
span_mod = importlib.import_module("custom_components.helman.recorder_statistics_span")

SOLAR_METER = "sensor.solar_total"
HOUSE_METER = "sensor.house_energy"
GRID_IMPORT_METER = "sensor.grid_import"
GRID_EXPORT_METER = "sensor.grid_export"
BATTERY_CHARGE_METER = "sensor.batt_charge"
BATTERY_DISCHARGE_METER = "sensor.batt_discharge"
BATTERY_SOC = "sensor.batt_soc"
IMPORT_PRICE = "sensor.helman_grid_import_price"
EXPORT_PRICE = "sensor.spot_sell_price"


def _row(local_hour: datetime, **fields) -> dict:
    """One ``StatisticsRow``, with the float ``start``/``end`` the real API uses."""
    start = local_hour.timestamp()
    return {"start": start, "end": start + 3600.0, **fields}


def _hour(raw: str) -> datetime:
    return datetime.fromisoformat(raw)


class _DummyStore:
    profile = None

    async def async_save(self, payload):
        self.saved = payload


def _make_service(*, import_price_config=None):
    hass = SimpleNamespace(
        config=SimpleNamespace(time_zone="Europe/Prague"),
        bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        states=SimpleNamespace(get=lambda entity_id: None),
    )
    cfg = models.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        aggregation_method="ratio_of_sums",
        daily_energy_entity_ids=["sensor.solar_today"],
        total_energy_entity_id=SOLAR_METER,
    )
    return service_mod.SolarBiasCorrectionService(
        hass,
        _DummyStore(),
        cfg,
        house_energy_entity_id_provider=lambda: HOUSE_METER,
        grid_import_energy_entity_id_provider=lambda: GRID_IMPORT_METER,
        grid_export_energy_entity_id_provider=lambda: GRID_EXPORT_METER,
        battery_charge_energy_entity_id_provider=lambda: BATTERY_CHARGE_METER,
        battery_discharge_energy_entity_id_provider=lambda: BATTERY_DISCHARGE_METER,
        battery_soc_entity_id_provider=lambda: BATTERY_SOC,
        grid_export_price_entity_id_provider=lambda: EXPORT_PRICE,
        grid_import_price_config_provider=lambda: import_price_config,
    )


def _set_rows(rows_by_entity: dict[str, list[dict]]) -> None:
    STATISTICS_CALLS.clear()
    STATISTICS_ROWS.clear()
    STATISTICS_ROWS.update(rows_by_entity)


class TestDayBuckets(unittest.IsolatedAsyncioTestCase):
    async def test_hourly_change_folds_into_local_days_in_one_read(self):
        _set_rows(
            {
                SOLAR_METER: [
                    # The padded hour, one before the window opens. It is what
                    # the first real hour is differenced against -- and its own
                    # reading must not itself become energy in 2026-04-23.
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=99.0),
                    # Readings, not deltas: 1.5 kWh then 2.5 kWh on the 23rd.
                    _row(_hour("2026-04-23T08:00:00+02:00"), state=100.5),
                    _row(_hour("2026-04-23T09:00:00+02:00"), state=103.0),
                    _row(_hour("2026-04-24T10:00:00+02:00"), state=106.0),
                ],
                GRID_IMPORT_METER: [
                    _row(_hour("2026-04-23T19:00:00+02:00"), state=48.75),
                    _row(_hour("2026-04-23T20:00:00+02:00"), state=50.0),
                ],
                GRID_EXPORT_METER: [
                    _row(_hour("2026-04-24T11:00:00+02:00"), state=7.25),
                    _row(_hour("2026-04-24T12:00:00+02:00"), state=8.0),
                ],
                HOUSE_METER: [
                    _row(_hour("2026-04-23T06:00:00+02:00"), state=68.0),
                    _row(_hour("2026-04-23T07:00:00+02:00"), state=70.0),
                ],
                BATTERY_CHARGE_METER: [
                    _row(_hour("2026-04-23T12:00:00+02:00"), state=36.0),
                    _row(_hour("2026-04-23T13:00:00+02:00"), state=40.0),
                ],
                BATTERY_DISCHARGE_METER: [
                    _row(_hour("2026-04-24T18:00:00+02:00"), state=11.0),
                    _row(_hour("2026-04-24T19:00:00+02:00"), state=12.0),
                ],
                BATTERY_SOC: [
                    _row(_hour("2026-04-23T06:00:00+02:00"), min=41.0, max=60.0),
                    _row(_hour("2026-04-23T14:00:00+02:00"), min=55.0, max=88.0),
                    _row(_hour("2026-04-24T05:00:00+02:00"), min=30.0, max=30.0),
                ],
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-24")

        self.assertEqual(payload["bucket"], "day")
        self.assertEqual(
            payload["days"],
            [
                {
                    "date": "2026-04-23",
                    "solarWh": 4000.0,
                    "gridImportKwh": 1.25,
                    # Nothing exported that day: null, not a zero the reader
                    # would take for a measurement.
                    "gridExportKwh": None,
                    "batteryMinSocPct": 41.0,
                    "batteryMaxSocPct": 88.0,
                    "houseWh": 2000.0,
                    "batteryChargeWh": 4000.0,
                    "batteryDischargeWh": None,
                    "moneyCost": None,
                    "moneyGain": None,
                },
                {
                    "date": "2026-04-24",
                    "solarWh": 3000.0,
                    "gridImportKwh": None,
                    "gridExportKwh": 0.75,
                    "batteryMinSocPct": 30.0,
                    "batteryMaxSocPct": 30.0,
                    "houseWh": None,
                    "batteryChargeWh": None,
                    "batteryDischargeWh": 1000.0,
                    "moneyCost": None,
                    "moneyGain": None,
                },
            ],
        )

        # One statistics call for every entity and every day of the span.
        self.assertEqual(len(STATISTICS_CALLS), 1)
        call = STATISTICS_CALLS[0]
        self.assertEqual(call["period"], "hour")
        self.assertEqual(call["units"], {"energy": "kWh"})
        self.assertEqual(call["types"], {"state", "min", "max", "mean"})
        self.assertEqual(
            call["statistic_ids"],
            {
                SOLAR_METER,
                HOUSE_METER,
                GRID_IMPORT_METER,
                GRID_EXPORT_METER,
                BATTERY_CHARGE_METER,
                BATTERY_DISCHARGE_METER,
                BATTERY_SOC,
                IMPORT_PRICE,
                EXPORT_PRICE,
            },
        )
        # One hour of padding before local midnight, so the window's first hour
        # has an earlier reading to be differenced against.
        self.assertEqual(
            call["start_time"],
            _hour("2026-04-23T00:00:00+02:00").astimezone(timezone.utc)
            - timedelta(hours=1),
        )
        self.assertEqual(
            call["end_time"],
            _hour("2026-04-25T00:00:00+02:00").astimezone(timezone.utc),
        )

    async def test_a_dst_day_folds_twenty_five_hours_onto_one_date(self):
        # Prague falls back on 2025-10-26: local midnight to local midnight is
        # 22:00Z to 23:00Z the next day, twenty-five hourly rows. Bucketing on
        # ``timestamp // 86400`` would split them across two keys and lose an
        # hour of energy; bucketing on the local date does not.
        first_hour = datetime(2025, 10, 25, 22, 0, tzinfo=timezone.utc)
        _set_rows(
            {
                SOLAR_METER: [
                    _row(first_hour - timedelta(hours=1), state=0.0),
                    *(
                        _row(first_hour + timedelta(hours=index), state=float(index + 1))
                        for index in range(25)
                    ),
                ]
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2025-10-26", "2025-10-26")

        self.assertEqual(len(payload["days"]), 1)
        self.assertEqual(payload["days"][0]["date"], "2025-10-26")
        self.assertEqual(payload["days"][0]["solarWh"], 25000.0)

    async def test_a_span_beyond_today_is_cut_and_a_future_span_costs_no_query(self):
        _set_rows({})
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-05-24", "2026-06-30")
        self.assertEqual(
            [day["date"] for day in payload["days"]], ["2026-05-24", "2026-05-25"]
        )

        STATISTICS_CALLS.clear()
        future_only = await service.async_get_span_aggregates("2026-06-01", "2026-06-30")
        self.assertEqual(future_only["days"], [])
        self.assertEqual(STATISTICS_CALLS, [])

    async def test_a_year_wide_span_is_still_one_query(self):
        _set_rows({})
        service = _make_service()

        payload = await service.async_get_span_aggregates("2020-01-01", "2026-05-25")

        # Trimmed to the cap, keeping the recent end.
        self.assertEqual(
            len(payload["days"]), service_mod._MAX_AGGREGATE_BUCKETS["day"]
        )
        self.assertEqual(payload["days"][-1]["date"], "2026-05-25")
        self.assertEqual(len(STATISTICS_CALLS), 1)


class TestResetArtefacts(unittest.IsolatedAsyncioTestCase):
    """The reason this endpoint does not read the ``change`` column.

    Taken from a real inverter feed: a ``total_increasing`` meter that blinked
    unavailable and came back made the statistics compiler record a counter
    reset, so it added the meter's entire lifetime reading into that hour. The
    day's ``change`` came to 49 MWh against a true 37 kWh, and one hour carried
    two such resets at once. The meter's own ``state`` readings were fine
    throughout, which is what this endpoint differences instead.
    """

    async def test_a_lifetime_sized_change_column_does_not_reach_the_bucket(self):
        _set_rows(
            {
                SOLAR_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=49181.0, change=0.0),
                    _row(_hour("2026-04-23T07:00:00+02:00"), state=49184.7, change=3.7),
                    _row(_hour("2026-04-23T08:00:00+02:00"), state=49191.1, change=6.4),
                    # The blink. ``change`` claims the meter's whole life; the
                    # reading beside it says 8.0 kWh actually arrived.
                    _row(
                        _hour("2026-04-23T09:00:00+02:00"),
                        state=49199.1,
                        change=49199.1,
                    ),
                    # And an hour carrying two resets at once.
                    _row(
                        _hour("2026-04-23T10:00:00+02:00"),
                        state=49202.4,
                        change=98404.8,
                    ),
                ]
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        # 3.7 + 6.4 + 8.0 + 3.3, to the tenth of a Wh the payload rounds to.
        self.assertEqual(payload["days"][0]["solarWh"], 21400.0)

    async def test_a_genuine_midnight_reset_is_unwrapped_not_counted_as_energy(self):
        # A daily-resetting meter drops to zero at midnight. Differencing alone
        # would hand the bucket a large negative step; the shared unwrap lifts
        # the series instead, which is what the raw-state path does too.
        _set_rows(
            {
                SOLAR_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=30.0),
                    _row(_hour("2026-04-23T09:00:00+02:00"), state=4.0),
                    _row(_hour("2026-04-23T10:00:00+02:00"), state=6.5),
                    _row(_hour("2026-04-23T11:00:00+02:00"), state=9.0),
                ]
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        # The 09:00 reading opens a new segment, so the day is 4.0 + 2.5 + 2.5.
        self.assertEqual(payload["days"][0]["solarWh"], 9000.0)


class TestMonthBuckets(unittest.IsolatedAsyncioTestCase):
    async def test_the_span_snaps_outward_to_whole_months(self):
        _set_rows(
            {
                SOLAR_METER: [
                    _row(_hour("2026-02-28T23:00:00+01:00"), state=8.0),
                    # The 1st of March, which a request starting on the 17th
                    # would miss without the outward snap.
                    _row(_hour("2026-03-01T09:00:00+01:00"), state=10.0),
                    _row(_hour("2026-03-20T09:00:00+01:00"), state=13.0),
                    # And the 30th of April, likewise past a request ending on
                    # the 9th.
                    _row(_hour("2026-04-30T09:00:00+02:00"), state=17.0),
                ]
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates(
            "2026-03-17", "2026-04-09", "month"
        )

        self.assertEqual(payload["bucket"], "month")
        self.assertEqual(
            [(day["date"], day["solarWh"]) for day in payload["days"]],
            [("2026-03-01", 5000.0), ("2026-04-01", 4000.0)],
        )
        call = STATISTICS_CALLS[0]
        self.assertEqual(
            call["start_time"],
            _hour("2026-03-01T00:00:00+01:00").astimezone(timezone.utc)
            - timedelta(hours=1),
        )
        self.assertEqual(
            call["end_time"],
            _hour("2026-05-01T00:00:00+02:00").astimezone(timezone.utc),
        )

    async def test_the_month_in_progress_is_reported_short_rather_than_dropped(self):
        _set_rows({})
        service = _make_service()

        payload = await service.async_get_span_aggregates(
            "2026-04-10", "2026-12-31", "month"
        )

        self.assertEqual(
            [day["date"] for day in payload["days"]], ["2026-04-01", "2026-05-01"]
        )
        # The read stops at the end of today, not at the end of the month.
        self.assertEqual(
            STATISTICS_CALLS[0]["end_time"],
            _hour("2026-05-26T00:00:00+02:00").astimezone(timezone.utc),
        )

    async def test_the_month_cap_still_bounds_the_hourly_read(self):
        _set_rows({})
        service = _make_service()

        payload = await service.async_get_span_aggregates(
            "2019-01-01", "2026-05-25", "month"
        )

        self.assertEqual(
            len(payload["days"]), service_mod._MAX_AGGREGATE_BUCKETS["month"]
        )
        self.assertEqual(payload["days"][0]["date"], "2025-05-01")
        self.assertEqual(payload["days"][-1]["date"], "2026-05-01")
        self.assertEqual(len(STATISTICS_CALLS), 1)


class TestMoney(unittest.IsolatedAsyncioTestCase):
    async def test_each_hour_is_priced_on_its_own_rate(self):
        config = price_builder.FixedGridImportPriceConfig(
            unit="CZK/kWh",
            windows=(
                price_builder.FixedGridImportPriceWindow(
                    start_minutes=0, end_minutes=480, price=2.0
                ),
                price_builder.FixedGridImportPriceWindow(
                    start_minutes=480, end_minutes=1440, price=5.0
                ),
            ),
        )
        _set_rows(
            {
                GRID_IMPORT_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=0.0),
                    # 03:00 has no recorded rate, so the window table fills it.
                    _row(_hour("2026-04-23T03:00:00+02:00"), state=1.0),
                    # 09:00 does, and the recorded rate wins over the window's
                    # 5.0 -- history first, config only as a gap-fill.
                    _row(_hour("2026-04-23T09:00:00+02:00"), state=3.0),
                    _row(_hour("2026-04-24T05:00:00+02:00"), state=4.0),
                ],
                GRID_EXPORT_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=0.0),
                    _row(_hour("2026-04-23T12:00:00+02:00"), state=3.0),
                    # No export rate for this hour, and no config fill exists for
                    # the sell side, so its kWh are simply not valued.
                    _row(_hour("2026-04-23T13:00:00+02:00"), state=4.0),
                ],
                IMPORT_PRICE: [
                    _row(_hour("2026-04-23T09:00:00+02:00"), mean=7.0),
                ],
                EXPORT_PRICE: [
                    _row(_hour("2026-04-23T12:00:00+02:00"), mean=1.5),
                ],
            }
        )
        service = _make_service(import_price_config=config)

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-24")

        self.assertEqual(payload["currency"], "CZK/kWh")
        first, second = payload["days"]
        # 1 kWh at the night window's 2.0 plus 2 kWh at the recorded 7.0. Pricing
        # the day's 3 kWh at any single rate cannot produce this number.
        self.assertEqual(first["moneyCost"], 16.0)
        self.assertEqual(first["moneyGain"], 4.5)
        self.assertEqual(second["moneyCost"], 2.0)
        # Exported nothing rather than earned nothing.
        self.assertIsNone(second["moneyGain"])

    async def test_without_an_import_config_unpriced_hours_stay_unpriced(self):
        _set_rows(
            {
                GRID_IMPORT_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=0.0),
                    _row(_hour("2026-04-23T03:00:00+02:00"), state=1.0),
                    _row(_hour("2026-04-23T09:00:00+02:00"), state=3.0),
                ],
                IMPORT_PRICE: [_row(_hour("2026-04-23T09:00:00+02:00"), mean=7.0)],
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        # Only the recorded hour contributes; the 03:00 kWh has no rate at all
        # and is left out rather than valued at zero.
        self.assertEqual(payload["days"][0]["moneyCost"], 14.0)


class TestQueryHourlyStatistics(unittest.IsolatedAsyncioTestCase):
    """The read itself, apart from the service."""

    async def test_it_de_duplicates_ids_and_maps_the_unrecorded_to_empty(self):
        _set_rows({})
        hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
        local_start = _hour("2026-04-23T00:00:00+02:00")

        span = await span_mod.query_hourly_statistics(
            hass,
            ["sensor.a", None, "sensor.b", "sensor.a"],
            local_start=local_start,
            local_end=local_start + timedelta(days=1),
        )

        self.assertEqual(span.rows, {"sensor.a": {}, "sensor.b": {}})
        self.assertEqual(span.energy_kwh, {"sensor.a": {}, "sensor.b": {}})
        self.assertEqual(span.rows_for(None), {})
        self.assertEqual(span.energy_for("sensor.unconfigured"), {})
        self.assertEqual(STATISTICS_CALLS[0]["statistic_ids"], {"sensor.a", "sensor.b"})

    async def test_an_empty_id_list_costs_no_query(self):
        _set_rows({})
        hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
        local_start = _hour("2026-04-23T00:00:00+02:00")

        span = await span_mod.query_hourly_statistics(
            hass,
            [None, ""],
            local_start=local_start,
            local_end=local_start + timedelta(days=1),
        )

        self.assertEqual(span.rows, {})
        self.assertEqual(span.energy_kwh, {})
        self.assertEqual(STATISTICS_CALLS, [])


if __name__ == "__main__":
    unittest.main()
