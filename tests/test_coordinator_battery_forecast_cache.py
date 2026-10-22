from __future__ import annotations
from tests._fakes import hold_pipeline, make_coordinator

import asyncio
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")


from custom_components.helman.coordinator import HelmanCoordinator  # noqa: E402
from custom_components.helman import coordinator as coordinator_module
from custom_components.helman.const import SLOT_ALIGNED_REFRESH_REASON  # noqa: E402
from custom_components.helman.forecast import assembly  # noqa: E402
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleControlConfig,
    ScheduleDocument,
    build_controllable_actions,
)


@pytest.fixture(autouse=True)
def _fixed_now(monkeypatch):
    from homeassistant.util import dt as dt_util

    monkeypatch.setattr(dt_util, "now", lambda: REFERENCE_TIME)


def _make_coordinator(test: unittest.TestCase) -> HelmanCoordinator:
    """A coordinator whose pipeline builds inline, with the simulation stubbed.

    The battery simulation and the schedule overlay are patched for the whole
    test and left on it as ``test.build_battery_forecast`` and
    ``test.build_overlay``.
    """
    storage = SimpleNamespace(
        config={},
        schedule_document=_make_schedule_document(),
        async_save_schedule_document=AsyncMock(),
    )
    coordinator = make_coordinator(_storage=storage, _active_config={})
    coordinator._hass = SimpleNamespace(async_add_executor_job=_inline_executor_job)
    # The tests store documents, not their dicts.
    coordinator.schedule.load = lambda: storage.schedule_document
    coordinator._appliances_registry.current = coordinator_module.AppliancesRuntimeRegistry()
    test.build_battery_forecast = test.enterContext(
        patch.object(
            assembly.BatteryCapacityForecastBuilder,
            "build_with_history",
            Mock(return_value=_make_battery_forecast()),
        )
    )
    test.build_overlay = test.enterContext(
        patch.object(
            assembly, "build_schedule_forecast_overlay", Mock(return_value=None)
        )
    )
    return coordinator


async def _inline_executor_job(func, *args):
    """Run an executor hop inline, so the offloaded pure cores stay testable."""
    return func(*args)


async def _read_pipeline(
    coordinator: HelmanCoordinator,
    started_at: datetime = REFERENCE_TIME,
    *,
    house_forecast: dict | None = None,
):
    """The pipeline served for these snapshots at ``started_at``."""
    return await coordinator._async_current_pipeline(
        started_at,
        in_flight=(house_forecast or _make_house_forecast(), _make_solar_forecast()),
    )


async def _read_battery_forecast(
    coordinator: HelmanCoordinator,
    started_at: datetime = REFERENCE_TIME,
    *,
    house_forecast: dict | None = None,
) -> dict:
    pipeline = await _read_pipeline(
        coordinator, started_at, house_forecast=house_forecast
    )
    return pipeline.battery_forecast


def _make_solar_forecast() -> dict:
    return {
        "status": "available",
        "points": [
            {
                "timestamp": "2026-03-20T21:00:00+01:00",
                "value": 100.0,
            },
            {
                "timestamp": "2026-03-20T21:15:00+01:00",
                "value": 125.0,
            },
        ],
    }


def _make_house_forecast(*, generated_at: str = "2026-03-20T21:05:00+01:00") -> dict:
    return {
        "status": "available",
        "generatedAt": generated_at,
    }


def _make_battery_forecast(
    *,
    started_at: str | None = "2026-03-20T21:07:00+01:00",
    current_soc: float = 50.0,
    current_remaining_energy_kwh: float = 5.0,
) -> dict:
    return {
        "status": "available",
        "startedAt": started_at,
        "currentSoc": current_soc,
        "currentRemainingEnergyKwh": current_remaining_energy_kwh,
        "series": [],
        "actualHistory": [],
    }


def _make_projection_plan() -> SimpleNamespace:
    return SimpleNamespace(
        generated_at=REFERENCE_TIME.isoformat(),
        appliances_by_id={},
        demand_points=(),
    )


def _make_schedule_action(kind: str, target_soc: int | None = None) -> dict:
    """One slot's flat, id-keyed action map holding just the inverter's."""
    return build_controllable_actions(
        inverter=ScheduleAction(kind=kind, target_soc=target_soc)
    )


def _make_schedule_document(
    *,
    execution_enabled: bool = False,
    slots: dict[str, SimpleNamespace] | None = None,
) -> ScheduleDocument:
    return ScheduleDocument(
        execution_enabled=execution_enabled,
        slots={} if slots is None else dict(slots),
    )


def _make_control_config() -> ScheduleControlConfig:
    return ScheduleControlConfig(
        mode_entity_id="select.inverter_mode",
        options={
            "normal": "normal",
            "stop_charging": "stop_charging",
            "stop_discharging": "stop_discharging",
            "charge_to_target_soc": "charge_target",
            "discharge_to_target_soc": "discharge_target",
            "stop_export": "stop_export",
        },
    )


def _patch_live_battery(*live_states):
    """Configure a battery and answer each live-state read with the next state."""
    return (
        patch.object(
            coordinator_module,
            "read_battery_entity_config",
            return_value=SimpleNamespace(capacity_entity_id="sensor.battery_capacity"),
        ),
        patch.object(
            coordinator_module,
            "read_battery_live_state",
            side_effect=[
                SimpleNamespace(current_soc=soc, current_remaining_energy_kwh=kwh)
                for soc, kwh in live_states
            ],
        ),
    )


class CoordinatorBatteryForecastCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_reuses_cache_within_ttl(self) -> None:
        coordinator = _make_coordinator(self)

        first = await _read_battery_forecast(coordinator)
        second = await _read_battery_forecast(
            coordinator, datetime.fromisoformat("2026-03-20T21:11:00+01:00")
        )

        self.assertEqual(first, second)
        self.build_battery_forecast.assert_called_once()

    async def test_the_cache_key_records_what_the_pipeline_was_built_from(
        self,
    ) -> None:
        coordinator = _make_coordinator(self)

        await _read_battery_forecast(coordinator)

        entry = coordinator._pipeline_cache
        self.assertEqual(
            entry.key,
            coordinator_module._PipelineCacheKey(
                slot_start=datetime.fromisoformat("2026-03-20T21:00:00+01:00"),
                house_generated_at="2026-03-20T21:05:00+01:00",
                solar_signature=assembly.build_battery_forecast_solar_signature(
                    _make_solar_forecast()
                ),
                schedule_sig=(),
                appliance_sig=(),
                effective_sig=None,
            ),
        )
        self.assertEqual(
            entry.expires_at,
            REFERENCE_TIME
            + timedelta(
                seconds=coordinator_module.BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS
            ),
        )

    async def test_rebuilds_after_ttl_expiry(self) -> None:
        coordinator = _make_coordinator(self)

        await _read_battery_forecast(coordinator)
        await _read_battery_forecast(
            coordinator, datetime.fromisoformat("2026-03-20T21:13:00+01:00")
        )

        self.assertEqual(self.build_battery_forecast.call_count, 2)

    async def test_rebuilds_when_the_battery_forecast_carries_no_started_at(
        self,
    ) -> None:
        # Every status short of a simulated one leaves ``startedAt`` unset. The
        # entry is keyed on the slot the forecast says it started in, so it
        # matches no read and the next reader builds again.
        coordinator = _make_coordinator(self)
        expected_forecast = _make_battery_forecast()
        self.build_battery_forecast.side_effect = [
            _make_battery_forecast(started_at=None),
            expected_forecast,
        ]

        await _read_battery_forecast(coordinator)
        self.assertIsNone(coordinator._pipeline_cache.key.slot_start)
        forecast = await _read_battery_forecast(coordinator)

        self.assertEqual(forecast, expected_forecast)
        self.assertEqual(self.build_battery_forecast.call_count, 2)

    async def test_rebuilds_when_house_snapshot_changes(self) -> None:
        coordinator = _make_coordinator(self)

        await _read_battery_forecast(
            coordinator,
            house_forecast=_make_house_forecast(generated_at="2026-03-20T21:05:00+01:00"),
        )
        await _read_battery_forecast(
            coordinator,
            datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
            house_forecast=_make_house_forecast(generated_at="2026-03-20T21:10:00+01:00"),
        )

        self.assertEqual(self.build_battery_forecast.call_count, 2)

    async def test_invalidation_drops_the_entry_and_forces_a_rebuild(self) -> None:
        coordinator = _make_coordinator(self)

        await _read_battery_forecast(coordinator)
        revision = coordinator._forecast_cache_revision
        coordinator._invalidate_pipeline_cache()
        self.assertIsNone(coordinator._pipeline_cache)
        self.assertEqual(coordinator._forecast_cache_revision, revision + 1)
        await _read_battery_forecast(
            coordinator, datetime.fromisoformat("2026-03-20T21:11:00+01:00")
        )

        self.assertEqual(self.build_battery_forecast.call_count, 2)

    async def test_schedule_writes_leave_the_forecast_cache_alone(self) -> None:
        # The signatures in the cache key cover every slot a write can touch,
        # so neither write drops the entry nor moves the revision.
        from custom_components.helman.const import SCHEDULE_ACTION_STOP_CHARGING
        from custom_components.helman.scheduling.schedule import (
            ScheduleAction,
            ScheduleSlot,
        )
        from tests._fakes import (
            CURRENT_SLOT_ID,
            FakeExecutor,
            FakeHass,
            FakeStorage,
        )

        storage = FakeStorage(
            schedule_document={
                "executionEnabled": False,
                "slotMinutes": coordinator_module.SCHEDULE_SLOT_MINUTES,
                "slots": {},
            }
        )
        coordinator = make_coordinator(_hass=FakeHass(), _storage=storage)
        coordinator.schedule.executor = FakeExecutor()
        hold_pipeline(coordinator, SimpleNamespace())
        entry = coordinator._pipeline_cache
        revision = coordinator._forecast_cache_revision

        await coordinator.set_schedule(
            slots=[
                ScheduleSlot(
                    id=CURRENT_SLOT_ID,
                    action=ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING),
                )
            ],
            reference_time=REFERENCE_TIME,
        )
        self.assertEqual(coordinator._forecast_cache_revision, revision)
        self.assertIs(coordinator._pipeline_cache, entry)

        await coordinator.set_schedule_execution(
            enabled=True, reference_time=REFERENCE_TIME
        )
        self.assertEqual(coordinator._forecast_cache_revision, revision)
        self.assertIs(coordinator._pipeline_cache, entry)

    async def test_projection_plan_reuses_cache_for_same_started_at(
        self,
    ) -> None:
        coordinator = _make_coordinator(self)
        plan = _make_projection_plan()

        with (
            patch.object(
                assembly,
                "build_projection_input_bundle",
                return_value=object(),
            ) as build_input_bundle,
            patch.object(
                assembly,
                "build_appliance_projection_plan",
                return_value=plan,
            ) as build_plan,
        ):
            first = (await _read_pipeline(coordinator)).projection_plan
            second = (await _read_pipeline(coordinator)).projection_plan

        self.assertIs(first, plan)
        self.assertIs(second, plan)
        build_input_bundle.assert_called_once()
        build_plan.assert_called_once_with(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=coordinator._appliances_registry.current,
            schedule_document=_make_schedule_document(),
            inputs=build_input_bundle.return_value,
            hass=None,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id={},
            vehicle_remaining_capacity_kwh_by_vehicle_id={},
        )
        self.build_battery_forecast.assert_called_once()

    async def test_projection_plan_reuses_shared_pipeline_within_slot(
        self,
    ) -> None:
        coordinator = _make_coordinator(self)
        first_plan = _make_projection_plan()

        with (
            patch.object(
                assembly,
                "build_projection_input_bundle",
                return_value=object(),
            ) as build_input_bundle,
            patch.object(
                assembly,
                "build_appliance_projection_plan",
                return_value=first_plan,
            ) as build_plan,
        ):
            first = (await _read_pipeline(coordinator)).projection_plan
            second = (
                await _read_pipeline(
                    coordinator, datetime.fromisoformat("2026-03-20T21:08:00+01:00")
                )
            ).projection_plan

        self.assertIs(first, first_plan)
        self.assertIs(second, first_plan)
        self.assertEqual(build_input_bundle.call_count, 1)
        self.assertEqual(build_plan.call_count, 1)
        self.build_battery_forecast.assert_called_once()

    async def test_rebuilds_when_schedule_slots_change(
        self,
    ) -> None:
        coordinator = _make_coordinator(self)
        self.build_overlay.return_value = object()
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            }
        )

        await _read_battery_forecast(coordinator)
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:30:00+01:00": _make_schedule_action("stop_charging"),
            }
        )
        await _read_battery_forecast(
            coordinator, datetime.fromisoformat("2026-03-20T21:11:00+01:00")
        )

        self.assertEqual(self.build_battery_forecast.call_count, 2)

    async def test_rebuilds_when_only_execution_flag_changes(
        self,
    ) -> None:
        # Toggling execution swaps the forecast between the unmanaged
        # trajectory and the plan's effect, and nothing invalidates the cache on
        # the toggle any more. The signature notices on its own because it is
        # built from the gated document, which empties with the flag.
        coordinator = _make_coordinator(self)
        first_schedule_document = _make_schedule_document(
            execution_enabled=False,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        second_schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        self.build_overlay.return_value = object()
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = first_schedule_document

        await _read_battery_forecast(coordinator)
        self.assertEqual(coordinator._pipeline_cache.key.schedule_sig, ())
        coordinator._storage.schedule_document = second_schedule_document
        await _read_battery_forecast(
            coordinator, datetime.fromisoformat("2026-03-20T21:11:00+01:00")
        )

        self.assertEqual(self.build_battery_forecast.call_count, 2)
        self.assertNotEqual(coordinator._pipeline_cache.key.schedule_sig, ())
        # The disabled build gets an overlay built from the emptied document.
        self.assertEqual(
            self.build_overlay.call_args_list[0].kwargs["schedule_document"].slots,
            {},
        )

    async def test_reuses_cache_with_matching_schedule_state(
        self,
    ) -> None:
        # A schedule write that leaves the horizon actions alone — the executor
        # re-persisting a pruned document, an automation run landing on the same
        # plan — costs nothing: the read side sees the same signature and serves
        # the cached pipeline.
        coordinator = _make_coordinator(self)
        first_schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        second_schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        self.build_overlay.return_value = object()
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = first_schedule_document

        await _read_battery_forecast(coordinator)
        coordinator._storage.schedule_document = second_schedule_document
        await _read_battery_forecast(
            coordinator, datetime.fromisoformat("2026-03-20T21:11:00+01:00")
        )

        self.assertEqual(self.build_battery_forecast.call_count, 1)
        self.build_overlay.assert_called_once_with(
            schedule_document=first_schedule_document,
            reference_time=REFERENCE_TIME,
        )

    def _hold_active_charge_target(self, coordinator) -> None:
        self.build_overlay.return_value = object()
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action(
                    "charge_to_target_soc",
                    50,
                ),
            },
        )

    async def test_rebuilds_when_active_target_effective_action_flips(
        self,
    ) -> None:
        coordinator = _make_coordinator(self)
        self.build_battery_forecast.side_effect = [
            _make_battery_forecast(
                current_soc=49.4,
                current_remaining_energy_kwh=5.0,
            ),
            _make_battery_forecast(
                started_at="2026-03-20T21:11:00+01:00",
                current_soc=50.2,
                current_remaining_energy_kwh=5.05,
            ),
        ]
        self._hold_active_charge_target(coordinator)
        entity_config, live_state = _patch_live_battery((49.4, 5.0), (50.2, 5.05))

        with entity_config, live_state:
            await _read_battery_forecast(coordinator)
            first_effective_sig = coordinator._pipeline_cache.key.effective_sig
            await _read_battery_forecast(
                coordinator, datetime.fromisoformat("2026-03-20T21:11:00+01:00")
            )

        self.assertEqual(self.build_battery_forecast.call_count, 2)
        self.assertNotEqual(
            coordinator._pipeline_cache.key.effective_sig, first_effective_sig
        )

    async def test_rebuilds_when_active_target_slot_remains_target(
        self,
    ) -> None:
        coordinator = _make_coordinator(self)
        self.build_battery_forecast.side_effect = [
            _make_battery_forecast(
                current_soc=49.4,
                current_remaining_energy_kwh=5.0,
            ),
            _make_battery_forecast(
                started_at="2026-03-20T21:11:00+01:00",
                current_soc=50.6,
                current_remaining_energy_kwh=5.2,
            ),
        ]
        self._hold_active_charge_target(coordinator)
        entity_config, live_state = _patch_live_battery((49.4, 5.0), (50.6, 5.2))

        with entity_config, live_state:
            await _read_battery_forecast(coordinator)
            await _read_battery_forecast(
                coordinator, datetime.fromisoformat("2026-03-20T21:11:00+01:00")
            )

        self.assertEqual(self.build_battery_forecast.call_count, 2)

    async def test_reuses_cache_when_active_target_signature_matches(
        self,
    ) -> None:
        coordinator = _make_coordinator(self)
        forecast = _make_battery_forecast(
            current_soc=49.4,
            current_remaining_energy_kwh=5.0,
        )
        self.build_battery_forecast.return_value = forecast
        self._hold_active_charge_target(coordinator)
        # Two prepares and, on the second read, the live-state check.
        entity_config, live_state = _patch_live_battery(
            (49.4, 5.0), (49.4, 5.0), (49.4, 5.0)
        )

        with entity_config, live_state:
            first = await _read_battery_forecast(coordinator)
            second = await _read_battery_forecast(
                coordinator, datetime.fromisoformat("2026-03-20T21:11:00+01:00")
            )

        self.assertIs(first, forecast)
        self.assertIs(second, forecast)
        self.assertEqual(self.build_battery_forecast.call_count, 1)

    async def test_rebuilds_when_live_soc_drifts(
        self,
    ) -> None:
        # The projected curve starts from the live SoC, so a battery that has
        # moved beyond the tolerance must not be drawn from a cached curve
        # anchored to where it used to be. The slot action is a plain one, so
        # the effective signature is None, the key matches, and only the
        # live-state check -- kept outside the key -- can decide.
        coordinator = _make_coordinator(self)
        self.build_battery_forecast.return_value = _make_battery_forecast(
            current_soc=49.4,
            current_remaining_energy_kwh=5.0,
        )
        self.build_overlay.return_value = object()
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        live_state = SimpleNamespace(
            current_soc=49.4,
            current_remaining_energy_kwh=5.0,
        )

        with (
            patch.object(
                coordinator_module,
                "read_battery_entity_config",
                return_value=SimpleNamespace(capacity_entity_id="sensor.battery_capacity"),
            ),
            patch.object(
                coordinator_module,
                "read_battery_live_state",
                side_effect=lambda *args, **kwargs: live_state,
            ),
        ):
            await _read_battery_forecast(coordinator)
            first_key = coordinator._pipeline_cache.key
            # A couple of minutes of charging: past the 0.1 kWh bound.
            live_state = SimpleNamespace(
                current_soc=51.0,
                current_remaining_energy_kwh=5.2,
            )
            await _read_battery_forecast(
                coordinator, datetime.fromisoformat("2026-03-20T21:11:00+01:00")
            )

        self.assertEqual(self.build_battery_forecast.call_count, 2)
        self.assertEqual(coordinator._pipeline_cache.key, first_key)


