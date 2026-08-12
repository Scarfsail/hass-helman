from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]

NOW = "2026-05-11T10:07:00+02:00"
TODAY = "2026-05-11"
PAST_DAY = "2026-05-10"


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

    recorder_mod = types.ModuleType("homeassistant.components.recorder")
    recorder_mod.get_instance = lambda hass: None
    sys.modules["homeassistant.components.recorder"] = recorder_mod

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}

    async def _fake_get_significant_states(*args, **kwargs):
        return {}

    history_mod.get_significant_states = _fake_get_significant_states
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    helpers_mod = types.ModuleType("homeassistant.helpers")
    helpers_mod.__path__ = []
    sys.modules["homeassistant.helpers"] = helpers_mod

    # The tests patch in their own Store; this only has to satisfy the import.
    storage_mod = types.ModuleType("homeassistant.helpers.storage")
    storage_mod.Store = type("Store", (), {})
    sys.modules["homeassistant.helpers.storage"] = storage_mod
    helpers_mod.storage = storage_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.now = lambda: datetime.fromisoformat(NOW)
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    # Force a fresh service import, matching test_inspector_house_battery_payload.
    # Nothing more than this: popping modules other suites hold references to
    # (recorder_hourly_series in particular) makes them re-import under these stubs.
    for name in (
        "custom_components.helman.solar_bias_correction.service",
        "custom_components.helman.solar_bias_correction.house_forecast_history",
    ):
        sys.modules.pop(name, None)


_install_import_stubs()

import importlib  # noqa: E402

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module("custom_components.helman.solar_bias_correction.models")
history_mod = importlib.import_module("custom_components.helman.battery_forecast_history")

from zoneinfo import ZoneInfo  # noqa: E402

PRAGUE = ZoneInfo("Europe/Prague")


class _FakeStore:
    """Stand-in for homeassistant Store that keeps the delayed save in memory."""

    def __init__(self, hass, version, key):
        self.saved: dict | None = None

    async def async_load(self):
        return self.saved

    def async_delay_save(self, data_func, delay):
        self.saved = data_func()


# Now is 10:07, so the slot in progress is 10:00 and the next one starts at 10:15.
# Pinned rather than computed: the real helpers import the recorder integration
# through the package __init__, which other test modules stub out differently.
CURRENT_SLOT = datetime.fromisoformat(f"{TODAY}T10:00:00+02:00")
NEXT_SLOT = datetime.fromisoformat(f"{TODAY}T10:15:00+02:00")


def _pinned_slot_helpers():
    return (
        patch.object(service_mod, "_current_slot_start", lambda _now: CURRENT_SLOT),
        patch.object(service_mod, "_next_slot_boundary", lambda _now: NEXT_SLOT),
    )


def _snapshot(*entries: dict) -> dict:
    return {"status": "available", "series": list(entries)}


def _entry(
    timestamp: str,
    *,
    soc: float,
    imported: float = 0.0,
    exported: float = 0.0,
    charged: float | None = None,
    discharged: float | None = None,
) -> dict:
    entry = {
        "timestamp": timestamp,
        "socPct": soc,
        "importedFromGridKwh": imported,
        "exportedToGridKwh": exported,
    }
    # Left out entirely when unset, so a slot can stand in for a snapshot that
    # carries no battery charge/discharge fields at all.
    if charged is not None:
        entry["chargedKwh"] = charged
    if discharged is not None:
        entry["dischargedKwh"] = discharged
    return entry


