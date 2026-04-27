from __future__ import annotations

import asyncio
import importlib
import inspect
import sys
import types
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


if "custom_components" not in sys.modules:
    pkg = types.ModuleType("custom_components")
    pkg.__path__ = [str(ROOT / "custom_components")]
    sys.modules["custom_components"] = pkg

if "custom_components.helman" not in sys.modules:
    pkg = types.ModuleType("custom_components.helman")
    pkg.__path__ = [str(ROOT / "custom_components" / "helman")]
    sys.modules["custom_components.helman"] = pkg

if "homeassistant" not in sys.modules:
    sys.modules["homeassistant"] = types.ModuleType("homeassistant")

core_mod = types.ModuleType("homeassistant.core")
core_mod.HomeAssistant = type("HomeAssistant", (), {})
core_mod.callback = lambda func: func
sys.modules["homeassistant.core"] = core_mod

util_mod = types.ModuleType("homeassistant.util")
sys.modules["homeassistant.util"] = util_mod

dt_mod = types.ModuleType("homeassistant.util.dt")
dt_mod.now = lambda: None
dt_mod.as_local = lambda value: value
sys.modules["homeassistant.util.dt"] = dt_mod

helpers_mod = types.ModuleType("homeassistant.helpers")
sys.modules["homeassistant.helpers"] = helpers_mod

event_mod = types.ModuleType("homeassistant.helpers.event")
event_mod.async_track_time_change = lambda hass, callback, **kwargs: lambda: None
sys.modules["homeassistant.helpers.event"] = event_mod

actuals_mod = types.ModuleType("custom_components.helman.solar_bias_correction.actuals")
async def _load_actuals_window(*args, **kwargs):
    return None
async def _load_actuals_for_day(*args, **kwargs):
    return {}
actuals_mod.load_actuals_window = _load_actuals_window
actuals_mod.load_actuals_for_day = _load_actuals_for_day
sys.modules[actuals_mod.__name__] = actuals_mod

forecast_history_mod = types.ModuleType("custom_components.helman.solar_bias_correction.forecast_history")
async def _load_forecast_points_for_day(*args, **kwargs):
    return []
async def _load_trainer_samples(*args, **kwargs):
    return []
forecast_history_mod.load_forecast_points_for_day = _load_forecast_points_for_day
forecast_history_mod.load_trainer_samples = _load_trainer_samples
sys.modules[forecast_history_mod.__name__] = forecast_history_mod


models = importlib.import_module("custom_components.helman.solar_bias_correction.models")
sys.modules.pop("custom_components.helman.solar_bias_correction.service", None)
service_mod = importlib.import_module("custom_components.helman.solar_bias_correction.service")
scheduler_mod = importlib.import_module("custom_components.helman.solar_bias_correction.scheduler")


class _DummyStore:
    profile = None

    async def async_save(self, payload):
        self.saved = payload


def _make_cfg(
    *,
    slot_invalidation_max_battery_soc_percent: float | None = None,
    slot_invalidation_export_enabled_entity_id: str | None = None,
) -> models.BiasConfig:
    return models.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        aggregation_method="ratio_of_sums",
        daily_energy_entity_ids=[],
        total_energy_entity_id=None,
        slot_invalidation_max_battery_soc_percent=(
            slot_invalidation_max_battery_soc_percent
        ),
        slot_invalidation_export_enabled_entity_id=(
            slot_invalidation_export_enabled_entity_id
        ),
        max_training_window_days=90,
    )


def test_training_failed_with_preserved_profile_keeps_adjusted_variant():
    service = service_mod.SolarBiasCorrectionService(
        SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
        _DummyStore(),
        _make_cfg(),
    )
    service._profile = models.SolarBiasProfile(factors={"12:00": 2.0}, omitted_slots=[])
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-24T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=2.0,
        factor_max=2.0,
        factor_median=2.0,
        omitted_slot_count=0,
        last_outcome="training_failed",
        error_reason="boom",
    )

    result = service.build_adjustment_result(
        [{"timestamp": "2026-04-24T12:00:00+02:00", "value": 10.0}],
        None,
    )

    assert result.status == "training_failed"
    assert result.effective_variant == "adjusted"
    assert result.adjusted_points[0]["value"] == 20.0
    assert result.explainability.error == "boom"


def test_training_failed_without_profile_falls_back_to_raw():
    service = service_mod.SolarBiasCorrectionService(
        SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
        _DummyStore(),
        _make_cfg(),
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-24T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=0,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=0,
        last_outcome="training_failed",
        error_reason="boom",
    )

    result = service.build_adjustment_result(
        [{"timestamp": "2026-04-24T12:00:00+02:00", "value": 10.0}],
        None,
    )

    assert result.status == "training_failed"
    assert result.effective_variant == "raw"
    assert result.adjusted_points[0]["value"] == 10.0