class PipelineReadPathTests(unittest.IsolatedAsyncioTestCase):
    """What the readers hand the pipeline when they bring no snapshots."""

    async def test_waiting_reader_uses_the_latest_snapshots(self) -> None:
        coordinator = _make_coordinator(self)
        coordinator._cached_forecast = _make_house_forecast()
        coordinator._cached_solar_forecast = _make_solar_forecast()
        async with coordinator._appliance_forecast_pipeline_lock:
            reader = asyncio.create_task(coordinator._async_current_pipeline(REFERENCE_TIME))
            await asyncio.sleep(0)
            latest = {**_make_house_forecast(), "generatedAt": "2026-03-20T21:08:00+01:00"}
            coordinator._cached_forecast = latest
            coordinator._cached_solar_forecast = {
                **_make_solar_forecast(),
                "correctedPoints": [{"timestamp": "2026-03-20T21:00:00+01:00", "value": 42.0}],
            }
        pipeline = await reader
        self.assertEqual(pipeline.original_house_forecast, latest)
        self.assertEqual(coordinator._pipeline_cache.key.house_generated_at, latest["generatedAt"])
        self.assertEqual(self.build_battery_forecast.call_args.kwargs["solar_forecast"]["points"][0]["value"], 42.0)

    async def test_readers_build_against_the_canonical_snapshots(self) -> None:
        coordinator = _make_coordinator(self)
        house_forecast = _make_house_forecast()
        coordinator._cached_forecast = house_forecast
        coordinator._cached_solar_forecast = {
            "status": "available",
            "points": [{"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0}],
            "correctedPoints": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 20.0}
            ],
        }

        pipeline = await coordinator._async_current_pipeline(REFERENCE_TIME)

        self.assertEqual(pipeline.original_house_forecast, house_forecast)
        # The bias-corrected view, which is what automation plans against too.
        solar_forecast = self.build_battery_forecast.call_args.kwargs["solar_forecast"]
        self.assertEqual(solar_forecast["points"][0]["value"], 20.0)

    async def test_without_snapshots_the_pipeline_builds_on_placeholders(
        self,
    ) -> None:
        coordinator = _make_coordinator(self)
        coordinator._active_config = {
            "energy_nodes": {
                "house": {"forecast": {"total_energy_entity_id": "sensor.house_total"}}
            }
        }

        pipeline = await coordinator._async_current_pipeline(REFERENCE_TIME)

        self.assertEqual(pipeline.original_house_forecast["status"], "unavailable")
        self.assertEqual(
            self.build_battery_forecast.call_args.kwargs["solar_forecast"],
            {"status": "unavailable", "points": []},
        )

    async def test_projections_refresh_the_registry_before_reading_the_pipeline(
        self,
    ) -> None:
        coordinator = make_coordinator()
        calls: list[str] = []
        coordinator._appliances_registry.refresh = lambda: calls.append("refresh")
        plan = SimpleNamespace(appliances_by_id={}, generated_at="2026-03-20T21:07:00+01:00")

        async def current_pipeline(now):
            calls.append("pipeline")
            return SimpleNamespace(projection_plan=plan)

        coordinator._async_current_pipeline = current_pipeline

        response = await coordinator.get_appliance_projections()

        self.assertEqual(calls, ["refresh", "pipeline"])
        self.assertEqual(
            response,
            coordinator_module.build_empty_appliance_projections_response(
                generated_at=plan.generated_at
            ),
        )

    async def test_the_inspector_reads_the_battery_forecast_through_the_pipeline(
        self,
    ) -> None:
        coordinator = make_coordinator()
        battery_forecast = _make_battery_forecast()
        coordinator._async_current_pipeline = AsyncMock(
            return_value=SimpleNamespace(battery_forecast=battery_forecast)
        )

        self.assertIs(await coordinator.battery_forecast(), battery_forecast)
        coordinator._async_current_pipeline.assert_awaited_once_with(REFERENCE_TIME)


