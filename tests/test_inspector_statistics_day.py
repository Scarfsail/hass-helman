"""Opening a day the recorder has purged the raw states of.

The day view's ordinary source is raw states at fifteen minutes, and the
recorder purges those at ``purge_keep_days``. Long-term statistics are kept
indefinitely, so every day the month view can draw as a bar has hourly numbers
behind it -- and this is the path that turns them back into a day the inspector
can open, at sixty minutes instead of fifteen.

Four things about that path can be quietly wrong, and each returns plausible
numbers rather than an error:

* picking the wrong source for a day, in either direction -- a recent day
  silently coarsened to hourly, or a purged day left drawing nothing;
* splitting one day across both sources, which would put two bar widths in one
  chart and double-count the boundary hour in the totals;
* reading a measurement's ``mean`` as if it were energy, or an energy as if a
  repeated DST hour could simply overwrite its twin;
* drawing the solar forecast at the wrong grain, or letting a day the back-fill
  wrote nothing for fail rather than fall back to an actuals-only day.

The recorder is faked at ``statistics_during_period``, so
``recorder_statistics_span`` and ``statistics_day`` are really exercised, in the
style of ``test_inspector_span_aggregates.py``.
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]

#: What the fake recorder hands back for ``period="hour"``, keyed by statistic id.
STATISTICS_ROWS: dict[str, list[dict]] = {}
#: The same, for the month-reduced rows the history-floor probe asks for.
STATISTICS_ROWS_MONTH: dict[str, list[dict]] = {}
#: Every ``statistics_during_period`` call the fake saw, in order.
STATISTICS_CALLS: list[dict] = []


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
        await asyncio.sleep(0)
        return func(*args)

    recorder_mod = types.ModuleType("homeassistant.components.recorder")
    # One shared instance, so a test can give the recorder a purge horizon.
    # ``keep_days``/``auto_purge`` absent is how the fake says "no horizon".
    recorder_mod.instance_stub = SimpleNamespace(async_add_executor_job=_run_in_executor)
    recorder_mod.get_instance = lambda hass: recorder_mod.instance_stub
    sys.modules["homeassistant.components.recorder"] = recorder_mod

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    # Raw states are gone -- which is the situation under test. Every raw-state
    # loader therefore comes back empty on its own, without being stubbed out
    # one by one.
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
            }
        )
        source = STATISTICS_ROWS_MONTH if period == "month" else STATISTICS_ROWS
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
NOW = datetime(2026, 5, 25, 10, 0, tzinfo=PRAGUE)

_install_import_stubs()

RECORDER_STUB = sys.modules["homeassistant.components.recorder"].instance_stub

import importlib  # noqa: E402

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)

SOLAR_METER = "sensor.solar_total"
HOUSE_METER = "sensor.house_energy"
GRID_IMPORT_METER = "sensor.grid_import"
GRID_EXPORT_METER = "sensor.grid_export"
BATTERY_CHARGE_METER = "sensor.batt_charge"
BATTERY_DISCHARGE_METER = "sensor.batt_discharge"
BATTERY_SOC = "sensor.batt_soc"
WASHER_METER = "sensor.washer_energy"
IMPORT_PRICE = "sensor.helman_grid_import_price"
HELMAN_EXPORT_PRICE = "sensor.helman_grid_export_price"
EXPORT_PRICE = "sensor.spot_sell_price"
SOLAR_FORECAST = "sensor.helman_solar_forecast_current"
HOUSE_FORECAST = "sensor.helman_house_consumption_forecast_current"
BATTERY_SOC_FORECAST = "sensor.helman_battery_soc_forecast_current"
BATTERY_NET_FORECAST = "sensor.helman_battery_net_forecast_current"
GRID_NET_FORECAST = "sensor.helman_grid_net_forecast_current"
GRID_IMPORT_FORECAST = "sensor.helman_grid_import_forecast_current"
GRID_EXPORT_FORECAST = "sensor.helman_grid_export_forecast_current"

#: A day well past any horizon these tests set, and far enough from a DST
#: changeover to have twenty-four ordinary hours.
PURGED_DAY = "2025-06-11"
#: The oldest month the fake recorder has statistics for, so the floor is deep
#: enough for :data:`PURGED_DAY` to be inside it.
FLOOR_MONTH = datetime(2024, 3, 1, tzinfo=PRAGUE)


@contextmanager
def _purging_after(keep_days: int, *, auto_purge: bool = True):
    RECORDER_STUB.keep_days = keep_days
    RECORDER_STUB.auto_purge = auto_purge
    try:
        yield
    finally:
        del RECORDER_STUB.keep_days
        del RECORDER_STUB.auto_purge


def _hour(raw: str) -> datetime:
    return datetime.fromisoformat(raw)


def _row(local_hour: datetime, **fields) -> dict:
    """One hourly ``StatisticsRow``, with the float ``start`` the real API uses."""
    start = local_hour.timestamp()
    return {"start": start, "end": start + 3600.0, **fields}


def _month_row(local_first: datetime) -> dict:
    start = local_first.timestamp()
    return {"start": start, "end": start}


def _meter_series(local_first_hour: datetime, readings: list[float]) -> list[dict]:
    """Consecutive hourly meter readings, seeded by the hour before the first.

    Energy is a difference between readings, so ``readings[0]`` is the seed and
    produces no energy of its own -- the first hour's energy is
    ``readings[1] - readings[0]``.
    """
    return [
        _row(local_first_hour + timedelta(hours=index), state=value)
        for index, value in enumerate(readings)
    ]


def _set_rows(
    rows_by_entity: dict[str, list[dict]],
    *,
    month: dict[str, list[dict]] | None = None,
) -> None:
    STATISTICS_CALLS.clear()
    STATISTICS_ROWS.clear()
    STATISTICS_ROWS.update(rows_by_entity)
    STATISTICS_ROWS_MONTH.clear()
    STATISTICS_ROWS_MONTH.update(
        month if month is not None else {SOLAR_METER: [_month_row(FLOOR_MONTH)]}
    )


class _DummyStore:
    profile = None

    async def async_save(self, payload):
        self.saved = payload


def _make_service(*, with_consumers: bool = False):
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
    service = service_mod.SolarBiasCorrectionService(
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
    )
    if with_consumers:
        async def _device_consumers():
            return [{"energy_entity_id": WASHER_METER, "label": "Washer"}]

        service._house_device_consumers_provider = _device_consumers
    return service


async def _purged_day(service=None, day: str = PURGED_DAY, keep_days: int = 10):
    """Open ``day`` on a recorder purging after ``keep_days``."""
    with _purging_after(keep_days):
        return await (service or _make_service()).async_get_inspector_day(day)


class TestSourceChoice(unittest.IsolatedAsyncioTestCase):
    """Which store a day is drawn from, and that it is only ever one of them."""

    async def test_a_day_inside_the_horizon_stays_on_raw_states(self):
        _set_rows({})
        # today - 3 with ten days kept: comfortably inside, so nothing about it
        # changes and no statistics read is issued on its behalf.
        payload = await _purged_day(day="2026-05-22")

        self.assertEqual(payload["dataGranularityMinutes"], 15)
        self.assertEqual([call["period"] for call in STATISTICS_CALLS], ["month"])

    async def test_a_day_past_the_horizon_reads_hourly_statistics(self):
        _set_rows({SOLAR_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [10.0, 11.5])})

        payload = await _purged_day()

        self.assertEqual(payload["dataGranularityMinutes"], 60)
        self.assertEqual(
            payload["series"]["actual"],
            [{"timestamp": f"{PURGED_DAY}T08:00:00+02:00", "valueWh": 1500.0}],
        )

    async def test_the_day_the_purge_cuts_through_goes_wholly_to_statistics(self):
        # The recorder deletes everything older than ``now - keep_days``, so
        # today-10 has already lost its small hours and loses the rest tonight.
        # Reading it half from each store is what the whole-day rule forbids: two
        # bar widths in one chart, and a boundary hour counted twice.
        cut_day = "2026-05-15"
        _set_rows({SOLAR_METER: _meter_series(_hour(f"{cut_day}T07:00:00+02:00"), [10.0, 12.0])})

        payload = await _purged_day(day=cut_day)

        self.assertEqual(payload["dataGranularityMinutes"], 60)
        self.assertEqual(payload["totals"]["actualWh"], 2000.0)
        # One day later is the first the recorder still holds whole.
        _set_rows({})
        self.assertEqual(
            (await _purged_day(day="2026-05-16"))["dataGranularityMinutes"], 15
        )

    async def test_no_horizon_and_raw_actuals_present_keeps_the_day_at_fifteen(self):
        # Nothing to floor on -- no recorder answer, purging switched off -- so
        # the raw read is attempted and its result is the answer.
        _set_rows({})
        service = _make_service()
        service_mod.load_actuals_for_day = _actuals_returning({"08:00": 500.0})
        try:
            payload = await service.async_get_inspector_day(PURGED_DAY)
        finally:
            service_mod.load_actuals_for_day = _REAL_LOAD_ACTUALS

        self.assertEqual(payload["dataGranularityMinutes"], 15)
        self.assertEqual(payload["totals"]["actualWh"], 500.0)

    async def test_no_horizon_and_an_empty_elapsed_day_falls_back_to_statistics(self):
        # The fallback that makes G1 hold on a setup that never purges but never
        # recorded that far back either.
        _set_rows({SOLAR_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [10.0, 13.0])})

        payload = await _make_service().async_get_inspector_day(PURGED_DAY)

        self.assertEqual(payload["dataGranularityMinutes"], 60)
        self.assertEqual(payload["totals"]["actualWh"], 3000.0)

    async def test_today_is_never_swapped_onto_statistics_by_reading_empty(self):
        # Today reads empty before dawn and has no compiled hour at all just
        # after midnight, so its emptiness is never evidence of a purge.
        _set_rows({})

        payload = await _make_service().async_get_inspector_day("2026-05-25")

        self.assertEqual(payload["dataGranularityMinutes"], 15)

    async def test_a_recorder_that_raised_is_not_evidence_of_a_purge(self):
        # ``auto_purge`` off is an ordinary configuration, and it leaves the
        # source undecided. A momentary recorder failure then leaves both raw
        # reads empty -- but a read that *raised* has said nothing about what the
        # recorder holds, and calling that a purge would tell the user their
        # detailed history is gone and lock the day to the hour.
        _set_rows({})
        service = _make_service()

        async def _boom(*args, **kwargs):
            raise RuntimeError("recorder unavailable")

        service._load_slot_energy_kwh_for_entities = _boom
        with _purging_after(10, auto_purge=False):
            payload = await service.async_get_inspector_day(PURGED_DAY)

        self.assertEqual(payload["dataGranularityMinutes"], 15)

    async def test_purging_switched_off_is_not_a_horizon(self):
        # ``keep_days`` keeps its configured value while ``auto_purge`` is off,
        # so reading it as a horizon would send days to statistics whose raw
        # states the recorder is deliberately still holding.
        _set_rows({})
        service = _make_service()
        service_mod.load_actuals_for_day = _actuals_returning({"08:00": 500.0})
        try:
            with _purging_after(10, auto_purge=False):
                payload = await service.async_get_inspector_day(PURGED_DAY)
        finally:
            service_mod.load_actuals_for_day = _REAL_LOAD_ACTUALS

        self.assertEqual(payload["dataGranularityMinutes"], 15)


class TestMeasuredSeries(unittest.IsolatedAsyncioTestCase):
    """What a statistics-only day actually draws."""

    async def test_every_meter_series_comes_back_hourly_and_signed_as_before(self):
        _set_rows(
            {
                SOLAR_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [10.0, 12.0, 15.0]),
                HOUSE_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [40.0, 40.5]),
                GRID_IMPORT_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [5.0, 5.25]),
                GRID_EXPORT_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [3.0, 4.0]),
                BATTERY_CHARGE_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [7.0, 7.5]),
                BATTERY_DISCHARGE_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [2.0, 2.125]),
            }
        )

        payload = await _purged_day()
        series = payload["series"]
        first = f"{PURGED_DAY}T08:00:00+02:00"

        self.assertEqual(
            [(p["timestamp"], p["valueWh"]) for p in series["actual"]],
            [(first, 2000.0), (f"{PURGED_DAY}T09:00:00+02:00", 3000.0)],
        )
        self.assertEqual(series["houseActual"], [{"timestamp": first, "valueWh": 500.0}])
        # Net grid is positive when exporting: 1.0 kWh out against 0.25 kWh in.
        self.assertEqual(series["gridActual"], [{"timestamp": first, "valueWh": 750.0}])
        # Net battery is positive when charging: 0.5 kWh in against 0.125 out.
        self.assertEqual(series["batteryActual"], [{"timestamp": first, "valueWh": 375.0}])
        self.assertEqual(payload["totals"]["actualWh"], 5000.0)

    async def test_a_measurement_is_read_as_its_hourly_mean(self):
        _set_rows(
            {
                BATTERY_SOC: [
                    _row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=61.5, min=55.0, max=70.0),
                    # Present but empty, the way an hour folded from short-term
                    # rows can arrive: presence is not a reading.
                    _row(_hour(f"{PURGED_DAY}T09:00:00+02:00")),
                ],
                HOUSE_FORECAST: [
                    _row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=800.0),
                ],
            }
        )

        payload = await _purged_day()

        self.assertEqual(payload["series"]["batterySocActual"], [{"slot": "08:00", "pct": 61.5}])
        # The sensor publishes watts, so an hour's mean W *is* that hour's Wh.
        self.assertEqual(
            payload["series"]["houseForecast"],
            [{"timestamp": f"{PURGED_DAY}T08:00:00+02:00", "valueWh": 800.0}],
        )

    async def test_the_battery_forecast_series_come_back_hourly_from_statistics(self):
        # The retired store's five series are now entities, so a purged day draws
        # them from the same one statistics read as everything else, at hour
        # grain. The SoC is its hourly mean percent. The four Wh entities publish
        # *one slot's* energy, so an hour holds four of them and the hour's mean
        # is a quarter of the hour's forecast: the point carries mean * 1000 * 4,
        # commensurable with the hour-total actuals on this same path.
        #
        # Grid net forecast is pinned equal to grid net actual for this hour so
        # the two totals must come out identical -- the regression guard, since
        # dropping the * 4 quartered the forecast against a full-size actual.
        _set_rows(
            {
                GRID_IMPORT_METER: _meter_series(
                    _hour(f"{PURGED_DAY}T07:00:00+02:00"), [5.0, 5.25]
                ),
                GRID_EXPORT_METER: _meter_series(
                    _hour(f"{PURGED_DAY}T07:00:00+02:00"), [3.0, 4.0]
                ),
                BATTERY_SOC_FORECAST: [
                    _row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=54.0),
                ],
                # 0.1875 kWh mean * 1000 * 4 = 750 Wh, the hour's net (1.0 kWh
                # exported minus 0.25 kWh imported).
                GRID_NET_FORECAST: [
                    _row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=0.1875),
                ],
                BATTERY_NET_FORECAST: [
                    _row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=0.3),
                ],
            }
        )

        payload = await _purged_day()

        self.assertEqual(payload["dataGranularityMinutes"], 60)
        self.assertEqual(
            payload["series"]["batterySocForecast"], [{"slot": "08:00", "pct": 54.0}]
        )
        self.assertEqual(
            payload["series"]["gridForecast"],
            [{"timestamp": f"{PURGED_DAY}T08:00:00+02:00", "valueWh": 750.0}],
        )
        self.assertEqual(
            payload["series"]["batteryForecast"],
            [{"timestamp": f"{PURGED_DAY}T08:00:00+02:00", "valueWh": 1200.0}],
        )
        # Forecast and actual are the same quantity at the same scale: an hour
        # where they are equal produces equal day totals.
        self.assertEqual(payload["series"]["gridActual"][0]["valueWh"], 750.0)
        self.assertEqual(
            payload["totals"]["gridForecastWh"], payload["totals"]["gridActualWh"]
        )
        self.assertTrue(payload["availability"]["hasBatterySocForecast"])
        self.assertTrue(payload["availability"]["hasGridForecast"])

    async def test_a_price_rail_holds_its_hourly_rate_across_the_hour(self):
        # Emitted at ``HH:00`` alone the rail would come back three-quarters
        # empty, and the caller's config fill would paint today's tariff into
        # the gaps of a day it never applied to.
        _set_rows(
            {
                IMPORT_PRICE: [_row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=4.5)],
                HELMAN_EXPORT_PRICE: [_row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=1.25)],
            }
        )

        payload = await _purged_day()

        self.assertEqual(
            payload["series"]["importPrice"],
            [
                {"slot": "08:00", "value": 4.5},
                {"slot": "08:15", "value": 4.5},
                {"slot": "08:30", "value": 4.5},
                {"slot": "08:45", "value": 4.5},
            ],
        )
        self.assertEqual([p["value"] for p in payload["series"]["exportPrice"]], [1.25] * 4)

    async def test_the_export_rail_prefers_helmans_mirror_hour_by_hour(self):
        # The seam falls mid-history: the mirror covers hours since it started
        # publishing, the configured sell-price entity covers whatever its own
        # statistics happen to hold.
        _set_rows(
            {
                HELMAN_EXPORT_PRICE: [_row(_hour(f"{PURGED_DAY}T09:00:00+02:00"), mean=2.0)],
                EXPORT_PRICE: [
                    _row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=1.0),
                    _row(_hour(f"{PURGED_DAY}T09:00:00+02:00"), mean=9.0),
                ],
            }
        )

        payload = await _purged_day()
        by_slot = {p["slot"]: p["value"] for p in payload["series"]["exportPrice"]}

        self.assertEqual(by_slot["08:00"], 1.0)
        self.assertEqual(by_slot["09:00"], 2.0)

    async def test_money_is_priced_per_hour_from_the_two_rails(self):
        _set_rows(
            {
                GRID_IMPORT_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [5.0, 7.0]),
                GRID_EXPORT_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [3.0, 4.0]),
                IMPORT_PRICE: [_row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=4.0)],
                HELMAN_EXPORT_PRICE: [_row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=1.5)],
            }
        )

        payload = await _purged_day()

        self.assertEqual(
            payload["series"]["moneyActual"],
            [{"slot": "08:00", "cost": 8.0, "gain": 1.5}],
        )

    async def test_the_house_breakdown_still_composes_against_the_hourly_house(self):
        _set_rows(
            {
                HOUSE_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [40.0, 42.0]),
                WASHER_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [1.0, 1.5]),
            }
        )

        payload = await _purged_day(_make_service(with_consumers=True))
        breakdown = payload["series"]["houseActualBreakdown"]

        self.assertEqual(len(breakdown), 1)
        self.assertEqual(breakdown[0]["slot"], "08:00")
        # 2.0 kWh of house against the washer's 0.5, so the remainder composes
        # back to the hourly house actual exactly as it does at fifteen minutes.
        self.assertEqual(breakdown[0]["unmeasuredWh"], 1500.0)
        appliances = {a["label"]: a["wh"] for a in breakdown[0]["appliances"]}
        self.assertEqual(appliances["Washer"], 500.0)

    async def test_the_day_reads_the_statistics_table_exactly_once(self):
        # One read however many series the day draws: the recorder serves from a
        # single executor thread, so a query per series is a serial round-trip
        # per series however the awaits are arranged.
        _set_rows({SOLAR_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [10.0, 11.0])})

        await _purged_day(_make_service(with_consumers=True))

        hourly = [call for call in STATISTICS_CALLS if call["period"] == "hour"]
        self.assertEqual(len(hourly), 1)
        self.assertEqual(
            hourly[0]["statistic_ids"],
            {
                SOLAR_METER,
                SOLAR_FORECAST,
                HOUSE_METER,
                GRID_IMPORT_METER,
                GRID_EXPORT_METER,
                BATTERY_CHARGE_METER,
                BATTERY_DISCHARGE_METER,
                WASHER_METER,
                BATTERY_SOC,
                HOUSE_FORECAST,
                BATTERY_SOC_FORECAST,
                GRID_NET_FORECAST,
                GRID_IMPORT_FORECAST,
                GRID_EXPORT_FORECAST,
                BATTERY_NET_FORECAST,
                IMPORT_PRICE,
                HELMAN_EXPORT_PRICE,
                EXPORT_PRICE,
            },
        )
        # A day entirely in the past is fully compiled, so no short-term tail.
        self.assertEqual([call["period"] for call in STATISTICS_CALLS].count("5minute"), 0)


class TestSolarForecastFromStatistics(unittest.IsolatedAsyncioTestCase):
    """The recorded solar forecast, folded out of the same one hourly read."""

    async def test_a_forecast_hour_reaches_its_four_slots_at_hour_grain(self):
        # ``solar_forecast_backfill`` writes each hour's mean of the current-slot
        # Wh sensor; the span read hands it back in the energy class's kWh, and
        # each of the hour's four slots carries that mean back as Wh -- a weight,
        # not a claim about how the hour was shaped.
        _set_rows(
            {
                SOLAR_FORECAST: [
                    _row(_hour(f"{PURGED_DAY}T08:00:00+02:00"), mean=0.5),
                    _row(_hour(f"{PURGED_DAY}T09:00:00+02:00"), mean=0.8),
                ],
            }
        )

        payload = await _purged_day()

        self.assertEqual(payload["dataGranularityMinutes"], 60)
        self.assertEqual(
            [(p["timestamp"], p["valueWh"]) for p in payload["series"]["raw"]],
            [
                (f"{PURGED_DAY}T08:00:00+02:00", 500.0),
                (f"{PURGED_DAY}T08:15:00+02:00", 500.0),
                (f"{PURGED_DAY}T08:30:00+02:00", 500.0),
                (f"{PURGED_DAY}T08:45:00+02:00", 500.0),
                (f"{PURGED_DAY}T09:00:00+02:00", 800.0),
                (f"{PURGED_DAY}T09:15:00+02:00", 800.0),
                (f"{PURGED_DAY}T09:30:00+02:00", 800.0),
                (f"{PURGED_DAY}T09:45:00+02:00", 800.0),
            ],
        )
        # The hour's forecast energy is its four slots summed, not a quarter of
        # the mean and not four times it.
        self.assertEqual(payload["totals"]["rawWh"], 4 * 500.0 + 4 * 800.0)
        self.assertTrue(payload["availability"]["hasRawForecast"])

    async def test_the_back_fill_wrote_nothing_leaves_an_actuals_only_day(self):
        # No forecast rows for the day: not an error, not an empty day -- just a
        # day drawing what happened with no curve beside it, as before #188.
        _set_rows({SOLAR_METER: _meter_series(_hour(f"{PURGED_DAY}T07:00:00+02:00"), [10.0, 12.5])})

        payload = await _purged_day()

        self.assertFalse(payload["availability"]["hasRawForecast"])
        self.assertFalse(payload["availability"]["hasCorrectedForecast"])
        self.assertIsNone(payload["totals"]["rawWh"])
        # ``hasActuals`` alone is what keeps the chart drawing.
        self.assertTrue(payload["availability"]["hasActuals"])


class TestWhatStatisticsCannotBringBack(unittest.IsolatedAsyncioTestCase):
    async def test_a_day_the_recorder_has_nothing_for_is_empty_rather_than_broken(self):
        _set_rows({})

        payload = await _purged_day()

        self.assertEqual(payload["dataGranularityMinutes"], 60)
        self.assertEqual(payload["series"]["actual"], [])
        self.assertFalse(payload["availability"]["hasActuals"])


#: ``load_actuals_for_day`` as the service imported it, so a test that stubs the
#: raw solar read can put it back.
_REAL_LOAD_ACTUALS = service_mod.load_actuals_for_day


def _actuals_returning(by_slot: dict[str, float]):
    async def _load(hass, cfg, target_date, *, local_now):
        return dict(by_slot)

    return _load


if __name__ == "__main__":
    unittest.main()
