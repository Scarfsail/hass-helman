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

import asyncio
import sys
from contextlib import contextmanager
import types
import unittest
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]

#: Every ``statistics_during_period`` call the fake recorder saw, in order.
STATISTICS_CALLS: list[dict] = []
#: What that fake hands back for ``period="hour"``, keyed by statistic id. Tests
#: rewrite it in place.
STATISTICS_ROWS: dict[str, list[dict]] = {}
#: The same, for the short-term table the tail read asks for.
STATISTICS_ROWS_5MIN: dict[str, list[dict]] = {}
#: The same, for the month-reduced rows the history-floor probe asks for. Kept
#: apart from the hourly source because the real API reduces before returning:
#: a probe row's ``start`` is local midnight on the first of a month, not an
#: hour, and a fake that served hours here could not tell the two reads apart.
STATISTICS_ROWS_MONTH: dict[str, list[dict]] = {}


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
        # Yields before running, the way a real executor hand-off does. Without
        # this the fake never lets a second coroutine interleave, and anything
        # racing a recorder read would pass here no matter how it behaved.
        await asyncio.sleep(0)
        return func(*args)

    recorder_mod = types.ModuleType("homeassistant.components.recorder")
    # One shared instance rather than a fresh namespace per call, so a test can
    # give the recorder a purge horizon. ``keep_days`` and ``auto_purge`` are
    # absent by default, which is how the fake says "no horizon to be had".
    recorder_mod.instance_stub = SimpleNamespace(
        async_add_executor_job=_run_in_executor
    )
    recorder_mod.get_instance = lambda hass: recorder_mod.instance_stub
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
        source = {
            "5minute": STATISTICS_ROWS_5MIN,
            "month": STATISTICS_ROWS_MONTH,
        }.get(period, STATISTICS_ROWS)
        # The real reader only ever returns rows inside the window it was given,
        # which is the whole point of the tail read's clamps -- a fake that
        # ignored the window could not tell a correct clamp from a missing one.
        # ``end_time=None`` means "everything newer than the start", which is how
        # the history-floor probe asks.
        lower = start_time.timestamp()
        upper = None if end_time is None else end_time.timestamp()
        return {
            statistic_id: [
                row
                for row in rows
                if lower <= row["start"] and (upper is None or row["start"] < upper)
            ]
            for statistic_id, rows in source.items()
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

#: The stubbed ``dt_util`` module, so a test can move the clock.
DT_STUB = sys.modules["homeassistant.util.dt"]
#: The stubbed recorder instance, so a test can give it a purge horizon.
RECORDER_STUB = sys.modules["homeassistant.components.recorder"].instance_stub


@contextmanager
def _purging_after(keep_days: int, *, auto_purge: bool = True):
    """Give the fake recorder a purge horizon for the duration of a test."""
    RECORDER_STUB.keep_days = keep_days
    RECORDER_STUB.auto_purge = auto_purge
    try:
        yield
    finally:
        del RECORDER_STUB.keep_days
        del RECORDER_STUB.auto_purge

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
HELMAN_EXPORT_PRICE = "sensor.helman_grid_export_price"


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


#: Two metered consumers, one shiftable and one the device tree alone knows.
WASHER_METER = "sensor.washer_energy"
FRIDGE_METER = "sensor.fridge_energy"


def _make_service_with_consumers():
    """A service whose house actual is split by a washer and a fridge.

    The rosters are the two the day view's breakdown is built from, wired the
    same way round: the washer is a deferrable appliance that the device tree
    also meters (so it is where the switch and power sensor come from), the
    fridge is a tree node alone.
    """
    service = _make_service()

    async def _device_consumers():
        return [
            {
                "energy_entity_id": WASHER_METER,
                "label": "Washer",
                "switch_entity_id": "switch.washer",
                "power_entity_id": "sensor.washer_power",
            },
            {"energy_entity_id": FRIDGE_METER, "label": "Fridge"},
        ]

    service._house_deferrable_consumers_provider = lambda: [
        {"energy_entity_id": WASHER_METER, "label": "Washer", "id": "washer"}
    ]
    service._house_device_consumers_provider = _device_consumers
    return service


def _five_minute_row(local_instant: datetime, **fields) -> dict:
    """One short-term ``StatisticsRow``, five minutes wide."""
    start = local_instant.timestamp()
    return {"start": start, "end": start + 300.0, **fields}


def _set_rows(
    rows_by_entity: dict[str, list[dict]],
    five_minute: dict[str, list[dict]] | None = None,
    month: dict[str, list[dict]] | None = None,
) -> None:
    STATISTICS_CALLS.clear()
    STATISTICS_ROWS.clear()
    STATISTICS_ROWS.update(rows_by_entity)
    STATISTICS_ROWS_5MIN.clear()
    STATISTICS_ROWS_5MIN.update(five_minute or {})
    STATISTICS_ROWS_MONTH.clear()
    STATISTICS_ROWS_MONTH.update(month or {})


def _calls(period: str) -> list[dict]:
    return [call for call in STATISTICS_CALLS if call["period"] == period]


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
                    # No consumers configured here, so there is nothing to split
                    # the house by and the panel is simply absent.
                    "houseBreakdown": None,
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
                    # No consumers configured here, so there is nothing to split
                    # the house by and the panel is simply absent.
                    "houseBreakdown": None,
                },
            ],
        )

        # One statistics call for every entity and every day of the span. The
        # history-floor probe is a separate, month-reduced read and is counted
        # separately throughout this file.
        self.assertEqual(len(_calls("hour")), 1)
        call = _calls("hour")[0]
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
                HELMAN_EXPORT_PRICE,
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
        # No data read at all. The floor probe does not reappear here either --
        # the first call cached it -- but what this test is about is that a span
        # with nothing to measure measures nothing.
        self.assertEqual(_calls("hour"), [])
        self.assertEqual(_calls("5minute"), [])

    async def test_a_year_wide_span_is_still_one_query(self):
        _set_rows({})
        service = _make_service()

        payload = await service.async_get_span_aggregates("2020-01-01", "2026-05-25")

        # Trimmed to the cap, keeping the recent end.
        self.assertEqual(
            len(payload["days"]), service_mod._MAX_AGGREGATE_BUCKETS["day"]
        )
        self.assertEqual(payload["days"][-1]["date"], "2026-05-25")
        # One hourly call whatever the span's width. The span reaches today, so
        # it also pays for the short tail read -- a fixed second query, not a
        # per-bucket one.
        self.assertEqual(len(_calls("hour")), 1)
        self.assertEqual(len(_calls("5minute")), 1)


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

    async def test_a_single_dipped_reading_is_a_glitch_not_a_reset(self):
        # The blink itself, seen in the readings rather than in ``change``: one
        # low sample with a normal one an hour later. Suppressing it needs a
        # rebound window at least as long as the sample spacing -- the raw-state
        # default of thirty minutes never sees the neighbour, so every blink
        # would open a new segment and lift the rest of the series by the
        # meter's whole reading.
        _set_rows(
            {
                SOLAR_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=49181.0),
                    _row(_hour("2026-04-23T07:00:00+02:00"), state=49184.7),
                    _row(_hour("2026-04-23T08:00:00+02:00"), state=0.5),
                    _row(_hour("2026-04-23T09:00:00+02:00"), state=49191.1),
                    _row(_hour("2026-04-23T10:00:00+02:00"), state=49195.0),
                ]
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        # 3.7, then 6.4 spanning the discarded reading's hour and the next, then
        # 3.9. The blink costs the resolution of one hour, not its energy.
        # Treating the dip as a reset would put ~49190 kWh into this one day.
        self.assertEqual(payload["days"][0]["solarWh"], 14000.0)

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


