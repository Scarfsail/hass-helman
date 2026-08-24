from __future__ import annotations

import asyncio
import sys
import types
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]


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
    # A stated purge horizon, wide enough to hold the target day. Without one the
    # inspector cannot tell "this instance keeps everything" from "the recorder
    # will not say", and an elapsed day whose every meter reads empty -- which is
    # exactly what these stubs produce before a test fills one in -- is taken as
    # purged and served from hourly statistics instead of raw states.
    recorder_mod.get_instance = lambda hass: SimpleNamespace(
        keep_days=30, auto_purge=True
    )
    sys.modules["homeassistant.components.recorder"] = recorder_mod

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}

    async def _fake_get_significant_states(*args, **kwargs):
        return {}

    history_mod.get_significant_states = _fake_get_significant_states
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    # The inspector day asks the recorder where its statistics begin, which
    # imports the span module. Answering with nothing leaves the floor at the
    # trainer's window, which is what every assertion in this file was written
    # against.
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
    # "now" is after 2026-05-10, so that date is in the past
    dt_mod.now = lambda: datetime.fromisoformat("2026-05-11T10:00:00+02:00")
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    # Force a fresh service import (test_solar_bias_service_runtime.py pops the
    # service module at collection time, which can leave it cached without the
    # load_house_forecast_points_for_day attribute when tests run in full suite).
    sys.modules.pop(
        "custom_components.helman.solar_bias_correction.service", None
    )
    sys.modules.pop(
        "custom_components.helman.solar_bias_correction.house_forecast_history", None
    )


_install_import_stubs()

import importlib  # noqa: E402

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)

TARGET_DATE = "2026-05-10"

HOUSE_FC_POINTS = [
    {"timestamp": f"{TARGET_DATE}T00:00:00+02:00", "wh": 200.0}
]
HOUSE_ACTUAL_POINTS = [
    {"timestamp": f"{TARGET_DATE}T00:00:00+02:00", "wh": 180.0}
]
BATTERY_SOC_ACTUAL = [
    {"slot": "00:00", "pct": 88.0}
]
BATTERY_SNAPSHOT = {
    "status": "available",
    "series": [
        {"timestamp": f"{TARGET_DATE}T18:00:00+02:00", "socPct": 65.0},
    ],
}


async def _battery_forecast_provider():
    return BATTERY_SNAPSHOT


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


def _slot_energy_kwh_by_entity(
    consumer_slot_by_entity: dict[str, dict[str, float]] | None,
) -> dict[str, dict[datetime, float]]:
    """The batched meter read's shape, from per-consumer ``{"HH:MM": Wh}`` maps.

    The inspector reads every cumulative meter for the day in one recorder query
    and hands the result to the shaping steps, so a test stubs that one read.
    """
    return {
        entity_id: {
            datetime.fromisoformat(f"{TARGET_DATE}T{slot}:00+02:00"): wh / 1000.0
            for slot, wh in by_slot.items()
        }
        for entity_id, by_slot in (consumer_slot_by_entity or {}).items()
    }


