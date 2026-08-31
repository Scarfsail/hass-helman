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


def make_cfg(
    min_history_days=2,
    clamp_min=0.5,
    clamp_max=2.0,
    training_time="00:00",
    aggregation_method="ratio_of_sums",
    min_valid_slot_days=1,
) -> models.BiasConfig:
    return models.BiasConfig(
        enabled=True,
        min_history_days=min_history_days,
        training_time=training_time,
        clamp_min=clamp_min,
        clamp_max=clamp_max,
        min_valid_slot_days=min_valid_slot_days,
        aggregation_method=aggregation_method,
        daily_energy_entity_ids=[],
        total_energy_entity_id=None,
    )


def test_bias_config_defaults_max_interpolated_consecutive_slots_to_two():
    cfg = make_cfg()
    assert cfg.max_interpolated_consecutive_slots == 2


def test_read_bias_config_parses_max_interpolated_consecutive_slots():
    from custom_components.helman.solar_bias_correction.models import read_bias_config

    cfg = read_bias_config(
        {
            "power_devices": {
                "solar": {
                    "forecast": {
                        "bias_correction": {
                            "max_interpolated_consecutive_slots": 4,
                        }
                    }
                }
            }
        }
    )
    assert cfg.max_interpolated_consecutive_slots == 4


def test_read_bias_config_max_interpolated_defaults_when_missing():
    from custom_components.helman.solar_bias_correction.models import read_bias_config

    cfg = read_bias_config({})
    assert cfg.max_interpolated_consecutive_slots == 2


def test_fingerprint_differs_when_max_interpolated_consecutive_slots_changes():
    cfg_a = make_cfg()
    cfg_a.max_interpolated_consecutive_slots = 2
    cfg_b = make_cfg()
    cfg_b.max_interpolated_consecutive_slots = 3
    assert trainer.compute_fingerprint(cfg_a) != trainer.compute_fingerprint(cfg_b)


def test_fingerprint_zero_max_interpolated_matches_payload_includes_value():
    cfg = make_cfg()
    cfg.max_interpolated_consecutive_slots = 0
    fp = trainer.compute_fingerprint(cfg)
    assert fp.startswith("sha256:")


def test_metadata_default_interpolated_slot_count_is_zero():
    md = models.SolarBiasMetadata(
        trained_at="2026-05-06T00:00:00",
        training_config_fingerprint="sha256:abc",
        usable_days=0,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=0,
        last_outcome="insufficient_history",
    )
    assert md.interpolated_slot_count == 0


def test_slot_explainability_default_interpolation_fields():
    se = models.SolarBiasSlotExplainability(
        factor=None,
        raw_ratio=None,
        clamped=False,
        forecast_sum_wh=0.0,
        actual_sum_wh=0.0,
        rows=[],
    )
    assert se.interpolated is False
    assert se.interpolation_anchors is None


def test_slot_with_too_few_valid_slot_days_is_omitted():
    cfg = make_cfg(min_history_days=1)
    cfg.min_valid_slot_days = 2
    cfg.max_interpolated_consecutive_slots = 0

    samples = [
        models.TrainerSample(
            date="2023-01-01",
            forecast_wh=200.0,
            slot_forecast_wh={"12:00": 200.0},
        ),
        models.TrainerSample(
            date="2023-01-02",
            forecast_wh=200.0,
            slot_forecast_wh={"12:00": 200.0},
        ),
    ]

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2023-01-01": {"12:00": 200.0},
            "2023-01-02": {"12:00": 200.0},
        },
        invalidated_slots_by_date={
            "2023-01-02": {"12:00"},
        },
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert "12:00" not in outcome.profile.factors
    assert "12:00" in outcome.profile.omitted_slots


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
    cfg4 = make_cfg(min_history_days=2, training_time="00:00")
    cfg4.min_valid_slot_days = 6

    f1 = trainer.compute_fingerprint(cfg1)
    f2 = trainer.compute_fingerprint(cfg2)
    f3 = trainer.compute_fingerprint(cfg3)
    f4 = trainer.compute_fingerprint(cfg4)

    assert f1 == f2
    assert f1 != f3
    assert f1 != f4