class SlotAlignedRefreshBeatTests(unittest.TestCase):
    """The quarter-hour beat snaps back to the boundary before rebuilding.

    Home Assistant's ``async_track_time_change`` draws a microsecond offset in
    [50ms, 500ms] once, when the listener is attached, schedules every firing at
    boundary + that offset, then hands the callback the real clock. Passing that
    straight through as the rebuild's reference time stamped the snapshot's
    first slot short by the offset for the whole session -- #204.
    """

    def _fire(self, fired_at):
        coordinator = make_coordinator()
        coordinator._hass = SimpleNamespace()
        coordinator._unsub_forecast_refresh = None
        forwarded = []
        coordinator._create_tracked_refresh_task = lambda coro: coro
        coordinator._async_refresh_forecast = (
            lambda *, reason, reference_time: forwarded.append(
                (reason, reference_time)
            )
        )

        registered = []
        original = coordinator_module.async_track_time_change
        coordinator_module.async_track_time_change = (
            lambda hass, action, **kwargs: registered.append((action, kwargs))
            or (lambda: None)
        )
        try:
            coordinator._start_forecast_refresh()
        finally:
            coordinator_module.async_track_time_change = original

        (on_interval, kwargs) = registered[0]
        self.assertEqual(kwargs, {"minute": [0, 15, 30, 45], "second": 0})
        on_interval(fired_at)
        return forwarded[0]

    def test_a_late_firing_is_snapped_back_to_the_slot_boundary(self):
        for offset_text in ("0.050000", "0.183000", "0.499999"):
            with self.subTest(offset=offset_text):
                reason, reference_time = self._fire(
                    datetime.fromisoformat(f"2026-03-20T21:15:00.{offset_text[2:]}+01:00")
                )
                self.assertEqual(reason, SLOT_ALIGNED_REFRESH_REASON)
                self.assertEqual(
                    reference_time,
                    datetime.fromisoformat("2026-03-20T21:15:00+01:00"),
                )

    def test_a_firing_that_slips_past_the_next_boundary_keeps_its_own_slot(self):
        # An event loop stalled past :30 must not be snapped back to :15 -- the
        # slot it is actually in is the one the rebuild has to stamp.
        _, reference_time = self._fire(
            datetime.fromisoformat("2026-03-20T21:30:02.400000+01:00")
        )
        self.assertEqual(
            reference_time, datetime.fromisoformat("2026-03-20T21:30:00+01:00")
        )


