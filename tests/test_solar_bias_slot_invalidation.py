from __future__ import annotations

import sys
import types
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TZ = timezone.utc


def _install_import_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]

    solar_pkg = sys.modules.get("custom_components.helman.solar_bias_correction")
    if solar_pkg is None:
        solar_pkg = types.ModuleType("custom_components.helman.solar_bias_correction")
        sys.modules["custom_components.helman.solar_bias_correction"] = solar_pkg
    solar_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "solar_bias_correction")
    ]


_install_import_stubs()

from custom_components.helman.solar_bias_correction.slot_invalidation import (  # noqa: E402
    InvalidationInputs,
    StateSample,
    compute_data_glitch_invalidations,
    compute_invalidated_slots_for_window,
)


def _dt(hour: int, minute: int) -> datetime:
    return datetime(2026, 4, 15, hour, minute, tzinfo=TZ)


def _inputs(
    *,
    max_battery_soc_percent: float = 85.0,
    max_export_w: float = 50.0,
    max_actual_forecast_ratio: float = 0.8,
    soc_samples_utc: list[StateSample] | None = None,
    grid_power_samples_utc: list[StateSample] | None = None,
    slot_actuals_by_date: dict[str, dict[str, float]] | None = None,
    forecast_slot_wh_by_date: dict[str, dict[str, float]] | None = None,
    forecast_slot_starts_by_date: dict[str, list[datetime]] | None = None,
    slot_keys_by_date: dict[str, list[str]] | None = None,
) -> InvalidationInputs:
    return InvalidationInputs(
        max_battery_soc_percent=max_battery_soc_percent,
        max_export_w=max_export_w,
        max_actual_forecast_ratio=max_actual_forecast_ratio,
        soc_samples_utc=soc_samples_utc or [],
        grid_power_samples_utc=grid_power_samples_utc or [],
        slot_actuals_by_date=(
            slot_actuals_by_date
            if slot_actuals_by_date is not None
            # Underdelivering by default: 200 Wh against a 1000 Wh forecast.
            else {"2026-04-15": {"12:00": 200.0, "12:15": 200.0, "23:45": 200.0}}
        ),
        forecast_slot_wh_by_date=(
            forecast_slot_wh_by_date
            if forecast_slot_wh_by_date is not None
            else {"2026-04-15": {"12:00": 1000.0, "12:15": 1000.0, "23:45": 1000.0}}
        ),
        forecast_slot_starts_by_date=forecast_slot_starts_by_date
        or {"2026-04-15": [_dt(12, 0)]},
        slot_keys_by_date=slot_keys_by_date or {"2026-04-15": ["12:00"]},
    )


def test_returns_empty_when_no_inputs_are_available() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            forecast_slot_starts_by_date={},
            slot_keys_by_date={},
            soc_samples_utc=[],
            grid_power_samples_utc=[],
        )
    )

    assert invalidated == {}


def test_invalidates_when_battery_full_nothing_exported_and_slot_underdelivers() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[
                StateSample(timestamp=_dt(12, 0), value=84.0),
                StateSample(timestamp=_dt(12, 10), value=88.0),
            ],
            grid_power_samples_utc=[
                StateSample(timestamp=_dt(12, 0), value=-900.0),  # importing
                StateSample(timestamp=_dt(12, 5), value=12.0),
            ],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_does_not_invalidate_when_the_slot_exported() -> None:
    """The clearest disproof of clipping: the energy had somewhere to go."""
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            grid_power_samples_utc=[
                StateSample(timestamp=_dt(12, 0), value=10.0),
                StateSample(timestamp=_dt(12, 5), value=2400.0),
            ],
        )
    )

    assert invalidated == {}


def test_does_not_invalidate_cloudy_full_battery_slot_that_tracks_its_forecast() -> None:
    """Battery full, house eating everything, nothing exported — but the slot
    produced what was predicted for it, so nothing was clipped."""
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=99.0)],
            grid_power_samples_utc=[StateSample(timestamp=_dt(12, 0), value=0.0)],
            slot_actuals_by_date={"2026-04-15": {"12:00": 950.0}},
            forecast_slot_wh_by_date={"2026-04-15": {"12:00": 1000.0}},
        )
    )

    assert invalidated == {}


def test_does_not_invalidate_when_soc_is_missing() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[],
            grid_power_samples_utc=[StateSample(timestamp=_dt(12, 0), value=0.0)],
        )
    )

    assert invalidated == {}


def test_does_not_invalidate_when_grid_power_is_unknown() -> None:
    """No grid reading is no evidence, not evidence of no export."""
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            grid_power_samples_utc=[StateSample(timestamp=_dt(12, 0), value=None)],
        )
    )

    assert invalidated == {}


def test_does_not_invalidate_when_the_day_has_no_historical_forecast() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            grid_power_samples_utc=[StateSample(timestamp=_dt(12, 0), value=0.0)],
            forecast_slot_wh_by_date={},
        )
    )

    assert invalidated == {}