def test_fingerprint_depends_on_slot_invalidation_config():
    cfg1 = make_cfg()
    cfg2 = make_cfg()
    cfg2.slot_invalidation_max_battery_soc_percent = 97.0
    cfg3 = make_cfg()
    cfg3.slot_invalidation_max_battery_soc_percent = 95.0
    cfg4 = make_cfg()
    cfg4.slot_invalidation_max_battery_soc_percent = 97.0
    cfg4.slot_invalidation_curtailment_max_export_w = 150.0
    cfg5 = make_cfg()
    cfg5.slot_invalidation_max_battery_soc_percent = 97.0
    cfg5.slot_invalidation_curtailment_max_actual_forecast_ratio = 0.5

    assert trainer.compute_fingerprint(cfg1) != trainer.compute_fingerprint(cfg2)
    assert trainer.compute_fingerprint(cfg2) != trainer.compute_fingerprint(cfg3)
    assert trainer.compute_fingerprint(cfg2) != trainer.compute_fingerprint(cfg4)
    assert trainer.compute_fingerprint(cfg2) != trainer.compute_fingerprint(cfg5)


def test_fingerprint_format():
    cfg = make_cfg()
    f = trainer.compute_fingerprint(cfg)
    assert re.match(r"^sha256:[0-9a-f]{64}$", f)


def test_trimmed_mean_returns_none_for_empty():
    assert trainer._trimmed_mean([]) is None


def test_trimmed_mean_plain_mean_for_small_n():
    assert trainer._trimmed_mean([1.0]) == 1.0
    assert trainer._trimmed_mean([1.0, 3.0]) == 2.0


def test_trimmed_mean_drops_one_high_one_low():
    assert trainer._trimmed_mean([0.0, 1.0, 5.0]) == 1.0


def test_trimmed_mean_eight_values():
    values = [0.0, 0.0, 0.0, 0.0, 0.0, 0.958, 1.297, 2.057]
    expected = (0.0 + 0.0 + 0.0 + 0.0 + 0.958 + 1.297) / 6
    assert abs(trainer._trimmed_mean(values) - expected) < 1e-9


def test_compute_fingerprint_includes_algorithm_version():
    cfg = make_cfg()
    fp = trainer.compute_fingerprint(cfg)
    assert fp.startswith("sha256:")
    expected_payload = (
        "algo=configurable_aggregation_v1+15min_v1+curtailment_inference_v1"
        "+live_horizon_v1+hourly_statistics_tail_v1+carry_staleness_v1;"
        f"min_history_days={cfg.min_history_days};"
        f"clamp_min={cfg.clamp_min};"
        f"clamp_max={cfg.clamp_max};"
        f"min_valid_slot_days={cfg.min_valid_slot_days};"
        f"aggregation_method={cfg.aggregation_method};"
        "slot_invalidation_max_battery_soc_percent="
        f"{cfg.slot_invalidation_max_battery_soc_percent};"
        "slot_invalidation_curtailment_max_export_w="
        f"{cfg.slot_invalidation_curtailment_max_export_w};"
        "slot_invalidation_curtailment_max_actual_forecast_ratio="
        f"{cfg.slot_invalidation_curtailment_max_actual_forecast_ratio};"
        "slot_invalidation_data_glitch_max_slot_wh="
        f"{cfg.slot_invalidation_data_glitch_max_slot_wh};"
        "slot_invalidation_data_glitch_min_neighbour_forecast_wh="
        f"{cfg.slot_invalidation_data_glitch_min_neighbour_forecast_wh};"
        "slot_invalidation_data_glitch_backfill_max_minutes="
        f"{cfg.slot_invalidation_data_glitch_backfill_max_minutes};"
        "max_interpolated_consecutive_slots="
        f"{cfg.max_interpolated_consecutive_slots}"
    )
    import hashlib

    expected = "sha256:" + hashlib.sha256(expected_payload.encode("utf-8")).hexdigest()
    assert fp == expected