class BatteryForecastCurrentAccessorTests(unittest.TestCase):
    """The accessor the five retired-store entities read, and the derivation it
    now owns (moved verbatim from ``BatteryForecastHistoryStore._slot_values``)."""

    def _coordinator(self, snapshot):
        coordinator = make_coordinator()
        coordinator._hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague")
        )
        hold_pipeline(
            coordinator,
            None if snapshot is None else SimpleNamespace(battery_forecast=snapshot),
        )
        return coordinator

    def test_derives_the_five_figures_with_their_sign_conventions(self):
        # Reference clock is 21:07+01:00, so the current slot starts at 21:00.
        coordinator = self._coordinator(
            {
                "series": [
                    # The slot-aligned first entry: stamped microseconds into
                    # the slot, a full slot's ``durationHours``.
                    {
                        "timestamp": "2026-03-20T21:00:00.010000+01:00",
                        "durationHours": 0.25,
                        "socPct": 62.5,
                        "importedFromGridKwh": 0.4,
                        "exportedToGridKwh": 0.1,
                        "chargedKwh": 0.6,
                        "dischargedKwh": 0.25,
                    },
                    {"timestamp": "2026-03-20T21:15:00+01:00", "socPct": 99.0},
                ]
            }
        )
        values = coordinator.get_battery_forecast_current()
        self.assertEqual(values["socPct"], 62.5)
        # Positive when exporting: 0.1 kWh out minus 0.4 kWh in, in Wh.
        self.assertEqual(values["gridNetWh"], -300.0)
        self.assertEqual(values["gridImportWh"], 400.0)
        self.assertEqual(values["gridExportWh"], 100.0)
        # Positive when charging: 0.6 kWh in minus 0.25 kWh out.
        self.assertEqual(values["batteryNetWh"], 350.0)

    def test_a_slot_without_the_later_fields_omits_those_keys(self):
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T21:00:00+01:00", "socPct": 40.0}]}
        )
        self.assertEqual(coordinator.get_battery_forecast_current(), {"socPct": 40.0})

    def test_a_partial_first_entry_is_refused(self):
        # Off the slot-aligned beat the first entry covers only the slot's
        # remainder -- ``durationHours`` short of 0.25, energies scaled down.
        # The accessor refuses it whole, SoC included, so no state-write path
        # can publish a partial value.
        coordinator = self._coordinator(
            {
                "series": [
                    {
                        "timestamp": "2026-03-20T21:07:00+01:00",
                        "durationHours": 0.1333,
                        "socPct": 62.5,
                        "importedFromGridKwh": 0.05,
                        "exportedToGridKwh": 0.0,
                        "chargedKwh": 0.08,
                        "dischargedKwh": 0.0,
                    }
                ]
            }
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())

    _FULL_SLOT_SNAPSHOT = {
        "series": [
            {
                "timestamp": "2026-03-20T21:00:00+01:00",
                "durationHours": 0.25,
                "socPct": 62.5,
                "importedFromGridKwh": 0.4,
                "exportedToGridKwh": 0.1,
                "chargedKwh": 0.6,
                "dischargedKwh": 0.25,
            }
        ]
    }

    _PARTIAL_SNAPSHOT = {
        "series": [
            {
                "timestamp": "2026-03-20T21:07:00+01:00",
                "durationHours": 0.1333,
                "socPct": 58.0,
                "importedFromGridKwh": 0.05,
                "exportedToGridKwh": 0.0,
                "chargedKwh": 0.08,
                "dischargedKwh": 0.0,
            }
        ]
    }

    def test_a_partial_after_a_full_slot_serves_the_full_slot_again(self):
        # #204: the beat fills the 21:00 slot, then an off-beat rebuild replaces
        # the snapshot's entry for that same slot with a partial. The slot's
        # answer was already known and does not become unknown -- the five must
        # not drop out for the remaining eight minutes.
        whole_slot = {
            "socPct": 62.5,
            "gridNetWh": -300.0,
            "gridImportWh": 400.0,
            "gridExportWh": 100.0,
            "batteryNetWh": 350.0,
        }
        coordinator = self._coordinator(self._FULL_SLOT_SNAPSHOT)
        served = coordinator.get_battery_forecast_current()
        self.assertEqual(served, whole_slot)
        hold_pipeline(
            coordinator, SimpleNamespace(battery_forecast=self._PARTIAL_SNAPSHOT)
        )
        # The whole-slot figures spelled out, not the object the first read
        # returned: the partial's rescaled 58.0 and its eighth of a slot's
        # energies must not appear.
        self.assertEqual(coordinator.get_battery_forecast_current(), whole_slot)

    def test_the_memo_survives_a_caller_mutating_what_it_was_handed(self):
        # The accessor runs on every state read of the five entities. Handing
        # out the memo's own map would let one caller's mutation stand as the
        # slot's answer for the rest of the quarter hour.
        coordinator = self._coordinator(self._FULL_SLOT_SNAPSHOT)
        coordinator.get_battery_forecast_current().clear()
        hold_pipeline(
            coordinator, SimpleNamespace(battery_forecast=self._PARTIAL_SNAPSHOT)
        )
        served = coordinator.get_battery_forecast_current()
        self.assertEqual(served["socPct"], 62.5)
        served["socPct"] = 0.0
        self.assertEqual(
            coordinator.get_battery_forecast_current()["socPct"], 62.5
        )

    def test_a_memo_from_an_earlier_slot_is_not_served(self):
        # The slot key is the memo's entire expiry: 20:45's figures can never
        # answer a read taken in the 21:00 slot.
        coordinator = self._coordinator(self._PARTIAL_SNAPSHOT)
        coordinator._battery_forecast_current_slot = (
            "2026-03-20T20:45:00+01:00",
            {"socPct": 91.0},
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())

    def test_the_memo_answers_the_partial_branch_only(self):
        # A cold pipeline or a snapshot with no series means the system has
        # nothing for this slot, which is a different failure and must stay
        # visible -- the memo does not paper over it.
        coordinator = self._coordinator(self._FULL_SLOT_SNAPSHOT)
        self.assertIsNotNone(coordinator.get_battery_forecast_current())
        hold_pipeline(
            coordinator, SimpleNamespace(battery_forecast={"status": "unavailable"})
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())
        hold_pipeline(coordinator, None)
        self.assertIsNone(coordinator.get_battery_forecast_current())

    def test_an_entry_with_none_of_the_five_is_not_memoed(self):
        # "No slot" is not an answer worth remembering; memoing it would hand a
        # later partial the same ``None`` while suppressing its reason.
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T21:00:00+01:00"}]}
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())
        self.assertIsNone(coordinator._battery_forecast_current_slot)

    def _first_entry(self, duration_hours):
        return self._coordinator(
            {
                "series": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "durationHours": duration_hours,
                        "socPct": 62.5,
                    }
                ]
            }
        )

    def test_the_duration_the_slot_aligned_beat_really_produces_is_accepted(self):
        # #204: the guard used to demand a full slot to within 3.6us, which the
        # slot-aligned rebuild never once met -- Home Assistant fires the beat
        # 50-500ms late, by a per-session offset it draws when the listener is
        # attached, so the first entry came out short by that offset. Sessions
        # that drew over ~180ms published ``unavailable`` on every slot for
        # their whole life; the rest survived only because ``simulate_slot``
        # rounds ``durationHours`` to four places. The beat is snapped to the
        # boundary now, and the tolerance is a second rather than microseconds.
        for duration_hours in (
            0.25,  # snapped: what the beat produces now
            0.2499,  # rounded, from a 190ms-500ms offset
            (900 - 0.5) / 3600,  # unrounded, from the largest offset HA draws
            0.25 - 1 / 3600,  # a full second short, the edge of the tolerance
        ):
            with self.subTest(duration_hours=duration_hours):
                values = self._first_entry(duration_hours).get_battery_forecast_current()
                self.assertEqual(values, {"socPct": 62.5})

    def test_an_entry_short_by_more_than_the_tolerance_is_still_refused(self):
        # 36 seconds short: an off-beat rebuild, not scheduler slop.
        self.assertIsNone(self._first_entry(0.249).get_battery_forecast_current())

    def test_an_entry_with_none_of_the_five_is_none_not_empty(self):
        # ``_battery_forecast_slot_values`` ends on ``values or None`` again, so
        # the accessor never hands back a truthy-but-empty ``{}``.
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T21:00:00+01:00"}]}
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())

    def test_none_without_a_pipeline_or_a_slot_for_the_current_quarter_hour(self):
        self.assertIsNone(self._coordinator(None).get_battery_forecast_current())
        # Only future slots: nothing for the 21:00 quarter hour.
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T22:00:00+01:00", "socPct": 40.0}]}
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())