def test_does_not_invalidate_a_slot_the_actuals_never_recorded() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            grid_power_samples_utc=[StateSample(timestamp=_dt(12, 0), value=0.0)],
            slot_actuals_by_date={"2026-04-15": {"13:00": 200.0}},
        )
    )

    assert invalidated == {}


def test_export_deadband_tolerates_a_trickle() -> None:
    """A few watts leaking out is measurement noise, not an export path."""
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            max_export_w=50.0,
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            grid_power_samples_utc=[StateSample(timestamp=_dt(12, 0), value=49.0)],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_uses_left_edge_inheritance_for_soc_and_grid_power() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(11, 55), value=91.0)],
            grid_power_samples_utc=[StateSample(timestamp=_dt(11, 59), value=-300.0)],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_unknown_blip_does_not_overwrite_known_grid_power_carry() -> None:
    """Regression: in live recorder data the modbus sensors drop to `unknown`
    for tens of milliseconds. The carry into a later slot must remain the last
    known reading, so the slot still invalidates."""
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 11, 0, tzinfo=TZ), value=100.0),
            ],
            grid_power_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 9, 0, tzinfo=TZ), value=-40.0),
                StateSample(
                    timestamp=datetime(2026, 4, 15, 11, 38, 15, tzinfo=TZ),
                    value=None,  # unknown blip
                ),
                StateSample(
                    timestamp=datetime(2026, 4, 15, 11, 39, 24, tzinfo=TZ),
                    value=-35.0,
                ),
            ],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_sample_at_slot_end_applies_to_next_slot_only() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[
                StateSample(timestamp=_dt(12, 0), value=90.0),
                StateSample(timestamp=_dt(12, 15), value=90.0),
            ],
            grid_power_samples_utc=[
                StateSample(timestamp=_dt(12, 0), value=3000.0),
                StateSample(timestamp=_dt(12, 15), value=0.0),
            ],
            forecast_slot_starts_by_date={"2026-04-15": [_dt(12, 0), _dt(12, 15)]},
            slot_keys_by_date={"2026-04-15": ["12:00", "12:15"]},
        )
    )

    assert invalidated == {"2026-04-15": {"12:15"}}


def test_sample_at_slot_start_applies_to_current_slot() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            grid_power_samples_utc=[StateSample(timestamp=_dt(12, 0), value=0.0)],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_sub_second_transition_at_slot_boundary_starts_new_state() -> None:
    """Regression: a transition timestamped a few hundred milliseconds after
    the slot start (e.g. `14:00:00.220215`) is the new state for that slot, not
    an in-window addition stacked on the previous-slot carry. The 14:00 slot
    still carries a no-export reading and so invalidates; 14:15 has been
    exporting for a full 15 minutes by the time it starts."""
    slot_start = datetime(2026, 4, 15, 14, 0, tzinfo=TZ)
    slot_start_plus = datetime(2026, 4, 15, 14, 0, 0, 220215, tzinfo=TZ)
    next_slot_start = datetime(2026, 4, 15, 14, 15, tzinfo=TZ)

    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 12, 0, tzinfo=TZ), value=100.0),
            ],
            grid_power_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 9, 0, tzinfo=TZ), value=0.0),
                StateSample(timestamp=slot_start_plus, value=2500.0),
            ],
            slot_actuals_by_date={"2026-04-15": {"14:00": 200.0, "14:15": 200.0}},
            forecast_slot_wh_by_date={"2026-04-15": {"14:00": 1000.0, "14:15": 1000.0}},
            forecast_slot_starts_by_date={
                "2026-04-15": [slot_start, next_slot_start],
            },
            slot_keys_by_date={"2026-04-15": ["14:00", "14:15"]},
        )
    )

    # 14:00's peak export is the in-slot 2500 W, so it does NOT invalidate
    # either — the peak is taken over the carry and every in-window sample.
    assert invalidated == {}


def test_final_slot_uses_next_day_boundary_for_slot_end() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 23, 45, tzinfo=TZ), value=90.0)
            ],
            grid_power_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 23, 45, tzinfo=TZ), value=-100.0),
                StateSample(timestamp=datetime(2026, 4, 15, 23, 59, tzinfo=TZ), value=0.0),
            ],
            forecast_slot_starts_by_date={
                "2026-04-15": [datetime(2026, 4, 15, 23, 45, tzinfo=TZ)]
            },
            slot_keys_by_date={"2026-04-15": ["23:45"]},
        )
    )

    assert invalidated == {"2026-04-15": {"23:45"}}


def test_data_glitch_spike_invalidates_above_max_slot_wh() -> None:
    actuals = {
        "2026-04-20": {
            "14:00": 1500.0,
            "14:15": 1400.0,
            "14:30": 8200.0,  # spike — above 3150
            "14:45": 1300.0,
        }
    }
    result = compute_data_glitch_invalidations(
        slot_actuals_by_date=actuals,
        forecast_slot_wh_by_date={},
        max_slot_wh=3150.0,
        min_neighbour_forecast_wh=0.0,
        backfill_max_minutes=120,
    )
    assert result == {"2026-04-20": {"14:30"}}


