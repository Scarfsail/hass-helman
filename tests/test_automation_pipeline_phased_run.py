from __future__ import annotations

from automation_pipeline_support import *
from custom_components.helman.scheduling.schedule import SlotAction


def _make_appliance_optimizer_instance(
    *,
    optimizer_id: str,
    controllable_id: str,
) -> OptimizerInstanceConfig:
    return _make_optimizer_instance(
        optimizer_id=optimizer_id,
        kind="appliance_runtime",
        target={"controllable_id": controllable_id},
        params={"daily_minimum": {"hours": 1.0}},
    )


class PhasedRunTests(unittest.IsolatedAsyncioTestCase):
    """#272 (P2 of #270): the three-phase replacement for the old
    baseline-restore machinery (#116's original fix).

    Phase 1 (appliance, untraced) plans every appliance against no inverter
    action. Phase 2 (system, traced) reads the whole phase-1 appliance demand.
    Phase 3 (appliance, traced) re-plans each appliance against earlier
    phase-3 appliances plus the phase-2 inverter plan.
    """

    APPLIANCE_ACTION = {"on": True, "setBy": "automation"}
    INVERTER_ACTION = {"kind": "stop_charging", "setBy": "automation"}

    def _baseline_document(self) -> ScheduleDocument:
        return ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": dict(self.INVERTER_ACTION),
                    "pool-filtration": dict(self.APPLIANCE_ACTION),
                }
            },
        )

    def _optimizers(self) -> tuple[OptimizerInstanceConfig, ...]:
        return (
            _make_optimizer_instance(optimizer_id="charge-hold", kind="charge_hold"),
            _make_appliance_optimizer_instance(
                optimizer_id="pool", controllable_id="pool-filtration"
            ),
        )

    async def test_cold_start_sizes_charge_hold_against_full_appliance_demand(
        self,
    ) -> None:
        """The #116 assertion, now with no baseline present (G1's cold-start
        fix): with nothing stored from a previous run at all, phase 1 still
        places the appliance for real before ``charge_hold`` (phase 2) ever
        reads the house.
        """
        coordinator = _FakeCoordinator(
            # No prior plan whatsoever -- true cold start.
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        appliance_plan = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "pool-filtration": dict(self.APPLIANCE_ACTION),
                }
            },
        )
        charge_hold_seen: list[OptimizationSnapshot] = []

        def _build_optimizer_side_effect(config, *, control_config, appliance_registry):
            if config.id == "pool":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(appliance_plan))
                )

            def _charge_hold_optimize(snapshot, current_config, trace=None):
                charge_hold_seen.append(snapshot)
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_charge_hold_optimize))

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=_build_optimizer_side_effect,
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(*self._optimizers()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual(len(charge_hold_seen), 1)
        slot = schedule_document_to_dict(charge_hold_seen[0].schedule)["slots"][
            CURRENT_SLOT_ID
        ]
        self.assertEqual(slot.get("pool-filtration"), self.APPLIANCE_ACTION)

    async def test_run_output_is_independent_of_the_prior_plan(self) -> None:
        """G1's determinism acceptance for #272: holding every other input
        fixed (forecasts, prices, live state, day-context bands, appliance
        runtime history) and varying only the automation-owned content of the
        schedule already on disk -- present, different, or absent entirely --
        must produce a byte-identical finished document. The prior plan is
        stripped before phase 1 ever runs and never read again, so nothing
        about it can leak into a decision.

        This must not be confused with history-dependent variation (a
        different hysteresis band, a different appliance runtime history),
        which stays legitimate -- only the *prior plan's content* is varied
        here, nothing else.
        """
        pool_plan = ScheduleDocument(
            execution_enabled=True,
            slots={CURRENT_SLOT_ID: {"pool-filtration": dict(self.APPLIANCE_ACTION)}},
        )

        def _build_optimizer_side_effect(config, *, control_config, appliance_registry):
            if config.id == "pool":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(pool_plan))
                )

            def _charge_hold_optimize(snapshot, current_config, trace=None):
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_charge_hold_optimize))

        other_slot_id = "2026-03-20T21:15:00+01:00"
        prior_plans = (
            # Absent: true cold start, nothing on disk at all.
            ScheduleDocument(execution_enabled=True),
            # Present: a prior plan occupying the exact lanes this run will
            # write, at the exact slot this run will choose.
            self._baseline_document(),
            # Different: a prior plan occupying the same lanes, but at a
            # different slot than this run will choose.
            ScheduleDocument(
                execution_enabled=True,
                slots={
                    other_slot_id: {
                        "inverter": dict(self.INVERTER_ACTION),
                        "pool-filtration": dict(self.APPLIANCE_ACTION),
                    }
                },
            ),
        )

        outputs: list[dict] = []
        for prior_plan in prior_plans:
            coordinator = _FakeCoordinator(
                schedule_document=prior_plan,
                bundle=_make_automation_bundle(),
                snapshot_factory=_make_snapshot,
            )
            with patch.object(
                pipeline_module,
                "build_optimizer",
                side_effect=_build_optimizer_side_effect,
            ):
                result = await AutomationRunner(
                    coordinator=coordinator,
                    automation_config=_make_automation_config(*self._optimizers()),
                ).run(reference_time=REFERENCE_TIME)
            self.assertTrue(result.ran_automation)
            outputs.append(schedule_document_to_dict(result.snapshot.schedule))

        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0], outputs[2])

    def test_phase1_appliance_sees_earlier_appliances_and_no_inverter_action(
        self,
    ) -> None:
        pool = _make_appliance_optimizer_instance(
            optimizer_id="pool", controllable_id="pool-filtration"
        )
        washer = _make_appliance_optimizer_instance(
            optimizer_id="washer", controllable_id="washer"
        )
        charge_hold = _make_optimizer_instance(
            optimizer_id="charge-hold", kind="charge_hold"
        )
        pool_plan = ScheduleDocument(
            execution_enabled=True,
            slots={CURRENT_SLOT_ID: {"pool-filtration": dict(self.APPLIANCE_ACTION)}},
        )
        seen_by_id: dict[str, OptimizationSnapshot] = {}

        def _build_optimizer(config, **kwargs):
            def _optimize(snapshot, current_config, trace=None):
                seen_by_id[current_config.id] = snapshot
                if current_config.id == "pool":
                    return deepcopy(pool_plan)
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_optimize))

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            return _make_snapshot(schedule_document=document)

        with patch.object(pipeline_module, "build_optimizer", side_effect=_build_optimizer):
            pipeline_module.run_optimizer_loop_pure(
                appliance_optimizers=(pool, washer),
                system_optimizers=(charge_hold,),
                schedule_document=self._baseline_document(),
                initial_snapshot=build_snapshot(self._baseline_document()),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
            )

        washer_phase1_slot = schedule_document_to_dict(
            seen_by_id["washer"].schedule
        )["slots"].get(CURRENT_SLOT_ID, {})
        # Washer (second appliance, phase 1) sees pool's fresh phase-1 write...
        self.assertEqual(
            washer_phase1_slot.get("pool-filtration"), self.APPLIANCE_ACTION
        )
        # ...but no inverter action at all: phase 2 has not run yet.
        self.assertNotIn("inverter", washer_phase1_slot)

    async def test_phase3_appliance_sees_the_phase2_inverter_plan(self) -> None:
        """Phase 3 placements are computed against the phase-2 inverter lane:
        a ``charge_hold``-written action is visible to the appliance
        optimizer re-planning in phase 3 (earlier appliances + phase-2
        inverter plan)."""
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        charge_hold_write = ScheduleDocument(
            execution_enabled=True,
            slots={CURRENT_SLOT_ID: {"inverter": dict(self.INVERTER_ACTION)}},
        )
        phase3_seen: list[OptimizationSnapshot] = []

        def _build_optimizer_side_effect(config, *, control_config, appliance_registry):
            if config.id == "charge-hold":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(charge_hold_write))
                )

            def _pool_optimize(snapshot, current_config, trace=None):
                phase3_seen.append(snapshot)
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_pool_optimize))

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=_build_optimizer_side_effect,
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(*self._optimizers()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        # phase3_seen[0] is phase 1 (no inverter yet), phase3_seen[1] is phase 3.
        self.assertEqual(len(phase3_seen), 2)
        phase1_slot = schedule_document_to_dict(phase3_seen[0].schedule)["slots"].get(
            CURRENT_SLOT_ID, {}
        )
        phase3_slot = schedule_document_to_dict(phase3_seen[1].schedule)["slots"].get(
            CURRENT_SLOT_ID, {}
        )
        self.assertNotIn("inverter", phase1_slot)
        self.assertEqual(phase3_slot.get("inverter"), self.INVERTER_ACTION)
        # Phase 1's provisional run must not leak into the reported result:
        # each configured optimizer (system and appliance alike) appears
        # exactly once, as its authoritative (phase-2 or phase-3) summary.
        self.assertEqual(
            sorted(summary.id for summary in result.optimizers),
            ["charge-hold", "pool"],
        )

    def test_same_lane_composes_in_bucket_order_in_both_appliance_phases(self) -> None:
        """Two optimizers targeting one appliance lane: the later one sees the
        earlier one's writes in that lane, in both phase 1 and phase 3."""
        first = _make_appliance_optimizer_instance(
            optimizer_id="first", controllable_id="boiler"
        )
        second = _make_appliance_optimizer_instance(
            optimizer_id="second", controllable_id="boiler"
        )
        first_write = ScheduleDocument(
            execution_enabled=True,
            slots={CURRENT_SLOT_ID: {"boiler": {"on": True, "setBy": "automation"}}},
        )
        seen_before_second: list[dict] = []

        def _build_optimizer(config, **kwargs):
            if config.id == "first":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(first_write))
                )

            def _second_optimize(snapshot, current_config, trace=None):
                seen_before_second.append(
                    schedule_document_to_dict(snapshot.schedule)["slots"].get(
                        CURRENT_SLOT_ID, {}
                    )
                )
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_second_optimize))

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            return _make_snapshot(schedule_document=document)

        with patch.object(pipeline_module, "build_optimizer", side_effect=_build_optimizer):
            pipeline_module.run_optimizer_loop_pure(
                appliance_optimizers=(first, second),
                system_optimizers=(),
                schedule_document=ScheduleDocument(execution_enabled=True),
                initial_snapshot=build_snapshot(ScheduleDocument(execution_enabled=True)),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
            )

        # Once from phase 1, once from phase 3 -- both see "first"'s write.
        self.assertEqual(len(seen_before_second), 2)
        for slot in seen_before_second:
            self.assertEqual(slot.get("boiler"), {"on": True, "setBy": "automation"})

    def test_house_kwh_differs_between_phase2_and_phase3_when_phase3_moves_it(
        self,
    ) -> None:
        """``houseKwh`` is captured per step (#272, P2 of #270), not once for
        the whole run: phase 2's step shows the phase-1 estimate it actually
        read, and a phase-3 step shows a different figure once phase 3 moves
        the appliance's load out of the slot phase 1 put it in.
        """
        charge_hold = _make_optimizer_instance(
            optimizer_id="charge-hold", kind="charge_hold"
        )
        boiler = _make_appliance_optimizer_instance(
            optimizer_id="boiler", controllable_id="boiler"
        )
        boiler_action = {"on": True, "setBy": "automation"}
        other_slot_id = "2026-03-20T21:15:00+01:00"

        def _build_optimizer(config, **kwargs):
            if config.id == "boiler":
                calls = {"count": 0}

                def _boiler_optimize(snapshot, current_config, trace=None):
                    calls["count"] += 1
                    slot_id = CURRENT_SLOT_ID if calls["count"] == 1 else other_slot_id
                    return ScheduleDocument(
                        execution_enabled=True,
                        slots={slot_id: {"boiler": dict(boiler_action)}},
                    )

                return SimpleNamespace(optimize=Mock(side_effect=_boiler_optimize))

            # charge_hold: reads, writes nothing.
            def _charge_hold_optimize(snapshot, current_config, trace=None):
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_charge_hold_optimize))

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            # houseKwh at CURRENT_SLOT_ID depends on whether the boiler's
            # automation-owned action is present there in this document --
            # exactly what a real forecast rebuild would reflect.
            slot_actions = document.slots.get(CURRENT_SLOT_ID, {})
            boiler = slot_actions.get("boiler")
            boiler_present = boiler is not None and boiler.set_by == "automation"
            house_kwh = 3.0 + (2.0 if boiler_present else 0.0)
            base = _make_snapshot(schedule_document=document)
            return replace(
                base,
                battery_forecast={
                    **base.battery_forecast,
                    "series": [
                        {
                            "timestamp": CURRENT_SLOT_ID,
                            "durationHours": 0.25,
                            "importedFromGridKwh": 1.4,
                            "exportedToGridKwh": 0.2,
                            "baselineHouseKwh": house_kwh,
                        }
                    ],
                },
            )

        with patch.object(pipeline_module, "build_optimizer", side_effect=_build_optimizer):
            result = pipeline_module.run_optimizer_loop_pure(
                appliance_optimizers=(boiler,),
                system_optimizers=(charge_hold,),
                schedule_document=ScheduleDocument(execution_enabled=True),
                initial_snapshot=build_snapshot(ScheduleDocument(execution_enabled=True)),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
            )

        trace = result.trace.to_dict()
        steps_by_id = {step["optimizerId"]: step for step in trace["steps"]}
        # Phase 2 (charge-hold) reads the phase-1 estimate: boiler present at
        # CURRENT_SLOT_ID -> houseKwh includes it.
        charge_hold_house_kwh = steps_by_id["charge-hold"]["railsIn"]["houseKwh"][0]
        # Phase 3 (boiler) reads the house after the phase-3 strip cleared
        # phase 1's placement: boiler absent from CURRENT_SLOT_ID until this
        # very step writes it (to a different slot) -> houseKwh excludes it.
        boiler_house_kwh = steps_by_id["boiler"]["railsIn"]["houseKwh"][0]
        self.assertEqual(charge_hold_house_kwh, 5.0)
        self.assertEqual(boiler_house_kwh, 3.0)
        self.assertNotEqual(charge_hold_house_kwh, boiler_house_kwh)


