from __future__ import annotations
from tests._fakes import make_coordinator

import ast
import asyncio
import concurrent.futures
import inspect
import sys
import types
import unittest
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from _ha_stubs import stub_ha_dt, stub_module
from _fakes import FakeConnection as SharedFakeConnection, FakeHass as SharedFakeHass, loaded_config_entries


REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"
CURRENT_SLOT_ID_UTC = "2026-03-20T20:00:00+00:00"


from custom_components.helman.appliances.state import AppliancesRuntimeRegistry
from custom_components.helman.automation.config import AutomationConfig
from custom_components.helman.automation.config import OptimizerInstanceConfig
from custom_components.helman.automation.spec import OPTIMIZER_BUCKET_APPLIANCE
from custom_components.helman.automation.explain import (
    PHASE_FINAL_APPLIANCE_PLACEMENT,
    ExplanationBook,
    OptimizerExplanation,
    RunExplanation,
    SlotExplanation,
)
from custom_components.helman.automation.input_bundle import AutomationInputBundle
from custom_components.helman.automation.conditions.types import (
    ConditionRailsUnavailable,
)
from custom_components.helman.automation.pipeline import (
    AutomationCleanupSummary,
    AutomationRunFailure,
    AutomationRunResult,
    AutomationRunner,
    DayContextResolver,
    OptimizerRunSummary,
    _PipelineExecutionResult,
    run_optimizer_loop_pure,
)
from custom_components.helman.automation.snapshot import (
    OptimizationContext,
    OptimizationSnapshot,
    snapshot_to_dict,
)
from custom_components.helman.automation.compute_inputs import ComputeInputs
from custom_components.helman.battery_state import BatteryEntityConfig, BatteryLiveState
from custom_components.helman.const import MAX_FORECAST_DAYS, SCHEDULE_SLOT_MINUTES
from custom_components.helman.coordinator import HelmanCoordinator
from custom_components.helman import coordinator as coordinator_module
from custom_components.helman.automation import pipeline as pipeline_module
from custom_components.helman.scheduling.schedule import (
    ScheduleControlConfig,
    ScheduleDocument,
    iter_horizon_slot_ids,
    schedule_document_to_dict,
)
from custom_components.helman.websockets import (
    ws_get_schedule_explanation,
    ws_run_automation,
)

def _make_executor_hass() -> SimpleNamespace:
    """A hass stub that runs executor hops inline and records them.

    The forecast rebuild and the automation snapshot are pure CPU and belong on
    a worker thread; running them inline keeps the assertions readable while
    ``executor_hops`` still proves the hop happened.
    """
    executor_hops: list[object] = []

    async def async_add_executor_job(func, *args):
        executor_hops.append(func)
        return func(*args)

    return SimpleNamespace(
        async_add_executor_job=async_add_executor_job,
        executor_hops=executor_hops,
    )


def _make_schedule_document(*, execution_enabled: bool = True) -> ScheduleDocument:
    return ScheduleDocument(
        execution_enabled=execution_enabled,
        slots={
            CURRENT_SLOT_ID: {
                "inverter": {"kind": "stop_export"},
            }
        },
    )


def _make_grid_price_response() -> dict[str, object]:
    return {
        "export": {
            "unit": "CZK/kWh",
            "currentPrice": 2.5,
            "points": [{"timestamp": CURRENT_SLOT_ID, "value": 2.5}],
        },
        "import": {
            "unit": "CZK/kWh",
            "currentPrice": 7.0,
            "points": [{"timestamp": CURRENT_SLOT_ID, "value": 7.0}],
        },
    }


def _make_automation_bundle() -> AutomationInputBundle:
    return AutomationInputBundle(
        original_house_forecast={
            "status": "available",
            "generatedAt": REFERENCE_TIME.isoformat(),
            "series": [],
        },
        solar_forecast={
            "status": "available",
            "points": [{"timestamp": CURRENT_SLOT_ID, "value": 0.8}],
        },
        grid_price_forecast=_make_grid_price_response(),
        when_active_hourly_energy_kwh_by_appliance_id={"boiler": 1.25},
    )


