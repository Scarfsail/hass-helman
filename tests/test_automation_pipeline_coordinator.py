from __future__ import annotations

from automation_pipeline_support import *

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

        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=build_snapshot,
        )
        with patch.object(assembly, "build_forecast_rebuild", return_value=rebuild):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(result.failure.stage, "initial_snapshot")
        self.assertIn("status='unavailable'", result.failure.message)
        self.assertIn(CURRENT_SLOT_ID, result.failure.message)
        self.assertIsNone(result.snapshot)
        self.assertEqual(result.optimizers, ())
        self.assertEqual(coordinator.persist_calls, [])
        self.assertEqual(coordinator.post_write_calls, [])

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

    async def test_build_automation_snapshot_locked_populates_context_from_bundle(self) -> None:
        coordinator = make_coordinator()
        coordinator._hass = _make_executor_hass()
        coordinator._active_config = {}
        coordinator._appliances_registry.current = AppliancesRuntimeRegistry()
        # The async wrapper gathers the run-invariant inputs once, then delegates
        # to the pure snapshot builder (which reads the battery state from the
        # gathered ComputeInputs and calls the pure rebuild core).
        rebuild = assembly.ForecastRebuildSnapshot(
            adjusted_house_forecast={"status": "available"},
            battery_forecast={"status": "available"},
            projection_plan=SimpleNamespace(generated_at=REFERENCE_TIME.isoformat()),
            grid_forecast={"status": "available", "currentImportPrice": 7.0},
        )
        coordinator._async_gather_compute_inputs = AsyncMock(
            return_value=ComputeInputs(
                battery_live_state=BatteryLiveState(
                    current_remaining_energy_kwh=7.5,
                    current_soc=50.0,
                    min_soc=10.0,
                    max_soc=90.0,
                    nominal_capacity_kwh=15.0,
                    min_energy_kwh=1.5,
                    max_energy_kwh=13.5,
                ),
            )
        )

        with patch.object(assembly, "build_forecast_rebuild", return_value=rebuild):
            for status in ("available", "partial"):
                with self.subTest(status=status):
                    rebuild.battery_forecast["status"] = status
                    snapshot = await coordinator._build_automation_snapshot_from_schedule_locked(
                        schedule_document=_make_schedule_document(),
                        input_bundle=_make_automation_bundle(),
                        reference_time=REFERENCE_TIME,
                    )
                    self.assertEqual(snapshot.battery_forecast["status"], status)

        self.assertEqual(snapshot.schedule, _make_schedule_document())
        self.assertEqual(snapshot.context.import_price_forecast["currentPrice"], 7.0)
        self.assertEqual(snapshot.context.export_price_forecast["currentPrice"], 2.5)
        self.assertEqual(
            snapshot.context.when_active_hourly_energy_kwh_by_appliance_id,
            {"boiler": 1.25},
        )
        self.assertEqual(snapshot.context.battery_state.current_soc, 50.0)
        # One executor hop per snapshot build (two statuses were exercised).
        self.assertEqual(len(coordinator._hass.executor_hops), 2)
        self.assertEqual(
            {hop.func for hop in coordinator._hass.executor_hops},
            {coordinator._build_automation_snapshot_from_schedule_pure},
        )


class CoordinatorRunAutomationFailureTests(unittest.IsolatedAsyncioTestCase):
    """What ``run_automation`` returns when the runner escapes.

    An exception that gets past the runner must still come back as a structured
    ``runner_failed`` result rather than propagating to the caller.
    """

    async def test_run_automation_returns_runner_failed_when_runner_escapes(
        self,
    ) -> None:
        coordinator = make_coordinator()
        coordinator._active_config = {}
        # Recording a run also announces the new plan on the bus, so every run
        # path -- including the escaped-failure one -- needs a bus to fire on.
        coordinator._hass = SimpleNamespace(
            bus=SimpleNamespace(async_fire=lambda event_type, event_data=None: None)
        )

        class _FailingRunner:
            def __init__(self, *, coordinator, automation_config) -> None:
                pass

            async def run(self, *, reference_time=None, run_reason=None):
                raise RuntimeError("escaped runner failure")

        with (
            patch.object(coordinator_module, "read_automation_config", return_value=None),
            patch.object(pipeline_module, "AutomationRunner", _FailingRunner),
        ):
            result = await coordinator.run_automation(
                reference_time=REFERENCE_TIME,
                reason="trigger",
            )

        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="coordinator",
                message="escaped runner failure",
            ),
        )
        self.assertIsInstance(result.duration_ms, int)