class ApplianceGroupExpansionTests(unittest.TestCase):
    """#291: one ``appliance_runtime`` config naming an ordered group expands in
    the pipeline into one single-target step per member, in priority order.

    The optimizer here is a stand-in for the real ranking: a slot carries enough
    surplus for ``capacity`` appliances, and each member places itself only if
    the snapshot it received leaves room. That is exactly what the rebuilt
    snapshot gives the real optimizer — earlier members' placements already
    consumed the surplus — so the stand-in keeps the test on the pipeline.
    """

    ACTION = {"on": True, "setBy": "automation"}
    STALE_SLOT_ID = "2026-03-20T21:15:00+01:00"

    def _group(self) -> OptimizerInstanceConfig:
        return OptimizerInstanceConfig(
            id="acs",
            kind="appliance_runtime",
            target={
                "controllables": (
                    {"controllable_id": "ac-living"},
                    {"controllable_id": "ac-bedroom"},
                )
            },
            params={"window": {"start": "08:00", "end": "18:00"}},
        )

    def _run(self, *, capacity: int, schedule_document: ScheduleDocument | None = None):
        seen: list[tuple[str, OptimizationSnapshot]] = []
        resolver_calls: list[str | None] = []

        def _build_optimizer(config, **kwargs):
            def _optimize(snapshot, current_config, trace=None):
                lane = current_config.target["controllable_id"]
                seen.append((lane, snapshot))
                slots = deepcopy(snapshot.schedule.slots)
                current = slots.setdefault(CURRENT_SLOT_ID, {})
                if len(current) >= capacity:
                    return snapshot.schedule
                current[lane] = SlotAction(payload={"on": True}, set_by="automation")
                return ScheduleDocument(execution_enabled=True, slots=slots)

            return SimpleNamespace(optimize=Mock(side_effect=_optimize))

        def _resolve_day_contexts(snapshot, *, optimizer_id):
            resolver_calls.append(optimizer_id)
            # A fresh object per call, so identity says which call a member saw.
            return {
                REFERENCE_TIME.date(): SimpleNamespace(
                    classification=f"call-{len(resolver_calls)}"
                )
            }

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            return _make_snapshot(schedule_document=document)

        document = schedule_document or ScheduleDocument(execution_enabled=True)
        with patch.object(pipeline_module, "build_optimizer", side_effect=_build_optimizer):
            result = pipeline_module.run_optimizer_loop_pure(
                appliance_optimizers=(self._group(),),
                system_optimizers=(),
                schedule_document=document,
                initial_snapshot=build_snapshot(document),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
                resolve_day_contexts=_resolve_day_contexts,
            )
        return result, seen, resolver_calls

    def test_members_run_in_order_as_one_step_each_on_their_own_lane(self) -> None:
        result, seen, _calls = self._run(capacity=2)

        # Phase 1 then phase 3, each walking the group in priority order.
        self.assertEqual(
            [lane for lane, _snapshot in seen],
            ["ac-living", "ac-bedroom", "ac-living", "ac-bedroom"],
        )
        self.assertEqual(
            [
                (step.optimizer_id, step.controllable_id, step.phase)
                for step in result.trace.optimizer_explanations()
            ],
            [
                ("acs", "ac-living", PHASE_FINAL_APPLIANCE_PLACEMENT),
                ("acs", "ac-bedroom", PHASE_FINAL_APPLIANCE_PLACEMENT),
            ],
        )
        # One summary per configured optimizer, not per lane.
        self.assertEqual(
            [(summary.id, summary.status, summary.slots_written) for summary in result.optimizers],
            [("acs", "ok", 2)],
        )
        slot = schedule_document_to_dict(result.working_schedule_document)["slots"][
            CURRENT_SLOT_ID
        ]
        self.assertEqual(slot, {"ac-living": self.ACTION, "ac-bedroom": self.ACTION})

    def test_the_second_member_plans_against_the_first_members_placements(self) -> None:
        """Surplus for one unit: only the top-priority member is placed."""
        result, seen, _calls = self._run(capacity=1)

        phase3_bedroom_snapshot = seen[3][1]
        self.assertEqual(
            schedule_document_to_dict(phase3_bedroom_snapshot.schedule)["slots"][
                CURRENT_SLOT_ID
            ],
            {"ac-living": self.ACTION},
        )
        slot = schedule_document_to_dict(result.working_schedule_document)["slots"][
            CURRENT_SLOT_ID
        ]
        self.assertEqual(slot, {"ac-living": self.ACTION})

    def test_the_group_shares_one_day_classification(self) -> None:
        result, seen, resolver_calls = self._run(capacity=2)

        # Once per phase for the group -- not once per member -- plus the
        # run-wide reading.
        self.assertEqual(resolver_calls, ["acs", "acs", None])
        for first, second in ((seen[0], seen[1]), (seen[2], seen[3])):
            self.assertIs(
                first[1].context.day_contexts, second[1].context.day_contexts
            )
        self.assertEqual(
            result.emitted_day_bands, {(REFERENCE_TIME.date(), "acs"): "call-2"}
        )

    def test_every_members_stale_lane_is_stripped_before_the_final_placement(
        self,
    ) -> None:
        stale = ScheduleDocument(
            execution_enabled=True,
            slots={
                self.STALE_SLOT_ID: {
                    "ac-living": dict(self.ACTION),
                    "ac-bedroom": dict(self.ACTION),
                }
            },
        )

        result, _seen, _calls = self._run(capacity=1, schedule_document=stale)

        slots = schedule_document_to_dict(result.working_schedule_document)["slots"]
        self.assertNotIn("ac-bedroom", slots.get(self.STALE_SLOT_ID, {}))
        self.assertNotIn("ac-living", slots.get(self.STALE_SLOT_ID, {}))
        self.assertEqual(slots[CURRENT_SLOT_ID], {"ac-living": self.ACTION})