def test_data_glitch_backfill_walks_back_through_zeros() -> None:
    """A spike at 15:15 with five preceding zero slots: the trio likely holds
    the energy that the cumulative meter dumped into 15:15, so all of them
    invalidate together."""
    actuals = {
        "2026-04-20": {
            "13:45": 2500.0,
            "14:00": 0.0,
            "14:15": 0.0,
            "14:30": 0.0,
            "14:45": 0.0,
            "15:00": 0.0,
            "15:15": 20400.0,  # massive spike
            "15:30": 800.0,
        }
    }
    result = compute_data_glitch_invalidations(
        slot_actuals_by_date=actuals,
        forecast_slot_wh_by_date={},
        max_slot_wh=3150.0,
        min_neighbour_forecast_wh=0.0,
        backfill_max_minutes=120,
    )
    assert result == {
        "2026-04-20": {"14:00", "14:15", "14:30", "14:45", "15:00", "15:15"}
    }


def test_data_glitch_backfill_stops_at_first_nonzero() -> None:
    actuals = {
        "2026-04-20": {
            "14:00": 0.0,
            "14:15": 1200.0,  # boundary — backfill stops here
            "14:30": 0.0,
            "14:45": 0.0,
            "15:00": 20400.0,  # spike
        }
    }
    result = compute_data_glitch_invalidations(
        slot_actuals_by_date=actuals,
        forecast_slot_wh_by_date={},
        max_slot_wh=3150.0,
        min_neighbour_forecast_wh=0.0,
        backfill_max_minutes=120,
    )
    # 14:30 and 14:45 are zeros adjacent to the spike; 14:15 is non-zero so
    # backfill stops there. 14:00 must NOT invalidate.
    assert result == {"2026-04-20": {"14:30", "14:45", "15:00"}}


def test_data_glitch_backfill_stops_at_max_minutes() -> None:
    actuals = {
        "2026-04-20": {
            "12:00": 0.0,
            "12:15": 0.0,
            "12:30": 0.0,
            "12:45": 0.0,
            "13:00": 0.0,
            "13:15": 0.0,
            "13:30": 0.0,
            "13:45": 0.0,
            "14:00": 0.0,
            "14:15": 0.0,
            "14:30": 20400.0,  # spike
        }
    }
    result = compute_data_glitch_invalidations(
        slot_actuals_by_date=actuals,
        forecast_slot_wh_by_date={},
        max_slot_wh=3150.0,
        min_neighbour_forecast_wh=0.0,
        backfill_max_minutes=60,
    )
    # backfill_max_minutes=60 limits the walk to 14:30 minus 60 minutes = 13:30
    # exclusive. So 13:30, 13:45, 14:00, 14:15 invalidate alongside the spike.
    assert result == {
        "2026-04-20": {"13:30", "13:45", "14:00", "14:15", "14:30"}
    }


def test_data_glitch_zero_with_neighbour_and_substantial_forecast_invalidates() -> None:
    """Independent of any spike: a zero actual in a slot whose forecast was
    substantial AND whose neighbours within ±60 min show production must be
    treated as a recorder gap."""
    actuals = {
        "2026-04-19": {
            "13:00": 1200.0,
            "13:15": 0.0,  # gap with substantial forecast and live neighbour
            "13:30": 1100.0,
            "14:00": 1300.0,
        }
    }
    forecast = {
        "2026-04-19": {"13:00": 1500.0, "13:15": 1400.0, "13:30": 1300.0, "14:00": 1100.0}
    }
    result = compute_data_glitch_invalidations(
        slot_actuals_by_date=actuals,
        forecast_slot_wh_by_date=forecast,
        max_slot_wh=None,  # spike rule disabled, prove rule 3 fires alone
        min_neighbour_forecast_wh=200.0,
        backfill_max_minutes=120,
    )
    assert result == {"2026-04-19": {"13:15"}}


def test_data_glitch_zero_without_substantial_forecast_keeps_slot() -> None:
    """A zero actual with a *low* forecast for that slot is treated as a real
    weather drop, not a recorder gap — even if neighbours produce."""
    actuals = {
        "2026-04-19": {"13:00": 1200.0, "13:15": 0.0, "13:30": 1100.0}
    }
    forecast = {
        "2026-04-19": {"13:00": 1500.0, "13:15": 80.0, "13:30": 1300.0}
    }
    result = compute_data_glitch_invalidations(
        slot_actuals_by_date=actuals,
        forecast_slot_wh_by_date=forecast,
        max_slot_wh=None,
        min_neighbour_forecast_wh=200.0,
        backfill_max_minutes=120,
    )
    assert result == {}


def test_data_glitch_disabled_when_max_slot_wh_none_and_no_forecast() -> None:
    actuals = {
        "2026-04-20": {"14:00": 0.0, "14:15": 20400.0}
    }
    result = compute_data_glitch_invalidations(
        slot_actuals_by_date=actuals,
        forecast_slot_wh_by_date={},
        max_slot_wh=None,
        min_neighbour_forecast_wh=200.0,
        backfill_max_minutes=120,
    )
    assert result == {}