def test_get_profile_payload_returns_none_without_real_profile():
    service = service_mod.SolarBiasCorrectionService(
        SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
        _DummyStore(),
        _make_cfg(),
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-24T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=0,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=0,
        last_outcome="training_failed",
        error_reason="boom",
    )

    assert service.get_profile_payload() is None


def test_get_profile_payload_returns_none_for_insufficient_history_placeholder():
    service = service_mod.SolarBiasCorrectionService(
        SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
        _DummyStore(),
        _make_cfg(),
    )
    service._profile = models.SolarBiasProfile(
        factors={},
        omitted_slots=["00:00", "00:15"],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-24T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=0,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=96,
        last_outcome="insufficient_history",
        error_reason=None,
    )

    assert service.get_profile_payload() is None


def test_get_profile_payload_returns_runtime_profile():
    service = service_mod.SolarBiasCorrectionService(
        SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
        _DummyStore(),
        _make_cfg(),
    )
    service._profile = models.SolarBiasProfile(
        factors={"12:00": 2.0},
        omitted_slots=["11:30"],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-24T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=2.0,
        factor_max=2.0,
        factor_median=2.0,
        omitted_slot_count=1,
        last_outcome="profile_trained",
        error_reason=None,
    )

    assert service.get_profile_payload() == {
        "trainedAt": "2026-04-24T03:00:00+02:00",
        "factors": {"12:00": 2.0},
        "omittedSlots": ["11:30"],
    }


def test_get_status_payload_includes_invalidated_slot_count():
    service = service_mod.SolarBiasCorrectionService(
        SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
        _DummyStore(),
        _make_cfg(),
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-24T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=2.0,
        factor_max=2.0,
        factor_median=2.0,
        omitted_slot_count=1,
        last_outcome="profile_trained",
        invalidated_slot_count=4,
        error_reason=None,
    )

    old_now = service_mod.dt_util.now
    try:
        from datetime import datetime

        service_mod.dt_util.now = lambda: datetime.fromisoformat(
            "2026-04-24T03:00:00+02:00"
        )
        assert service.get_status_payload()["invalidatedSlotCount"] == 4
    finally:
        service_mod.dt_util.now = old_now


def test_get_status_payload_reports_slot_invalidation_enabled():
    service = service_mod.SolarBiasCorrectionService(
        SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
        _DummyStore(),
        _make_cfg(
            slot_invalidation_max_battery_soc_percent=97.0,
            slot_invalidation_export_enabled_entity_id="binary_sensor.export_enabled",
        ),
    )

    old_now = service_mod.dt_util.now
    try:
        from datetime import datetime

        service_mod.dt_util.now = lambda: datetime.fromisoformat(
            "2026-04-24T03:00:00+02:00"
        )
        payload = service.get_status_payload()
    finally:
        service_mod.dt_util.now = old_now

    assert payload["slotInvalidationEnabled"] is True


def test_reloaded_insufficient_history_payload_keeps_profile_unavailable():
    async def _inner():
        store = _DummyStore()
        store.profile = {
            "version": 1,
            "profile": {
                "factors": {},
                "omitted_slots": ["00:00", "00:15"],
            },
            "metadata": {
                "trained_at": "2026-04-24T03:00:00+02:00",
                "training_config_fingerprint": service_mod.compute_fingerprint(_make_cfg()),
                "usable_days": 0,
                "dropped_days": [],
                "factor_min": None,
                "factor_max": None,
                "factor_median": None,
                "omitted_slot_count": 96,
                "last_outcome": "insufficient_history",
                "error_reason": None,
            },
        }

        service = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            store,
            _make_cfg(),
        )
        await service.async_setup()

        assert service.get_profile_payload() is None

    asyncio.run(_inner())


