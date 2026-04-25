from __future__ import annotations

from datetime import datetime

import re
import importlib
import sys
import types
import pathlib


def setup_package_stubs():
    repo_root = pathlib.Path(__file__).resolve().parents[1]
    custom_components_dir = repo_root / "custom_components"
    helman_dir = custom_components_dir / "helman"

    # custom_components package stub
    if "custom_components" not in sys.modules:
        pkg = types.ModuleType("custom_components")
        pkg.__path__ = [str(custom_components_dir)]
        sys.modules["custom_components"] = pkg

    # custom_components.helman package stub
    if "custom_components.helman" not in sys.modules:
        pkg = types.ModuleType("custom_components.helman")
        pkg.__path__ = [str(helman_dir)]
        sys.modules["custom_components.helman"] = pkg


setup_package_stubs()

from custom_components.helman.solar_bias_correction import models

# Trainer module will be created in Task 4
from custom_components.helman.solar_bias_correction import trainer


_ALL_SLOTS = [f"{h:02d}:{m:02d}" for h in range(24) for m in (0, 15, 30, 45)]


def make_uniform_actuals(forecast_wh: float) -> dict[str, float]:
    per_slot = forecast_wh / len(_ALL_SLOTS)
    return {s: per_slot for s in _ALL_SLOTS}


def make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0, training_time="00:00") -> models.BiasConfig:
    return models.BiasConfig(
        enabled=True,
        min_history_days=min_history_days,
        training_time=training_time,
        clamp_min=clamp_min,
        clamp_max=clamp_max,
        daily_energy_entity_ids=[],
        total_energy_entity_id=None,
    )


def test_profile_trains_with_sufficient_history():
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)

    samples = [
        models.TrainerSample(date="2023-01-01", forecast_wh=5000.0),
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0),
    ]

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            s.date: make_uniform_actuals(s.forecast_wh) for s in samples
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.last_outcome == "profile_trained"
    assert len(outcome.profile.factors) > 0
    # All factors should be 1.0 because actual == forecast per slot
    vals = list(outcome.profile.factors.values())
    assert all(abs(v - 1.0) < 1e-6 for v in vals)
    assert outcome.metadata.omitted_slot_count == 0
    assert outcome.metadata.factor_min == 1.0
    assert outcome.metadata.factor_max == 1.0
    assert outcome.metadata.factor_median == 1.0


def test_insufficient_history_returns_fallback():
    cfg = make_cfg(min_history_days=3)

    samples = [
        models.TrainerSample(date="2023-01-01", forecast_wh=5000.0),
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0),
    ]

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            s.date: make_uniform_actuals(s.forecast_wh) for s in samples
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.last_outcome == "insufficient_history"
    assert outcome.profile.factors == {}
    assert set(outcome.profile.omitted_slots) == set(_ALL_SLOTS)
    assert outcome.metadata.omitted_slot_count == len(_ALL_SLOTS)


def test_day_forecast_too_low_is_dropped():
    cfg = make_cfg(min_history_days=2)

    samples = [
        models.TrainerSample(date="2023-01-01", forecast_wh=50.0),  # too low
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0),
        models.TrainerSample(date="2023-01-03", forecast_wh=5000.0),
    ]

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            s.date: make_uniform_actuals(s.forecast_wh) for s in samples
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.last_outcome == "profile_trained"
    # Ensure dropped day recorded
    dropped = outcome.metadata.dropped_days
    assert any(d["date"] == "2023-01-01" and d["reason"] == "day_forecast_too_low" for d in dropped)


def test_day_ratio_out_of_band_is_dropped():
    cfg = make_cfg(min_history_days=2)

    samples = [
        models.TrainerSample(date="2023-01-01", forecast_wh=1000.0),
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0),
        models.TrainerSample(date="2023-01-03", forecast_wh=5000.0),
    ]

    # Make day 2023-01-01 actuals huge to force ratio > 5.0
    big_actuals = {s: 1000.0 for s in _ALL_SLOTS}

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2023-01-01": big_actuals,
            "2023-01-02": make_uniform_actuals(5000.0),
            "2023-01-03": make_uniform_actuals(5000.0),
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.last_outcome == "profile_trained"
    dropped = outcome.metadata.dropped_days
    assert any(
        d["date"] == "2023-01-01"
        and d["reason"] == "day_ratio_out_of_band"
        and d["forecast_wh"] == "1000.000"
        and d["actual_wh"] == "96000.000"
        and d["ratio"] == "96.000000"
        for d in dropped
    )


def test_factor_clamps_to_clamp_max():
    cfg = make_cfg(min_history_days=1, clamp_min=0.1, clamp_max=1.5)

    samples = [models.TrainerSample(date="2023-01-01", forecast_wh=5000.0)]

    # Set actuals double the forecast to produce raw factor 2.0 -> clamp to 1.5
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2023-01-01": {s: (5000.0 / len(_ALL_SLOTS)) * 2.0 for s in _ALL_SLOTS}
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())
    vals = list(outcome.profile.factors.values())
    assert all(abs(v - 1.5) < 1e-6 for v in vals)


def test_factor_clamps_to_clamp_min():
    cfg = make_cfg(min_history_days=1, clamp_min=0.8, clamp_max=10.0)

    samples = [models.TrainerSample(date="2023-01-01", forecast_wh=5000.0)]

    # Set actuals half the forecast to produce raw factor 0.5 -> clamp to 0.8
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2023-01-01": {s: (5000.0 / len(_ALL_SLOTS)) * 0.5 for s in _ALL_SLOTS}
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())
    vals = list(outcome.profile.factors.values())
    assert all(abs(v - 0.8) < 1e-6 for v in vals)


def test_fingerprint_depends_on_training_config_but_excludes_training_time():
    cfg1 = make_cfg(min_history_days=2, training_time="00:00")
    cfg2 = make_cfg(min_history_days=2, training_time="12:34")
    cfg3 = make_cfg(min_history_days=3, training_time="00:00")

    f1 = trainer.compute_fingerprint(cfg1)
    f2 = trainer.compute_fingerprint(cfg2)
    f3 = trainer.compute_fingerprint(cfg3)

    assert f1 == f2
    assert f1 != f3


def test_fingerprint_format():
    cfg = make_cfg()
    f = trainer.compute_fingerprint(cfg)
    assert re.match(r"^sha256:[0-9a-f]{64}$", f)