def test_slot_factor_uses_trimmed_mean_of_daily_ratios():
    cfg = make_cfg(min_history_days=8, clamp_min=0.0, clamp_max=3.0, aggregation_method="trimmed_mean")
    slot = "06:00"
    filler_slot = "12:00"

    per_day = [
        ("2026-04-15", 97.2, 200.0),
        ("2026-04-16", 198.8, 0.0),
        ("2026-04-17", 231.2, 300.0),
        ("2026-04-21", 115.0, 0.0),
        ("2026-04-22", 313.2, 300.0),
        ("2026-04-23", 370.5, 0.0),
        ("2026-04-25", 364.0, 0.0),
        ("2026-04-26", 385.8, 0.0),
    ]

    samples = [
        models.TrainerSample(
            date=day,
            forecast_wh=2400.0,
            slot_forecast_wh={slot: forecast, filler_slot: 1200.0},
        )
        for day, forecast, _ in per_day
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            day: {
                slot: actual,
                filler_slot: 1000.0,
            }
            for day, _, actual in per_day
        }
    )

    outcome = trainer.train(samples, actuals, cfg, datetime(2026, 4, 27, 3, 0))

    assert slot in outcome.profile.factors
    expected = (0.0 + 0.0 + 0.0 + 0.0 + 0.958 + 1.297) / 6
    assert abs(outcome.profile.factors[slot] - expected) < 0.002


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


def test_invalidated_slot_does_not_affect_day_ratio_gate():
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
                "12:00": 5000.0,
                "12:15": 5000.0,
                "12:30": 5000.0,
                "12:45": 5000.0,
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
    assert not any(
        day["date"] == "2023-01-01"
        and day["reason"] == "day_ratio_out_of_band"
        for day in outcome.metadata.dropped_days
    )
    assert outcome.profile.factors["12:00"] == 1.0
    assert outcome.profile.factors["13:00"] == 1.0


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
    cfg.max_interpolated_consecutive_slots = 0

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


def test_fingerprint_differs_for_different_aggregation_methods():
    cfg_ros = make_cfg(aggregation_method="ratio_of_sums")
    cfg_tm = make_cfg(aggregation_method="trimmed_mean")
    assert trainer.compute_fingerprint(cfg_ros) != trainer.compute_fingerprint(cfg_tm)


def test_training_explainability_records_ratio_of_sums_rows():
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)
    samples = [
        models.TrainerSample(
            date="2026-04-21",
            forecast_wh=1000.0,
            slot_forecast_wh={"12:00": 400.0, "13:00": 600.0},
        ),
        models.TrainerSample(
            date="2026-04-22",
            forecast_wh=1000.0,
            slot_forecast_wh={"12:00": 600.0, "13:00": 400.0},
        ),
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2026-04-21": {"12:00": 500.0, "13:00": 600.0},
            "2026-04-22": {"12:00": 700.0, "13:00": 400.0},
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime(2026, 4, 23, 3, 0))

    details = outcome.explainability.slots["12:00"]
    assert details.factor == 1.2
    assert details.raw_ratio == 1.2
    assert details.clamped is False
    assert details.forecast_sum_wh == 1000.0
    assert details.actual_sum_wh == 1200.0
    assert [(row.date, row.forecast_wh, row.actual_wh, row.status) for row in details.rows] == [
        ("2026-04-21", 400.0, 500.0, "included"),
        ("2026-04-22", 600.0, 700.0, "included"),
    ]
    assert abs(details.rows[0].ratio - 1.25) < 1e-9
    assert abs(details.rows[1].ratio - (700.0 / 600.0)) < 1e-9


def test_training_explainability_marks_invalidated_dropped_and_omitted_rows():
    cfg = make_cfg(min_history_days=1, clamp_min=0.5, clamp_max=2.0)
    samples = [
        models.TrainerSample(
            date="2026-04-20",
            forecast_wh=50.0,
            slot_forecast_wh={"12:00": 50.0},
        ),
        models.TrainerSample(
            date="2026-04-21",
            forecast_wh=1000.0,
            slot_forecast_wh={"12:00": 40.0, "13:00": 960.0},
        ),
        models.TrainerSample(
            date="2026-04-22",
            forecast_wh=1000.0,
            slot_forecast_wh={"12:00": 40.0, "13:00": 960.0},
        ),
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2026-04-20": {"12:00": 50.0},
            "2026-04-21": {"12:00": 40.0, "13:00": 960.0},
            "2026-04-22": {"12:00": 40.0, "13:00": 960.0},
        },
        invalidated_slots_by_date={"2026-04-21": {"12:00"}},
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime(2026, 4, 23, 3, 0))

    statuses = [(row.date, row.status, row.reason) for row in outcome.explainability.slots["12:00"].rows]
    assert ("2026-04-21", "invalidated", "slot_invalidated") in statuses
    assert ("2026-04-20", "dropped_day", "day_forecast_too_low") in statuses
    assert ("", "omitted_slot", "slot_forecast_sum_too_low") in statuses
    assert "12:00" in outcome.profile.omitted_slots