def test_failed_first_training_does_not_persist_phantom_profile_after_reload():
    class _SavingStore:
        profile = None

        def __init__(self) -> None:
            self.saved_payloads = []

        async def async_save(self, payload):
            self.saved_payloads.append(payload)
            self.profile = payload

    async def _inner():
        store = _SavingStore()
        service = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            store,
            _make_cfg(),
        )

        old_now = service_mod.dt_util.now
        old_samples = service_mod.load_trainer_samples
        old_actuals = service_mod.load_actuals_window
        try:
            from datetime import datetime

            now = datetime.fromisoformat("2026-04-24T03:00:00+02:00")
            service_mod.dt_util.now = lambda: now

            async def _samples(*args, **kwargs):
                return ["sample"]

            async def _actuals(*args, **kwargs):
                raise RuntimeError("boom")

            service_mod.load_trainer_samples = _samples
            service_mod.load_actuals_window = _actuals

            payload = await service.async_train()
        finally:
            service_mod.dt_util.now = old_now
            service_mod.load_trainer_samples = old_samples
            service_mod.load_actuals_window = old_actuals

        reloaded = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            store,
            _make_cfg(),
        )
        await reloaded.async_setup()

        assert store.saved_payloads[-1]["profile"] is None
        assert payload["status"] == "training_failed"
        assert payload["effectiveVariant"] == "raw"
        assert reloaded.get_profile_payload() is None
        service_mod.dt_util.now = lambda: now
        try:
            reloaded_status = reloaded.get_status_payload()
        finally:
            service_mod.dt_util.now = old_now
        assert reloaded_status["status"] == "training_failed"
        assert reloaded_status["effectiveVariant"] == "raw"

    asyncio.run(_inner())


def test_insufficient_history_placeholder_is_not_preserved_after_failed_retrain():
    class _SavingStore:
        profile = None

        def __init__(self) -> None:
            self.saved_payloads = []

        async def async_save(self, payload):
            self.saved_payloads.append(payload)
            self.profile = payload

    async def _inner():
        store = _SavingStore()
        service = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            store,
            _make_cfg(),
        )

        service._profile = models.SolarBiasProfile(
            factors={},
            omitted_slots=["00:00", "00:30"],
        )
        service._metadata = models.SolarBiasMetadata(
            trained_at="2026-04-24T03:00:00+02:00",
            training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
            usable_days=0,
            dropped_days=[],
            factor_min=None,
            factor_max=None,
            factor_median=None,
            omitted_slot_count=48,
            last_outcome="insufficient_history",
            error_reason=None,
        )

        old_now = service_mod.dt_util.now
        old_samples = service_mod.load_trainer_samples
        old_actuals = service_mod.load_actuals_window
        try:
            from datetime import datetime

            now = datetime.fromisoformat("2026-04-25T03:00:00+02:00")
            service_mod.dt_util.now = lambda: now

            async def _samples(*args, **kwargs):
                return ["sample"]

            async def _actuals(*args, **kwargs):
                raise RuntimeError("boom")

            service_mod.load_trainer_samples = _samples
            service_mod.load_actuals_window = _actuals

            payload = await service.async_train()
        finally:
            service_mod.dt_util.now = old_now
            service_mod.load_trainer_samples = old_samples
            service_mod.load_actuals_window = old_actuals

        reloaded = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            store,
            _make_cfg(),
        )
        await reloaded.async_setup()

        assert payload["status"] == "training_failed"
        assert payload["effectiveVariant"] == "raw"
        assert service.get_profile_payload() is None
        assert store.saved_payloads[-1]["profile"] is None
        assert reloaded.get_profile_payload() is None

        service_mod.dt_util.now = lambda: now
        try:
            reloaded_status = reloaded.get_status_payload()
        finally:
            service_mod.dt_util.now = old_now
        assert reloaded_status["status"] == "training_failed"
        assert reloaded_status["effectiveVariant"] == "raw"

    asyncio.run(_inner())


def test_failed_retrain_keeps_original_trained_at_for_preserved_profile():
    class _SavingStore:
        profile = None

        def __init__(self) -> None:
            self.saved_payloads = []

        async def async_save(self, payload):
            self.saved_payloads.append(payload)
            self.profile = payload

    async def _inner():
        store = _SavingStore()
        service = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            store,
            _make_cfg(),
        )
        service._profile = models.SolarBiasProfile(
            factors={"12:00": 2.0},
            omitted_slots=[],
        )
        service._metadata = models.SolarBiasMetadata(
            trained_at="2026-04-20T03:00:00+02:00",
            training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
            usable_days=12,
            dropped_days=[],
            factor_min=2.0,
            factor_max=2.0,
            factor_median=2.0,
            omitted_slot_count=0,
            last_outcome="profile_trained",
            error_reason=None,
        )

        old_now = service_mod.dt_util.now
        old_samples = service_mod.load_trainer_samples
        old_actuals = service_mod.load_actuals_window
        try:
            from datetime import datetime

            now = datetime.fromisoformat("2026-04-25T03:00:00+02:00")
            service_mod.dt_util.now = lambda: now

            async def _samples(*args, **kwargs):
                return ["sample"]

            async def _actuals(*args, **kwargs):
                raise RuntimeError("boom")

            service_mod.load_trainer_samples = _samples
            service_mod.load_actuals_window = _actuals

            payload = await service.async_train()
        finally:
            service_mod.dt_util.now = old_now
            service_mod.load_trainer_samples = old_samples
            service_mod.load_actuals_window = old_actuals

        assert payload["status"] == "training_failed"
        assert payload["effectiveVariant"] == "adjusted"
        assert payload["trainedAt"] == "2026-04-20T03:00:00+02:00"
        assert service.get_profile_payload()["trainedAt"] == "2026-04-20T03:00:00+02:00"
        assert store.saved_payloads[-1]["metadata"]["trained_at"] == "2026-04-20T03:00:00+02:00"

    asyncio.run(_inner())


