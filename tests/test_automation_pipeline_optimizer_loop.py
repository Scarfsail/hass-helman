from __future__ import annotations

from automation_pipeline_support import *


class _RecordingOptimizer:
    """Deterministic fake optimizer: records the snapshots it is handed and
    returns a fixed schedule document. Lets the pure loop be exercised without
    any real optimizer internals (or hass)."""

    def __init__(self, result_document: ScheduleDocument) -> None:
        self._result_document = result_document
        self.seen_snapshots: list[OptimizationSnapshot] = []

    def optimize(self, snapshot, config, trace):
        self.seen_snapshots.append(snapshot)
        return self._result_document


def _summary_signature(summary: OptimizerRunSummary) -> dict[str, object]:
    # Drop the wall-clock duration, which legitimately differs run to run.
    return {
        key: value
        for key, value in vars(summary).items()
        if key != "duration_ms"
    }


def _run_pure_loop(build_snapshot) -> _PipelineExecutionResult:
    optimizers = [
        _make_optimizer_instance(optimizer_id="a"),
        _make_optimizer_instance(optimizer_id="b"),
    ]
    with patch.object(
        pipeline_module,
        "build_optimizer",
        return_value=_RecordingOptimizer(_make_schedule_document()),
    ):
        return run_optimizer_loop_pure(
            appliance_optimizers=(),
            system_optimizers=optimizers,
            schedule_document=_make_schedule_document(),
            initial_snapshot=_make_snapshot(),
            reference_time=REFERENCE_TIME,
            control_config=None,
            appliance_registry=AppliancesRuntimeRegistry(),
            build_snapshot=build_snapshot,
        )


#: A midday timestamp, so the local date is the same whatever timezone
#: ``dt_util`` is configured with when this module runs alone.
_DAY_CONTEXT_DATE = REFERENCE_TIME.date()
_DAY_CONTEXT_NOON = datetime.fromisoformat("2026-03-20T12:00:00+01:00")


def _day_context_snapshot(*, house_kwh_per_slot: float) -> OptimizationSnapshot:
    """A snapshot the day-context builder can actually classify.

    Solar is fixed; the house figure is what the two optimizers disagree about,
    because one of them is re-planning the lane the other one reads as demand.
    """
    base = _make_snapshot()
    points = [
        {
            "timestamp": (_DAY_CONTEXT_NOON + timedelta(minutes=15 * index)).isoformat(),
            "value": 2.0,
        }
        for index in range(4)
    ]
    return replace(
        base,
        battery_forecast={
            **base.battery_forecast,
            "series": [
                {
                    "timestamp": (
                        _DAY_CONTEXT_NOON + timedelta(minutes=15 * index)
                    ).isoformat(),
                    "solarKwh": 2.5,
                    "baselineHouseKwh": house_kwh_per_slot,
                }
                for index in range(4)
            ],
        },
        context=replace(
            base.context,
            inputs=replace(
                base.context.inputs,
                grid_price_forecast={
                    "export": {**base.context.export_price_forecast, "points": points},
                    "import": {**base.context.import_price_forecast, "points": points},
                },
            ),
        ),
    )


