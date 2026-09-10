"""The inspector's cumulative-energy meters are read in ONE recorder query.

The recorder serves every query from a single DB executor thread, so a read per
meter is a serial round-trip per meter however the awaits are arranged: the
inspector once issued eighteen of them and spent 0.4-1.7s in the gather. The
batched read is the fix, and it is only a fix while it stays one query, so this
counts the queries rather than trusting the shape of the call site.
"""

from __future__ import annotations

import sys
import types
import unittest
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]

QUERIES: dict[str, list] = {"batched": [], "per_entity": [], "all": []}


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

    # The inspector day asks the recorder where its statistics begin, which
    # imports the span module. Nothing here is about that read -- it is
    # month-reduced and cached, and this file counts the *raw state* queries the
    # meters cost -- so it answers with nothing and the floor falls back to the
    # trainer's window.
    statistics_mod = types.ModuleType("homeassistant.components.recorder.statistics")
    statistics_mod.statistics_during_period = lambda *args, **kwargs: {}
    sys.modules["homeassistant.components.recorder.statistics"] = statistics_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.now = lambda: datetime.fromisoformat("2026-05-11T10:00:00+02:00")
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    sys.modules.pop("custom_components.helman.recorder_hourly_series", None)
    sys.modules.pop("custom_components.helman.recorder_statistics_span", None)
    sys.modules.pop("custom_components.helman.solar_bias_correction.service", None)


_install_import_stubs()

import importlib  # noqa: E402

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)

recorder_series_mod = importlib.import_module(
    "custom_components.helman.recorder_hourly_series"
)
span_mod = importlib.import_module(
    "custom_components.helman.recorder_statistics_span"
)


@contextmanager
def _counting_queries():
    """Count every recorder read the inspector day makes, and what it asked for.

    ``QUERIES["batched"]``/``["per_entity"]`` are the cumulative-meter helpers'
    own reads, and ``QUERIES["all"]`` is every read on the path in issue order —
    which is what "the solar meter is read once *in total*" has to be counted
    against, since a duplicate read need not come from the same module as the
    batch. Reads reach the recorder under two names from several modules, some
    binding them at import time (``recorder_hourly_series``) and some at call
    time (the inspector's own numeric history), so both names are replaced in
    both places.
    """

    def _batched(hass, start, end, entity_ids=None, *args, **kwargs):
        QUERIES["batched"].append(list(entity_ids or []))
        QUERIES["all"].append(list(entity_ids or []))
        return {}

    def _shared_batched(hass, start, end, entity_ids=None, *args, **kwargs):
        QUERIES["all"].append(list(entity_ids or []))
        return {}

    def _per_entity(hass, start, end, entity_id, *args, **kwargs):
        QUERIES["per_entity"].append(entity_id)
        QUERIES["all"].append([entity_id])
        return {}

    for reads in QUERIES.values():
        reads.clear()
    with patch.multiple(
        recorder_series_mod,
        get_significant_states=_batched,
        state_changes_during_period=_per_entity,
    ), patch.multiple(
        sys.modules["homeassistant.components.recorder.history"],
        get_significant_states=_shared_batched,
        state_changes_during_period=_per_entity,
    ):
        yield


def _reads_touching(entity_id: str) -> list[list[str]]:
    """Every counted read whose entity list contains ``entity_id``."""
    return [read for read in QUERIES["all"] if entity_id in read]


PRAGUE = ZoneInfo("Europe/Prague")
TARGET_DATE = "2026-05-10"

HOUSE_METER = "sensor.house_energy"
GRID_IMPORT_METER = "sensor.grid_import"
GRID_EXPORT_METER = "sensor.grid_export"
BATTERY_CHARGE_METER = "sensor.batt_charge"
BATTERY_DISCHARGE_METER = "sensor.batt_discharge"
CONSUMER_METERS = [f"sensor.consumer_{index}" for index in range(13)]
SOLAR_METER = "sensor.solar_total"
SOC_SENSOR = "sensor.battery_soc"
MIN_SOC_SENSOR = "number.battery_min_soc"
MAX_SOC_SENSOR = "number.battery_max_soc"
IMPORT_PRICE_ENTITY = "sensor.helman_grid_import_price"
EXPORT_PRICE_ENTITY = "sensor.helman_grid_export_price"