class TestHouseBreakdown(unittest.IsolatedAsyncioTestCase):
    """Every bucket says what the house was doing, not just how much it used.

    The figures come from the same one read as the six meters -- the consumers'
    energy entities simply join the entity list -- and are folded through the
    same ``_energy_by_bucket``, so a consumer's bucket total is arrived at
    exactly as the house total it is subtracted from. What matters here is that
    the parts reconcile: itemised plus unmeasured is the house, at both
    granularities, or the panel is claiming a composition the chart above it
    does not draw.
    """

    async def test_a_day_bucket_itemises_its_consumers_against_the_house(self):
        _set_rows(
            {
                HOUSE_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=100.0),
                    _row(_hour("2026-04-23T08:00:00+02:00"), state=110.0),
                ],
                WASHER_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=5.0),
                    _row(_hour("2026-04-23T08:00:00+02:00"), state=6.5),
                ],
                FRIDGE_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=2.0),
                    _row(_hour("2026-04-23T08:00:00+02:00"), state=2.5),
                ],
            }
        )
        service = _make_service_with_consumers()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        (row,) = payload["days"]
        self.assertEqual(row["houseWh"], 10000.0)
        breakdown = row["houseBreakdown"]
        # The appliance shape is the day slot's, field for field, so the card
        # parses a bucket's breakdown with the types it already has.
        self.assertEqual(
            breakdown["appliances"],
            [
                {
                    "entityId": WASHER_METER,
                    "label": "Washer",
                    "wh": 1500.0,
                    # The deferrable roster knows no switch or power sensor; the
                    # tree does, and the merge is where they come from.
                    "switchEntityId": "switch.washer",
                    "powerEntityId": "sensor.washer_power",
                    "deferrable": True,
                    "controllableId": "washer",
                },
                {
                    "entityId": FRIDGE_METER,
                    "label": "Fridge",
                    "wh": 500.0,
                    "switchEntityId": None,
                    "powerEntityId": None,
                    "deferrable": False,
                    "controllableId": None,
                },
            ],
        )
        # The remainder is what no individual meter accounted for, so the parts
        # add back up to the house the chart drew.
        self.assertEqual(breakdown["unmeasuredWh"], 8000.0)
        itemised = sum(a["wh"] for a in breakdown["appliances"])
        self.assertEqual(itemised + breakdown["unmeasuredWh"], row["houseWh"])

        # And still one read: the consumers' meters joined the entity list
        # rather than adding a query apiece.
        self.assertEqual(len(_calls("hour")), 1)
        self.assertIn(WASHER_METER, _calls("hour")[0]["statistic_ids"])
        self.assertIn(FRIDGE_METER, _calls("hour")[0]["statistic_ids"])

    async def test_the_same_fold_one_granularity_up(self):
        # Two days of washer energy inside one month, so the month's figure has
        # to be their sum and not either day's.
        _set_rows(
            {
                HOUSE_METER: [
                    _row(_hour("2026-03-31T23:00:00+02:00"), state=100.0),
                    _row(_hour("2026-04-03T08:00:00+02:00"), state=104.0),
                    _row(_hour("2026-04-20T08:00:00+02:00"), state=110.0),
                ],
                WASHER_METER: [
                    _row(_hour("2026-03-31T23:00:00+02:00"), state=5.0),
                    _row(_hour("2026-04-03T08:00:00+02:00"), state=6.0),
                    _row(_hour("2026-04-20T08:00:00+02:00"), state=6.25),
                ],
            }
        )
        service = _make_service_with_consumers()

        payload = await service.async_get_span_aggregates(
            "2026-04-01", "2026-04-30", bucket="month"
        )

        (row,) = payload["days"]
        self.assertEqual(row["date"], "2026-04-01")
        self.assertEqual(row["houseWh"], 10000.0)
        breakdown = row["houseBreakdown"]
        washer = next(a for a in breakdown["appliances"] if a["entityId"] == WASHER_METER)
        self.assertEqual(washer["wh"], 1250.0)
        # The fridge is configured but read nothing this month: a zero row
        # rather than an absent one, because the roster is what the panel's
        # boxes are, and a box that vanished would read as a lost appliance.
        fridge = next(a for a in breakdown["appliances"] if a["entityId"] == FRIDGE_METER)
        self.assertEqual(fridge["wh"], 0.0)
        itemised = sum(a["wh"] for a in breakdown["appliances"])
        self.assertEqual(itemised + breakdown["unmeasuredWh"], row["houseWh"])

    async def test_a_bucket_the_house_meter_missed_carries_no_breakdown(self):
        # Nothing to split: the remainder would have to be invented from a house
        # total that does not exist, and a panel drawn from it would be fiction.
        _set_rows(
            {
                WASHER_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=5.0),
                    _row(_hour("2026-04-23T08:00:00+02:00"), state=6.5),
                ],
            }
        )
        service = _make_service_with_consumers()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        (row,) = payload["days"]
        self.assertIsNone(row["houseWh"])
        self.assertIsNone(row["houseBreakdown"])

    async def test_no_consumers_configured_changes_nothing_else(self):
        # The house column, the meters and the entity list are all as they were
        # before there was a breakdown to carry; only the new key is null.
        rows = {
            HOUSE_METER: [
                _row(_hour("2026-04-22T23:00:00+02:00"), state=100.0),
                _row(_hour("2026-04-23T08:00:00+02:00"), state=110.0),
            ],
        }
        _set_rows(rows)
        bare = await _make_service().async_get_span_aggregates("2026-04-23", "2026-04-23")
        bare_ids = set(_calls("hour")[0]["statistic_ids"])

        _set_rows(rows)
        with_roster = await _make_service_with_consumers().async_get_span_aggregates(
            "2026-04-23", "2026-04-23"
        )

        (bare_row,) = bare["days"]
        self.assertIsNone(bare_row["houseBreakdown"])
        self.assertEqual(bare_row["houseWh"], 10000.0)
        # Every other field of the row is the same either way -- the roster adds
        # a key and reads two more meters, and touches nothing else.
        (roster_row,) = with_roster["days"]
        self.assertEqual(
            {k: v for k, v in bare_row.items() if k != "houseBreakdown"},
            {k: v for k, v in roster_row.items() if k != "houseBreakdown"},
        )
        self.assertNotIn(WASHER_METER, bare_ids)


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
        call = _calls("hour")[0]
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
            _calls("hour")[0]["end_time"],
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
        self.assertEqual(len(_calls("hour")), 1)
        self.assertEqual(len(_calls("5minute")), 1)


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

    async def test_the_export_rate_prefers_helmans_mirror_hour_by_hour(self):
        """The mirror wins where it has the hour; the configured entity fills the rest.

        The reason the mirror exists at all is that a sell-price entity usually
        declares no ``state_class`` and therefore has no statistics -- but some
        setups' do, and the mirror only reaches back as far as its back-fill got.
        A per-series choice would either blank the hours only one of them covers
        or throw away Helman's own record; a per-hour one keeps both.
        """
        _set_rows(
            {
                GRID_EXPORT_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=0.0),
                    # 10:00: both series have the hour.
                    _row(_hour("2026-04-23T10:00:00+02:00"), state=1.0),
                    # 11:00: only the configured entity does.
                    _row(_hour("2026-04-23T11:00:00+02:00"), state=3.0),
                    # 12:00: only the mirror does.
                    _row(_hour("2026-04-23T12:00:00+02:00"), state=7.0),
                ],
                HELMAN_EXPORT_PRICE: [
                    _row(_hour("2026-04-23T10:00:00+02:00"), mean=2.0),
                    _row(_hour("2026-04-23T12:00:00+02:00"), mean=5.0),
                ],
                EXPORT_PRICE: [
                    # Deliberately disagreeing on the shared hour: the mirror is
                    # the series Helman archived, so it is the one that counts.
                    _row(_hour("2026-04-23T10:00:00+02:00"), mean=99.0),
                    _row(_hour("2026-04-23T11:00:00+02:00"), mean=3.0),
                ],
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        # 1 kWh at the mirror's 2.0, 2 kWh at the configured entity's 3.0, and
        # 4 kWh at the mirror's 5.0.
        self.assertEqual(payload["days"][0]["moneyGain"], 28.0)

    async def test_a_mirror_row_without_a_rate_yields_to_one_that_has_one(self):
        # A row is not a reading. The span read folds five-minute tail rows onto
        # their containing hour and emits a row whether or not any of them
        # carried a mean, so the hour in progress can arrive present-but-empty --
        # a mirror that has just come back from `unavailable`, say. Preferring it
        # on presence alone would blank an hour the configured entity priced.
        _set_rows(
            {
                GRID_EXPORT_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=0.0),
                    _row(_hour("2026-04-23T10:00:00+02:00"), state=2.0),
                ],
                HELMAN_EXPORT_PRICE: [
                    _row(_hour("2026-04-23T10:00:00+02:00"), mean=None),
                ],
                EXPORT_PRICE: [
                    _row(_hour("2026-04-23T10:00:00+02:00"), mean=4.0),
                ],
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        # 2 kWh at the only rate anything actually recorded.
        self.assertEqual(payload["days"][0]["moneyGain"], 8.0)

    async def test_the_export_rate_falls_back_when_the_mirror_has_no_rows(self):
        _set_rows(
            {
                GRID_EXPORT_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=0.0),
                    _row(_hour("2026-04-23T10:00:00+02:00"), state=2.0),
                ],
                EXPORT_PRICE: [_row(_hour("2026-04-23T10:00:00+02:00"), mean=1.5)],
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        self.assertEqual(payload["days"][0]["moneyGain"], 3.0)

    async def test_a_window_boundary_inside_an_hour_is_averaged_across_it(self):
        # The night rate ends at 08:30, so the 08:00 hour is half at 2.0 and
        # half at 5.0. Reading the rate off the hour's start would price the
        # whole hour at 2.0 -- and would do it to every such hour in a year.
        config = price_builder.FixedGridImportPriceConfig(
            unit="CZK/kWh",
            windows=(
                price_builder.FixedGridImportPriceWindow(
                    start_minutes=0, end_minutes=510, price=2.0
                ),
                price_builder.FixedGridImportPriceWindow(
                    start_minutes=510, end_minutes=1440, price=5.0
                ),
            ),
        )
        _set_rows(
            {
                GRID_IMPORT_METER: [
                    _row(_hour("2026-04-22T23:00:00+02:00"), state=0.0),
                    _row(_hour("2026-04-23T08:00:00+02:00"), state=2.0),
                ]
            }
        )
        service = _make_service(import_price_config=config)

        payload = await service.async_get_span_aggregates("2026-04-23", "2026-04-23")

        # 2 kWh at the hour's mean of (30 x 2.0 + 30 x 5.0) / 60 = 3.5.
        self.assertEqual(payload["days"][0]["moneyCost"], 7.0)

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


