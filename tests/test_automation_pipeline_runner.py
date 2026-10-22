from __future__ import annotations

from automation_pipeline_support import *


class OptimizationSnapshotTests(unittest.TestCase):
    def test_context_exposes_both_charge_and_discharge_settings(self) -> None:
        context = _make_snapshot().context
        context = replace(context, battery=replace(
            context.battery, max_discharge_power_w=4000.0,
            discharge_efficiency=0.93))
        self.assertEqual(context.battery_max_discharge_power_kw, 4.0)
        self.assertEqual(context.battery_discharge_efficiency, 0.93)
        self.assertEqual(context.battery_max_charge_power_kw, _make_snapshot().context.battery_max_charge_power_kw)


class AutomationRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_plans_normally_when_execution_flag_is_off(self) -> None:
        # execution_enabled gates only the apply step: optimizers still run and
        # persist their plan so the card and the inspectors can display it.
        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(execution_enabled=False),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        result = await _make_runner(
            coordinator,
            automation_config=_make_automation_config(_make_optimizer_instance()),
        ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertIsNotNone(result.snapshot)
        self.assertEqual(len(result.optimizers), 1)
        self.assertIsInstance(result.duration_ms, int)
        self.assertNotEqual(coordinator.snapshot_calls, [])

    async def test_run_returns_automation_disabled_when_config_disabled(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        result = await _make_runner(
            coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "automation_disabled")
        self.assertIsNone(result.snapshot)
        self.assertEqual(result.optimizers, ())
        self.assertIsInstance(result.duration_ms, int)
        self.assertEqual(coordinator.snapshot_calls, [])

    async def test_run_returns_inputs_unavailable_without_bundle(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=None,
            snapshot_factory=_make_snapshot,
        )

        result = await _make_runner(
            coordinator,
            automation_config=_make_automation_config(_make_optimizer_instance()),
        ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "inputs_unavailable")
        self.assertIsNone(result.snapshot)
        self.assertEqual(result.optimizers, ())
        self.assertIsInstance(result.duration_ms, int)
        self.assertEqual(coordinator.snapshot_calls, [])

    async def test_run_returns_runner_failed_when_initial_snapshot_build_raises(
        self,
    ) -> None:
        def _raise_snapshot(**kwargs):
            raise RuntimeError("snapshot boom")

        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_raise_snapshot,
        )

        result = await _make_runner(
            coordinator,
            automation_config=_make_automation_config(_make_optimizer_instance()),
        ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="initial_snapshot",
                message="snapshot boom",
            ),
        )
        self.assertIsNone(result.snapshot)
        self.assertEqual(result.optimizers, ())
        self.assertEqual(coordinator.schedule.persist_calls, [])
        self.assertEqual(coordinator.schedule.reconcile_requests, [])

    async def test_run_returns_runner_failed_when_cleanup_persist_raises(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeRunDeps(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        coordinator.schedule.save = AsyncMock(
            side_effect=RuntimeError("cleanup write failed")
        )

        result = await _make_runner(
            coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="cleanup_persist",
                message="cleanup write failed",
            ),
        )
        self.assertEqual(coordinator.schedule.saved_documents, [])
        self.assertEqual(coordinator.schedule.reconcile_requests, [])

    async def test_run_returns_snapshot_and_is_repeatable(self) -> None:
        schedule_document = _make_schedule_document()
        coordinator = _FakeRunDeps(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        runner = _make_runner(
            coordinator,
            automation_config=_make_automation_config(_make_optimizer_instance()),
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            first = await runner.run(reference_time=REFERENCE_TIME)
            second = await runner.run(reference_time=REFERENCE_TIME)

        self.assertTrue(first.ran_automation)
        self.assertEqual(
            schedule_document_to_dict(first.snapshot.schedule),
            schedule_document_to_dict(schedule_document),
        )
        self.assertEqual(
            schedule_document_to_dict(second.snapshot.schedule),
            schedule_document_to_dict(schedule_document),
        )
        self.assertEqual(first.snapshot.adjusted_house_forecast["status"], "available")
        self.assertEqual(first.snapshot.battery_forecast["status"], "available")
        self.assertEqual(first.snapshot.grid_forecast["currentImportPrice"], 7.0)
        self.assertEqual(len(first.optimizers), 1)
        self.assertEqual(first.optimizers[0].status, "ok")
        self.assertGreaterEqual(first.duration_ms, 0)
        self.assertEqual(
            first.snapshot.context.when_active_hourly_energy_kwh_by_appliance_id,
            {"boiler": 1.25},
        )
        self.assertEqual(len(coordinator.snapshot_calls), 4)
        self.assertEqual(len(coordinator.schedule.persist_calls), 2)
        self.assertEqual(coordinator.schedule.reconcile_requests, [])

    async def test_run_builds_snapshot_from_stripped_working_schedule(self) -> None:
        next_slot_id = "2026-03-20T21:30:00+01:00"
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                    "boiler": {"on": True, "setBy": "user"},
                },
                next_slot_id: {
                    "inverter": {"kind": "normal"},
                },
            },
        )
        coordinator = _FakeRunDeps(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual(
            schedule_document_to_dict(result.snapshot.schedule),
            {
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "boiler": {"on": True, "setBy": "user"},
                    },
                    next_slot_id: {
                        "inverter": {"kind": "normal"},
                    },
                },
            },
        )
        self.assertEqual(
            schedule_document_to_dict(coordinator.snapshot_calls[0]["schedule_document"]),
            schedule_document_to_dict(result.snapshot.schedule),
        )
        self.assertEqual(
            schedule_document_to_dict(coordinator.snapshot_calls[1]["schedule_document"]),
            schedule_document_to_dict(result.snapshot.schedule),
        )

    async def test_run_cleans_up_automation_owned_actions_when_automation_disabled(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeRunDeps(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        result = await _make_runner(
            coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "cleanup_only")
        self.assertEqual(
            result.cleanup,
            AutomationCleanupSummary(
                reason="automation_disabled",
                actions_stripped=1,
            ),
        )
        self.assertEqual(len(coordinator.schedule.saved_documents), 1)
        self.assertEqual(
            schedule_document_to_dict(coordinator.schedule.saved_documents[0]),
            {
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {},
            },
        )
        self.assertEqual(
            coordinator.schedule.reconcile_requests,
            [("automation_updated", False)],
        )

    async def test_run_skips_cleanup_write_when_disabled_schedule_is_already_clean(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        result = await _make_runner(
            coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "automation_disabled")
        self.assertIsNone(result.cleanup)
        self.assertEqual(coordinator.schedule.saved_documents, [])
        self.assertEqual(coordinator.schedule.reconcile_requests, [])

    async def test_run_persists_single_optimizer_result_and_runs_side_effects_on_change(
        self,
    ) -> None:
        optimized_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
            persist_changed=True,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(optimized_schedule)
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual(len(coordinator.schedule.persist_calls), 1)
        self.assertEqual(
            schedule_document_to_dict(
                coordinator.schedule.persist_calls[0]["automation_result"]
            ),
            schedule_document_to_dict(optimized_schedule),
        )
        self.assertEqual(
            coordinator.schedule.reconcile_requests,
            [("automation_updated", False)],
        )
        self.assertEqual(len(coordinator.snapshot_calls), 2)
        self.assertEqual(
            result.optimizers,
            (
                OptimizerRunSummary(
                    id="avoid-negative-export",
                    kind="export_price",
                    status="ok",
                    slots_written=1,
                    duration_ms=result.optimizers[0].duration_ms,
                ),
            ),
        )
        self.assertEqual(
            schedule_document_to_dict(result.snapshot.schedule),
            schedule_document_to_dict(optimized_schedule),
        )

    async def test_run_multi_optimizer_rebuilds_snapshot_between_steps(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        first_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )

        def _build_optimizer_side_effect(config, *, control_config, appliance_registry):
            if config.id == "one":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(first_schedule))
                )

            def _second_optimize(snapshot, current_config, trace=None):
                self.assertEqual(
                    schedule_document_to_dict(snapshot.schedule),
                    schedule_document_to_dict(first_schedule),
                )
                return deepcopy(snapshot.schedule)

            return SimpleNamespace(optimize=Mock(side_effect=_second_optimize))

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=_build_optimizer_side_effect,
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        self.assertEqual(len(coordinator.snapshot_calls), 3)
        self.assertEqual(
            schedule_document_to_dict(result.snapshot.schedule),
            schedule_document_to_dict(first_schedule),
        )

    async def test_run_multi_optimizer_reuses_same_pinned_input_bundle_for_every_rebuild(
        self,
    ) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=lambda config, *, control_config, appliance_registry: SimpleNamespace(
                optimize=Mock(
                    side_effect=lambda snapshot, current_config, trace=None: deepcopy(
                        snapshot.schedule
                    )
                )
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        self.assertEqual(len(coordinator.snapshot_calls), 3)
        self.assertIs(
            coordinator.snapshot_calls[0]["input_bundle"],
            coordinator.snapshot_calls[1]["input_bundle"],
        )
        self.assertIs(
            coordinator.snapshot_calls[1]["input_bundle"],
            coordinator.snapshot_calls[2]["input_bundle"],
        )
        self.assertEqual(
            coordinator.snapshot_calls[0]["input_bundle"].original_house_forecast,
            coordinator.snapshot_calls[2]["input_bundle"].original_house_forecast,
        )

    async def test_run_multi_optimizer_later_result_wins_before_persist(self) -> None:
        first_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        final_schedule = ScheduleDocument(execution_enabled=True)
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
            persist_changed=True,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=[
                SimpleNamespace(optimize=Mock(return_value=deepcopy(first_schedule))),
                SimpleNamespace(optimize=Mock(return_value=deepcopy(final_schedule))),
            ],
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        self.assertEqual(len(coordinator.schedule.persist_calls), 1)
        self.assertEqual(
            schedule_document_to_dict(
                coordinator.schedule.persist_calls[0]["automation_result"]
            ),
            schedule_document_to_dict(final_schedule),
        )
        self.assertEqual(
            schedule_document_to_dict(result.snapshot.schedule),
            schedule_document_to_dict(final_schedule),
        )

    async def test_run_fails_and_persists_nothing_when_appliance_rails_unavailable(
        self,
    ) -> None:
        """#272 (P2 of #270): with no baseline to fall back to, a
        ``ConditionRailsUnavailable`` for an appliance escalates to the
        existing run-failure path rather than restoring that appliance's lane
        and continuing — persisting it empty would silently erase a required
        appliance schedule on a transient forecast gap. The previous complete
        schedule is left standing.
        """
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "boiler": {"on": True, "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeRunDeps(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(
                    side_effect=ConditionRailsUnavailable(
                        "boiler",
                        "when-active demand is unavailable",
                    )
                )
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(
                        optimizer_id="run-boiler-on-surplus",
                        kind="appliance_runtime",
                        target={"controllable_id": "boiler"},
                        params={},
                    )
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(len(result.optimizers), 1)
        self.assertEqual(result.optimizers[0].status, "failed")
        self.assertEqual(result.optimizers[0].error, "when-active demand is unavailable")
        # Nothing persisted: the previous good record stands.
        self.assertEqual(coordinator.schedule.persist_calls, [])
        self.assertEqual(coordinator.schedule.reconcile_requests, [])
        # The "optimizer_skipped" note stays visible on the failed run's trace.
        step = trace_rows_payload(result.trace)["steps"][0]
        self.assertEqual(step["status"], "skipped")

    async def test_run_returns_failure_when_optimizer_raises(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=RuntimeError("boom"))
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(result.message, "boom")
        self.assertEqual(len(result.optimizers), 1)
        self.assertEqual(result.optimizers[0].status, "failed")
        self.assertEqual(result.optimizers[0].error, "boom")
        self.assertEqual(coordinator.schedule.persist_calls, [])
        self.assertEqual(coordinator.schedule.reconcile_requests, [])

    async def test_run_returns_failure_when_optimizer_construction_raises(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=ValueError("bad target"),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(result.message, "bad target")
        self.assertEqual(len(result.optimizers), 1)
        self.assertEqual(result.optimizers[0].status, "failed")
        self.assertEqual(result.optimizers[0].error, "bad target")
        self.assertEqual(len(coordinator.snapshot_calls), 1)
        self.assertIsNotNone(result.snapshot)
        self.assertEqual(coordinator.schedule.persist_calls, [])
        self.assertEqual(coordinator.schedule.reconcile_requests, [])

    async def test_run_returns_runner_failed_when_final_persist_raises(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        coordinator.schedule.persist_automation_result = AsyncMock(
            side_effect=RuntimeError("persist boom")
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule))
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="final_persist",
                message="persist boom",
            ),
        )
        self.assertIsNotNone(result.snapshot)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok"])
        self.assertEqual(coordinator.schedule.reconcile_requests, [])

    async def test_run_returns_runner_failed_when_post_write_side_effects_raise(
        self,
    ) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
            persist_changed=True,
        )
        coordinator.schedule.request_reconcile = Mock(
            side_effect=RuntimeError("side effects boom")
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule))
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="post_write_side_effects",
                message="side effects boom",
            ),
        )
        self.assertIsNotNone(result.snapshot)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok"])

    async def test_run_preserves_cleanup_metadata_when_cleanup_post_write_fails(
        self,
    ) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeRunDeps(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        coordinator.schedule.request_reconcile = Mock(
            side_effect=RuntimeError("cleanup side effects boom")
        )

        result = await _make_runner(
            coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="post_write_side_effects",
                message="cleanup side effects boom",
            ),
        )
        self.assertEqual(
            result.cleanup,
            AutomationCleanupSummary(
                reason="automation_disabled",
                actions_stripped=1,
            ),
        )

    async def test_run_does_not_persist_when_later_optimizer_raises(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        first_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=[
                SimpleNamespace(optimize=Mock(return_value=deepcopy(first_schedule))),
                SimpleNamespace(optimize=Mock(side_effect=RuntimeError("boom after first"))),
            ],
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(result.message, "boom after first")
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "failed"])
        self.assertEqual(result.optimizers[1].error, "boom after first")
        self.assertEqual(coordinator.schedule.persist_calls, [])
        self.assertEqual(coordinator.schedule.reconcile_requests, [])
        self.assertEqual(len(coordinator.snapshot_calls), 2)

    async def test_run_rebuilds_even_when_optimizer_returns_unchanged_document(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=lambda config, *, control_config, appliance_registry: SimpleNamespace(
                optimize=Mock(
                    side_effect=lambda snapshot, current_config, trace=None: deepcopy(
                        snapshot.schedule
                    )
                )
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        self.assertEqual(len(coordinator.snapshot_calls), 3)
        self.assertEqual(len(coordinator.schedule.persist_calls), 1)


class AutomationRunnerTraceTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_run_attaches_trace_with_expected_shape(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertIsNotNone(result.trace)
        self.assertEqual(result.trace.slot_ids, tuple(iter_horizon_slot_ids(REFERENCE_TIME)))
        step = result.trace._steps[0]
        self.assertEqual(step.optimizer_id, "avoid-negative-export")
        self.assertEqual(step.status, "ok")

    async def test_committed_write_is_retained_without_an_optimizer_explanation(self) -> None:
        # A mocked optimizer supplies no explanation; actual writes still come
        # from the framework diff and the run completes.
        written_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "boiler": {"on": True, "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(written_schedule)
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        step = trace_rows_payload(result.trace)["steps"][0]
        self.assertEqual(step["status"], "ok")
        self.assertTrue(step["writes"])

    async def test_appliance_write_records_serialize_before_and_after(self) -> None:
        # An optimizer that turns the boiler on for the current slot -> the
        # framework write diff must record the appliance dict, not null.
        written_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "boiler": {"on": True, "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(written_schedule)
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(
                        optimizer_id="run-boiler",
                        kind="appliance_runtime",
                        params={"appliance_id": "boiler", "action": "on"},
                        target={"controllable_id": "boiler"},
                    )
                ),
            ).run(reference_time=REFERENCE_TIME)

        writes = trace_rows_payload(result.trace)["steps"][0]["writes"]
        boiler_writes = [w for w in writes if w["domain"] == "boiler"]
        self.assertEqual(len(boiler_writes), 1)
        self.assertIsNone(boiler_writes[0]["before"])
        self.assertEqual(
            boiler_writes[0]["after"], {"on": True, "setBy": "automation"}
        )

    async def test_completed_run_hands_the_coordinator_a_run_explanation(
        self,
    ) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(len(coordinator.recorded_explanations), 1)
        explanation = coordinator.recorded_explanations[0]
        self.assertEqual(explanation.run_at, REFERENCE_TIME)
        self.assertEqual(
            list(explanation.slot_ids), iter_horizon_slot_ids(REFERENCE_TIME)
        )
        self.assertEqual(
            [optimizer.optimizer_id for optimizer in explanation.optimizers],
            ["avoid-negative-export"],
        )

    async def test_the_run_explanation_carries_each_step_s_lane(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            await _make_runner(
                coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(),
                    _make_optimizer_instance(
                        optimizer_id="run-boiler",
                        kind="appliance_runtime",
                        params={"appliance_id": "boiler", "action": "on"},
                        target={"controllable_id": "boiler"},
                    ),
                ),
            ).run(reference_time=REFERENCE_TIME)

        explanation = coordinator.recorded_explanations[0]
        # Only phases 2 and 3 are traced (#272, P2 of #270): the system
        # optimizer ("inverter") is phase 2, the appliance one ("boiler")
        # runs again in phase 3 — its phase-1 pass is untraced.
        self.assertEqual(
            [optimizer.controllable_id for optimizer in explanation.optimizers],
            ["inverter", "boiler"],
        )
        self.assertEqual(
            [optimizer.phase for optimizer in explanation.optimizers], [2, 3]
        )

    async def test_a_failed_run_records_no_explanation(self) -> None:
        # The previous good record must stand: a run that blew up mid-loop has
        # nothing trustworthy to say about the slots it never reached.
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=RuntimeError("boom"))
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(coordinator.recorded_explanations, [])

    async def test_optimizer_failure_still_attaches_partial_trace(self) -> None:
        coordinator = _FakeRunDeps(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=RuntimeError("boom"))
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertIsNotNone(result.trace)
        self.assertEqual(len(result.trace._steps), 1)
        self.assertEqual(result.trace._steps[0].status, "failed")

    async def test_surplus_failure_retains_skipped_step_status(
        self,
    ) -> None:
        """#272 (P2 of #270): the run fails (see the persists-nothing test
        above), but the trace it reports still carries the collapsed
        single-note column for the appliance whose rails were unavailable —
        the "optimizer_skipped" visibility the issue asks to keep.
        """
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "boiler": {"on": True, "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeRunDeps(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(
                    side_effect=ConditionRailsUnavailable(
                        "boiler",
                        "when-active demand is unavailable",
                    )
                )
            ),
        ):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(
                        optimizer_id="run-boiler-on-surplus",
                        kind="appliance_runtime",
                        target={"controllable_id": "boiler"},
                        params={},
                    )
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "optimizer_failed")
        self.assertIsNotNone(result.trace)
        step = trace_rows_payload(result.trace)["steps"][0]
        self.assertEqual(step["status"], "skipped")
        self.assertEqual(step["writes"], [])


from automation_trace_contract import trace_rows_payload
