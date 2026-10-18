from __future__ import annotations

import importlib
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from _fakes import FakeConnection as SharedFakeConnection
from _fakes import FakeHass as SharedFakeHass

from custom_components.helman.const import DOMAIN


class FakeConnection(SharedFakeConnection):
    def __init__(self, *, is_admin: bool = True) -> None:
        super().__init__()
        self.user = SimpleNamespace(is_admin=is_admin)



class FakeHass(SharedFakeHass):
    def __init__(self, coordinator) -> None:
        super().__init__()
        self.data = {DOMAIN: {"coordinator": coordinator}}


def _load_websocket_modules():
    return (
        importlib.import_module("custom_components.helman.solar_bias_correction.websocket"),
        importlib.import_module("custom_components.helman.websockets"),
    )


class SolarBiasWebsocketTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.solar_bias_ws, self.websockets_mod = _load_websocket_modules()

    async def test_inspector_returns_not_loaded_when_service_or_coordinator_missing(
        self,
    ) -> None:
        cases = (
            (
                None,
                [(1, "not_loaded", "Helman coordinator not available")],
            ),
            (
                SimpleNamespace(solar_inspector=None),
                [
                    (
                        1,
                        "not_loaded",
                        "Helman solar bias correction service not available",
                    )
                ],
            ),
        )

        for coordinator, expected_error in cases:
            with self.subTest(coordinator=coordinator):
                connection = FakeConnection()

                await self.solar_bias_ws.ws_get_solar_bias_inspector.__wrapped__(
                    FakeHass(coordinator),
                    connection,
                    {"id": 1, "type": "helman/solar_bias/inspector", "date": "2026-04-25"},
                )

                self.assertEqual(connection.results, [])
                self.assertEqual(connection.errors, expected_error)

    async def test_inspector_returns_service_payload_for_date(self) -> None:
        payload = {
            "date": "2026-04-25",
            "timezone": "Europe/Prague",
            "series": {"raw": [], "corrected": [], "actual": [], "factors": []},
        }
        service = SimpleNamespace(
            async_get_inspector_day=AsyncMock(return_value=payload)
        )
        coordinator = SimpleNamespace(solar_inspector=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_get_solar_bias_inspector.__wrapped__(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/inspector", "date": "2026-04-25"},
        )

        service.async_get_inspector_day.assert_awaited_once_with("2026-04-25")
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    async def test_inspector_allows_non_admin(self) -> None:
        payload = {
            "date": "2026-04-25",
            "timezone": "Europe/Prague",
            "series": {"raw": [], "corrected": [], "actual": [], "factors": []},
        }
        service = SimpleNamespace(
            async_get_inspector_day=AsyncMock(return_value=payload)
        )
        coordinator = SimpleNamespace(solar_inspector=service)
        connection = FakeConnection(is_admin=False)

        await self.solar_bias_ws.ws_get_solar_bias_inspector.__wrapped__(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/inspector", "date": "2026-04-25"},
        )

        service.async_get_inspector_day.assert_awaited_once_with("2026-04-25")
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    async def test_inspector_rejects_invalid_date(self) -> None:
        for raw_date in ("04/25/2026", "20260425", "2026-W17-6"):
            with self.subTest(raw_date=raw_date):
                service = SimpleNamespace(async_get_inspector_day=AsyncMock())
                coordinator = SimpleNamespace(solar_inspector=service)
                connection = FakeConnection()

                await self.solar_bias_ws.ws_get_solar_bias_inspector.__wrapped__(
                    FakeHass(coordinator),
                    connection,
                    {
                        "id": 1,
                        "type": "helman/solar_bias/inspector",
                        "date": raw_date,
                    },
                )

                service.async_get_inspector_day.assert_not_awaited()
                self.assertEqual(
                    connection.errors,
                    [(1, "invalid_date", "Date must use YYYY-MM-DD format")],
                )

    async def test_day_aggregates_defaults_to_day_buckets(self) -> None:
        payload = {"bucket": "day", "currency": None, "days": []}
        service = SimpleNamespace(
            async_get_span_aggregates=AsyncMock(return_value=payload)
        )
        coordinator = SimpleNamespace(solar_inspector=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_get_solar_bias_day_aggregates.__wrapped__(
            FakeHass(coordinator),
            connection,
            {
                "id": 1,
                "type": "helman/solar_bias/day_aggregates",
                "start_date": "2026-04-19",
                "end_date": "2026-04-25",
            },
        )

        # The day pills send no bucket at all, and must keep getting days --
        # and no breakdown either, which is what keeps their read from widening
        # by a meter per configured consumer for a field they never draw.
        service.async_get_span_aggregates.assert_awaited_once_with(
            "2026-04-19", "2026-04-25", "day", house_breakdown=False, house_forecast=False
        )
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    async def test_day_aggregates_passes_the_month_bucket_through(self) -> None:
        payload = {"bucket": "month", "currency": "CZK/kWh", "days": []}
        service = SimpleNamespace(
            async_get_span_aggregates=AsyncMock(return_value=payload)
        )
        coordinator = SimpleNamespace(solar_inspector=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_get_solar_bias_day_aggregates.__wrapped__(
            FakeHass(coordinator),
            connection,
            {
                "id": 1,
                "type": "helman/solar_bias/day_aggregates",
                "start_date": "2025-06-01",
                "end_date": "2026-05-31",
                "bucket": "month",
            },
        )

        service.async_get_span_aggregates.assert_awaited_once_with(
            "2025-06-01", "2026-05-31", "month", house_breakdown=False, house_forecast=False
        )
        self.assertEqual(connection.results, [(1, payload)])

    async def test_day_aggregates_passes_the_breakdown_request_through(self) -> None:
        # Both callers share this endpoint and want different things from it:
        # the aggregate views draw each bucket's composition, the day pills read
        # six scalars a bucket. The flag is how they say which, so it has to
        # reach the service rather than being defaulted away here.
        payload = {"bucket": "month", "currency": None, "days": []}
        service = SimpleNamespace(
            async_get_span_aggregates=AsyncMock(return_value=payload)
        )
        coordinator = SimpleNamespace(solar_inspector=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_get_solar_bias_day_aggregates.__wrapped__(
            FakeHass(coordinator),
            connection,
            {
                "id": 1,
                "type": "helman/solar_bias/day_aggregates",
                "start_date": "2025-06-01",
                "end_date": "2026-05-31",
                "bucket": "month",
                "house_breakdown": True,
            },
        )

        service.async_get_span_aggregates.assert_awaited_once_with(
            "2025-06-01", "2026-05-31", "month", house_breakdown=True, house_forecast=False
        )
        self.assertEqual(connection.results, [(1, payload)])

    async def test_day_aggregates_passes_the_house_forecast_request_through(
        self,
    ) -> None:
        # The house-focused inspector's pills compare each day's actual house
        # energy with what was predicted for it; the flag is how they ask for the
        # prediction, so it has to reach the service.
        payload = {"bucket": "day", "currency": None, "days": []}
        service = SimpleNamespace(
            async_get_span_aggregates=AsyncMock(return_value=payload)
        )
        coordinator = SimpleNamespace(solar_inspector=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_get_solar_bias_day_aggregates.__wrapped__(
            FakeHass(coordinator),
            connection,
            {
                "id": 1,
                "type": "helman/solar_bias/day_aggregates",
                "start_date": "2026-04-19",
                "end_date": "2026-04-25",
                "house_forecast": True,
            },
        )

        service.async_get_span_aggregates.assert_awaited_once_with(
            "2026-04-19", "2026-04-25", "day", house_breakdown=False, house_forecast=True
        )
        self.assertEqual(connection.results, [(1, payload)])

    async def test_day_aggregates_rejects_invalid_dates(self) -> None:
        service = SimpleNamespace(async_get_span_aggregates=AsyncMock())
        coordinator = SimpleNamespace(solar_inspector=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_get_solar_bias_day_aggregates.__wrapped__(
            FakeHass(coordinator),
            connection,
            {
                "id": 1,
                "type": "helman/solar_bias/day_aggregates",
                "start_date": "04/19/2026",
                "end_date": "2026-04-25",
            },
        )

        service.async_get_span_aggregates.assert_not_awaited()
        self.assertEqual(
            connection.errors,
            [(1, "invalid_date", "Dates must use YYYY-MM-DD format")],
        )

    def test_registration_wiring_includes_solar_bias_handlers(self) -> None:
        registered: list[object] = []
        self.websockets_mod.async_register_command = lambda hass, command: registered.append(
            command
        )

        self.websockets_mod.async_register_websocket_commands(object())

        self.assertIn(self.solar_bias_ws.ws_get_solar_bias_inspector, registered)
        # Its diagnostics ride the solar job of the admin-only training status.
        self.assertNotIn(
            "helman/solar_bias/status",
            [command._ws_command for command in registered],
        )


if __name__ == "__main__":
    unittest.main()
