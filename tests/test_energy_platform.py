from __future__ import annotations

import importlib
import sys
import types
import unittest




def _load_energy_module():
    return importlib.import_module("custom_components.helman.energy")


class _FakeConfigEntry:
    def __init__(self, entry_id: str, domain: str) -> None:
        self.entry_id = entry_id
        self.domain = domain


class _FakeConfigEntries:
    def __init__(self, entries: dict[str, _FakeConfigEntry]) -> None:
        self._entries = entries

    def async_get_entry(self, entry_id: str) -> _FakeConfigEntry | None:
        return self._entries.get(entry_id)


class _FakeHass:
    def __init__(self, coordinator, entries: dict[str, _FakeConfigEntry]) -> None:
        for entry in entries.values():
            entry.runtime_data = coordinator
        self.config_entries = _FakeConfigEntries(entries)


class _FakeCoordinator:
    def __init__(self, forecast: dict | None = None) -> None:
        self.calls: list[dict[str, int]] = []
        # Canonical 15-minute points: two whole hours, then a partial tail
        # (two quarters of 12:00) that must not be reported as an hour, plus
        # malformed entries that are skipped rather than raised on.
        self._forecast = forecast or {
            "solar": {
                "points": [
                    {"timestamp": "2026-04-29T10:00:00+02:00", "value": 300.0},
                    {"timestamp": "2026-04-29T10:15:00+02:00", "value": 300.0},
                    {"timestamp": "2026-04-29T10:30:00+02:00", "value": 325.25},
                    {"timestamp": "2026-04-29T10:45:00+02:00", "value": 325.0},
                    {"timestamp": "2026-04-29T11:00:00+02:00", "value": 0},
                    {"timestamp": "2026-04-29T11:15:00+02:00", "value": 0},
                    {"timestamp": "2026-04-29T11:30:00+02:00", "value": 0},
                    {"timestamp": "2026-04-29T11:45:00+02:00", "value": 0},
                    {"timestamp": "2026-04-29T12:00:00+02:00", "value": "bad"},
                    {"timestamp": None, "value": 500},
                    {"timestamp": "2026-04-29T12:15:00+02:00", "value": 10.0},
                    {"timestamp": "2026-04-29T12:30:00+02:00", "value": 10.0},
                ],
            },
        }

    async def get_forecast(self, *, forecast_days: int) -> dict:
        self.calls.append({"forecast_days": forecast_days})
        return self._forecast

    def get_corrected_solar_forecast_points(self) -> list[dict]:
        self.calls.append({"get_corrected_solar_forecast_points": True})
        solar = self._forecast.get("solar", {})
        points = solar.get("adjustedPoints")
        if not isinstance(points, list):
            points = solar.get("points")
        if isinstance(points, list):
            return points
        return []


class EnergyPlatformTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.energy = _load_energy_module()

    async def test_get_solar_forecast_output_equals_legacy_fixture(self) -> None:
        """Regression test ensuring async_get_solar_forecast produces the exact same hourly result as legacy get_forecast path."""
        coordinator = _FakeCoordinator()
        entry = _FakeConfigEntry("entry-1", "helman")
        hass = _FakeHass(coordinator, {"entry-1": entry})

        forecast = await coordinator.get_forecast(forecast_days=14)
        solar = forecast.get("solar", {})
        legacy_points = solar.get("adjustedPoints") or solar.get("points")
        legacy_output = {"wh_hours": dict(self.energy._to_hourly(legacy_points))}

        coordinator.calls.clear()
        result = await self.energy.async_get_solar_forecast(hass, "entry-1")
        self.assertEqual(result, legacy_output)
        self.assertEqual(coordinator.calls, [{"get_corrected_solar_forecast_points": True}])

    async def test_get_solar_forecast_returns_hourly_wh_for_matching_entry(self) -> None:
        coordinator = _FakeCoordinator()
        entry = _FakeConfigEntry("entry-1", "helman")
        hass = _FakeHass(coordinator, {"entry-1": entry})

        result = await self.energy.async_get_solar_forecast(hass, "entry-1")

        self.assertEqual(coordinator.calls, [{"get_corrected_solar_forecast_points": True}])
        # 300 + 300 + 325.25 + 325 = 1250.25 for the 10:00 hour; the two
        # surviving 12:00 quarters are half an hour and are dropped.
        self.assertEqual(
            result,
            {
                "wh_hours": {
                    "2026-04-29T10:00:00+02:00": 1250.25,
                    "2026-04-29T11:00:00+02:00": 0,
                }
            },
        )

    async def test_get_solar_forecast_prefers_adjusted_points_when_available(self) -> None:
        coordinator = _FakeCoordinator(
            {
                "solar": {
                    "points": [
                        {"timestamp": "2026-04-29T10:00:00+02:00", "value": 1250.25},
                    ],
                    "adjustedPoints": [
                        {"timestamp": "2026-04-29T10:00:00+02:00", "value": 900.5},
                        {"timestamp": "2026-04-29T10:15:00+02:00", "value": 0},
                        {"timestamp": "2026-04-29T10:30:00+02:00", "value": 0},
                        {"timestamp": "2026-04-29T10:45:00+02:00", "value": 0},
                    ],
                },
            }
        )
        entry = _FakeConfigEntry("entry-1", "helman")
        hass = _FakeHass(coordinator, {"entry-1": entry})

        result = await self.energy.async_get_solar_forecast(hass, "entry-1")

        self.assertEqual(
            result,
            {"wh_hours": {"2026-04-29T10:00:00+02:00": 900.5}},
        )

    async def test_an_hour_missing_slots_is_dropped_rather_than_reported_short(self) -> None:
        """A series starting mid-hour must not label a partial sum as an hour.

        Grouping by position would have summed 10:15-11:00 and keyed it 10:15;
        grouping by each point's own hour drops that hour and keeps the whole
        one after it.
        """
        coordinator = _FakeCoordinator(
            {
                "solar": {
                    "points": [
                        {"timestamp": "2026-04-29T10:15:00+02:00", "value": 100.0},
                        {"timestamp": "2026-04-29T10:30:00+02:00", "value": 100.0},
                        {"timestamp": "2026-04-29T10:45:00+02:00", "value": 100.0},
                        {"timestamp": "2026-04-29T11:00:00+02:00", "value": 25.0},
                        {"timestamp": "2026-04-29T11:15:00+02:00", "value": 25.0},
                        {"timestamp": "2026-04-29T11:30:00+02:00", "value": 25.0},
                        {"timestamp": "2026-04-29T11:45:00+02:00", "value": 25.0},
                    ],
                },
            }
        )
        entry = _FakeConfigEntry("entry-1", "helman")
        hass = _FakeHass(coordinator, {"entry-1": entry})

        result = await self.energy.async_get_solar_forecast(hass, "entry-1")

        self.assertEqual(
            result,
            {"wh_hours": {"2026-04-29T11:00:00+02:00": 100.0}},
        )

    async def test_every_key_is_the_start_of_its_own_hour(self) -> None:
        coordinator = _FakeCoordinator()
        entry = _FakeConfigEntry("entry-1", "helman")
        hass = _FakeHass(coordinator, {"entry-1": entry})

        result = await self.energy.async_get_solar_forecast(hass, "entry-1")

        for timestamp in result["wh_hours"]:
            self.assertTrue(timestamp.endswith(":00:00+02:00"), timestamp)

    async def test_get_solar_forecast_returns_none_for_unknown_entry(self) -> None:
        coordinator = _FakeCoordinator()
        hass = _FakeHass(coordinator, {})

        result = await self.energy.async_get_solar_forecast(hass, "missing")

        self.assertIsNone(result)
        self.assertEqual(coordinator.calls, [])

    async def test_get_solar_forecast_returns_none_for_other_domain(self) -> None:
        coordinator = _FakeCoordinator()
        entry = _FakeConfigEntry("entry-1", "open_meteo_solar_forecast")
        hass = _FakeHass(coordinator, {"entry-1": entry})

        result = await self.energy.async_get_solar_forecast(hass, "entry-1")

        self.assertIsNone(result)
        self.assertEqual(coordinator.calls, [])


if __name__ == "__main__":
    unittest.main()