class BatteryForecastCurrentRefusalLoggingTests(unittest.TestCase):
    """Every route to the five current-slot entities reporting unavailable says
    why, and says it once.

    #204 spent two rounds of investigation on dead stretches that left nothing
    in the log: the builder logged its own refusals, but this accessor -- which
    is what the entities actually read -- returned ``None`` in silence down
    every branch. The reproduction that finally pinned it was a 13-minute hole
    whose only trace was the recorder.
    """

    LOGGER = "custom_components.helman.coordinator"

    def _coordinator(self, snapshot):
        coordinator = make_coordinator()
        coordinator._hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague")
        )
        hold_pipeline(
            coordinator,
            None if snapshot is None else SimpleNamespace(battery_forecast=snapshot),
        )
        return coordinator

    def _partial_first_entry(self):
        # The off-beat rebuild: stamped 21:07 into the 21:00 slot, so
        # ``durationHours`` covers only the remainder.
        return self._coordinator(
            {
                "series": [
                    {
                        "timestamp": "2026-03-20T21:07:00+01:00",
                        "durationHours": 0.1333,
                        "socPct": 62.5,
                    }
                ]
            }
        )

    def test_a_refused_partial_names_the_off_beat_rebuild(self):
        coordinator = self._partial_first_entry()
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            self.assertIsNone(coordinator.get_battery_forecast_current())
        (line,) = captured.output
        self.assertIn("reason=partial_slot", line)
        # The slot the entities are down *for*, not the stamp on the entry.
        self.assertIn("slot=2026-03-20T21:00:00+01:00", line)
        self.assertIn("0.1333", line)

    def test_the_reason_is_logged_once_per_slot_not_once_per_read(self):
        # The five entities call this accessor on every state read; without the
        # dedupe a single dead slot would bury the log in identical lines.
        coordinator = self._partial_first_entry()
        with self.assertLogs(self.LOGGER, level="INFO"):
            coordinator.get_battery_forecast_current()
        with self.assertNoLogs(self.LOGGER, level="INFO"):
            for _ in range(5):
                coordinator.get_battery_forecast_current()

    def test_a_new_reason_in_the_same_slot_is_not_swallowed(self):
        # Dedupe keys on (reason, slot), so a stretch that changes cause
        # mid-slot still reports the change.
        coordinator = self._partial_first_entry()
        with self.assertLogs(self.LOGGER, level="INFO"):
            coordinator.get_battery_forecast_current()
        hold_pipeline(coordinator, None)
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            coordinator.get_battery_forecast_current()
        self.assertIn("reason=pipeline_cold", captured.output[0])

    def test_a_partial_served_from_the_memo_is_not_a_refusal(self):
        # Serving the slot's own full-slot figures is a success, so it logs
        # nothing -- and, crucially, does not consume the (reason, slot) dedupe
        # token, so a genuine refusal later in the same slot is still reported.
        coordinator = self._coordinator(
            {
                "series": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "durationHours": 0.25,
                        "socPct": 62.5,
                    }
                ]
            }
        )
        coordinator.get_battery_forecast_current()
        coordinator._pipeline_cache = self._partial_first_entry()._pipeline_cache
        with self.assertNoLogs(self.LOGGER, level="INFO"):
            self.assertEqual(
                coordinator.get_battery_forecast_current(), {"socPct": 62.5}
            )
        coordinator._battery_forecast_current_slot = None
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            self.assertIsNone(coordinator.get_battery_forecast_current())
        self.assertIn("reason=partial_slot", captured.output[0])

    def test_a_slot_missing_from_the_series_names_the_range_it_covered(self):
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T22:00:00+01:00", "socPct": 40.0}]}
        )
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            self.assertIsNone(coordinator.get_battery_forecast_current())
        (line,) = captured.output
        self.assertIn("reason=slot_not_in_series", line)
        self.assertIn("2026-03-20T22:00:00+01:00", line)

    def test_a_forecast_without_a_series_reports_its_status(self):
        coordinator = self._coordinator({"status": "unavailable"})
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            self.assertIsNone(coordinator.get_battery_forecast_current())
        (line,) = captured.output
        self.assertIn("reason=no_series", line)
        self.assertIn("'unavailable'", line)