class PerOptimizerDayContextTests(unittest.TestCase):
    """Two optimizers, one calendar day, two bands — by design (#264).

    Under the phased pipeline (#272, P2 of #270), phase 1's appliance reads
    the bare initial house view; ``charge_hold`` (phase 2) reads whatever
    phase 1's own rebuild produced. The classification follows each of those
    views rather than being computed once up front.
    """

    def test_each_optimizer_sees_the_band_of_its_own_house_view(self) -> None:
        charge_hold = _make_optimizer_instance(
            optimizer_id="charge-hold", kind="charge_hold"
        )
        filtration = _make_optimizer_instance(
            optimizer_id="pool-filtration",
            kind="appliance_runtime",
            target={"controllable_id": "pool"},
        )
        pool_snapshots: list[OptimizationSnapshot] = []

        def _build_optimizer(config, **kwargs):
            if config.id == "pool-filtration":
                optimizer = _RecordingOptimizer(_make_schedule_document())
                original_optimize = optimizer.optimize

                def _optimize(snapshot, cfg, trace):
                    pool_snapshots.append(snapshot)
                    return original_optimize(snapshot, cfg, trace)

                optimizer.optimize = _optimize
                return optimizer
            return _RecordingOptimizer(_make_schedule_document())

        resolver = DayContextResolver(
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
            solar_actual_history=[],
            house_actual_history=[],
            previous_bands={},
        )
        with patch.object(
            pipeline_module, "build_optimizer", side_effect=_build_optimizer
        ):
            result = run_optimizer_loop_pure(
                appliance_optimizers=(filtration,),
                system_optimizers=(charge_hold,),
                schedule_document=_make_schedule_document(),
                # Phase 1's filtration sees this bare initial view directly.
                initial_snapshot=_day_context_snapshot(house_kwh_per_slot=3.0),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                # Every rebuild after phase 1's own step (feeding phase 2's
                # charge-hold, and phase 3's re-plan of filtration) sees this.
                build_snapshot=lambda document: _day_context_snapshot(
                    house_kwh_per_slot=5.0
                ),
                resolve_day_contexts=resolver,
            )

        # pool_snapshots[0] is phase 1 (untraced, the bare initial view);
        # pool_snapshots[1] is phase 3 (traced, after phase 2's rebuild).
        self.assertEqual(len(pool_snapshots), 2)
        phase1_context = pool_snapshots[0]
        # 10 kWh of solar against 12 kWh of house (phase 1), then against 20
        # kWh (phase 2/3): the same shape as the day in #264, where the
        # appliance's own load sat in the denominator deciding whether it
        # could run.
        self.assertEqual(
            phase1_context.context.day_contexts[_DAY_CONTEXT_DATE].classification,
            "tight",
        )
        self.assertEqual(
            phase1_context.context.day_contexts[
                _DAY_CONTEXT_DATE
            ].denominator_optimizer_id,
            "pool-filtration",
        )
        # Phase 1 emits no day band -- only phase 2 (charge-hold) and phase 3
        # (filtration, re-planning against the phase-2 rebuild) do.
        self.assertEqual(
            result.emitted_day_bands,
            {
                (_DAY_CONTEXT_DATE, "charge-hold"): "deficit",
                (_DAY_CONTEXT_DATE, "pool-filtration"): "deficit",
            },
        )
        # The canonical reading the run reports (#272, P2 of #270): the final
        # plan, whole house, appliances placed -- not phase 1's bare initial
        # view. Phase 1 alone reads "tight" (see above); the final snapshot
        # reads "deficit", the same band phase 2 and phase 3 actually saw.
        self.assertEqual(
            result.snapshot.context.day_contexts[_DAY_CONTEXT_DATE].classification,
            "deficit",
        )

    def test_the_previous_band_of_the_same_optimizer_damps_the_new_one(self) -> None:
        """Hysteresis is keyed by optimizer, not only by day.

        A ratio of 0.667 is below the deficit threshold outright, so only the
        band this same optimizer emitted last run can hold it at tight.
        """
        optimizers = [
            _make_optimizer_instance(optimizer_id="charge-hold", kind="charge_hold")
        ]
        resolver = DayContextResolver(
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
            solar_actual_history=[],
            house_actual_history=[],
            previous_bands={(_DAY_CONTEXT_DATE, "charge-hold"): "tight"},
        )
        seen: list[_RecordingOptimizer] = []

        def _build_optimizer(config, **kwargs):
            optimizer = _RecordingOptimizer(_make_schedule_document())
            seen.append(optimizer)
            return optimizer

        with patch.object(
            pipeline_module, "build_optimizer", side_effect=_build_optimizer
        ):
            result = run_optimizer_loop_pure(
                appliance_optimizers=(),
                system_optimizers=optimizers,
                schedule_document=_make_schedule_document(),
                initial_snapshot=_day_context_snapshot(house_kwh_per_slot=3.75),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=lambda document: _day_context_snapshot(
                    house_kwh_per_slot=3.75
                ),
                resolve_day_contexts=resolver,
            )

        self.assertEqual(
            seen[0].seen_snapshots[0].context.day_contexts[
                _DAY_CONTEXT_DATE
            ].classification,
            "tight",
        )
        self.assertEqual(
            result.emitted_day_bands,
            {(_DAY_CONTEXT_DATE, "charge-hold"): "tight"},
        )


class RunOptimizerLoopPurityTests(unittest.TestCase):
    """The optimizer loop is offloaded to an executor thread, so it must be a
    pure function of its inputs: no ``hass`` access, no ``await``."""

    def test_source_has_no_await_and_no_hass_reference(self) -> None:
        func = ast.parse(inspect.getsource(run_optimizer_loop_pure)).body[0]
        self.assertFalse(
            any(isinstance(node, ast.Await) for node in ast.walk(func)),
            "run_optimizer_loop_pure must not await",
        )
        referenced = {
            node.id for node in ast.walk(func) if isinstance(node, ast.Name)
        } | {
            node.attr for node in ast.walk(func) if isinstance(node, ast.Attribute)
        }
        self.assertFalse(
            any("hass" in name.lower() for name in referenced),
            "run_optimizer_loop_pure must not touch hass",
        )

    def test_runs_in_worker_thread_without_hass(self) -> None:
        rebuilt_documents: list[ScheduleDocument] = []

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            rebuilt_documents.append(document)
            return _make_snapshot(schedule_document=document)

        # Run in a real worker thread with no event loop and no hass in scope —
        # if the loop reached for either it would fail here.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            result = executor.submit(_run_pure_loop, build_snapshot).result()

        self.assertIsInstance(result, _PipelineExecutionResult)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        # The snapshot is rebuilt once per optimizer via the injected pure builder.
        self.assertEqual(len(rebuilt_documents), 2)


class OptimizerLoopExecutorEquivalenceTests(unittest.IsolatedAsyncioTestCase):
    """Moving the loop across the executor boundary must not change its result."""

    async def test_executor_hop_matches_inline(self) -> None:
        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            return _make_snapshot(schedule_document=document)

        inline_result = _run_pure_loop(build_snapshot)

        loop = asyncio.get_running_loop()
        executor_result = await loop.run_in_executor(
            None, lambda: _run_pure_loop(build_snapshot)
        )

        self.assertEqual(
            inline_result.working_schedule_document,
            executor_result.working_schedule_document,
        )
        self.assertEqual(
            [_summary_signature(s) for s in inline_result.optimizers],
            [_summary_signature(s) for s in executor_result.optimizers],
        )
        self.assertEqual(
            trace_rows_payload(inline_result.trace),
            trace_rows_payload(executor_result.trace),
        )

from automation_trace_contract import trace_rows_payload