#: A recorder that keeps ten years of raw states, so the day under test is
#: decided as a raw-state day outright rather than by whether the (stubbed,
#: empty) read came back with anything.
def _keeping_raw_states():
    holding_recorder = SimpleNamespace(
        async_add_executor_job=_run_in_executor_now,
        keep_days=3650,
        auto_purge=True,
    )
    return patch(
        "homeassistant.components.recorder.get_instance",
        lambda hass: holding_recorder,
    )


async def _run_in_executor_now(func, *args):
    return func(*args)


class _DummyStore:
    profile = None

    async def async_save(self, payload):
        self.saved = payload


def _make_cfg():
    return models.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        aggregation_method="ratio_of_sums",
        daily_energy_entity_ids=["sensor.solar_today", "sensor.solar_tomorrow"],
        total_energy_entity_id="sensor.solar_total",
    )


def _make_service():
    hass = SimpleNamespace(
        config=SimpleNamespace(time_zone="Europe/Prague"),
        bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        states=SimpleNamespace(get=lambda entity_id: None),
        # Where the oldest-state probe caches its answers. One per service, so
        # each test starts cold and counts the probes a first open really costs.
        data={},
    )
    service = service_mod.SolarBiasCorrectionService(
        hass,
        _DummyStore(),
        _make_cfg(),
        house_energy_entity_id_provider=lambda: HOUSE_METER,
        grid_import_energy_entity_id_provider=lambda: GRID_IMPORT_METER,
        grid_export_energy_entity_id_provider=lambda: GRID_EXPORT_METER,
        battery_charge_energy_entity_id_provider=lambda: BATTERY_CHARGE_METER,
        battery_discharge_energy_entity_id_provider=lambda: BATTERY_DISCHARGE_METER,
        house_deferrable_consumers_provider=lambda: [
            {"energy_entity_id": entity_id, "label": entity_id}
            for entity_id in CONSUMER_METERS
        ],
        battery_soc_entity_id_provider=lambda: SOC_SENSOR,
        battery_soc_bounds_entity_id_provider=lambda: (
            MIN_SOC_SENSOR,
            MAX_SOC_SENSOR,
        ),
    )
    service._profile = models.SolarBiasProfile(factors={}, omitted_slots=[])
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-05-01T03:00:00+02:00",
        training_config_fingerprint="fp",
        usable_days=5,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=0,
        last_outcome="profile_trained",
    )
    return service


