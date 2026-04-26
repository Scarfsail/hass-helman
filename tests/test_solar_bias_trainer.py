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


def make_uniform_slot_forecast(forecast_wh: float, slots: list[str] | None = None) -> dict[str, float]:
    """Spread forecast evenly across hourly slots (00:00..23:00)."""
    keys = slots if slots is not None else [f"{h:02d}:00" for h in range(24)]
    if not keys:
        return {}
    per = forecast_wh / len(keys)
    return {k: per for k in keys}


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
        models.TrainerSample(date="2023-01-01", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
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


def test_train_logs_invalidated_slot_count(caplog):
    cfg = make_cfg(min_history_days=1)
    samples = [
        models.TrainerSample(
            date="2023-01-01",
            forecast_wh=5000.0,
            slot_forecast_wh=make_uniform_slot_forecast(5000.0),
        )
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={"2023-01-01": make_uniform_actuals(5000.0)},
        invalidated_slots_by_date={"2023-01-01": {"12:00", "13:00"}},
    )

    with caplog.at_level("INFO"):
        trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert "invalidated" in caplog.text
    assert "2" in caplog.text


def test_insufficient_history_returns_fallback():
    cfg = make_cfg(min_history_days=3)

    samples = [
        models.TrainerSample(date="2023-01-01", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
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
        models.TrainerSample(date="2023-01-01", forecast_wh=50.0, slot_forecast_wh=make_uniform_slot_forecast(50.0)),  # too low
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
        models.TrainerSample(date="2023-01-03", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
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
        models.TrainerSample(date="2023-01-01", forecast_wh=1000.0, slot_forecast_wh=make_uniform_slot_forecast(1000.0)),
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
        models.TrainerSample(date="2023-01-03", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
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

    samples = [models.TrainerSample(date="2023-01-01", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0))]

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

    samples = [models.TrainerSample(date="2023-01-01", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0))]

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


def test_factors_match_per_slot_actual_over_forecast():
    """factor[slot] = sum(actual_in_slot) / sum(forecast_in_slot), regardless of day total."""
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)

    # Realistic single-hour forecast: 9 kWh at 12:00, 0 elsewhere.
    slot_forecast = {f"{h:02d}:00": 0.0 for h in range(24)}
    slot_forecast["12:00"] = 9000.0

    # Actuals: 4 quarters making up the 12:00 hour total 9000 Wh.
    actuals_full = {f"{h:02d}:{m:02d}": 0.0 for h in range(24) for m in (0, 15, 30, 45)}
    actuals_full["12:00"] = 2000.0
    actuals_full["12:15"] = 2500.0
    actuals_full["12:30"] = 2500.0
    actuals_full["12:45"] = 2000.0  # sum = 9000

    samples = [
        models.TrainerSample(
            date=f"2026-04-{15+i:02d}",
            forecast_wh=9000.0,
            slot_forecast_wh=dict(slot_forecast),
        )
        for i in range(2)
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={s.date: dict(actuals_full) for s in samples}
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.last_outcome == "profile_trained"
    # Sum of 4 quarters / hourly forecast = 9000/9000 = 1.0 → factor at 12:00 must be ~1.0
    assert "12:00" in outcome.profile.factors
    assert abs(outcome.profile.factors["12:00"] - 1.0) < 1e-6
    # Slots with zero forecast must be omitted, not pinned to clamp_min
    assert "00:00" in outcome.profile.omitted_slots
    assert "00:00" not in outcome.profile.factors


def test_factors_not_pinned_to_clamps_when_forecast_is_realistic():
    """Regression test: previous algorithm pinned night to clamp_min and noon to clamp_max."""
    cfg = make_cfg(min_history_days=1, clamp_min=0.3, clamp_max=2.0)

    # Diurnal hourly forecast (Wh), totaling ~60 kWh.
    diurnal = {
        "06:00": 364.0, "07:00": 1292.5, "08:00": 3010.75, "09:00": 4747.75,
        "10:00": 6554.25, "11:00": 7995.75, "12:00": 8997.5, "13:00": 9158.25,
        "14:00": 8480.5, "15:00": 7262.5, "16:00": 5857.75, "17:00": 4044.5,
        "18:00": 1726.5, "19:00": 302.75,
    }
    slot_forecast = {f"{h:02d}:00": diurnal.get(f"{h:02d}:00", 0.0) for h in range(24)}

    # Actuals match forecast exactly, evenly split across 4 quarters in each hour.
    actuals = {f"{h:02d}:{m:02d}": 0.0 for h in range(24) for m in (0, 15, 30, 45)}
    for hour_key, hour_wh in diurnal.items():
        h = int(hour_key.split(":")[0])
        per_q = hour_wh / 4
        for m in (0, 15, 30, 45):
            actuals[f"{h:02d}:{m:02d}"] = per_q

    samples = [
        models.TrainerSample(
            date="2026-04-24",
            forecast_wh=sum(diurnal.values()),
            slot_forecast_wh=slot_forecast,
        ),
    ]
    actuals_window = models.SolarActualsWindow(
        slot_actuals_by_date={"2026-04-24": actuals}
    )

    outcome = trainer.train(samples, actuals_window, cfg, now=datetime.utcnow())
    assert outcome.metadata.last_outcome == "profile_trained"
    # All non-zero forecast slots have factor ~1.0 (perfect match)
    for slot, fcast in slot_forecast.items():
        if fcast > 0:
            assert slot in outcome.profile.factors, slot
            assert abs(outcome.profile.factors[slot] - 1.0) < 1e-6, (slot, outcome.profile.factors[slot])
    # No factor pinned to clamp boundaries
    vals = list(outcome.profile.factors.values())
    assert min(vals) > cfg.clamp_min + 1e-6
    assert max(vals) < cfg.clamp_max - 1e-6


def test_invalidated_slot_is_skipped_for_both_forecast_and_actual():
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)

    slot_forecast = {"12:00": 500.0, "13:00": 500.0}
    samples = [
        models.TrainerSample(
            date="2023-01-01",
            forecast_wh=1000.0,
            slot_forecast_wh=dict(slot_forecast),
        ),
        models.TrainerSample(
            date="2023-01-02",
            forecast_wh=1000.0,
            slot_forecast_wh=dict(slot_forecast),
        ),
    ]

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2023-01-01": {
                "12:00": 500.0,
                "12:15": 500.0,
                "12:30": 500.0,
                "12:45": 500.0,
                "13:00": 125.0,
                "13:15": 125.0,
                "13:30": 125.0,
                "13:45": 125.0,
            },
            "2023-01-02": {
                "12:00": 125.0,
                "12:15": 125.0,
                "12:30": 125.0,
                "12:45": 125.0,
                "13:00": 125.0,
                "13:15": 125.0,
                "13:30": 125.0,
                "13:45": 125.0,
            },
        },
        invalidated_slots_by_date={"2023-01-01": {"12:00"}},
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.last_outcome == "profile_trained"
    assert outcome.profile.factors["12:00"] == 1.0
    assert outcome.profile.factors["13:00"] == 1.0
    assert outcome.metadata.invalidated_slots_by_date == {"2023-01-01": ["12:00"]}
    assert outcome.metadata.invalidated_slot_count == 1


