"""What the day cost and what it earned, priced in the backend.

Money used to be derived in the card, from the *drawn* series -- the ones that
stop at the slot in progress. Every energy total on the same panel is summed
from the undropped points, so on today, mid-slot, the two disagreed: the grid
tile reported energy the money tiles had already dropped. Pricing here removes
the second opinion, and these tests pin both halves of the rule the payload now
follows -- the drawn money series stops at the running slot, the totals count
it -- alongside the pricing properties themselves, which moved here from
``frontend/tests/money-model.spec.ts``.
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from zoneinfo import ZoneInfo

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

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.now = lambda: datetime.fromisoformat("2026-05-11T10:00:00+02:00")
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    sys.modules.pop("custom_components.helman.solar_bias_correction.service", None)


_install_import_stubs()

import importlib  # noqa: E402

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)


PRAGUE = ZoneInfo("Europe/Prague")
#: "Now" for every test here: 10:00 local on 2026-05-11.
TODAY = "2026-05-11"


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
        daily_energy_entity_ids=["sensor.solar_today"],
        total_energy_entity_id="sensor.solar_total",
    )


def _wh(slot: str, value: float) -> dict:
    """An energy point on a slot of the fixed test day."""
    return {"timestamp": f"{TODAY}T{slot}:00+02:00", "wh": value}


def _money(points) -> dict[str, tuple[float, float]]:
    return {p.slot: (p.cost, p.gain) for p in points}


class TestPricingOneVintage(unittest.TestCase):
    """The arithmetic, exercised on the helper rather than through a payload."""

    def test_each_direction_is_priced_at_its_own_rate(self):
        # The case netting destroys: 2 kWh in at 6, 3 kWh out at 1. Net energy
        # is -1 kWh, and no single rate applied to it yields both 12 and 3.
        points = service_mod._money_points(
            [_wh("10:00", 2000.0)],
            [_wh("10:00", 3000.0)],
            {"10:00": 6.0},
            {"10:00": 1.0},
        )

        self.assertEqual(_money(points), {"10:00": (12.0, 3.0)})

    def test_a_days_money_is_the_sum_of_its_slots(self):
        # 1 kWh at 10 plus 3 kWh at 2 is 16, where 4 kWh at the mean rate of 6
        # would be 24. Mean-rate accounting flatters exactly the days whose
        # consumption avoided the expensive hours.
        points = service_mod._money_points(
            [_wh("10:00", 1000.0), _wh("10:15", 3000.0)],
            [],
            {"10:00": 10.0, "10:15": 2.0},
            {},
        )

        self.assertAlmostEqual(service_mod._money_totals(points).cost, 16.0, places=6)

    def test_energy_with_no_rate_contributes_nothing_rather_than_zero(self):
        # A day past the recorder's reach has real exported kWh at an unknown
        # rate. Calling that "earned 0" is a claim the data cannot support, so
        # the slot is left out and the tile above it reads an em dash.
        points = service_mod._money_points([], [_wh("10:00", 3000.0)], {}, {})

        self.assertEqual(points, [])
        self.assertIsNone(service_mod._money_totals(points))

    def test_one_priced_direction_still_yields_the_slot(self):
        # Only the unpriced *side* drops out; a slot that imported at a known
        # rate is not lost because its export rail happens to be empty.
        points = service_mod._money_points(
            [_wh("10:00", 1000.0)],
            [_wh("10:00", 2000.0)],
            {"10:00": 4.0},
            {},
        )

        self.assertEqual(_money(points), {"10:00": (4.0, 0.0)})

    def test_a_negative_export_rate_makes_the_gain_negative(self):
        # Paying to export is ordinary here: sign carries the direction of the
        # money, and the reader is told by the number rather than by a colour.
        points = service_mod._money_points(
            [], [_wh("13:00", 4000.0)], {}, {"13:00": -0.5}
        )

        self.assertEqual(_money(points), {"13:00": (0.0, -2.0)})

    def test_several_points_in_one_slot_accumulate_before_pricing(self):
        points = service_mod._money_points(
            [_wh("10:00", 500.0), _wh("10:00", 1500.0)], [], {"10:00": 3.0}, {}
        )

        self.assertEqual(_money(points), {"10:00": (6.0, 0.0)})

    def test_net_is_what_the_grid_came_to_on_balance(self):
        points = service_mod._money_points(
            [_wh("10:00", 2000.0)],
            [_wh("11:00", 5000.0)],
            {"10:00": 6.0},
            {"11:00": 1.0},
        )

        totals = service_mod._money_totals(points)
        self.assertAlmostEqual(totals.cost, 12.0, places=6)
        self.assertAlmostEqual(totals.gain, 5.0, places=6)
        # Positive means the grid took money off you over the span.
        self.assertAlmostEqual(totals.net, 7.0, places=6)


class TestRunningSlotSplit(unittest.IsolatedAsyncioTestCase):
    """The disagreement this file exists to prevent, at the payload level."""

    def _make_service(self):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
            states=SimpleNamespace(get=lambda entity_id: None),
        )
        service = service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
            grid_export_price_entity_id_provider=lambda: "sensor.spot_sell_price",
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

    async def _payload(self, service, *, grid_sides, rails):
        async def _fake_rails(entity_ids, target_date, local_tz, *, local_end):
            return tuple(rails.get(entity_id, []) for entity_id in entity_ids)

        old_actuals = service_mod.load_actuals_for_day
        try:
            service_mod.load_actuals_for_day = AsyncMock(return_value={})
            with patch.object(
                service_mod,
                "load_house_forecast_points_for_day",
                AsyncMock(return_value=[]),
            ), patch.object(
                service, "_load_house_actual_for_date", AsyncMock(return_value=[])
            ), patch.object(
                service, "_load_battery_soc_actual_for_date", AsyncMock(return_value=[])
            ), patch.object(
                service,
                "_load_grid_actual_for_date",
                AsyncMock(return_value=grid_sides),
            ), patch.object(
                service, "_load_battery_actual_for_date", AsyncMock(return_value=[])
            ), patch.object(
                service,
                "_house_consumer_breakdown_for_date",
                Mock(return_value=([], [])),
            ), patch.object(
                service, "_load_recorded_price_rails", side_effect=_fake_rails
            ):
                return await service.async_get_inspector_day(TODAY)
        finally:
            service_mod.load_actuals_for_day = old_actuals

    async def test_the_totals_count_the_running_slot_the_series_stops_before(self):
        # 09:45 has finished; 10:00 is the slot in progress at the stubbed now.
        # This is the shape of the live observation that opened the issue: all
        # of the day's export sat in the running slot, so the grid tile read
        # 340 Wh while the gain tile read 0.00.
        imported = [_wh("09:45", 400.0), _wh("10:00", 200.0)]
        exported = [_wh("10:00", 340.0)]
        net = [_wh("09:45", 400.0), _wh("10:00", -140.0)]
        rails = {
            "sensor.helman_grid_import_price": [
                {"slot": "09:45", "value": 5.0},
                {"slot": "10:00", "value": 5.0},
            ],
            "sensor.spot_sell_price": [
                {"slot": "09:45", "value": 2.0},
                {"slot": "10:00", "value": 2.0},
            ],
        }

        payload = await self._payload(
            self._make_service(),
            grid_sides=(net, imported, exported),
            rails=rails,
        )

        # Drawn: the running slot is gone, exactly as it is from gridActual.
        self.assertEqual(
            [p["slot"] for p in payload["series"]["moneyActual"]], ["09:45"]
        )
        self.assertEqual(
            [p["timestamp"][11:16] for p in payload["series"]["gridActual"]],
            ["09:45"],
        )
        # Summed: the running slot counts, exactly as it does for gridActualWh.
        totals = payload["totals"]["moneyActual"]
        self.assertAlmostEqual(totals["cost"], 0.4 * 5.0 + 0.2 * 5.0, places=6)
        self.assertAlmostEqual(totals["gain"], 0.34 * 2.0, places=6)
        self.assertAlmostEqual(totals["net"], 3.0 - 0.68, places=6)
        # The claim that failed live: the money totals and the energy total now
        # describe the same slots.
        self.assertAlmostEqual(payload["totals"]["gridActualWh"], 260.0, places=6)

    async def test_a_day_with_no_rail_prices_nothing(self):
        payload = await self._payload(
            self._make_service(),
            grid_sides=([_wh("09:45", 400.0)], [_wh("09:45", 400.0)], []),
            rails={},
        )

        self.assertEqual(payload["series"]["moneyActual"], [])
        self.assertIsNone(payload["totals"]["moneyActual"])


if __name__ == "__main__":
    unittest.main()