class TestInspectorIssuesOneCumulativeEnergyQuery(unittest.IsolatedAsyncioTestCase):
    async def test_nineteen_meters_cost_one_recorder_query(self):
        service = _make_service()

        # A stated horizon on purpose: an elapsed day whose stubbed reads all
        # come back empty, on an instance that states no purge horizon, is taken
        # as a purged day and served from hourly statistics instead -- which
        # would leave the batched raw read this test counts unissued.
        with _counting_queries(), _keeping_raw_states(), patch.object(
            service_mod,
            "load_house_forecast_points_for_day",
            AsyncMock(return_value=[]),
        ), patch.object(
            service,
            "_load_recorded_price_rails",
            AsyncMock(return_value=([], [])),
        ):
            await service.async_get_inspector_day(TARGET_DATE)

        # One query, covering every meter the day's actual series draw. The
        # solar meter is in it even though its own series is read separately:
        # the batch needs its publishes as recorder-liveness evidence (#208).
        self.assertEqual(len(QUERIES["batched"]), 1)
        self.assertEqual(
            sorted(QUERIES["batched"][0]),
            sorted(
                [
                    SOLAR_METER,
                    HOUSE_METER,
                    GRID_IMPORT_METER,
                    GRID_EXPORT_METER,
                    BATTERY_CHARGE_METER,
                    BATTERY_DISCHARGE_METER,
                    *CONSUMER_METERS,
                ]
            ),
        )
        # And not one per meter behind it: the per-entity read is what this
        # replaced, so reaching it at all is the regression.
        self.assertEqual(QUERIES["per_entity"], [])
        # The solar meter is read exactly once on the whole path, counting every
        # module's reads and not just the meter batch's own: its actual series
        # is that batch's solar column, not a second read of the same meter.
        self.assertEqual(_reads_touching(SOLAR_METER), [QUERIES["batched"][0]])

    async def test_unrelated_provider_failure_keeps_solar_actuals(self):
        service = _make_service()

        def _raise_house_provider():
            raise RuntimeError("house meter unavailable")

        service._house_energy_entity_id_provider = _raise_house_provider
        requested_entity_ids: list[str] = []

        async def _load_meter_batch(entity_ids, target_date, local_tz):
            requested_entity_ids.extend(entity_ids)
            slot_start = datetime.combine(
                target_date,
                datetime.min.time(),
                tzinfo=local_tz,
            ).replace(hour=8)
            return recorder_series_mod.SlotEnergyBatch(
                by_entity={SOLAR_METER: {slot_start: 0.25}},
                liveness_instants=[slot_start],
            )

        service._load_slot_energy_kwh_for_entities = _load_meter_batch

        with _counting_queries(), _keeping_raw_states(), patch.object(
            service_mod,
            "load_house_forecast_points_for_day",
            AsyncMock(return_value=[]),
        ), patch.object(
            service,
            "_load_recorded_price_rails",
            AsyncMock(return_value=([], [])),
        ):
            payload = await service.async_get_inspector_day(TARGET_DATE)

        self.assertIn(SOLAR_METER, requested_entity_ids)
        self.assertEqual(
            payload["series"]["actual"],
            [
                {
                    "timestamp": "2026-05-10T08:00:00+02:00",
                    "valueWh": 250.0,
                }
            ],
        )

    async def test_soc_and_both_bounds_cost_one_numeric_read(self):
        service = _make_service()

        with _counting_queries(), _keeping_raw_states(), patch.object(
            service_mod,
            "load_house_forecast_points_for_day",
            AsyncMock(return_value=[]),
        ), patch.object(
            service,
            "_load_recorded_price_rails",
            AsyncMock(return_value=([], [])),
        ):
            await service.async_get_inspector_day(TARGET_DATE)

        # One read for all three numeric sensors rather than one apiece: they
        # share a day, a grid and a sampling rule, and the recorder answers from
        # a single DB thread.
        numeric_reads = [
            read
            for read in QUERIES["all"]
            if {SOC_SENSOR, MIN_SOC_SENSOR, MAX_SOC_SENSOR} & set(read)
        ]
        self.assertEqual(len(numeric_reads), 1)
        self.assertEqual(
            sorted(numeric_reads[0]),
            sorted([SOC_SENSOR, MIN_SOC_SENSOR, MAX_SOC_SENSOR]),
        )


class TestStatisticsDayIssuesOneStatisticsQuery(unittest.IsolatedAsyncioTestCase):
    """A day past the purge horizon draws every series from one hourly read.

    The solar forecast joined that read in #188 by being added to its id list,
    not by a read of its own -- so a statistics day must still cost exactly one
    ``period="hour"`` round-trip, with the forecast entity inside it.
    """

    async def test_the_solar_forecast_adds_no_statistics_round_trip(self):
        service = _make_service()

        async def _executor(func, *args):
            return func(*args)

        hourly_id_lists: list[list[str]] = []

        def _statistics_during_period(
            hass, start, end, statistic_ids, period, *args, **kwargs
        ):
            if period == "hour":
                hourly_id_lists.append(sorted(statistic_ids or []))
            return {}

        purging_recorder = SimpleNamespace(
            async_add_executor_job=_executor, keep_days=1, auto_purge=True
        )

        soc_reads: list[list[str]] = []

        def _count_soc_reads(hass, start, end, entity_ids=None, *args, **kwargs):
            soc_reads.append(list(entity_ids or []))
            return {}

        with patch.object(
            sys.modules["homeassistant.components.recorder.history"],
            "get_significant_states",
            _count_soc_reads,
        ), patch.multiple(
            span_mod,
            statistics_during_period=_statistics_during_period,
            get_instance=lambda hass: purging_recorder,
        ), patch(
            "homeassistant.components.recorder.get_instance",
            lambda hass: purging_recorder,
        ), patch.object(
            service_mod,
            "load_house_forecast_points_for_day",
            AsyncMock(return_value=[]),
        ), patch.object(
            service,
            "_load_recorded_price_rails",
            AsyncMock(return_value=([], [])),
        ):
            # today - 1 with one day kept: the day the purge cuts through, so
            # it reads statistics along with everything older.
            await service.async_get_inspector_day("2026-05-10")

        self.assertEqual(len(hourly_id_lists), 1)
        self.assertIn("sensor.helman_solar_forecast_current", hourly_id_lists[0])
        # The SoC sensor is in that hourly read, so a raw-state read for it here
        # would be the duplicate the statistics path exists to avoid. The bounds
        # are not in it and are still read raw -- once, together.
        self.assertEqual(soc_reads, [[MIN_SOC_SENSOR, MAX_SOC_SENSOR]])