def test_failed_stale_retrain_preserves_previous_fingerprint_after_reload():
    class _SavingStore:
        profile = None

        def __init__(self) -> None:
            self.saved_payloads = []

        async def async_save(self, payload):
            self.saved_payloads.append(payload)
            self.profile = payload

    async def _inner():
        store = _SavingStore()
        base_cfg = _make_cfg()
        service = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            store,
            base_cfg,
        )
        service._profile = models.SolarBiasProfile(
            factors={"12:00": 2.0},
            omitted_slots=[],
        )
        service._metadata = models.SolarBiasMetadata(
            trained_at="2026-04-20T03:00:00+02:00",
            training_config_fingerprint=service_mod.compute_fingerprint(base_cfg),
            usable_days=12,
            dropped_days=[],
            factor_min=2.0,
            factor_max=2.0,
            factor_median=2.0,
            omitted_slot_count=0,
            last_outcome="profile_trained",
            error_reason=None,
        )

        changed_cfg = models.BiasConfig(
            enabled=True,
            min_history_days=3,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=[],
            total_energy_entity_id=None,
        )
        service.update_config(changed_cfg)

        old_now = service_mod.dt_util.now
        old_samples = service_mod.load_trainer_samples
        old_actuals = service_mod.load_actuals_window
        try:
            from datetime import datetime

            now = datetime.fromisoformat("2026-04-25T04:00:00+02:00")
            service_mod.dt_util.now = lambda: now

            async def _samples(*args, **kwargs):
                return ["sample"]

            async def _actuals(*args, **kwargs):
                raise RuntimeError("boom")

            service_mod.load_trainer_samples = _samples
            service_mod.load_actuals_window = _actuals

            payload = await service.async_train()
        finally:
            service_mod.dt_util.now = old_now
            service_mod.load_trainer_samples = old_samples
            service_mod.load_actuals_window = old_actuals

        reloaded = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            store,
            changed_cfg,
        )
        await reloaded.async_setup()

        assert payload["status"] == "config_changed_pending_retrain"
        assert payload["effectiveVariant"] == "raw"
        assert payload["lastOutcome"] == "training_failed"
        assert store.saved_payloads[-1]["metadata"]["training_config_fingerprint"] == service_mod.compute_fingerprint(base_cfg)
        assert reloaded.get_profile_payload()["factors"] == {"12:00": 2.0}

        service_mod.dt_util.now = lambda: now
        try:
            reloaded_status = reloaded.get_status_payload()
        finally:
            service_mod.dt_util.now = old_now
        assert reloaded_status["status"] == "config_changed_pending_retrain"
        assert reloaded_status["effectiveVariant"] == "raw"
        assert reloaded_status["isStale"] is True

    asyncio.run(_inner())


def test_async_train_uses_configured_max_training_window_days_for_actuals():
    class _SavingStore:
        profile = None

        async def async_save(self, payload):
            self.profile = payload

    async def _inner():
        cfg = _make_cfg()
        cfg.max_training_window_days = 12
        service = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            _SavingStore(),
            cfg,
        )

        old_now = service_mod.dt_util.now
        old_samples = service_mod.load_trainer_samples
        old_actuals = service_mod.load_actuals_window
        old_train = service_mod.train
        try:
            from datetime import datetime

            now = datetime.fromisoformat("2026-04-24T03:00:00+02:00")
            service_mod.dt_util.now = lambda: now

            async def _samples(*args, **kwargs):
                return []

            async def _actuals(hass, cfg_arg, days):
                assert days == 12
                return models.SolarActualsWindow(slot_actuals_by_date={})

            def _train(samples, actuals, cfg_arg, now):
                return models.TrainingOutcome(
                    profile=models.SolarBiasProfile(factors={}, omitted_slots=[]),
                    metadata=models.SolarBiasMetadata(
                        trained_at=now.isoformat(),
                        training_config_fingerprint=service_mod.compute_fingerprint(cfg_arg),
                        usable_days=cfg_arg.max_training_window_days,
                        dropped_days=[],
                        factor_min=None,
                        factor_max=None,
                        factor_median=None,
                        omitted_slot_count=0,
                        last_outcome="profile_trained",
                        error_reason=None,
                    ),
                )

            service_mod.load_trainer_samples = _samples
            service_mod.load_actuals_window = _actuals
            service_mod.train = _train

            payload = await service.async_train()
        finally:
            service_mod.dt_util.now = old_now
            service_mod.load_trainer_samples = old_samples
            service_mod.load_actuals_window = old_actuals
            service_mod.train = old_train

        assert payload["usableDays"] == 12

    asyncio.run(_inner())