def test_no_invalidation_preserves_behavior_and_default_metadata():
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)

    samples = [
        models.TrainerSample(
            date="2023-01-01",
            forecast_wh=5000.0,
            slot_forecast_wh=make_uniform_slot_forecast(5000.0),
        ),
        models.TrainerSample(
            date="2023-01-02",
            forecast_wh=5000.0,
            slot_forecast_wh=make_uniform_slot_forecast(5000.0),
        ),
    ]

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            s.date: make_uniform_actuals(s.forecast_wh) for s in samples
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.last_outcome == "profile_trained"
    assert all(abs(v - 1.0) < 1e-6 for v in outcome.profile.factors.values())
    assert outcome.metadata.invalidated_slots_by_date == {}
    assert outcome.metadata.invalidated_slot_count == 0


def test_fully_invalidated_slot_is_omitted_via_forecast_floor():
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)

    slot_forecast = {"12:00": 30.0, "13:00": 100.0}
    samples = [
        models.TrainerSample(
            date="2023-01-01",
            forecast_wh=130.0,
            slot_forecast_wh=dict(slot_forecast),
        ),
        models.TrainerSample(
            date="2023-01-02",
            forecast_wh=130.0,
            slot_forecast_wh=dict(slot_forecast),
        ),
    ]

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2023-01-01": {
                "12:00": 7.5,
                "12:15": 7.5,
                "12:30": 7.5,
                "12:45": 7.5,
                "13:00": 25.0,
                "13:15": 25.0,
                "13:30": 25.0,
                "13:45": 25.0,
            },
            "2023-01-02": {
                "12:00": 7.5,
                "12:15": 7.5,
                "12:30": 7.5,
                "12:45": 7.5,
                "13:00": 25.0,
                "13:15": 25.0,
                "13:30": 25.0,
                "13:45": 25.0,
            },
        },
        invalidated_slots_by_date={
            "2023-01-01": {"12:00"},
            "2023-01-02": {"12:00"},
        },
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.last_outcome == "profile_trained"
    assert "12:00" in outcome.profile.omitted_slots
    assert "12:00" not in outcome.profile.factors
    assert outcome.profile.factors["13:00"] == 1.0
    assert outcome.metadata.invalidated_slots_by_date == {
        "2023-01-01": ["12:00"],
        "2023-01-02": ["12:00"],
    }
    assert outcome.metadata.invalidated_slot_count == 2