class TestPriceRailsCostOneReadPerTier(unittest.IsolatedAsyncioTestCase):
    """The two rails resolve in bounded reads, and never one per slot.

    A day has 96 slots per rail. The tiers are batched per tier -- one coverage
    probe per price entity, one raw read for both of them together, and a
    statistics read only for slots the raw tier left empty -- so the counts here
    are the ones the design intends rather than a ceiling that would forbid the
    hourly fill.
    """

    async def _counted_day(self, *, raw_from: datetime | None, dates=(TARGET_DATE,)):
        """Inspector days with the price rails live, counting their reads.

        More than one date runs them against a single service -- and so a single
        ``hass.data`` -- which is what makes the coverage probe's cache visible
        in the counts.
        """
        service = _make_service()
        probes: list[str] = []
        raw_reads: list[list[str]] = []
        statistics_reads: list[list[str]] = []

        def _probe(hass, start, end, entity_id, *args, **kwargs):
            probes.append(entity_id)
            if raw_from is None:
                return {}
            return {entity_id: [SimpleNamespace(last_updated=raw_from, state="2.0")]}

        def _raw(hass, start, end, entity_ids=None, *args, **kwargs):
            raw_reads.append(list(entity_ids or []))
            return {}

        def _statistics(hass, start, end, statistic_ids, period, *args, **kwargs):
            if period == "hour":
                statistics_reads.append(sorted(statistic_ids or []))
            return {}

        with _keeping_raw_states(), patch.multiple(
            sys.modules["homeassistant.components.recorder.history"],
            state_changes_during_period=_probe,
            get_significant_states=_raw,
        ), patch.multiple(
            recorder_series_mod,
            state_changes_during_period=_probe,
            get_significant_states=_raw,
        ), patch.object(
            span_mod, "statistics_during_period", _statistics
        ), patch.object(
            service_mod,
            "load_house_forecast_points_for_day",
            AsyncMock(return_value=[]),
        ):
            for target_date in dates:
                await service.async_get_inspector_day(target_date)
        return probes, raw_reads, statistics_reads

    async def test_rails_with_raw_history_cost_two_probes_and_one_batched_read(self):
        probes, raw_reads, statistics_reads = await self._counted_day(
            raw_from=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE)
        )

        price_entities = [IMPORT_PRICE_ENTITY, EXPORT_PRICE_ENTITY]
        # One coverage probe per price entity, not one per slot.
        self.assertEqual(
            [entity_id for entity_id in probes if entity_id in price_entities],
            price_entities,
        )
        price_raw_reads = [
            read for read in raw_reads if set(read) & set(price_entities)
        ]
        self.assertEqual(price_raw_reads, [price_entities])
        # The stubbed raw read comes back empty, so the tier below it answers --
        # once, for both entities together.
        self.assertEqual(statistics_reads, [sorted(price_entities)])

    async def test_rails_with_no_raw_history_skip_the_raw_read_entirely(self):
        probes, raw_reads, statistics_reads = await self._counted_day(raw_from=None)

        price_entities = [IMPORT_PRICE_ENTITY, EXPORT_PRICE_ENTITY]
        self.assertEqual(
            [entity_id for entity_id in probes if entity_id in price_entities],
            price_entities,
        )
        self.assertEqual(
            [read for read in raw_reads if set(read) & set(price_entities)], []
        )
        self.assertEqual(statistics_reads, [sorted(price_entities)])


    async def test_a_second_day_open_reuses_the_cached_coverage_probe(self):
        """Where an entity's raw states begin is asked once, not once per open.

        The probe is one indexed row, but the recorder answers from a single DB
        thread, so re-issuing it on every day open is a serial round trip in
        front of the reads the day actually came for. Two opens, two probes --
        one per entity -- is what the cache in ``query_oldest_state_date`` buys,
        and counting it here is what keeps it bought.
        """
        probes, _, _ = await self._counted_day(
            raw_from=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE),
            dates=(TARGET_DATE, "2026-05-09"),
        )

        price_entities = [IMPORT_PRICE_ENTITY, EXPORT_PRICE_ENTITY]
        self.assertEqual(
            [entity_id for entity_id in probes if entity_id in price_entities],
            price_entities,
        )