def test_training_explainability_marks_trimmed_mean_removed_rows():
    cfg = make_cfg(
        min_history_days=4,
        clamp_min=0.0,
        clamp_max=5.0,
        aggregation_method="trimmed_mean",
    )
    slot = "12:00"
    per_day = [
        ("2026-04-20", 100.0, 50.0),
        ("2026-04-21", 100.0, 100.0),
        ("2026-04-22", 100.0, 200.0),
        ("2026-04-23", 100.0, 400.0),
    ]
    samples = [
        models.TrainerSample(
            date=day,
            forecast_wh=1000.0,
            slot_forecast_wh={slot: forecast, "13:00": 900.0},
        )
        for day, forecast, _actual in per_day
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            day: {slot: actual, "13:00": 900.0}
            for day, _forecast, actual in per_day
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime(2026, 4, 24, 3, 0))

    rows = outcome.explainability.slots[slot].rows
    by_date = {row.date: row for row in rows}
    assert by_date["2026-04-20"].status == "trimmed"
    assert by_date["2026-04-20"].reason == "trimmed_mean_low"
    assert by_date["2026-04-23"].status == "trimmed"
    assert by_date["2026-04-23"].reason == "trimmed_mean_high"
    assert by_date["2026-04-21"].status == "included"
    assert by_date["2026-04-22"].status == "included"
    assert outcome.explainability.slots[slot].raw_ratio == 1.5
    assert outcome.profile.factors[slot] == 1.5


def test_ratio_of_sums_weights_by_volume_not_by_day_count():
    """Sunny days (high volume) should dominate the ratio, not be averaged equally with cloudy days."""
    slot = "12:00"
    # Day A: overcast — forecast 500 Wh, actual 1000 Wh (ratio 2.0)
    # Day B: clear sky — forecast 5000 Wh, actual 5000 Wh (ratio 1.0)
    # ratio_of_sums = (1000 + 5000) / (500 + 5000) = 6000/5500 ≈ 1.0909
    # trimmed_mean would give (1.0 + 2.0) / 2 = 1.5
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0, aggregation_method="ratio_of_sums")

    samples = [
        models.TrainerSample(date="2026-04-15", forecast_wh=500.0, slot_forecast_wh={slot: 500.0}),
        models.TrainerSample(date="2026-04-16", forecast_wh=5000.0, slot_forecast_wh={slot: 5000.0}),
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2026-04-15": {slot: 1000.0},
            "2026-04-16": {slot: 5000.0},
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime(2026, 4, 17, 3, 0))

    assert slot in outcome.profile.factors
    expected = 6000.0 / 5500.0
    assert abs(outcome.profile.factors[slot] - expected) < 1e-6


# ---------------------------------------------------------------------------
# Slot interpolation fallback
# ---------------------------------------------------------------------------


def _interp_samples(
    *,
    days: int,
    slots: list[str],
    forecast_per_slot: float,
) -> list[models.TrainerSample]:
    """Build `days` identical training samples covering the given hourly slots."""
    out = []
    for i in range(days):
        date = f"2024-03-{i + 1:02d}"
        out.append(
            models.TrainerSample(
                date=date,
                forecast_wh=forecast_per_slot * len(slots),
                slot_forecast_wh={s: forecast_per_slot for s in slots},
            )
        )
    return out