async def _inspector_payload(
    _history=None, _consumer_slot_by_entity=None, **service_kwargs
):
    hass = SimpleNamespace(
        config=SimpleNamespace(time_zone="Europe/Prague"),
        bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
    )
    service = service_mod.SolarBiasCorrectionService(
        hass,
        _DummyStore(),
        _make_cfg(),
        battery_forecast_provider=_battery_forecast_provider,
        house_energy_entity_id_provider=lambda: "sensor.house_energy",
        battery_soc_entity_id_provider=lambda: "sensor.battery_soc",
        **service_kwargs,
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

    if _history is not None:
        service._load_numeric_history_by_slot = _history

    old_now = service_mod.dt_util.now
    old_actuals = service_mod.load_actuals_for_day
    try:
        service_mod.dt_util.now = lambda: datetime.fromisoformat(
            "2026-05-11T10:00:00+02:00"
        )
        service_mod.load_actuals_for_day = AsyncMock(return_value={})
        with patch.object(
            service_mod,
            "load_house_forecast_points_for_day",
            AsyncMock(return_value=HOUSE_FC_POINTS),
        ), patch.object(
            service,
            "_load_house_actual_for_date",
            AsyncMock(return_value=HOUSE_ACTUAL_POINTS),
        ), patch.object(
            service,
            "_load_battery_soc_actual_for_date",
            AsyncMock(return_value=BATTERY_SOC_ACTUAL),
        ), patch.object(
            service,
            "_load_slot_energy_kwh_for_entities",
            AsyncMock(
                return_value=_slot_energy_kwh_by_entity(_consumer_slot_by_entity)
            ),
        ):
            return await service.async_get_inspector_day(TARGET_DATE)
    finally:
        service_mod.dt_util.now = old_now
        service_mod.load_actuals_for_day = old_actuals


class TestInspectorHouseBatteryPayload(unittest.IsolatedAsyncioTestCase):

    async def test_inspector_payload_includes_house_and_battery_fields(self):
        payload = await _inspector_payload()

        # series
        self.assertEqual(payload["series"]["houseForecast"][0]["valueWh"], 200.0)
        self.assertEqual(payload["series"]["houseActual"][0]["valueWh"], 180.0)
        self.assertEqual(payload["series"]["batterySocActual"][0]["slot"], "00:00")
        self.assertAlmostEqual(payload["series"]["batterySocActual"][0]["pct"], 88.0)

        # availability
        self.assertTrue(payload["availability"]["hasHouseForecast"])
        self.assertTrue(payload["availability"]["hasHouseActual"])
        self.assertTrue(payload["availability"]["hasBatterySocActual"])
        # no forecast archive wired in → past days have no battery SoC forecast
        self.assertFalse(payload["availability"]["hasBatterySocForecast"])

        # totals
        self.assertEqual(payload["totals"]["houseForecastWh"], 200.0)
        self.assertEqual(payload["totals"]["houseActualWh"], 180.0)

    async def test_house_actual_breakdown_splits_base_and_appliances(self):
        payload = await _inspector_payload(
            house_deferrable_consumers_provider=lambda: [
                {
                    "energy_entity_id": "sensor.dishwasher",
                    "label": "Dishwasher",
                    "id": "dishwasher",
                },
                # A roster entry that declares no controllable keys off nothing.
                {"energy_entity_id": "sensor.ev", "label": "EV charger"},
            ],
            _consumer_slot_by_entity={
                "sensor.dishwasher": {"00:00": 50.0},
                "sensor.ev": {"00:00": 30.0},
            },
        )

        breakdown = payload["series"]["houseActualBreakdown"]
        self.assertEqual(len(breakdown), 1)
        slot = breakdown[0]
        self.assertEqual(slot["slot"], "00:00")
        # House actual is 180 Wh; the two appliances take 80, so base is 100.
        self.assertEqual(slot["unmeasuredWh"], 100.0)
        self.assertEqual(
            slot["appliances"],
            [
                {
                    "entityId": "sensor.dishwasher",
                    "label": "Dishwasher",
                    "wh": 50.0,
                    "switchEntityId": None,
                    "powerEntityId": None,
                    "deferrable": True,
                    "controllableId": "dishwasher",
                },
                {
                    "entityId": "sensor.ev",
                    "label": "EV charger",
                    "wh": 30.0,
                    "switchEntityId": None,
                    "powerEntityId": None,
                    "deferrable": True,
                    "controllableId": None,
                },
            ],
        )
        # Base plus appliances reconciles with the plain house actual figure.
        total = slot["unmeasuredWh"] + sum(a["wh"] for a in slot["appliances"])
        self.assertEqual(total, payload["series"]["houseActual"][0]["valueWh"])
        self.assertTrue(payload["availability"]["hasHouseActualBreakdown"])

    async def test_house_actual_breakdown_merges_device_tree_consumers(self):
        # Deferrable appliances lead; device-tree consumers fill in the rest, and
        # an entity present in both lists appears once (deferrable label wins).
        async def _devices():
            return [
                {
                    "energy_entity_id": "sensor.ev",
                    "label": "EV (tree)",
                    "switch_entity_id": "switch.ev",
                    "power_entity_id": "sensor.ev_power",
                },
                {
                    "energy_entity_id": "sensor.fridge",
                    "label": "Fridge",
                    "switch_entity_id": "switch.fridge",
                    "power_entity_id": "sensor.fridge_power",
                },
            ]

        payload = await _inspector_payload(
            house_deferrable_consumers_provider=lambda: [
                {"energy_entity_id": "sensor.ev", "label": "EV charger"},
            ],
            house_device_consumers_provider=_devices,
            _consumer_slot_by_entity={
                "sensor.ev": {"00:00": 30.0},
                "sensor.fridge": {"00:00": 20.0},
            },
        )

        slot = payload["series"]["houseActualBreakdown"][0]
        # The EV keeps its deferrable label but adopts the tree's switch and power
        # sensor, which is the only place either is known.
        self.assertEqual(
            slot["appliances"],
            [
                {
                    "entityId": "sensor.ev",
                    "label": "EV charger",
                    "wh": 30.0,
                    "switchEntityId": "switch.ev",
                    "powerEntityId": "sensor.ev_power",
                    "deferrable": True,
                    "controllableId": None,
                },
                {
                    "entityId": "sensor.fridge",
                    "label": "Fridge",
                    "wh": 20.0,
                    "switchEntityId": "switch.fridge",
                    "powerEntityId": "sensor.fridge_power",
                    "deferrable": False,
                    "controllableId": None,
                },
            ],
        )
        # House 180 − (30 + 20) = 130 unmeasured remainder.
        self.assertEqual(slot["unmeasuredWh"], 130.0)

    async def test_house_actual_breakdown_marks_deferrable_consumers(self):
        # Deferrability is a property of the device, read from which roster the
        # consumer came from: the configured deferrable controllable is shiftable,
        # the tree-only meter is not, and being on both lists keeps it shiftable.
        async def _devices():
            return [
                {"energy_entity_id": "sensor.ev", "label": "EV (tree)"},
                {"energy_entity_id": "sensor.fridge", "label": "Fridge"},
            ]

        payload = await _inspector_payload(
            house_deferrable_consumers_provider=lambda: [
                {"energy_entity_id": "sensor.dishwasher", "label": "Dishwasher"},
                {"energy_entity_id": "sensor.ev", "label": "EV charger"},
            ],
            house_device_consumers_provider=_devices,
            _consumer_slot_by_entity={
                "sensor.dishwasher": {"00:00": 50.0},
                "sensor.ev": {"00:00": 30.0},
                "sensor.fridge": {"00:00": 20.0},
            },
        )

        slot = payload["series"]["houseActualBreakdown"][0]
        self.assertEqual(
            {a["entityId"]: a["deferrable"] for a in slot["appliances"]},
            {
                "sensor.dishwasher": True,
                "sensor.ev": True,
                "sensor.fridge": False,
            },
        )

    async def test_house_actual_breakdown_clamps_negative_base(self):
        # Appliances momentarily over-report past the house total: base floors at 0.
        payload = await _inspector_payload(
            house_deferrable_consumers_provider=lambda: [
                {"energy_entity_id": "sensor.ev", "label": "EV charger"},
            ],
            _consumer_slot_by_entity={"sensor.ev": {"00:00": 250.0}},
        )

        slot = payload["series"]["houseActualBreakdown"][0]
        self.assertEqual(slot["unmeasuredWh"], 0.0)
        self.assertEqual(slot["appliances"][0]["wh"], 250.0)

    async def test_house_unmeasured_label_comes_from_the_card_config(self):
        payload = await _inspector_payload(
            house_unmeasured_label_provider=lambda: "👻 Nesledovaná spotřeba",
        )

        self.assertEqual(payload["houseUnmeasuredLabel"], "👻 Nesledovaná spotřeba")

    async def test_house_unmeasured_label_null_when_card_leaves_it_unset(self):
        # The card falls back to its own localized string in this case.
        payload = await _inspector_payload(house_unmeasured_label_provider=lambda: "  ")

        self.assertIsNone(payload["houseUnmeasuredLabel"])

    async def test_house_actual_breakdown_absent_without_consumers(self):
        payload = await _inspector_payload()

        self.assertEqual(payload["series"]["houseActualBreakdown"], [])
        self.assertFalse(payload["availability"]["hasHouseActualBreakdown"])

    async def test_battery_soc_bounds_fall_back_to_live_values_per_slot(self):
        payload = await _inspector_payload(
            battery_soc_bounds_provider=lambda: (10.0, 95.0)
        )

        bounds = payload["batterySocBounds"]
        self.assertEqual(len(bounds), 96)
        self.assertEqual(bounds[0], {"slot": "00:00", "minPct": 10.0, "maxPct": 95.0})
        self.assertEqual(bounds[-1], {"slot": "23:45", "minPct": 10.0, "maxPct": 95.0})

    async def test_battery_soc_bounds_prefer_recorded_history_per_slot(self):
        # The floor was raised to 30% for the second slot of the day; the rest of
        # the day has no reading and falls back to the bounds set right now.
        async def _history(entity_id, *args, **kwargs):
            if entity_id == "sensor.min_soc":
                return {"00:00": 10.0, "00:15": 30.0}
            return {"00:00": 95.0, "00:15": 80.0}

        payload = await _inspector_payload(
            battery_soc_bounds_provider=lambda: (10.0, 100.0),
            battery_soc_bounds_entity_id_provider=lambda: (
                "sensor.min_soc",
                "sensor.max_soc",
            ),
            _history=_history,
        )

        bounds = {b["slot"]: b for b in payload["batterySocBounds"]}
        self.assertEqual(bounds["00:00"], {"slot": "00:00", "minPct": 10.0, "maxPct": 95.0})
        self.assertEqual(bounds["00:15"], {"slot": "00:15", "minPct": 30.0, "maxPct": 80.0})
        self.assertEqual(bounds["12:00"], {"slot": "12:00", "minPct": 10.0, "maxPct": 100.0})

    async def test_inspector_payload_omits_unconfigured_battery_soc_bounds(self):
        payload = await _inspector_payload()

        self.assertEqual(payload["batterySocBounds"], [])

    async def test_inspector_payload_survives_failing_bounds_provider(self):
        def _boom():
            raise RuntimeError("battery bounds entity is unavailable")

        payload = await _inspector_payload(battery_soc_bounds_provider=_boom)

        self.assertEqual(payload["batterySocBounds"], [])
