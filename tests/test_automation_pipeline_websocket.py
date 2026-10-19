from __future__ import annotations

from homeassistant.exceptions import Unauthorized

from automation_pipeline_support import *
from _fakes import FakeConfigEntries


class RunAutomationWebsocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_automation_returns_serialized_result(self) -> None:
        coordinator = SimpleNamespace(
            run_automation=AsyncMock(
                return_value=AutomationRunResult.completed(snapshot=_make_snapshot())
            )
        )
        connection = _FakeConnection(is_admin=True)

        await ws_run_automation.__wrapped__.__wrapped__(
            _FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/run_automation"},
        )

        coordinator.run_automation.assert_awaited_once_with(reason="websocket")
        self.assertEqual(connection.errors, [])
        self.assertTrue(connection.results[0][1]["ranAutomation"])
        self.assertIn("scheduleSlots", connection.results[0][1]["snapshot"])
        self.assertIn("optimizers", connection.results[0][1])
        self.assertIn("durationMs", connection.results[0][1])

    async def test_run_automation_returns_skipped_result(self) -> None:
        coordinator = SimpleNamespace(
            run_automation=AsyncMock(
                return_value=AutomationRunResult.skipped(reason="execution_disabled")
            )
        )
        connection = _FakeConnection(is_admin=True)

        await ws_run_automation.__wrapped__.__wrapped__(
            _FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/run_automation"},
        )

        self.assertFalse(connection.results[0][1]["ranAutomation"])
        self.assertEqual(connection.results[0][1]["reason"], "execution_disabled")

    async def test_run_automation_returns_failed_result(self) -> None:
        coordinator = SimpleNamespace(
            run_automation=AsyncMock(
                return_value=AutomationRunResult.failed(
                    reason="runner_failed",
                    failure=AutomationRunFailure(
                        stage="final_persist",
                        message="disk full",
                    ),
                )
            )
        )
        connection = _FakeConnection(is_admin=True)

        await ws_run_automation.__wrapped__.__wrapped__(
            _FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/run_automation"},
        )

        self.assertFalse(connection.results[0][1]["ranAutomation"])
        self.assertEqual(connection.results[0][1]["reason"], "runner_failed")
        self.assertEqual(
            connection.results[0][1]["failure"],
            {
                "stage": "final_persist",
                "message": "disk full",
                "unexpected": True,
            },
        )

    async def test_run_automation_requires_admin(self) -> None:
        coordinator = SimpleNamespace(run_automation=AsyncMock())
        connection = _FakeConnection(is_admin=False)

        with self.assertRaises(Unauthorized):
            ws_run_automation(
                _FakeHass(coordinator),
                connection,
                {"id": 1, "type": "helman/run_automation"},
            )

        coordinator.run_automation.assert_not_awaited()


class ScheduleExplanationWebsocketTests(unittest.IsolatedAsyncioTestCase):
    """`helman/get_schedule_explanation` — the per-lane, per-day "why", read by
    the daily editor's explanation panel.
    """

    MESSAGE = {
        "id": 1,
        "type": "helman/get_schedule_explanation",
        "controllable_id": "inverter",
        "date": "2026-07-31",
    }

    def _book_with_a_run(self) -> ExplanationBook:
        run_at = datetime(2026, 7, 31, 8, 0, tzinfo=timezone(timedelta(hours=2)))
        slot_ids = tuple(
            (run_at + timedelta(minutes=30 * index)).isoformat()
            for index in range(2)
        )
        book = ExplanationBook()
        book.record(
            RunExplanation(
                run_at=run_at,
                slot_ids=slot_ids,
                optimizers=(
                    OptimizerExplanation(
                        optimizer_id="avoid-negative-export",
                        kind="export_price",
                        controllable_id="inverter",
                        slots=tuple(
                            SlotExplanation(
                                slot_id=slot_id,
                                verdict="execute",
                                winning_optimizer="avoid-negative-export",
                            )
                            for slot_id in slot_ids
                        ),
                    ),
                ),
            )
        )
        return book

    async def test_returns_the_record_for_the_requested_lane_and_date(self) -> None:
        book = self._book_with_a_run()
        coordinator = SimpleNamespace(
            get_schedule_explanation=Mock(
                side_effect=lambda *, controllable_id, date: book.get(
                    controllable_id=controllable_id, date=date
                )
            )
        )
        connection = _FakeConnection(is_admin=True)

        ws_get_schedule_explanation(
            _FakeHass(coordinator), connection, dict(self.MESSAGE)
        )

        coordinator.get_schedule_explanation.assert_called_once_with(
            controllable_id="inverter", date="2026-07-31"
        )
        self.assertEqual(connection.errors, [])
        payload = connection.results[0][1]
        self.assertEqual(payload["controllableId"], "inverter")
        self.assertEqual(payload["date"], "2026-07-31")
        self.assertEqual(len(payload["slotIds"]), 2)
        self.assertEqual(payload["runAt"], "2026-07-31T08:00:00+02:00")
        optimizer = payload["optimizers"][0]
        self.assertEqual(optimizer["optimizerId"], "avoid-negative-export")
        self.assertEqual(optimizer["kind"], "export_price")
        self.assertEqual(optimizer["controllableId"], "inverter")
        self.assertEqual(optimizer["status"], "ok")
        self.assertEqual(
            optimizer["slots"],
            [
                {
                    "slotId": slot_id,
                    "runAt": "2026-07-31T08:00:00+02:00",
                    "verdict": "execute",
                    "winningOptimizer": "avoid-negative-export",
                    "groups": [],
                    "gates": [],
                }
                for slot_id in payload["slotIds"]
            ],
        )

    async def test_returns_null_when_nothing_is_recorded(self) -> None:
        coordinator = SimpleNamespace(
            get_schedule_explanation=Mock(return_value=None)
        )
        connection = _FakeConnection(is_admin=True)

        ws_get_schedule_explanation(
            _FakeHass(coordinator),
            connection,
            {**self.MESSAGE, "controllable_id": "appliance:nobody"},
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(1, None)])

    async def test_requires_admin(self) -> None:
        coordinator = SimpleNamespace(get_schedule_explanation=Mock())
        connection = _FakeConnection(is_admin=False)

        with self.assertRaises(Unauthorized):
            ws_get_schedule_explanation(
                _FakeHass(coordinator), connection, dict(self.MESSAGE)
            )

        coordinator.get_schedule_explanation.assert_not_called()

    async def test_returns_not_loaded_when_the_coordinator_is_missing(self) -> None:
        connection = _FakeConnection(is_admin=True)

        ws_get_schedule_explanation(
            SimpleNamespace(data={}, config_entries=FakeConfigEntries()),
            connection,
            dict(self.MESSAGE),
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "not_loaded", "Helman coordinator not available")],
        )

    def test_the_request_schema_rejects_a_bad_date_and_an_empty_lane(self) -> None:
        import voluptuous as vol

        schema = ws_get_schedule_explanation._ws_schema
        message = self.MESSAGE
        connection = _FakeConnection(is_admin=True)
        ws_get_schedule_explanation(SimpleNamespace(data={}), connection, schema({**message, "date": "31.7.2026"}))
        self.assertEqual(connection.errors[0][1], "invalid_date")
        with self.assertRaises(vol.Invalid):
            schema({**message, "controllable_id": ""})
        self.assertEqual(schema(message)["date"], "2026-07-31")