def _make_snapshot(
    *,
    schedule_document: ScheduleDocument | None = None,
    input_bundle: AutomationInputBundle | None = None,
    reference_time: datetime | None = None,
) -> OptimizationSnapshot:
    return OptimizationSnapshot(
        schedule=_make_schedule_document() if schedule_document is None else schedule_document,
        adjusted_house_forecast={
            "status": "available",
            "generatedAt": (
                REFERENCE_TIME if reference_time is None else reference_time
            ).isoformat(),
            "series": [{"timestamp": CURRENT_SLOT_ID, "value": 3.0}],
        },
        battery_forecast={
            "status": "available",
            "generatedAt": (
                REFERENCE_TIME if reference_time is None else reference_time
            ).isoformat(),
            "startedAt": (
                REFERENCE_TIME if reference_time is None else reference_time
            ).isoformat(),
            "sourceGranularityMinutes": 15,
            "series": [
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "durationHours": 0.25,
                    "importedFromGridKwh": 1.4,
                    "exportedToGridKwh": 0.2,
                }
            ],
        },
        grid_forecast={
            "status": "available",
            "currentImportPrice": 7.0,
            "currentExportPrice": 2.5,
            "series": [
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "durationHours": 0.25,
                    "importedFromGridKwh": 1.4,
                    "exportedToGridKwh": 0.2,
                }
            ],
        },
        context=OptimizationContext(
            now=REFERENCE_TIME if reference_time is None else reference_time,
            battery_state=BatteryLiveState(
                current_remaining_energy_kwh=7.5,
                current_soc=50.0,
                min_soc=10.0,
                max_soc=90.0,
                nominal_capacity_kwh=15.0,
                min_energy_kwh=1.5,
                max_energy_kwh=13.5,
            ),
            solar_forecast={"status": "available", "points": []},
            import_price_forecast={
                "unit": "CZK/kWh",
                "currentPrice": 7.0,
                "points": [],
            },
            export_price_forecast={
                "unit": "CZK/kWh",
                "currentPrice": 2.5,
                "points": [],
            },
            appliance_registry=AppliancesRuntimeRegistry(),
            when_active_hourly_energy_kwh_by_appliance_id=(
                {"boiler": 1.25}
                if input_bundle is None
                else deepcopy(
                    input_bundle.when_active_hourly_energy_kwh_by_appliance_id
                )
            ),
        ),
    )


def _make_optimizer_instance(
    *,
    optimizer_id: str = "avoid-negative-export",
    kind: str = "export_price",
    enabled: bool = True,
    params: dict[str, object] | None = None,
    target: dict[str, object] | None = None,
) -> OptimizerInstanceConfig:
    return OptimizerInstanceConfig(
        id=optimizer_id,
        kind=kind,
        enabled=enabled,
        # The config reader stamps the spec's ``controllable_id`` default, so a
        # hand-built instance has to carry it too -- it is the schedule lane
        # every trace and explanation record is filed under.
        target=target or {"controllable_id": "inverter"},
        params={
            "when_price_below": 0.0,
            "action": "stop_export",
        }
        if params is None
        else params,
    )


def _make_automation_config(
    *optimizers: OptimizerInstanceConfig,
    enabled: bool = True,
) -> AutomationConfig:
    """Partition hand-built optimizers into the two config buckets.

    Preserves each optimizer's relative position within its own bucket. The
    tests in this file that care about cross-bucket execution order (the
    pending-appliance-demand fix, #116) already list system-kind optimizers
    before appliance-kind ones, matching the order ``AutomationRunner`` derives
    from ``AutomationConfig`` (system bucket, then appliance bucket).
    """
    appliance = tuple(
        optimizer
        for optimizer in optimizers
        if optimizer.spec.bucket == OPTIMIZER_BUCKET_APPLIANCE
    )
    system = tuple(
        optimizer
        for optimizer in optimizers
        if optimizer.spec.bucket != OPTIMIZER_BUCKET_APPLIANCE
    )
    return AutomationConfig(
        enabled=enabled,
        appliance_optimizers=appliance,
        system_optimizers=system,
    )