class TestBatteryForecastHistoryStore(unittest.IsolatedAsyncioTestCase):
    def _store(self):
        hass = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))
        with patch.object(history_mod.storage, "Store", _FakeStore):
            return history_mod.BatteryForecastHistoryStore(hass)

    def test_records_todays_slots_with_net_grid_sign(self):
        store = self._store()
        store.record_snapshot(
            _snapshot(
                _entry(f"{TODAY}T10:00:00+02:00", soc=50.0, imported=0.4),
                _entry(f"{TODAY}T10:15:00+02:00", soc=55.0, exported=0.2),
            ),
            local_now=datetime.fromisoformat(NOW),
            timezone=PRAGUE,
        )
        slots = store.slots_for_day(date.fromisoformat(TODAY))
        self.assertEqual(slots["10:00"]["socPct"], 50.0)
        # Import is negative, export positive, matching gridNetKwh elsewhere.
        self.assertEqual(slots["10:00"]["gridNetWh"], -400.0)
        self.assertEqual(slots["10:15"]["gridNetWh"], 200.0)

    def test_records_net_battery_positive_when_charging(self):
        store = self._store()
        store.record_snapshot(
            _snapshot(
                _entry(f"{TODAY}T10:00:00+02:00", soc=50.0, charged=0.6),
                _entry(f"{TODAY}T10:15:00+02:00", soc=45.0, discharged=0.25),
            ),
            local_now=datetime.fromisoformat(NOW),
            timezone=PRAGUE,
        )
        slots = store.slots_for_day(date.fromisoformat(TODAY))
        self.assertEqual(slots["10:00"]["batteryNetWh"], 600.0)
        self.assertEqual(slots["10:15"]["batteryNetWh"], -250.0)

    def test_slot_without_battery_fields_omits_battery_net(self):
        store = self._store()
        store.record_snapshot(
            _snapshot(_entry(f"{TODAY}T10:00:00+02:00", soc=50.0, imported=0.4)),
            local_now=datetime.fromisoformat(NOW),
            timezone=PRAGUE,
        )
        slots = store.slots_for_day(date.fromisoformat(TODAY))
        self.assertNotIn("batteryNetWh", slots["10:00"])

    def test_later_build_overwrites_only_the_slots_it_still_covers(self):
        store = self._store()
        store.record_snapshot(
            _snapshot(
                _entry(f"{TODAY}T10:00:00+02:00", soc=50.0),
                _entry(f"{TODAY}T10:15:00+02:00", soc=55.0),
            ),
            local_now=datetime.fromisoformat(NOW),
            timezone=PRAGUE,
        )
        # A build one slot later no longer spans 10:00, so that slot must survive
        # with the value forecast for it while it was still ahead of the clock.
        store.record_snapshot(
            _snapshot(_entry(f"{TODAY}T10:15:00+02:00", soc=61.0)),
            local_now=datetime.fromisoformat(f"{TODAY}T10:20:00+02:00"),
            timezone=PRAGUE,
        )
        slots = store.slots_for_day(date.fromisoformat(TODAY))
        self.assertEqual(slots["10:00"]["socPct"], 50.0)
        self.assertEqual(slots["10:15"]["socPct"], 61.0)

    def test_ignores_the_build_time_partial_entry(self):
        # The snapshot's first entry is stamped at build time and only covers the
        # remainder of the slot in progress; archiving it would leave one stray
        # key per rebuild.
        store = self._store()
        store.record_snapshot(
            _snapshot(
                _entry(f"{TODAY}T10:07:00+02:00", soc=49.0),
                _entry(f"{TODAY}T10:15:00+02:00", soc=55.0),
            ),
            local_now=datetime.fromisoformat(NOW),
            timezone=PRAGUE,
        )
        self.assertEqual(list(store.slots_for_day(date.fromisoformat(TODAY))), ["10:15"])

    def test_drops_unaligned_keys_left_by_an_earlier_version(self):
        store = self._store()
        store._days[TODAY] = {
            "09:45": {"socPct": 45.0},
            "10:07": {"socPct": 49.0},
        }
        store.record_snapshot(
            _snapshot(_entry(f"{TODAY}T10:15:00+02:00", soc=55.0)),
            local_now=datetime.fromisoformat(NOW),
            timezone=PRAGUE,
        )
        self.assertEqual(
            sorted(store.slots_for_day(date.fromisoformat(TODAY))), ["09:45", "10:15"]
        )

    def test_entries_for_other_days_are_ignored(self):
        store = self._store()
        store.record_snapshot(
            _snapshot(
                _entry(f"{TODAY}T10:00:00+02:00", soc=50.0),
                _entry("2026-05-12T09:00:00+02:00", soc=70.0),
            ),
            local_now=datetime.fromisoformat(NOW),
            timezone=PRAGUE,
        )
        self.assertEqual(list(store.slots_for_day(date.fromisoformat(TODAY))), ["10:00"])
        self.assertEqual(store.slots_for_day(date.fromisoformat("2026-05-12")), {})

    def test_prunes_days_past_the_retention_window(self):
        store = self._store()
        store._days["2026-01-01"] = {"00:00": {"socPct": 1.0}}
        store.record_snapshot(
            _snapshot(_entry(f"{TODAY}T10:00:00+02:00", soc=50.0)),
            local_now=datetime.fromisoformat(NOW),
            timezone=PRAGUE,
        )
        self.assertNotIn("2026-01-01", store._days)
        self.assertIn(TODAY, store._days)

    async def test_survives_a_reload(self):
        store = self._store()
        store.record_snapshot(
            _snapshot(_entry(f"{TODAY}T10:00:00+02:00", soc=50.0)),
            local_now=datetime.fromisoformat(NOW),
            timezone=PRAGUE,
        )
        reloaded = self._store()
        reloaded._store.saved = store._store.saved
        await reloaded.async_load()
        self.assertEqual(
            reloaded.slots_for_day(date.fromisoformat(TODAY))["10:00"]["socPct"], 50.0
        )


