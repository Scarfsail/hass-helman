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
    compute_invalidated_slots_for_window,
)


def _dt(hour: int, minute: int) -> datetime:
    return datetime(2026, 4, 15, hour, minute, tzinfo=TZ)


def _inputs(
    *,
    max_battery_soc_percent: float = 85.0,
    soc_samples_utc: list[StateSample] | None = None,
    export_samples_utc: list[StateSample] | None = None,
    forecast_slot_starts_by_date: dict[str, list[datetime]] | None = None,
    slot_keys_by_date: dict[str, list[str]] | None = None,
) -> InvalidationInputs:
    return InvalidationInputs(
        max_battery_soc_percent=max_battery_soc_percent,
        soc_samples_utc=soc_samples_utc or [],
        export_samples_utc=export_samples_utc or [],
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
            export_samples_utc=[],
        )
    )

    assert invalidated == {}


def test_invalidates_when_soc_reaches_threshold_and_export_turns_off() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[
                StateSample(timestamp=_dt(12, 0), value=84.0),
                StateSample(timestamp=_dt(12, 10), value=88.0),
            ],
            export_samples_utc=[
                StateSample(timestamp=_dt(12, 0), value=True),
                StateSample(timestamp=_dt(12, 5), value=False),
            ],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_does_not_invalidate_when_export_stays_on() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            export_samples_utc=[StateSample(timestamp=_dt(12, 0), value=True)],
        )
    )

    assert invalidated == {}


def test_does_not_invalidate_when_soc_is_missing() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[],
            export_samples_utc=[StateSample(timestamp=_dt(12, 0), value=False)],
        )
    )

    assert invalidated == {}


def test_does_not_invalidate_when_export_state_is_unknown() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            export_samples_utc=[StateSample(timestamp=_dt(12, 0), value=None)],
        )
    )

    assert invalidated == {}


def test_invalidates_when_export_turns_off_even_with_unknown_sample() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            export_samples_utc=[
                StateSample(timestamp=_dt(12, 0), value=False),
                StateSample(timestamp=_dt(12, 5), value=None),
                StateSample(timestamp=_dt(12, 10), value=False),
            ],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_uses_left_edge_inheritance_for_soc_and_export_state() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[StateSample(timestamp=_dt(11, 55), value=91.0)],
            export_samples_utc=[StateSample(timestamp=_dt(11, 59), value=False)],
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
            export_samples_utc=[
                StateSample(timestamp=_dt(12, 0), value=True),
                StateSample(timestamp=_dt(12, 15), value=False),
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
            export_samples_utc=[StateSample(timestamp=_dt(12, 0), value=False)],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_final_slot_uses_next_day_boundary_for_slot_end() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 23, 45, tzinfo=TZ), value=90.0)
            ],
            export_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 23, 45, tzinfo=TZ), value=True),
                StateSample(timestamp=datetime(2026, 4, 15, 23, 59, tzinfo=TZ), value=False),
            ],
            forecast_slot_starts_by_date={
                "2026-04-15": [datetime(2026, 4, 15, 23, 45, tzinfo=TZ)]
            },
            slot_keys_by_date={"2026-04-15": ["23:45"]},
        )
    )

    assert invalidated == {"2026-04-15": {"23:45"}}