def test_scheduler_registers_sync_callback_that_schedules_training():
    captured: dict[str, object] = {}

    async def _training_callback():
        captured["ran"] = True

    def _track_time_change(hass, callback, **kwargs):
        captured["callback"] = callback
        captured["kwargs"] = kwargs
        return lambda: None

    scheduler_mod.async_track_time_change = _track_time_change

    created = []

    def _create_task(coro):
        created.append(coro)
        return SimpleNamespace()

    scheduler = scheduler_mod.SolarBiasTrainingScheduler(
        SimpleNamespace(async_create_task=_create_task),
        _training_callback,
    )

    scheduler.schedule("03:15")

    callback = captured["callback"]
    assert not inspect.iscoroutinefunction(callback)

    callback(None)
    assert len(created) == 1
    asyncio.run(created[0])
    assert captured["ran"] is True


def test_async_train_save_failure_keeps_previous_profile_active():
    class _FailingThenSavingStore:
        profile = None

        def __init__(self) -> None:
            self.calls = 0
            self.saved_payloads = []

        async def async_save(self, payload):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("save failed")
            self.saved_payloads.append(payload)

    async def _inner():
        store = _FailingThenSavingStore()
        service = service_mod.SolarBiasCorrectionService(
            SimpleNamespace(bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None)),
            store,
            _make_cfg(),
        )
        service._profile = models.SolarBiasProfile(factors={"12:00": 2.0}, omitted_slots=[])
        service._metadata = models.SolarBiasMetadata(
            trained_at="2026-04-23T03:00:00+02:00",
            training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
            usable_days=11,
            dropped_days=[],
            factor_min=2.0,
            factor_max=2.0,
            factor_median=2.0,
            omitted_slot_count=0,
            last_outcome="profile_trained",
            error_reason=None,
        )

        old_now = service_mod.dt_util.now
        old_samples = service_mod.load_trainer_samples
        old_actuals = service_mod.load_actuals_window
        old_train = service_mod.train
        try:
            from datetime import datetime

            service_mod.dt_util.now = lambda: datetime.fromisoformat(
                "2026-04-24T03:00:00+02:00"
            )

            async def _samples(*args, **kwargs):
                return ["sample"]

            async def _actuals(*args, **kwargs):
                return "actuals"

            def _train(samples, actuals, cfg, now):
                assert samples == ["sample"]
                assert actuals == "actuals"
                return models.TrainingOutcome(
                    profile=models.SolarBiasProfile(
                        factors={"12:00": 5.0},
                        omitted_slots=[],
                    ),
                    metadata=models.SolarBiasMetadata(
                        trained_at=now.isoformat(),
                        training_config_fingerprint=service_mod.compute_fingerprint(cfg),
                        usable_days=20,
                        dropped_days=[],
                        factor_min=5.0,
                        factor_max=5.0,
                        factor_median=5.0,
                        omitted_slot_count=0,
                        last_outcome="profile_trained",
                        error_reason=None,
                    ),
                )

            service_mod.load_trainer_samples = _samples
            service_mod.load_actuals_window = _actuals
            service_mod.train = _train

            payload = await service.async_train()
        finally:
            service_mod.dt_util.now = old_now
            service_mod.load_trainer_samples = old_samples
            service_mod.load_actuals_window = old_actuals
            service_mod.train = old_train

        result = service.build_adjustment_result(
            [{"timestamp": "2026-04-24T12:00:00+02:00", "value": 10.0}],
            None,
        )

        assert payload["status"] == "training_failed"
        assert payload["effectiveVariant"] == "adjusted"
        assert service._profile.factors == {"12:00": 2.0}
        assert service._metadata.last_outcome == "training_failed"
        assert result.adjusted_points[0]["value"] == 20.0
        assert store.calls == 2
        assert store.saved_payloads[-1]["profile"]["factors"] == {"12:00": 2.0}

    asyncio.run(_inner())
