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


class TestInspectorServesArchivedForecast(unittest.IsolatedAsyncioTestCase):
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

    async def _inspect(self, service, target_date, *, house_forecast_points=None):
        current_slot, next_slot = _pinned_slot_helpers()
        old_now = service_mod.dt_util.now
        old_actuals = service_mod.load_actuals_for_day
        try:
            service_mod.dt_util.now = lambda: datetime.fromisoformat(NOW)
            service_mod.load_actuals_for_day = AsyncMock(return_value={})
            with current_slot, next_slot, patch.object(
                service_mod,
                "load_house_forecast_points_for_day",
                AsyncMock(return_value=house_forecast_points or []),
            ), patch.object(
                service, "_load_house_actual_for_date", AsyncMock(return_value=[])
            ), patch.object(
                service, "_load_battery_soc_actual_for_date", AsyncMock(return_value=[])
            ), patch.object(
                service, "_load_grid_actual_for_date", AsyncMock(return_value=[])
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

    async def test_today_house_forecast_joins_recorder_history_to_the_snapshot(self):
        """The recorder covers through the slot in progress, the snapshot after it.

        The snapshot's series starts at the *next* slot -- the one in progress
        lives in its "currentSlot" field -- so the recorder has to run right up
        to that boundary or 10:00 falls through the gap between the two sources.
        Past that boundary the recorder is useless: it holds its last value flat
        all the way to midnight.
        """
        service = self._service(_FakeHistory({}), _snapshot())
        recorder_points = [
            {"timestamp": f"{TODAY}T09:45:00+02:00", "wh": 100.0},
            {"timestamp": f"{TODAY}T10:00:00+02:00", "wh": 200.0},
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
        payload = await self._inspect(
            service, TODAY, house_forecast_points=recorder_points
        )

        house = payload["series"]["houseForecast"]
        slots = [p["timestamp"][11:16] for p in house]
        # No hole at 10:00: every slot from 09:45 to 10:30 is present exactly once.
        self.assertEqual(slots, ["09:45", "10:00", "10:15", "10:30"])
        # 09:45 and 10:00 from the recorder; 10:15 and 10:30 from the snapshot
        # (kWh → Wh), never the recorder's held-flat 999.
        self.assertEqual([p["valueWh"] for p in house], [100.0, 200.0, 400.0, 500.0])

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


if __name__ == "__main__":
    unittest.main()