class TestTailRead(unittest.IsolatedAsyncioTestCase):
    """The newest bucket is minutes stale, not hours.

    Hourly statistics exist only for hours that have ended *and* been compiled,
    so the bucket in progress is short by up to a couple of hours -- and just
    after midnight a day bucket has no completed hour at all. These views are
    history-only, so a gap there is simply a hole. The fix is a second, short
    read of the same statistics on ``period="5minute"``.
    """

    async def test_the_newest_bucket_takes_its_energy_from_the_short_term_table(self):
        _set_rows(
            {
                SOLAR_METER: [
                    # Yesterday, fully compiled.
                    _row(_hour("2026-05-23T23:00:00+02:00"), state=100.0),
                    _row(_hour("2026-05-24T23:00:00+02:00"), state=120.0),
                    # Today, compiled only as far as 07:00 -- the lag the tail
                    # read exists for.
                    _row(_hour("2026-05-25T07:00:00+02:00"), state=125.0),
                ]
            },
            {
                SOLAR_METER: [
                    # Yesterday again: outside the tail window, so the reader
                    # never returns it and yesterday stays purely hourly.
                    _five_minute_row(_hour("2026-05-24T12:00:00+02:00"), state=999.0),
                    _five_minute_row(_hour("2026-05-25T08:55:00+02:00"), state=127.0),
                    _five_minute_row(_hour("2026-05-25T09:55:00+02:00"), state=130.0),
                ]
            },
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-05-24", "2026-05-25")

        self.assertEqual(
            [(day["date"], day["solarWh"]) for day in payload["days"]],
            # Yesterday: 120 - 100. Today: 5 kWh from the compiled hours, then
            # 2 and 3 more from the two hours only the short-term table has.
            [("2026-05-24", 20000.0), ("2026-05-25", 10000.0)],
        )

        tail = _calls("5minute")
        self.assertEqual(len(tail), 1)
        # Clamped to six hours back from now (10:00) and floored to the hour, so
        # every hour it reports on is wholly inside the read.
        self.assertEqual(
            tail[0]["start_time"],
            _hour("2026-05-25T04:00:00+02:00").astimezone(timezone.utc),
        )
        self.assertEqual(
            tail[0]["end_time"],
            _hour("2026-05-26T00:00:00+02:00").astimezone(timezone.utc),
        )

    async def test_a_span_entirely_in_the_past_costs_no_tail_read(self):
        _set_rows(
            {
                SOLAR_METER: [
                    _row(_hour("2026-05-19T23:00:00+02:00"), state=10.0),
                    _row(_hour("2026-05-20T23:00:00+02:00"), state=14.0),
                ]
            }
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-05-20", "2026-05-20")

        self.assertEqual(payload["days"][0]["solarWh"], 4000.0)
        self.assertEqual(len(_calls("hour")), 1)
        self.assertEqual(_calls("5minute"), [])

    async def test_a_compiled_hour_is_filled_around_but_never_overwritten(self):
        _set_rows(
            {
                SOLAR_METER: [
                    _row(_hour("2026-05-24T23:00:00+02:00"), state=120.0),
                    _row(_hour("2026-05-25T07:00:00+02:00"), state=125.0),
                ]
            },
            {
                SOLAR_METER: [
                    # A short-term table missing most of 07:00 would read as a
                    # 1 kWh hour. The compiled hour is complete by construction
                    # and wins.
                    _five_minute_row(_hour("2026-05-25T07:55:00+02:00"), state=121.0),
                    _five_minute_row(_hour("2026-05-25T09:55:00+02:00"), state=128.0),
                ]
            },
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-05-25", "2026-05-25")

        # 125 - 120 for the compiled hours, then 128 - 125 for the one only the
        # tail knows about. The 121.0 reading is discarded with its hour.
        self.assertEqual(payload["days"][0]["solarWh"], 8000.0)

    async def test_just_after_midnight_the_day_is_drawn_from_the_tail_alone(self):
        original_now = DT_STUB.now
        DT_STUB.now = lambda: datetime(2026, 5, 25, 0, 20, tzinfo=PRAGUE)
        try:
            _set_rows(
                {
                    # The last compiled hour is yesterday's; today has none, and
                    # without the tail its column would be null rather than small.
                    SOLAR_METER: [_row(_hour("2026-05-24T23:00:00+02:00"), state=100.0)],
                },
                {
                    SOLAR_METER: [
                        _five_minute_row(
                            _hour("2026-05-25T00:15:00+02:00"), state=104.0
                        )
                    ],
                    BATTERY_SOC: [
                        _five_minute_row(
                            _hour("2026-05-25T00:15:00+02:00"), min=40.0, max=45.0
                        )
                    ],
                },
            )
            service = _make_service()

            payload = await service.async_get_span_aggregates("2026-05-25", "2026-05-25")
        finally:
            DT_STUB.now = original_now

        day = payload["days"][0]
        self.assertEqual(day["solarWh"], 4000.0)
        # The folded row is an ordinary hourly row to everything downstream, so
        # min/max come through as well as energy.
        self.assertEqual((day["batteryMinSocPct"], day["batteryMaxSocPct"]), (40.0, 45.0))


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


def _month_row(local_first: datetime) -> dict:
    """One month-reduced ``StatisticsRow``.

    The real reducer buckets by *local* month and stamps each row with local
    midnight on the first, which is exactly why the probe can floor to a month
    without doing any arithmetic of its own.
    """
    start = local_first.timestamp()
    return {"start": start, "end": start}


def _with_usable_days(service, usable_days: int):
    """Move the trainer's window, which is the floor's fallback."""
    service._metadata = replace(service._metadata, usable_days=usable_days)
    return service


class TestHistoryFloor(unittest.IsolatedAsyncioTestCase):
    """How far back the inspector says it can be browsed.

    The floor used to be ``today - usable_days`` -- a count of usable *training
    samples*, which on a two-month training window hid two years of recorded
    history behind a disabled button. It is now the recorder's own answer, and
    these tests hold the three properties that answer has to have: it is cheap,
    it is honest about having nothing, and it can only ever widen the range.
    """

    async def test_the_floor_is_the_oldest_month_the_meters_have(self):
        _set_rows(
            {},
            month={
                # Not the first entity, and not the first row: the floor is the
                # oldest across all of them, because one meter installed later
                # than another does not make the earlier meter's months
                # undrawable.
                GRID_IMPORT_METER: [_month_row(_hour("2025-07-01T00:00:00+02:00"))],
                SOLAR_METER: [
                    _month_row(_hour("2024-03-01T00:00:00+01:00")),
                    _month_row(_hour("2024-04-01T00:00:00+02:00")),
                ],
            },
        )
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-05-25", "2026-05-25")

        self.assertEqual(payload["range"]["minDate"], "2024-03-01")
        self.assertEqual(payload["range"]["maxDate"], "2026-05-25")

    async def test_the_probe_is_one_cheap_month_wide_read_of_the_meters_alone(self):
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _make_service()

        await service.async_get_span_aggregates("2026-05-25", "2026-05-25")

        probes = _calls("month")
        self.assertEqual(len(probes), 1)
        probe = probes[0]
        # Empty ``types`` is what keeps the scan two columns wide however deep
        # the history goes, and ``end_time=None`` is what makes it open-ended.
        self.assertEqual(probe["types"], set())
        self.assertIsNone(probe["units"])
        self.assertIsNone(probe["end_time"])
        self.assertEqual(probe["start_time"], span_mod._HISTORY_PROBE_EPOCH)
        # The six meters, and nothing else. The SoC sensor and the price rails
        # are read by the span itself but do not decide whether a bucket has
        # history to draw, so probing them would only widen the scan.
        self.assertEqual(
            probe["statistic_ids"],
            {
                SOLAR_METER,
                HOUSE_METER,
                GRID_IMPORT_METER,
                GRID_EXPORT_METER,
                BATTERY_CHARGE_METER,
                BATTERY_DISCHARGE_METER,
            },
        )

    async def test_no_statistics_falls_back_to_the_training_window(self):
        _set_rows({}, month={})
        service = _with_usable_days(_make_service(), 12)

        payload = await service.async_get_span_aggregates("2026-05-25", "2026-05-25")

        self.assertEqual(len(_calls("month")), 1)
        self.assertEqual(payload["range"]["minDate"], "2026-05-13")

    async def test_the_floor_never_lands_later_than_the_training_window(self):
        # A recorder that has been purged back to this month still must not
        # narrow a range the trainer can reach past: the day view reads raw
        # states, not statistics, so those days are still there.
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2026-05-01T00:00:00+02:00"))]})
        service = _with_usable_days(_make_service(), 90)

        payload = await service.async_get_span_aggregates("2026-05-25", "2026-05-25")

        self.assertEqual(payload["range"]["minDate"], "2026-02-24")

    async def test_the_floor_is_probed_once_until_the_ttl_expires(self):
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _make_service()
        original_now = DT_STUB.now
        try:
            await service.async_get_span_aggregates("2026-05-25", "2026-05-25")
            await service.async_get_span_aggregates("2026-05-24", "2026-05-24")
            self.assertEqual(len(_calls("month")), 1)

            # Past the TTL the question is asked again -- a purge moves the true
            # floor forward and a back-fill moves it back, and neither should go
            # unnoticed for the life of the process.
            DT_STUB.now = lambda: NOW + service_mod._HISTORY_FLOOR_TTL
            await service.async_get_span_aggregates("2026-05-23", "2026-05-23")
            self.assertEqual(len(_calls("month")), 2)
        finally:
            DT_STUB.now = original_now

    async def test_a_recorder_that_raises_leaves_the_trainer_window_standing(self):
        _set_rows({}, month={})
        service = _with_usable_days(_make_service(), 12)

        def _explode(*args, **kwargs):
            raise RuntimeError("recorder is down")

        original = span_mod.statistics_during_period
        span_mod.statistics_during_period = _explode
        try:
            payload = await service.async_get_span_aggregates("2026-05-25", "2026-05-25")
        finally:
            span_mod.statistics_during_period = original

        self.assertEqual(payload["range"]["minDate"], "2026-05-13")

    async def test_a_failed_probe_is_retried_soon_but_not_at_once(self):
        # Two costs to sit between. Caching a failure for the whole TTL would pin
        # the shallow fallback over a moment's unavailability; not caching it at
        # all would put the probe's full-history scan in front of every request
        # for as long as the recorder stayed unwell -- on the one executor thread
        # the day view's own reads queue behind.
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _with_usable_days(_make_service(), 12)

        def _explode(*args, **kwargs):
            raise RuntimeError("recorder is down")

        original_now = DT_STUB.now
        original = span_mod.statistics_during_period
        span_mod.statistics_during_period = _explode
        try:
            first = await service.async_get_span_aggregates("2026-05-25", "2026-05-25")
        finally:
            span_mod.statistics_during_period = original
        self.assertEqual(first["range"]["minDate"], "2026-05-13")
        failed_probes = len(_calls("month"))

        try:
            # Inside the retry window the failure stands, and costs nothing.
            during = await service.async_get_span_aggregates("2026-05-24", "2026-05-24")
            self.assertEqual(during["range"]["minDate"], "2026-05-13")
            self.assertEqual(len(_calls("month")), failed_probes)

            # Past it the recorder is asked again, and its answer lands -- well
            # inside the six hours a successful probe would have been trusted for.
            DT_STUB.now = lambda: NOW + service_mod._HISTORY_FLOOR_RETRY
            after = await service.async_get_span_aggregates("2026-05-23", "2026-05-23")
            self.assertEqual(after["range"]["minDate"], "2024-03-01")
        finally:
            DT_STUB.now = original_now

    async def test_a_failure_does_not_narrow_a_floor_already_learned(self):
        # A recorder that has stopped answering is no reason to pull the range in
        # under a reader mid-session: the floor already learned is still the best
        # answer available.
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _with_usable_days(_make_service(), 12)

        good = await service.async_get_span_aggregates("2026-05-25", "2026-05-25")
        self.assertEqual(good["range"]["minDate"], "2024-03-01")

        def _explode(*args, **kwargs):
            raise RuntimeError("recorder is down")

        original_now = DT_STUB.now
        original = span_mod.statistics_during_period
        span_mod.statistics_during_period = _explode
        DT_STUB.now = lambda: NOW + service_mod._HISTORY_FLOOR_TTL
        try:
            after = await service.async_get_span_aggregates("2026-05-24", "2026-05-24")
        finally:
            span_mod.statistics_during_period = original
            DT_STUB.now = original_now

        self.assertEqual(after["range"]["minDate"], "2024-03-01")

    async def test_a_caller_arriving_mid_probe_waits_for_its_answer(self):
        # What a card mounting into an aggregate view really does: both websocket
        # commands are dispatched together, and one of them reaches the floor
        # while the other's read is still in flight. A probe that merely
        # deduplicated the read would let the late caller past a stamp the first
        # had not yet filled in and hand it the trainer window -- so the two
        # payloads would disagree about minDate on exactly the load this bound
        # exists to fix. The barrier holds the probe open so the overlap is the
        # test's, not the scheduler's to grant.
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _with_usable_days(_make_service(), 12)

        probing = asyncio.Event()
        release = asyncio.Event()
        real_probe = service._async_probe_history_floor

        async def _held_probe():
            probing.set()
            await release.wait()
            return await real_probe()

        service._async_probe_history_floor = _held_probe

        first = asyncio.ensure_future(service._async_history_floor(NOW))
        await probing.wait()
        second = asyncio.ensure_future(service._async_history_floor(NOW))
        # Let the late caller run as far as it can get on its own.
        await asyncio.sleep(0)
        release.set()

        self.assertEqual(await first, date(2024, 3, 1))
        self.assertEqual(await second, date(2024, 3, 1))
        self.assertEqual(len(_calls("month")), 1)

    async def test_an_empty_span_still_carries_the_range(self):
        # The reader is never more likely to press an arrow than when the span
        # in front of them has nothing in it.
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _make_service()

        payload = await service.async_get_span_aggregates("2026-06-01", "2026-06-30")

        self.assertEqual(payload["days"], [])
        self.assertEqual(payload["range"]["minDate"], "2024-03-01")

    async def test_the_day_view_stops_at_the_purge_horizon_and_the_spans_do_not(self):
        # The two floors differ on purpose, because the two views read two
        # different stores. The month and year views read long-term statistics,
        # which the recorder keeps indefinitely; the day view reads raw states
        # through load_actuals_for_day, which the recorder purges at
        # purge_keep_days. One deep floor would give the day view a back arrow
        # offering hundreds of days that can only ever draw empty.
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _with_usable_days(_make_service(), 5)

        with _purging_after(10):
            span = await service.async_get_span_aggregates("2026-05-25", "2026-05-25")
            day = await service.async_get_inspector_day("2026-05-25")

        self.assertEqual(span["range"]["minDate"], "2024-03-01")
        # keep_days - 1: the recorder purges through today-10, so today-9 is the
        # oldest day it still holds whole.
        self.assertEqual(day["range"]["minDate"], "2026-05-16")
        # Forward is one answer for everyone; only the floor is per view.
        self.assertEqual(day["range"]["maxDate"], span["range"]["maxDate"])
        # The day payload keeps its own four extra keys; the shared helper only
        # owns the two bounds.
        self.assertTrue(day["range"]["canGoPrevious"])

    async def test_a_stale_training_window_does_not_reopen_purged_days(self):
        # usable_days counts samples the *last* training run built, so it is
        # evidence that raw states existed when it ran and not that they exist
        # now. Shortening purge_keep_days after a run leaves the count untouched,
        # and honouring it would hand back the back arrow full of purged days the
        # floor exists to prevent.
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _with_usable_days(_make_service(), 60)

        with _purging_after(3):
            day = await service.async_get_inspector_day("2026-05-25")

        self.assertEqual(day["range"]["minDate"], "2026-05-23")

    async def test_without_a_purge_horizon_the_day_view_keeps_the_deep_floor(self):
        # No recorder to ask, so there is no horizon to floor on. Erring towards
        # offering a day rather than hiding one is the safe direction, and it is
        # what the day view did before the horizon was consulted at all.
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _with_usable_days(_make_service(), 5)

        day = await service.async_get_inspector_day("2026-05-25")

        self.assertEqual(day["range"]["minDate"], "2024-03-01")

    async def test_purging_switched_off_is_not_a_horizon(self):
        # keep_days keeps its configured value while auto_purge is off, so
        # flooring on it would hide raw states the recorder is deliberately
        # still holding.
        _set_rows({}, month={SOLAR_METER: [_month_row(_hour("2024-03-01T00:00:00+01:00"))]})
        service = _with_usable_days(_make_service(), 5)

        with _purging_after(10, auto_purge=False):
            day = await service.async_get_inspector_day("2026-05-25")

        self.assertEqual(day["range"]["minDate"], "2024-03-01")