class _FakeCoordinator:
    def __init__(
        self,
        *,
        schedule_document: ScheduleDocument,
        bundle: AutomationInputBundle | None,
        snapshot_factory,
        persist_changed: bool = False,
        control_config: ScheduleControlConfig | None = None,
    ) -> None:
        self._schedule_lock = asyncio.Lock()
        self._schedule_document = schedule_document
        self._bundle = bundle
        self._snapshot_factory = snapshot_factory
        self._persist_changed = persist_changed
        self._control_config = control_config
        from custom_components.helman.appliances.registry_holder import AppliancesRegistryHolder
        self._appliances_registry = AppliancesRegistryHolder(None, lambda: {})
        self._hass = SimpleNamespace(
            async_add_executor_job=self._async_add_executor_job
        )
        self.snapshot_calls: list[dict[str, object]] = []
        self.persist_calls: list[dict[str, object]] = []
        self.saved_documents: list[ScheduleDocument] = []
        self.post_write_calls: list[tuple[str, bool]] = []
        self.recorded_explanations: list[object] = []
        #: The hysteresis store, faked: what the previous run left behind, and
        #: what this run asked to write back (#264).
        self.day_context_bands: dict = {}
        self.persisted_day_context_bands: list = []

    def record_run_explanation(self, explanation) -> None:
        self.recorded_explanations.append(explanation)

    def _build_automation_working_schedule_document_locked(
        self,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        return deepcopy(self._schedule_document)

    async def _load_pruned_schedule_document_locked(
        self,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        return deepcopy(self._schedule_document)

    def get_automation_input_bundle(self) -> AutomationInputBundle | None:
        return None if self._bundle is None else deepcopy(self._bundle)

    async def async_load_day_context_bands(self) -> dict:
        return dict(self.day_context_bands)

    async def async_persist_day_context_bands(
        self,
        *,
        emitted,
        reference_time: datetime,
        optimizer_ids,
    ) -> None:
        self.persisted_day_context_bands.append(
            (dict(emitted), reference_time, set(optimizer_ids))
        )

    async def _async_gather_compute_inputs(
        self, *, started_at: datetime, live_state=None, include_condition_flags=False
    ):
        return None

    @staticmethod
    async def _async_add_executor_job(func, *args):
        # Tests run the pure loop inline; production hands it to a worker thread.
        return func(*args)

    def _build_automation_snapshot_from_schedule_pure(
        self,
        *,
        schedule_document: ScheduleDocument,
        input_bundle: AutomationInputBundle,
        reference_time: datetime,
        day_contexts: dict | None = None,
        compute_inputs=None,
    ) -> OptimizationSnapshot:
        self.snapshot_calls.append(
            {
                "schedule_document": schedule_document,
                "input_bundle": input_bundle,
                "reference_time": reference_time,
            }
        )
        return self._snapshot_factory(
            schedule_document=schedule_document,
            input_bundle=input_bundle,
            reference_time=reference_time,
        )

    async def _build_automation_snapshot_from_schedule_locked(
        self,
        *,
        schedule_document: ScheduleDocument,
        input_bundle: AutomationInputBundle,
        reference_time: datetime,
        day_contexts: dict | None = None,
        compute_inputs=None,
    ) -> OptimizationSnapshot:
        return self._build_automation_snapshot_from_schedule_pure(
            schedule_document=schedule_document,
            input_bundle=input_bundle,
            reference_time=reference_time,
            day_contexts=day_contexts,
            compute_inputs=compute_inputs,
        )

    async def _persist_automation_result_locked(
        self,
        *,
        automation_result: ScheduleDocument,
        reference_time: datetime | None = None,
    ) -> bool:
        self.persist_calls.append(
            {
                "automation_result": automation_result,
                "reference_time": reference_time,
            }
        )
        return self._persist_changed

    async def _save_schedule_document(self, schedule_document: ScheduleDocument) -> None:
        self.saved_documents.append(deepcopy(schedule_document))
        self._schedule_document = deepcopy(schedule_document)

    async def _async_run_post_schedule_write_side_effects(
        self,
        *,
        reason: str,
    ) -> None:
        self.post_write_calls.append((reason, self._schedule_lock.locked()))

    def _read_schedule_control_config(self) -> ScheduleControlConfig | None:
        return self._control_config


class _FakeConnection(SharedFakeConnection):
    def __init__(self, *, is_admin: bool) -> None:
        super().__init__()
        self.user = SimpleNamespace(is_admin=is_admin)


class _FakeHass(SharedFakeHass):
    def __init__(self, coordinator) -> None:
        super().__init__()
        self.config_entries = loaded_config_entries(coordinator)



__all__ = [name for name in globals() if not name.startswith("__")]