class _FakeHistory:
    def __init__(self, days: dict[str, dict]):
        self._days = days

    def slots_for_day(self, target_date: date) -> dict:
        return self._days.get(target_date.isoformat(), {})


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


class _InspectorHarness(unittest.IsolatedAsyncioTestCase):
    """A bias service wired to a fake history and a fixed battery snapshot, plus
    the inspector call with the clock and the recorder reads pinned."""

    def _service(self, history, snapshot):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )

        async def _battery_forecast_provider():
            return snapshot

        service = service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
            battery_forecast_provider=_battery_forecast_provider,
            battery_forecast_history=history,
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

    async def _inspect(
        self,
        service,
        target_date,
        *,
        house_forecast_points=None,
        actuals_by_slot=None,
        house_actual=None,
        battery_soc_actual=None,
        grid_actual=None,
        battery_actual=None,
    ):
        current_slot, next_slot = _pinned_slot_helpers()
        old_now = service_mod.dt_util.now
        old_actuals = service_mod.load_actuals_for_day
        try:
            service_mod.dt_util.now = lambda: datetime.fromisoformat(NOW)
            service_mod.load_actuals_for_day = AsyncMock(
                return_value=actuals_by_slot or {}
            )
            with current_slot, next_slot, patch.object(
                service_mod,
                "load_house_forecast_points_for_day",
                AsyncMock(return_value=house_forecast_points or []),
            ), patch.object(
                service,
                "_load_house_actual_for_date",
                AsyncMock(return_value=house_actual or []),
            ), patch.object(
                service,
                "_load_battery_soc_actual_for_date",
                AsyncMock(return_value=battery_soc_actual or []),
            ), patch.object(
                service,
                "_load_grid_actual_for_date",
                AsyncMock(return_value=grid_actual or []),
            ), patch.object(
                service,
                "_load_battery_actual_for_date",
                AsyncMock(return_value=battery_actual or []),
            ):
                return await service.async_get_inspector_day(target_date)
        finally:
            service_mod.dt_util.now = old_now
            service_mod.load_actuals_for_day = old_actuals

    async def test_past_day_serves_the_whole_archived_day(self):
        history = _FakeHistory(
            {
                PAST_DAY: {
                    "00:00": {"socPct": 40.0, "gridNetWh": -100.0},
                    "23:45": {"socPct": 80.0, "gridNetWh": 250.0},
                }
            }
        )
        payload = await self._inspect(self._service(history, _snapshot()), PAST_DAY)

        soc = payload["series"]["batterySocForecast"]
        grid = payload["series"]["gridForecast"]
        self.assertEqual([p["slot"] for p in soc], ["00:00", "23:45"])
        self.assertEqual([p["valueWh"] for p in grid], [-100.0, 250.0])
        self.assertTrue(payload["availability"]["hasBatterySocForecast"])
        self.assertTrue(payload["availability"]["hasGridForecast"])

    async def test_today_joins_the_archive_to_the_live_snapshot_without_overlap(self):
        # Now is 10:07, so the current slot is 10:00 and the snapshot starts at 10:15.
        history = _FakeHistory(
            {
                TODAY: {
                    "09:45": {"socPct": 45.0, "gridNetWh": -50.0},
                    "10:00": {"socPct": 48.0, "gridNetWh": -25.0},
                    # A stale future slot left by an earlier build must not win
                    # over the live snapshot.
                    "10:15": {"socPct": 1.0, "gridNetWh": 1.0},
                }
            }
        )
        snapshot = _snapshot(
            _entry(f"{TODAY}T10:15:00+02:00", soc=52.0, exported=0.1),
            _entry(f"{TODAY}T18:00:00+02:00", soc=90.0, exported=0.3),
        )
        payload = await self._inspect(self._service(history, snapshot), TODAY)

        soc = payload["series"]["batterySocForecast"]
        self.assertEqual([p["slot"] for p in soc], ["09:45", "10:00", "10:15", "18:00"])
        # The live snapshot owns 10:15, not the stale archived value.
        self.assertEqual(soc[2]["pct"], 52.0)

        grid = payload["series"]["gridForecast"]
        self.assertEqual([p["valueWh"] for p in grid], [-50.0, -25.0, 100.0, 300.0])

    async def test_without_an_archive_today_still_starts_at_the_live_snapshot(self):
        snapshot = _snapshot(_entry(f"{TODAY}T10:15:00+02:00", soc=52.0))
        payload = await self._inspect(self._service(_FakeHistory({}), snapshot), TODAY)

        soc = payload["series"]["batterySocForecast"]
        self.assertEqual([p["slot"] for p in soc], ["10:15"])

    async def test_today_house_forecast_joins_recorder_to_the_live_slot_and_snapshot(self):
        """Three sources, one series, no slot served by two of them.

        The recorder covers the slots that have elapsed; the slot in progress is
        summed from the live composition, so its total and the parts drawn under
        it are one vintage; the snapshot covers the slots after it. Past its own
        boundary the recorder is useless anyway: it holds its last value flat all
        the way to midnight.
        """
        service = self._service(_FakeHistory({}), _snapshot())
        recorder_points = [
            {"timestamp": f"{TODAY}T09:45:00+02:00", "wh": 100.0},
            # The archive's stale sample of the slot in progress, taken before the
            # schedule the composition describes: the composition supersedes it.
            {"timestamp": f"{TODAY}T10:00:00+02:00", "wh": 999.0},
            {"timestamp": f"{TODAY}T10:15:00+02:00", "wh": 999.0},
            {"timestamp": f"{TODAY}T10:30:00+02:00", "wh": 999.0},
        ]
        service._house_forecast_snapshot_provider = lambda: {
            "status": "available",
            "series": [
                {"timestamp": f"{TODAY}T10:15:00+02:00", "nonDeferrable": {"value": 0.4}},
                {"timestamp": f"{TODAY}T10:30:00+02:00", "nonDeferrable": {"value": 0.5}},
            ],
        }
        service._house_scheduled_consumers_provider = lambda: SCHEDULED_CONSUMERS
        service._house_forecast_composition_provider = lambda: {
            "original_house_forecast": {
                "status": "available",
                "currentSlot": {
                    "timestamp": f"{TODAY}T10:00:00+02:00",
                    "nonDeferrable": {"value": 0.25},
                },
                "series": [],
            },
            # Half the slot has run, so the planner has 0.05 kWh of pool left to
            # place in it out of the 0.15 kWh the whole slot was scheduled for.
            "demand_points": (
                _demand("pool", f"{TODAY}T10:00:00+02:00", 0.05, 0.15),
            ),
        }
        payload = await self._inspect(
            service, TODAY, house_forecast_points=recorder_points
        )

        house = payload["series"]["houseForecast"]
        slots = [p["timestamp"][11:16] for p in house]
        # No hole at 10:00: every slot from 09:45 to 10:30 is present exactly once.
        self.assertEqual(slots, ["09:45", "10:00", "10:15", "10:30"])
        # 09:45 from the recorder; 10:00 summed from its own composition, base plus
        # the *whole* slot's scheduled demand; 10:15 and 10:30 from the snapshot
        # (kWh → Wh), never the recorder's held-flat 999.
        self.assertEqual([p["valueWh"] for p in house], [100.0, 400.0, 400.0, 500.0])

    async def test_no_actual_series_reaches_into_the_slot_in_progress(self):
        """A part-slot measurement is not comparable to a whole-slot forecast.

        The 10:00 slot is still running at 10:07, so every actual series stops at
        09:45 — the rule the wider buckets already applied, applied at the native
        width too. The day's totals are an accumulation rather than a comparison,
        so they keep counting what the meters have recorded in it.
        """
        service = self._service(_FakeHistory({}), _snapshot())

        def _wh(wh_by_slot):
            return [
                {"timestamp": f"{TODAY}T{slot}:00+02:00", "wh": wh}
                for slot, wh in wh_by_slot.items()
            ]

        payload = await self._inspect(
            service,
            TODAY,
            actuals_by_slot={"09:45": 100.0, "10:00": 40.0},
            house_actual=_wh({"09:45": 200.0, "10:00": 80.0}),
            grid_actual=_wh({"09:45": -300.0, "10:00": -90.0}),
            battery_actual=_wh({"09:45": 400.0, "10:00": 110.0}),
            battery_soc_actual=[
                {"slot": "09:45", "pct": 55.0},
                {"slot": "10:00", "pct": 57.0},
            ],
        )

        series = payload["series"]
        for key in ("actual", "houseActual", "gridActual", "batteryActual"):
            self.assertEqual(
                [p["timestamp"][11:16] for p in series[key]], ["09:45"], key
            )
        self.assertEqual([p["slot"] for p in series["batterySocActual"]], ["09:45"])

        totals = payload["totals"]
        self.assertEqual(totals["actualWh"], 140.0)
        self.assertEqual(totals["houseActualWh"], 280.0)
        self.assertEqual(totals["gridActualWh"], -390.0)
        self.assertEqual(totals["batteryActualWh"], 510.0)

    async def test_house_forecast_ignores_the_deferrable_consumers_band(self):
        """nonDeferrable already carries the scheduled appliance demand.

        The snapshot is the adjusted house forecast the battery simulation ran
        against. Adding its deferrableConsumers band on top would count those
        appliances twice and push the demand stack above production.
        """
        service = self._service(_FakeHistory({}), _snapshot())
        service._house_forecast_snapshot_provider = lambda: {
            "status": "available",
            "series": [
                {
                    "timestamp": f"{TODAY}T10:15:00+02:00",
                    "nonDeferrable": {"value": 0.4},
                    "deferrableConsumers": [
                        {"entityId": "sensor.boiler", "value": 0.75},
                    ],
                },
            ],
        }
        payload = await self._inspect(service, TODAY, house_forecast_points=[])

        house = payload["series"]["houseForecast"]
        self.assertEqual([p["valueWh"] for p in house], [400.0])