class ApplianceForecastPipelineDedupeTests(unittest.IsolatedAsyncioTestCase):
    """Concurrent readers of the appliance/battery pipeline.

    The cache check, the history gather and the simulation are separated by
    awaits, so before the build lock every reader that arrived while a build was
    in flight saw the same miss and started its own gather and rebuild. These
    tests hold the gather pending on purpose -- that is the window -- and assert
    what happens to the readers waiting in it.
    """

    def _make_gated_coordinator(self):
        """A coordinator whose history gather is held until the gate opens."""
        coordinator = _make_coordinator(self)
        self.build_battery_forecast.side_effect = (
            lambda **_kwargs: _make_battery_forecast()
        )
        gate = asyncio.Event()
        gather = coordinator.gather_compute_inputs
        calls: list[dict] = []

        async def gated_gather(**kwargs):
            calls.append(kwargs)
            await gate.wait()
            return await gather(**kwargs)

        coordinator.gather_compute_inputs = gated_gather
        return coordinator, gate, calls

    @staticmethod
    def _request(coordinator, *, generated_at="2026-03-20T21:05:00+01:00"):
        return asyncio.ensure_future(
            _read_pipeline(
                coordinator,
                house_forecast=_make_house_forecast(generated_at=generated_at),
            )
        )

    @staticmethod
    async def _settle() -> None:
        # Let every pending task run up to its next real await.
        for _ in range(10):
            await asyncio.sleep(0)

    async def test_compatible_concurrent_requests_gather_and_build_once(self) -> None:
        coordinator, gate, gather_calls = self._make_gated_coordinator()

        requests = [self._request(coordinator) for _ in range(3)]
        await self._settle()
        # One reader is inside the gather; the other two are on the build lock.
        self.assertEqual(len(gather_calls), 1)

        gate.set()
        results = await asyncio.gather(*requests)

        self.assertEqual(len(gather_calls), 1)
        self.assertEqual(self.build_battery_forecast.call_count, 1)
        self.assertIs(results[0], results[1])
        self.assertIs(results[1], results[2])
        self.assertIs(results[0], coordinator._pipeline_cache.snapshot)

    async def test_incompatible_waiter_builds_its_own_result(self) -> None:
        coordinator, gate, gather_calls = self._make_gated_coordinator()

        first = self._request(coordinator)
        await self._settle()
        # A newer house snapshot: the winner's result is not valid for it, so
        # the recheck must miss and this reader must build for itself.
        second = self._request(
            coordinator, generated_at="2026-03-20T21:20:00+01:00"
        )
        await self._settle()
        gate.set()
        first_pipeline, second_pipeline = await asyncio.gather(first, second)

        self.assertEqual(len(gather_calls), 2)
        self.assertEqual(self.build_battery_forecast.call_count, 2)
        self.assertIsNot(first_pipeline, second_pipeline)
        self.assertEqual(
            coordinator._pipeline_cache.key.house_generated_at,
            "2026-03-20T21:20:00+01:00",
        )

    async def test_cancelled_waiter_leaves_the_build_and_the_other_waiter_alone(
        self,
    ) -> None:
        coordinator, gate, gather_calls = self._make_gated_coordinator()

        builder = self._request(coordinator)
        cancelled = self._request(coordinator)
        survivor = self._request(coordinator)
        await self._settle()

        cancelled.cancel()
        await self._settle()
        gate.set()
        built = await builder
        survived = await survivor

        self.assertTrue(cancelled.cancelled())
        self.assertEqual(len(gather_calls), 1)
        self.assertEqual(self.build_battery_forecast.call_count, 1)
        self.assertIs(built, survived)

    async def test_failed_build_releases_the_lock_and_the_next_reader_retries(
        self,
    ) -> None:
        coordinator, gate, gather_calls = self._make_gated_coordinator()
        self.build_battery_forecast.side_effect = [
            RuntimeError("recorder is down"),
            _make_battery_forecast(),
        ]

        failing = self._request(coordinator)
        waiter = self._request(coordinator)
        await self._settle()
        gate.set()

        with self.assertRaises(RuntimeError):
            await failing
        pipeline = await waiter

        # The failure is not cached and does not poison the waiter: it simply
        # finds no valid cache and builds again.
        self.assertEqual(len(gather_calls), 2)
        self.assertEqual(self.build_battery_forecast.call_count, 2)
        self.assertIs(pipeline, coordinator._pipeline_cache.snapshot)

    async def test_build_invalidated_mid_flight_is_not_published(self) -> None:
        coordinator, gate, _gather_calls = self._make_gated_coordinator()

        request = self._request(coordinator)
        await self._settle()
        # Stands in for a config change, a fresh forecast snapshot, or unload:
        # all of them invalidate, and none of them may be overwritten by the
        # build that was already in flight.
        coordinator._invalidate_pipeline_cache()
        gate.set()
        pipeline = await request

        # The caller still gets what it asked for; the cache stays cleared.
        self.assertIsNotNone(pipeline)
        self.assertIsNone(coordinator._pipeline_cache)

    async def test_a_superseded_build_does_not_set_the_cache_back(self) -> None:
        """A build handed older snapshots must not overwrite a newer entry.

        The caller reads the canonical snapshots and only then works its way
        down here, so a refresh can publish newer ones -- invalidating the
        cache and filling it again -- while it is still on its way. The
        revision it samples on arrival is then already the new one, and only
        the snapshots it is holding say the build is behind.
        """
        coordinator = self._make_gated_coordinator()[0]
        coordinator.gather_compute_inputs = (
            HelmanCoordinator.gather_compute_inputs.__get__(coordinator)
        )

        fresh = await _read_pipeline(
            coordinator,
            house_forecast=_make_house_forecast(
                generated_at="2026-03-20T21:20:00+01:00"
            ),
        )
        revision = coordinator._forecast_cache_revision

        stale = await _read_pipeline(
            coordinator,
            house_forecast=_make_house_forecast(
                generated_at="2026-03-20T21:05:00+01:00"
            ),
        )

        # It gets the forecast it asked for -- and the cache keeps the newer
        # one, so the signature-less readers go on serving that.
        self.assertIsNot(stale, fresh)
        self.assertIs(coordinator._pipeline_cache.snapshot, fresh)
        self.assertEqual(
            coordinator._pipeline_cache.key.house_generated_at,
            "2026-03-20T21:20:00+01:00",
        )
        # Nothing was invalidated: the revision guard alone would have let the
        # store through.
        self.assertEqual(coordinator._forecast_cache_revision, revision)

    async def test_the_run_computes_against_the_registry_it_pinned(self) -> None:
        """The registry travels with the other inputs pinned on the loop.

        ``AppliancesRegistryHolder.refresh`` replaces
        ``current``, and several loop-side request handlers call
        it. With the simulation on a worker, a rebind between the gather and
        the build would otherwise cost the projection against a different
        version of an appliance than the run pinned.
        """
        coordinator = _make_coordinator(self)
        pinned = coordinator._appliances_registry.current
        gather = coordinator.gather_compute_inputs
        used: list[object] = []

        async def gather_then_swap(**kwargs):
            compute_inputs = await gather(**kwargs)
            # Stands in for a climate entity coming back from unavailable
            # while this run is in flight.
            coordinator._appliances_registry.current = (
                coordinator_module.AppliancesRuntimeRegistry()
            )
            return compute_inputs

        coordinator.gather_compute_inputs = gather_then_swap

        def record_registry(**kwargs):
            used.append(kwargs["registry"])
            return _make_projection_plan()

        with patch.object(
            assembly,
            "build_appliance_projection_plan",
            side_effect=record_registry,
        ):
            await _read_pipeline(coordinator)

        # Identity, not equality: two empty registries compare equal.
        self.assertEqual(len(used), 1)
        self.assertIs(used[0], pinned)
        self.assertIsNot(coordinator._appliances_registry.current, pinned)

    async def test_pipeline_build_simulates_off_the_loop_without_touching_states(
        self,
    ) -> None:
        """The rebuild runs on a worker thread and reads no live state there.

        A real thread rather than an inline stub, so "off the event loop" is
        actually observed; ``hass.states`` is poisoned so any live read that
        crept back into the pure core would fail loudly instead of quietly
        blocking the loop.
        """
        coordinator = _make_coordinator(self)
        loop_thread_id = threading.get_ident()
        worker_thread_ids: list[int] = []
        hops: list[object] = []
        executor = ThreadPoolExecutor(max_workers=1)
        self.addCleanup(executor.shutdown)

        async def async_add_executor_job(func, *args):
            hops.append(func)

            def run():
                worker_thread_ids.append(threading.get_ident())
                return func(*args)

            return await asyncio.get_running_loop().run_in_executor(executor, run)

        class _PoisonedStates:
            def get(self, *_args, **_kwargs):
                raise AssertionError("the worker must not read hass.states")

        coordinator._hass = SimpleNamespace(
            async_add_executor_job=async_add_executor_job,
            states=_PoisonedStates(),
        )

        await _read_pipeline(coordinator)

        self.assertEqual(len(hops), 1)
        self.assertEqual(hops[0].func, assembly.build_forecast_rebuild)
        self.assertEqual(len(worker_thread_ids), 1)
        self.assertNotEqual(worker_thread_ids[0], loop_thread_id)


if __name__ == "__main__":
    unittest.main()
