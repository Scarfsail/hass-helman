from __future__ import annotations

from automation_pipeline_support import *

import functools

from _fakes import FakeExecutor, FakeStorage

from custom_components.helman.forecast import assembly


class CoordinatorAutomationSnapshotTests(unittest.IsolatedAsyncioTestCase):
    async def test_unusable_battery_rebuild_aborts_runner_before_persistence(self) -> None:
        rebuild = assembly.ForecastRebuildSnapshot(
            adjusted_house_forecast={
                "status": "available",
                "currentSlot": {"timestamp": CURRENT_SLOT_ID},
            },
            battery_forecast={"status": "unavailable", "series": []},
            projection_plan=SimpleNamespace(),
            grid_forecast={"status": "unavailable", "series": []},
        )

        def build_snapshot(**kwargs):
            return assembly.build_automation_snapshot(
                **kwargs,
                config={},
                control_config=None,
                appliances_registry=AppliancesRuntimeRegistry(),
                compute_inputs=ComputeInputs(),
            )

        coordinator = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=build_snapshot,
        )
        with patch.object(assembly, "build_forecast_rebuild", return_value=rebuild):
            result = await _make_runner(
                coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(result.failure.stage, "initial_snapshot")
        self.assertIn("status='unavailable'", result.failure.message)
        self.assertIn(CURRENT_SLOT_ID, result.failure.message)
        self.assertIsNone(result.snapshot)
        self.assertEqual(result.optimizers, ())
        self.assertEqual(coordinator.schedule.persist_calls, [])
        self.assertEqual(coordinator.schedule.reconcile_requests, [])

    async def test_async_build_forecast_rebuild_uses_pinned_inputs_and_composes_grid(self) -> None:
        coordinator = make_coordinator()
        coordinator._hass = _make_executor_hass()
        coordinator._active_config = {}
        coordinator._appliances_registry.current = AppliancesRuntimeRegistry()
        build_battery_forecast = Mock(
            return_value={
                "status": "available",
                "generatedAt": REFERENCE_TIME.isoformat(),
                "startedAt": REFERENCE_TIME.isoformat(),
                "sourceGranularityMinutes": 15,
                "series": [
                    {
                        "timestamp": CURRENT_SLOT_ID,
                        "durationHours": 0.25,
                        "importedFromGridKwh": 1.4,
                        "exportedToGridKwh": 0.2,
                    }
                ],
            }
        )
        projection_plan = SimpleNamespace(
            generated_at=REFERENCE_TIME.isoformat(),
            appliances_by_id={},
            demand_points=(),
        )
        pinned_inputs = {"boiler": 1.25}
        original_house_forecast = {
            "status": "available",
            "generatedAt": REFERENCE_TIME.isoformat(),
            "series": [],
        }
        adjusted_house_forecast = {
            "status": "available",
            "generatedAt": REFERENCE_TIME.isoformat(),
            "series": [{"timestamp": CURRENT_SLOT_ID, "value": 3.0}],
        }

        with (
            patch.object(
                assembly,
                "build_projection_input_bundle",
                return_value={"projection": "bundle"},
            ),
            patch.object(
                assembly,
                "build_appliance_projection_plan",
                return_value=projection_plan,
            ) as build_projection_plan,
            patch.object(
                assembly,
                "build_adjusted_house_forecast",
                return_value=adjusted_house_forecast,
            ),
            patch.object(
                assembly,
                "build_schedule_forecast_overlay",
                return_value={"overlay": True},
            ),
            patch.object(
                assembly.BatteryCapacityForecastBuilder,
                "build_with_history",
                build_battery_forecast,
            ),
        ):
            result = await coordinator._async_build_forecast_rebuild(
                solar_forecast={"status": "available", "points": []},
                original_house_forecast=original_house_forecast,
                started_at=REFERENCE_TIME,
                forecast_schedule_document=_make_schedule_document(),
                projection_schedule_document=_make_schedule_document(),
                when_active_hourly_energy_kwh_by_appliance_id=pinned_inputs,
                grid_price_forecast=_make_grid_price_response(),
            )

        build_projection_plan.assert_called_once_with(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=coordinator._appliances_registry.current,
            schedule_document=_make_schedule_document(),
            inputs={"projection": "bundle"},
            hass=None,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id=pinned_inputs,
            vehicle_remaining_capacity_kwh_by_vehicle_id={},
        )
        build_battery_forecast.assert_called_once_with(
            solar_forecast={"status": "available", "points": []},
            house_forecast=adjusted_house_forecast,
            started_at=REFERENCE_TIME,
            forecast_days=MAX_FORECAST_DAYS,
            schedule_overlay={"overlay": True},
            live_state=None,
            actual_history=[],
        )
        self.assertEqual(result.adjusted_house_forecast, adjusted_house_forecast)
        self.assertEqual(result.grid_forecast["status"], "available")
        self.assertEqual(
            result.grid_forecast["series"][0]["importedFromGridKwh"],
            1.4,
        )
        # The simulation is pure CPU: it goes to the executor, not the loop.
        self.assertEqual(len(coordinator._hass.executor_hops), 1)
        self.assertIs(
            coordinator._hass.executor_hops[0].func,
            assembly.build_forecast_rebuild,
        )

    async def test_initial_snapshot_is_built_off_loop_from_the_bundle_and_live_inputs(
        self,
    ) -> None:
        # The runner builds its initial snapshot with the assembly function it
        # was handed, in the executor, from the gathered live inputs.
        rebuild = assembly.ForecastRebuildSnapshot(
            adjusted_house_forecast={"status": "available"},
            battery_forecast={"status": "available"},
            projection_plan=SimpleNamespace(generated_at=REFERENCE_TIME.isoformat()),
            grid_forecast={"status": "available", "currentImportPrice": 7.0},
        )
        deps = _FakeRunDeps(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=None,
        )
        battery_state = BatteryLiveState(
            current_remaining_energy_kwh=7.5,
            current_soc=50.0,
            min_soc=10.0,
            max_soc=90.0,
            nominal_capacity_kwh=15.0,
            min_energy_kwh=1.5,
            max_energy_kwh=13.5,
        )
        deps.gather_compute_inputs = AsyncMock(
            return_value=ComputeInputs(
                battery_live_state=battery_state,
                appliances_registry=AppliancesRuntimeRegistry(),
            )
        )
        executor_hops: list[object] = []

        async def run_in_executor(func, *args):
            executor_hops.append(func)
            return func(*args)

        runner = AutomationRunner(
            automation_config=_make_automation_config(_make_optimizer_instance()),
            schedule=deps.schedule,
            forecast=deps,
            recorder=deps,
            build_snapshot=functools.partial(
                assembly.build_automation_snapshot, config={}
            ),
            read_control_config=lambda: None,
            run_in_executor=run_in_executor,
        )
        with (
            patch.object(assembly, "build_forecast_rebuild", return_value=rebuild),
            # Stop right after the initial snapshot: a failed optimizer reports
            # the snapshot it was handed.
            patch.object(
                pipeline_module, "build_optimizer", side_effect=ValueError("stop")
            ),
        ):
            result = await runner.run(reference_time=REFERENCE_TIME)

        deps.gather_compute_inputs.assert_awaited_once_with(
            started_at=REFERENCE_TIME, include_condition_flags=True
        )
        snapshot = result.snapshot
        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(snapshot.schedule, _make_schedule_document())
        self.assertEqual(snapshot.context.import_price_forecast["currentPrice"], 7.0)
        self.assertEqual(snapshot.context.export_price_forecast["currentPrice"], 2.5)
        self.assertEqual(
            snapshot.context.when_active_hourly_energy_kwh_by_appliance_id,
            {"boiler": 1.25},
        )
        self.assertIs(snapshot.context.battery_state, battery_state)
        # The initial snapshot hop, then the optimizer loop's own.
        self.assertEqual(len(executor_hops), 2)
        self.assertEqual(executor_hops[0].func.__name__, "_snapshot_for")
        self.assertIs(executor_hops[1].func, pipeline_module.run_optimizer_loop_pure)


class CoordinatorRunAutomationTests(unittest.IsolatedAsyncioTestCase):
    """``run_automation`` runs against the coordinator's own schedule service."""

    async def test_disabled_automation_strips_owned_actions_and_requests_execution(
        self,
    ) -> None:
        storage = FakeStorage(
            schedule_document={
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "stop_export", "setBy": "automation"},
                    },
                },
            }
        )
        coordinator = make_coordinator(_storage=storage)
        coordinator._active_config = {}
        coordinator._hass.async_add_executor_job = _FakeRunDeps.run_in_executor
        executor = FakeExecutor()
        coordinator.schedule.executor = executor

        result = await coordinator.run_automation(
            reference_time=REFERENCE_TIME, reason="trigger"
        )

        self.assertEqual(result.reason, "cleanup_only")
        self.assertEqual(
            result.cleanup,
            AutomationCleanupSummary(reason="automation_disabled", actions_stripped=1),
        )
        self.assertEqual(storage.schedule_document["slots"], {})
        self.assertEqual(executor.requested_reconciles, ["automation_updated"])
        self.assertFalse(coordinator.schedule._lock.locked())

    async def test_run_automation_returns_runner_failed_when_control_config_read_raises(
        self,
    ) -> None:
        coordinator = make_coordinator(
            _storage=FakeStorage(
                schedule_document={
                    "executionEnabled": True,
                    "slotMinutes": SCHEDULE_SLOT_MINUTES,
                    "slots": {},
                }
            )
        )
        coordinator._active_config = {}
        coordinator._hass.async_add_executor_job = _FakeRunDeps.run_in_executor
        coordinator._record_automation_run = Mock()

        with patch.object(
            coordinator,
            "_read_schedule_control_config",
            side_effect=ValueError("malformed inverter mode config"),
        ):
            result = await coordinator.run_automation(
                reference_time=REFERENCE_TIME, reason="trigger"
            )

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(result.failure.stage, "baseline_schedule")
        self.assertIn("malformed inverter mode config", result.failure.message)
        coordinator._record_automation_run.assert_called_once_with(result)
        self.assertFalse(coordinator.schedule._lock.locked())