def _interp_actuals(
    samples: list[models.TrainerSample],
    *,
    slot_actual_factor: dict[str, float],
    invalidated_slots_per_day: dict[str, set[str]] | None = None,
) -> models.SolarActualsWindow:
    """For each sample, produce actuals = forecast * factor[slot]."""
    by_date: dict[str, dict[str, float]] = {}
    for s in samples:
        per_slot = {}
        for slot, fcast in s.slot_forecast_wh.items():
            per_slot[slot] = fcast * slot_actual_factor.get(slot, 1.0)
        by_date[s.date] = per_slot
    return models.SolarActualsWindow(
        slot_actuals_by_date=by_date,
        invalidated_slots_by_date=invalidated_slots_per_day or {},
    )


def test_interpolation_fills_single_slot_between_two_healthy():
    # Slots 10:00 11:00 12:00. Healthy at 10 and 12; 11 is invalidated on most days.
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(days=6, slots=["10:00", "11:00", "12:00"], forecast_per_slot=200.0)
    # 10:00 actual ratio = 0.6, 12:00 actual ratio = 1.4, 11:00 invalidated 5/6 days.
    invalidated = {s.date: {"11:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.6, "11:00": 1.0, "12:00": 1.4},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # 11:00 should be interpolated as midpoint of (0.6, 1.4) = 1.0
    assert "11:00" in outcome.profile.factors
    assert "11:00" not in outcome.profile.omitted_slots
    assert abs(outcome.profile.factors["11:00"] - 1.0) < 1e-9
    assert outcome.metadata.interpolated_slot_count == 1
    assert outcome.explainability is not None
    slot_expl = outcome.explainability.slots["11:00"]
    assert slot_expl.interpolated is True
    assert slot_expl.interpolation_anchors == ("10:00", "12:00")
    # A synthetic contribution row of status=interpolated is appended.
    assert any(row.status == "interpolated" for row in slot_expl.rows)


def test_interpolation_fills_run_of_two_with_one_third_two_thirds_weights():
    cfg = make_cfg(min_history_days=2, clamp_min=0.0)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(
        days=6, slots=["10:00", "11:00", "12:00", "13:00"], forecast_per_slot=200.0
    )
    invalidated = {s.date: {"11:00", "12:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.4, "11:00": 1.0, "12:00": 1.0, "13:00": 1.6},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # left=0.4, right=1.6, L=2 -> i=1: 0.4 + 1.2 * 1/3 = 0.8
    #                            i=2: 0.4 + 1.2 * 2/3 = 1.2
    assert abs(outcome.profile.factors["11:00"] - 0.8) < 1e-9
    assert abs(outcome.profile.factors["12:00"] - 1.2) < 1e-9
    assert outcome.metadata.interpolated_slot_count == 2


def test_interpolation_skipped_when_run_exceeds_max():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(
        days=6,
        slots=["10:00", "11:00", "12:00", "13:00", "14:00"],
        forecast_per_slot=200.0,
    )
    invalidated = {s.date: {"11:00", "12:00", "13:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.6, "11:00": 1.0, "12:00": 1.0, "13:00": 1.0, "14:00": 1.4},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # All three remain omitted with the original reason.
    for slot in ("11:00", "12:00", "13:00"):
        assert slot in outcome.profile.omitted_slots
        assert slot not in outcome.profile.factors
    assert outcome.metadata.interpolated_slot_count == 0


def test_interpolation_morning_edge_uses_zero_left_anchor():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(days=6, slots=["06:00", "07:00"], forecast_per_slot=200.0)
    invalidated = {s.date: {"06:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"06:00": 1.0, "07:00": 1.5},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # left=0.0, right=1.5, L=1 -> midpoint = 0.75
    assert abs(outcome.profile.factors["06:00"] - 0.75) < 1e-9
    assert outcome.explainability.slots["06:00"].interpolation_anchors == (None, "07:00")


def test_interpolation_evening_edge_uses_zero_right_anchor():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(days=6, slots=["18:00", "19:00"], forecast_per_slot=200.0)
    invalidated = {s.date: {"19:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"18:00": 1.4, "19:00": 1.0},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # left=1.4, right=0.0, L=1 -> midpoint = 0.7
    assert abs(outcome.profile.factors["19:00"] - 0.7) < 1e-9
    assert outcome.explainability.slots["19:00"].interpolation_anchors == ("18:00", None)


def test_interpolation_disabled_when_max_is_zero_matches_legacy_behavior():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 0
    samples = _interp_samples(days=6, slots=["10:00", "11:00", "12:00"], forecast_per_slot=200.0)
    invalidated = {s.date: {"11:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.6, "11:00": 1.0, "12:00": 1.4},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert "11:00" in outcome.profile.omitted_slots
    assert "11:00" not in outcome.profile.factors
    assert outcome.metadata.interpolated_slot_count == 0


def test_two_runs_separated_by_healthy_slot_use_snapshot_anchors():
    cfg = make_cfg(min_history_days=2, clamp_min=0.0)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    slots = ["10:00", "11:00", "12:00", "13:00", "14:00"]
    samples = _interp_samples(days=6, slots=slots, forecast_per_slot=200.0)
    # Healthy at 10, 12, 14. 11 and 13 invalidated 5/6 days.
    invalidated = {s.date: {"11:00", "13:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={
            "10:00": 0.4,
            "11:00": 1.0,
            "12:00": 1.0,
            "13:00": 1.0,
            "14:00": 1.6,
        },
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # 11:00 between 0.4 and 1.0 -> 0.7. 13:00 between 1.0 and 1.6 -> 1.3.
    # Critically: 12:00 is the right anchor of run #1 AND left anchor of run #2 -
    # both use the SAME (original) value of 1.0 from the snapshot.
    assert abs(outcome.profile.factors["11:00"] - 0.7) < 1e-9
    assert abs(outcome.profile.factors["13:00"] - 1.3) < 1e-9
    assert outcome.metadata.interpolated_slot_count == 2


def test_interpolation_does_not_apply_to_forecast_floor_omissions():
    # Slot is omitted because forecast sum is too low - NOT eligible for interpolation
    # even when neighbors are healthy.
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 1
    cfg.max_interpolated_consecutive_slots = 2
    # 11:00 forecast set very low so its summed forecast falls below the 50 Wh floor.
    samples = []
    for i in range(3):
        date = f"2024-03-{i + 1:02d}"
        samples.append(
            models.TrainerSample(
                date=date,
                forecast_wh=200.0 + 200.0 + 1.0,
                slot_forecast_wh={"10:00": 200.0, "11:00": 1.0, "12:00": 200.0},
            )
        )
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.6, "11:00": 1.0, "12:00": 1.4},
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert "11:00" in outcome.profile.omitted_slots
    assert "11:00" not in outcome.profile.factors
    assert outcome.metadata.interpolated_slot_count == 0


def test_a_hole_in_the_archive_does_not_feed_the_slot_before_it():
    """Helman was down over 12:15-12:45, so the archive has only 12:00.

    Those three quarters of production belong to no forecast slot. Handing
    them to 12:00, which is what reaching to "the next forecast key" would do,
    scores a fifteen-minute forecast against an hour of actuals and books the
    outage as this array over-producing at noon.
    """
    cfg = make_cfg(min_history_days=1, clamp_min=0.5, clamp_max=2.0)

    samples = [
        models.TrainerSample(
            date="2026-04-15",
            forecast_wh=2000.0,
            slot_forecast_wh={"12:00": 2000.0},
        )
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2026-04-15": {
                "12:00": 2000.0,
                "12:15": 2100.0,
                "12:30": 2200.0,
                "12:45": 2300.0,
            }
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.profile.factors["12:00"] == 1.0


def test_an_hourly_forecast_still_reaches_across_its_four_quarters():
    """The cap is one slot of the forecast's own grid, not a flat fifteen."""
    cfg = make_cfg(min_history_days=1, clamp_min=0.5, clamp_max=2.0)

    samples = [
        models.TrainerSample(
            date="2026-04-15",
            forecast_wh=8000.0,
            slot_forecast_wh={"11:00": 0.0, "12:00": 8000.0, "13:00": 0.0},
        )
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2026-04-15": {
                "12:00": 2000.0,
                "12:15": 2000.0,
                "12:30": 2000.0,
                "12:45": 2000.0,
            }
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.profile.factors["12:00"] == 1.0