def _demand(
    appliance_id: str,
    slot_id: str,
    energy_kwh: float,
    scheduled_energy_kwh: float | None = None,
):
    """One ApplianceDemandPoint, as the projection plan carries them.

    The two figures differ only in the slot containing now, where ``energy_kwh``
    is the part of the slot still to come and ``scheduled_energy_kwh`` the whole
    of it; everywhere else they are the same number.
    """
    return SimpleNamespace(
        appliance_id=appliance_id,
        slot_id=slot_id,
        energy_kwh=energy_kwh,
        scheduled_energy_kwh=(
            energy_kwh if scheduled_energy_kwh is None else scheduled_energy_kwh
        ),
    )


# The house before any appliance was scheduled into it, and what the planner then
# added: 0.3 kWh of pool and 0.1 kWh of EV at 10:15, nothing at 10:30. The adjusted
# forecast below is their sum, exactly as build_adjusted_house_forecast makes it.
ORIGINAL_HOUSE_FORECAST = {
    "status": "available",
    "series": [
        {"timestamp": f"{TODAY}T10:15:00+02:00", "nonDeferrable": {"value": 0.4}},
        {"timestamp": f"{TODAY}T10:30:00+02:00", "nonDeferrable": {"value": 0.5}},
    ],
}
ADJUSTED_HOUSE_FORECAST = {
    "status": "available",
    "series": [
        {"timestamp": f"{TODAY}T10:15:00+02:00", "nonDeferrable": {"value": 0.8}},
        {"timestamp": f"{TODAY}T10:30:00+02:00", "nonDeferrable": {"value": 0.5}},
    ],
}
DEMAND_POINTS = (
    _demand("pool", f"{TODAY}T10:15:00+02:00", 0.3),
    _demand("ev", f"{TODAY}T10:15:00+02:00", 0.1),
)
# Every schedulable controllable, keyed by the id the demand points use. The EV
# has no meter and is still scheduled; the boiler is metered but opted out of
# deferrability, so it must not be reported as shiftable on either side of now.
SCHEDULED_CONSUMERS = [
    {
        "id": "pool",
        "label": "Pool pump",
        "energy_entity_id": "sensor.pool_energy",
        "deferrable": True,
    },
    {"id": "ev", "label": "EV charger", "energy_entity_id": None, "deferrable": True},
    {
        "id": "boiler",
        "label": "Boiler",
        "energy_entity_id": "sensor.boiler_energy",
        "deferrable": False,
    },
]


