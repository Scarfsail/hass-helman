from __future__ import annotations

from _fakes import FakeHass as SharedFakeHass

from _fakes import FakeConnection as SharedFakeConnection

import importlib
import sys
import types
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from _ha_stubs import stub_module


from custom_components.helman.const import DOMAIN  # noqa: E402


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

    def test_status_returns_service_payload(self) -> None:
        payload = {"status": "applied", "enabled": True}
        service = SimpleNamespace(get_status_payload=Mock(return_value=payload))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        self.solar_bias_ws.ws_get_solar_bias_status(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/status"},
        )

        service.get_status_payload.assert_called_once_with()
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    def test_status_allows_non_admin(self) -> None:
        payload = {"status": "applied", "enabled": True}
        service = SimpleNamespace(get_status_payload=Mock(return_value=payload))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection(is_admin=False)

        self.solar_bias_ws.ws_get_solar_bias_status(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/status"},
        )

        service.get_status_payload.assert_called_once_with()
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    def test_status_returns_not_loaded_when_service_or_coordinator_missing(self) -> None:
        cases = (
            (
                None,
                [(1, "not_loaded", "Helman coordinator not available")],
            ),
            (
                SimpleNamespace(_solar_bias_service=None),
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

                self.solar_bias_ws.ws_get_solar_bias_status(
                    FakeHass(coordinator),
                    connection,
                    {"id": 1, "type": "helman/solar_bias/status"},
                )

                self.assertEqual(connection.results, [])
                self.assertEqual(connection.errors, expected_error)

    async def test_train_now_returns_fresh_payload_on_success(self) -> None:
        payload = {"status": "applied", "trainedAt": "2026-04-24T03:00:00+02:00"}
        service = SimpleNamespace(async_train=AsyncMock(return_value=payload))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_train_solar_bias_now.__wrapped__(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/train_now"},
        )

        service.async_train.assert_awaited_once_with()
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    async def test_train_now_requires_admin(self) -> None:
        service = SimpleNamespace(async_train=AsyncMock())
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection(is_admin=False)

        await self.solar_bias_ws.ws_train_solar_bias_now.__wrapped__(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/train_now"},
        )

        service.async_train.assert_not_awaited()
        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )

    async def test_train_now_returns_not_loaded_when_missing(self) -> None:
        cases = (
            (
                None,
                [(1, "not_loaded", "Helman coordinator not available")],
            ),
            (
                SimpleNamespace(_solar_bias_service=None),
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

                await self.solar_bias_ws.ws_train_solar_bias_now.__wrapped__(
                    FakeHass(coordinator),
                    connection,
                    {"id": 1, "type": "helman/solar_bias/train_now"},
                )

                self.assertEqual(connection.results, [])
                self.assertEqual(connection.errors, expected_error)

    async def test_train_now_returns_training_in_progress(self) -> None:
        training_in_progress_error, _ = self.solar_bias_ws._get_training_error_types()
        service = SimpleNamespace(
            async_train=AsyncMock(
                side_effect=training_in_progress_error(
                    "Solar bias training already in progress"
                )
            )
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_train_solar_bias_now.__wrapped__(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/train_now"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "training_in_progress", "Solar bias training already in progress")],
        )

    async def test_train_now_returns_bias_correction_not_configured(self) -> None:
        _, bias_not_configured_error = self.solar_bias_ws._get_training_error_types()
        service = SimpleNamespace(
            async_train=AsyncMock(
                side_effect=bias_not_configured_error(
                    "Solar bias correction is disabled"
                )
            )
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_train_solar_bias_now.__wrapped__(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/train_now"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [
                (
                    1,
                    "bias_correction_not_configured",
                    "Solar bias correction is disabled",
                )
            ],
        )

    async def test_train_now_returns_internal_error_and_logs(self) -> None:
        service = SimpleNamespace(
            async_train=AsyncMock(
                return_value={
                    "status": "training_failed",
                    "lastOutcome": "training_failed",
                    "errorReason": "boom",
                    "trainedAt": "2026-04-24T03:00:00+02:00",
                }
            )
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        with self.assertLogs(
            "custom_components.helman.solar_bias_correction.websocket",
            level="ERROR",
        ) as captured:
            await self.solar_bias_ws.ws_train_solar_bias_now.__wrapped__(
                FakeHass(coordinator),
                connection,
                {"id": 1, "type": "helman/solar_bias/train_now"},
            )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "internal_error", "Unexpected solar bias training failure")],
        )
        self.assertIn("Unexpected solar bias training failure", captured.output[0])

    async def test_train_now_returns_internal_error_for_failed_stale_retrain_payload(self) -> None:
        service = SimpleNamespace(
            async_train=AsyncMock(
                return_value={
                    "status": "config_changed_pending_retrain",
                    "lastOutcome": "training_failed",
                    "errorReason": "boom",
                    "trainedAt": "2026-04-20T03:00:00+02:00",
                }
            )
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        with self.assertLogs(
            "custom_components.helman.solar_bias_correction.websocket",
            level="ERROR",
        ) as captured:
            await self.solar_bias_ws.ws_train_solar_bias_now.__wrapped__(
                FakeHass(coordinator),
                connection,
                {"id": 1, "type": "helman/solar_bias/train_now"},
            )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "internal_error", "Unexpected solar bias training failure")],
        )
        self.assertIn("Unexpected solar bias training failure", captured.output[0])

    async def test_train_now_returns_internal_error_when_service_raises_unexpected_exception(self) -> None:
        service = SimpleNamespace(async_train=AsyncMock(side_effect=RuntimeError("boom")))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        with self.assertLogs(
            "custom_components.helman.solar_bias_correction.websocket",
            level="ERROR",
        ) as captured:
            await self.solar_bias_ws.ws_train_solar_bias_now.__wrapped__(
                FakeHass(coordinator),
                connection,
                {"id": 1, "type": "helman/solar_bias/train_now"},
            )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "internal_error", "Unexpected solar bias training failure")],
        )
        self.assertIn("Unexpected solar bias training failure", captured.output[0])

    def test_profile_returns_persisted_profile_shape(self) -> None:
        service = SimpleNamespace(
            get_profile_payload=Mock(
                return_value={
                    "trainedAt": "2026-04-24T03:00:00+02:00",
                    "factors": {"08:00": 1.1, "08:30": 0.9},
                    "omittedSlots": ["07:30", "09:00"],
                }
            )
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        self.solar_bias_ws.ws_get_solar_bias_profile(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/profile"},
        )

        self.assertEqual(
            connection.results,
            [
                (
                    1,
                    {
                        "trainedAt": "2026-04-24T03:00:00+02:00",
                        "factors": {"08:00": 1.1, "08:30": 0.9},
                        "omittedSlots": ["07:30", "09:00"],
                    },
                )
            ],
        )
        self.assertEqual(connection.errors, [])

    def test_profile_allows_non_admin(self) -> None:
        payload = {"factors": {"08:00": 1.0}, "omittedSlots": []}
        service = SimpleNamespace(get_profile_payload=Mock(return_value=payload))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection(is_admin=False)

        self.solar_bias_ws.ws_get_solar_bias_profile(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/profile"},
        )

        service.get_profile_payload.assert_called_once_with()
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    def test_profile_returns_no_profile_before_training(self) -> None:
        service = SimpleNamespace(get_profile_payload=Mock(return_value=None))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        self.solar_bias_ws.ws_get_solar_bias_profile(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/profile"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors, [(1, "no_profile", "No solar bias profile available")])

    def test_profile_returns_no_profile_for_insufficient_history_state(self) -> None:
        service = SimpleNamespace(get_profile_payload=Mock(return_value=None))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        self.solar_bias_ws.ws_get_solar_bias_profile(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/profile"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "no_profile", "No solar bias profile available")],
        )

    def test_profile_returns_not_loaded_when_missing(self) -> None:
        cases = (
            (
                None,
                [(1, "not_loaded", "Helman coordinator not available")],
            ),
            (
                SimpleNamespace(_solar_bias_service=None),
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

                self.solar_bias_ws.ws_get_solar_bias_profile(
                    FakeHass(coordinator),
                    connection,
                    {"id": 1, "type": "helman/solar_bias/profile"},
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
        coordinator = SimpleNamespace(_solar_bias_service=service)
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
        coordinator = SimpleNamespace(_solar_bias_service=service)
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
                coordinator = SimpleNamespace(_solar_bias_service=service)
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
        coordinator = SimpleNamespace(_solar_bias_service=service)
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
        coordinator = SimpleNamespace(_solar_bias_service=service)
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
        coordinator = SimpleNamespace(_solar_bias_service=service)
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
        coordinator = SimpleNamespace(_solar_bias_service=service)
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
        coordinator = SimpleNamespace(_solar_bias_service=service)
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

        self.assertIn(self.solar_bias_ws.ws_get_solar_bias_status, registered)
        self.assertIn(self.solar_bias_ws.ws_train_solar_bias_now, registered)
        self.assertIn(self.solar_bias_ws.ws_get_solar_bias_profile, registered)
        self.assertIn(self.solar_bias_ws.ws_get_solar_bias_inspector, registered)


if __name__ == "__main__":
    unittest.main()