class TestBatchedMeterRead(unittest.IsolatedAsyncioTestCase):
    """The helper itself, apart from the inspector."""

    async def test_one_query_serves_every_entity_and_de_duplicates(self):
        hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
        local_start = datetime.combine(
            date.fromisoformat(TARGET_DATE), datetime.min.time(), tzinfo=PRAGUE
        )

        with _counting_queries():
            batch = (
                await recorder_series_mod.query_cumulative_slot_energy_changes_for_entities(
                    hass,
                    ["sensor.a", "sensor.b", "sensor.a"],
                    local_start=local_start,
                    local_end=local_start.replace(hour=1),
                    interval_minutes=15,
                )
            )

        self.assertEqual(QUERIES["batched"], [["sensor.a", "sensor.b"]])
        # Nothing recorded for either, so each maps to an empty series rather
        # than going missing — the singular function's behaviour.
        self.assertEqual(batch.by_entity, {"sensor.a": {}, "sensor.b": {}})
        # And nothing reached the recorder, so the read saw no liveness either.
        self.assertEqual(batch.liveness_instants, [])

    async def test_an_empty_entity_list_costs_no_query(self):
        hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
        local_start = datetime.combine(
            date.fromisoformat(TARGET_DATE), datetime.min.time(), tzinfo=PRAGUE
        )

        with _counting_queries():
            batch = (
                await recorder_series_mod.query_cumulative_slot_energy_changes_for_entities(
                    hass,
                    [],
                    local_start=local_start,
                    local_end=local_start.replace(hour=1),
                    interval_minutes=15,
                )
            )
            self.assertEqual(batch.by_entity, {})
            self.assertEqual(batch.liveness_instants, [])
        self.assertEqual(QUERIES["batched"], [])


class TestHistoryDepthProbeIssuesNoMoreQueriesThanBefore(unittest.IsolatedAsyncioTestCase):
    """The entity inspector's dual-depth probe costs what the single-depth one did.

    ``query_history_depths`` replaced a single-number probe that fell back
    from statistics to raw states (the since-deleted ``query_history_days``,
    issue #172): a caller that wants both tables' depth now always asks both,
    rather than asking the second only when the first came up empty. That
    predecessor's worst case was already two reads -- no statistics, then a
    raw-states probe -- so this costs nothing more than that worst case; this
    is the guard that pins it.
    """

    async def test_the_dual_depth_probe_issues_exactly_one_statistics_and_one_state_query(
        self,
    ) -> None:
        span_mod = importlib.import_module(
            "custom_components.helman.recorder_statistics_span"
        )

        statistics_calls: list[str] = []
        state_calls: list[str] = []

        def _statistics_during_period(hass, start, end, statistic_ids, period, *args, **kwargs):
            statistics_calls.append(sorted(statistic_ids))
            return {}

        def _state_changes_during_period(hass, start, end, entity_id, *args, **kwargs):
            state_calls.append(entity_id)
            return {}

        with patch.object(
            span_mod, "statistics_during_period", _statistics_during_period
        ), patch(
            "homeassistant.components.recorder.history.state_changes_during_period",
            _state_changes_during_period,
        ):
            await span_mod.query_history_depths(
                SimpleNamespace(data={}),
                "sensor.forecast_only",
                today_local=date(2026, 5, 11),
                local_tz=ZoneInfo("Europe/Prague"),
            )

        self.assertEqual(len(statistics_calls), 1)
        self.assertEqual(len(state_calls), 1)


if __name__ == "__main__":
    unittest.main()