# The same day with a composition for the slot in progress: 0.25 kWh of base and
# a pool pump scheduled across the whole of it, of which only part is still to
# come. `remaining_kwh` is what the clock has left of that 0.15 kWh.
def _composition_with_current_slot(remaining_kwh: float) -> dict:
    return {
        "original_house_forecast": {
            "status": "available",
            "currentSlot": {
                "timestamp": f"{TODAY}T10:00:00+02:00",
                "nonDeferrable": {"value": 0.25},
            },
            "series": ORIGINAL_HOUSE_FORECAST["series"],
        },
        "demand_points": (
            _demand("pool", f"{TODAY}T10:00:00+02:00", remaining_kwh, 0.15),
            *DEMAND_POINTS,
        ),
    }


class TestInspectorForecastComposition(_InspectorHarness):
    """The forecast half of the house breakdown: base load plus each scheduled appliance.

    Reuses the archived-forecast harness above for the service and the pinned
    slot helpers; only the two composition providers are new.
    """

    def _service(self, history=None, snapshot=None, *, composition=..., consumers=None):
        service = super()._service(history or _FakeHistory({}), snapshot or _snapshot())
        service._house_forecast_snapshot_provider = lambda: ADJUSTED_HOUSE_FORECAST
        service._house_scheduled_consumers_provider = lambda: (
            SCHEDULED_CONSUMERS if consumers is None else consumers
        )
        if composition is ...:
            composition = {
                "original_house_forecast": ORIGINAL_HOUSE_FORECAST,
                "demand_points": DEMAND_POINTS,
            }
        service._house_forecast_composition_provider = lambda: composition
        return service

    async def test_a_future_slot_is_itemised_per_scheduled_appliance(self):
        payload = await self._inspect(self._service(), TODAY)

        breakdown = payload["series"]["houseForecastBreakdown"]
        self.assertEqual([p["slot"] for p in breakdown], ["10:15", "10:30"])
        # The scheduled appliance is named by the consumer sharing its
        # controllable id, so it is the same row the measured breakdown draws.
        self.assertEqual(
            [(a["entityId"], a["label"], a["wh"], a["deferrable"])
             for a in breakdown[0]["appliances"]],
            [
                ("sensor.pool_energy", "Pool pump", 300.0, True),
                # No meter configured for the EV, so it is named after the
                # controllable and carries no entity id: there is no sensor for
                # the card to open, and its bare id is not one.
                (None, "EV charger", 100.0, True),
            ],
        )
        # The base is the house before the appliances were added, and the slot
        # with nothing scheduled is all base.
        self.assertEqual([p["unmeasuredWh"] for p in breakdown], [400.0, 500.0])
        self.assertEqual(breakdown[1]["appliances"], [])
        self.assertTrue(payload["availability"]["hasHouseForecastBreakdown"])

    def test_the_slot_in_progress_is_itemised_from_the_currentSlot_entry(self):
        """The one slot the planner schedules into that is not in the series.

        `currentSlot` rides alongside the series and takes scheduled demand like
        any other entry, so reading only the series left the slot the user is
        most likely looking at as the only one with no composition at all.
        """
        original = {
            "status": "available",
            "currentSlot": {
                "timestamp": f"{TODAY}T10:00:00+02:00",
                "nonDeferrable": {"value": 0.6},
            },
            "series": ORIGINAL_HOUSE_FORECAST["series"],
        }
        points = service_mod._build_house_forecast_breakdown(
            {
                "original_house_forecast": original,
                "demand_points": (
                    _demand("pool", f"{TODAY}T10:00:00+02:00", 0.2),
                    *DEMAND_POINTS,
                ),
            },
            SCHEDULED_CONSUMERS,
            date.fromisoformat(TODAY),
            next_slot=NEXT_SLOT,
        )

        self.assertEqual([p.slot for p in points], ["10:00", "10:15", "10:30"])
        self.assertEqual(points[0].unmeasured_wh, 600.0)
        self.assertEqual(
            [(a.label, a.value_wh) for a in points[0].appliances], [("Pool pump", 200.0)]
        )

    async def test_an_appliance_that_opted_out_is_not_reported_deferrable(self):
        """``consumption.deferrable: false`` holds on both sides of now.

        The planner still schedules such a device, so it still has demand to
        itemise — but reporting it shiftable here while the measured breakdown
        picks it up from the device tree as non-deferrable would make one
        appliance mean two different things either side of the clock.
        """
        composition = {
            "original_house_forecast": ORIGINAL_HOUSE_FORECAST,
            "demand_points": (_demand("boiler", f"{TODAY}T10:15:00+02:00", 0.2),),
        }
        payload = await self._inspect(self._service(composition=composition), TODAY)

        appliances = payload["series"]["houseForecastBreakdown"][0]["appliances"]
        self.assertEqual(
            [(a["label"], a["deferrable"]) for a in appliances], [("Boiler", False)]
        )

    async def test_an_unknown_controllable_is_named_but_never_given_an_entity(self):
        """A demand point for something the roster does not know at all.

        Its id is the only name there is, so it labels the row — but it is not an
        entity id, and passing it off as one would offer the card a more-info
        dialog for an entity that does not exist.
        """
        composition = {
            "original_house_forecast": ORIGINAL_HOUSE_FORECAST,
            "demand_points": (_demand("ghost", f"{TODAY}T10:15:00+02:00", 0.2),),
        }
        payload = await self._inspect(self._service(composition=composition), TODAY)

        appliances = payload["series"]["houseForecastBreakdown"][0]["appliances"]
        self.assertEqual(
            [(a["entityId"], a["label"], a["deferrable"]) for a in appliances],
            [(None, "ghost", False)],
        )

    def test_a_forecast_row_adopts_its_measured_twins_sensors(self):
        """The same appliance opens the same sensor either side of now.

        Switch and power sensors are known only to the device tree, which the
        measured half has already read on any day that has one; the forecast row
        takes them from that roster rather than reading it a second time. Built
        directly, since the enrichment is a property of the builder and not of
        the recorder plumbing that supplies it.
        """
        points = service_mod._build_house_forecast_breakdown(
            {
                "original_house_forecast": ORIGINAL_HOUSE_FORECAST,
                "demand_points": DEMAND_POINTS,
            },
            SCHEDULED_CONSUMERS,
            date.fromisoformat(TODAY),
            next_slot=None,
            metered_by_entity=[
                {
                    "energy_entity_id": "sensor.pool_energy",
                    "switch_entity_id": "switch.pool",
                    "power_entity_id": "sensor.pool_power",
                }
            ],
        )

        pool, ev = points[0].appliances
        self.assertEqual(
            (pool.switch_entity_id, pool.power_entity_id),
            ("switch.pool", "sensor.pool_power"),
        )
        # The meterless one has no tree entry to adopt anything from.
        self.assertEqual((ev.switch_entity_id, ev.power_entity_id), (None, None))

    async def test_the_parts_sum_to_the_house_forecast_they_decompose(self):
        payload = await self._inspect(self._service(), TODAY)

        forecast_by_slot = {
            p["timestamp"][11:16]: p["valueWh"] for p in payload["series"]["houseForecast"]
        }
        for point in payload["series"]["houseForecastBreakdown"]:
            self.assertAlmostEqual(
                point["unmeasuredWh"] + sum(a["wh"] for a in point["appliances"]),
                forecast_by_slot[point["slot"]],
                places=4,
            )

    async def test_the_slot_in_progress_sums_to_its_own_composition(self):
        """One slot, one vintage: its total is the sum of the parts drawn under it.

        The archive's sample of the running slot is ignored — it predates the
        schedule the composition describes, and drawing the two together is what
        made the deferrable share melt across the slot.
        """
        payload = await self._inspect(
            self._service(composition=_composition_with_current_slot(0.05)),
            TODAY,
            house_forecast_points=[
                {"timestamp": f"{TODAY}T10:00:00+02:00", "wh": 999.0}
            ],
        )

        forecast_by_slot = {
            p["timestamp"][11:16]: p["valueWh"]
            for p in payload["series"]["houseForecast"]
        }
        breakdown = {p["slot"]: p for p in payload["series"]["houseForecastBreakdown"]}
        # 0.25 kWh of base plus the 0.15 kWh the whole slot was scheduled for.
        self.assertEqual(forecast_by_slot["10:00"], 400.0)
        self.assertEqual(
            breakdown["10:00"]["unmeasuredWh"]
            + sum(a["wh"] for a in breakdown["10:00"]["appliances"]),
            forecast_by_slot["10:00"],
        )

    async def test_a_pipeline_with_nothing_for_the_running_slot_keeps_the_archive(self):
        """A composition that does not reach the slot in progress leaves no hole.

        The live pipeline can lag the clock by a slot, or be cold outright. The
        archive is a worse source for that slot — it is what this change moved
        away from — but it is a better one than nothing at all.
        """
        payload = await self._inspect(
            self._service(),
            TODAY,
            house_forecast_points=[
                {"timestamp": f"{TODAY}T09:45:00+02:00", "wh": 100.0},
                {"timestamp": f"{TODAY}T10:00:00+02:00", "wh": 200.0},
            ],
        )

        house = {
            p["timestamp"][11:16]: p["valueWh"]
            for p in payload["series"]["houseForecast"]
        }
        self.assertEqual(house["10:00"], 200.0)
        self.assertEqual(sorted(house), ["09:45", "10:00", "10:15", "10:30"])

    async def test_the_slot_in_progress_holds_still_as_it_ages(self):
        """Later in the same slot there is less left to plan — and nothing moves.

        All the clock changes is ``energy_kwh``, the part of the slot still to
        come; both the total and the parts read the whole-slot figure, so the
        user sitting in the slot sees the same numbers throughout it.
        """
        early, late = [
            await self._inspect(
                self._service(composition=_composition_with_current_slot(remaining)),
                TODAY,
            )
            for remaining in (0.14, 0.01)
        ]

        for key in ("houseForecast", "houseForecastBreakdown"):
            self.assertEqual(early["series"][key], late["series"][key])

    async def test_elapsed_and_other_day_demand_is_left_out(self):
        """Slot ids are local ISO timestamps; only this day's future ones count.

        A slot the clock has passed is not part of the forecast series at all, and
        tomorrow's 10:15 would otherwise collide with today's on the "HH:MM" key.
        """
        composition = {
            "original_house_forecast": ORIGINAL_HOUSE_FORECAST,
            "demand_points": (
                _demand("pool", f"{TODAY}T09:00:00+02:00", 0.9),
                _demand("pool", "2026-05-12T10:15:00+02:00", 0.9),
                *DEMAND_POINTS,
            ),
        }
        payload = await self._inspect(self._service(composition=composition), TODAY)

        breakdown = payload["series"]["houseForecastBreakdown"]
        self.assertEqual([p["slot"] for p in breakdown], ["10:15", "10:30"])
        self.assertEqual([a["wh"] for a in breakdown[0]["appliances"]], [300.0, 100.0])

    async def test_a_cold_pipeline_yields_no_composition(self):
        payload = await self._inspect(self._service(composition=None), TODAY)

        self.assertEqual(payload["series"]["houseForecastBreakdown"], [])
        self.assertFalse(payload["availability"]["hasHouseForecastBreakdown"])
        # The plain forecast figure is untouched — the card just has nothing to
        # itemise.
        self.assertEqual(
            [p["valueWh"] for p in payload["series"]["houseForecast"]], [800.0, 500.0]
        )

    async def test_a_past_only_day_never_reads_the_pipeline(self):
        """Opening an old day must not touch the forecast pipeline at all.

        The provider is cache-only, but reading it from outside the need_future
        branch would still be a step towards a rebuild being triggered by a day
        the user is only looking back at.
        """
        reads: list[str] = []
        service = self._service()

        def _composition():
            reads.append("read")
            return None

        service._house_forecast_composition_provider = _composition
        payload = await self._inspect(service, PAST_DAY)

        self.assertEqual(reads, [])
        self.assertEqual(payload["series"]["houseForecastBreakdown"], [])

    async def test_the_deferrable_consumers_band_is_not_the_itemisation(self):
        """The base model's own probabilistic band is a different quantity.

        It is the forecast of what those appliances might draw, not what the
        planner scheduled; the itemisation follows the demand points even when the
        two disagree.
        """
        original = {
            "status": "available",
            "series": [
                {
                    "timestamp": f"{TODAY}T10:15:00+02:00",
                    "nonDeferrable": {"value": 0.4},
                    "deferrableConsumers": [
                        {"entityId": "sensor.pool_energy", "value": 0.75},
                    ],
                },
            ],
        }
        payload = await self._inspect(
            self._service(
                composition={
                    "original_house_forecast": original,
                    "demand_points": DEMAND_POINTS,
                }
            ),
            TODAY,
        )

        breakdown = payload["series"]["houseForecastBreakdown"]
        self.assertEqual([p["unmeasuredWh"] for p in breakdown], [400.0])
        self.assertEqual([a["wh"] for a in breakdown[0]["appliances"]], [300.0, 100.0])


if __name__ == "__main__":
    unittest.main()
