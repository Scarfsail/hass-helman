from __future__ import annotations

import sys
import types
from datetime import datetime, timedelta, timezone
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
    slot_actuals_by_date: dict[str, dict[str, float]] | None = None,
    max_battery_soc_percent: float | None = 85.0,
    battery_soc_samples: list[StateSample] | None = None,
    export_enabled_samples: list[StateSample] | None = None,
) -> InvalidationInputs:
    return InvalidationInputs(
        slot_actuals_by_date=slot_actuals_by_date or {"2026-04-15": {"12:00": 100.0}},
        max_battery_soc_percent=max_battery_soc_percent,
        battery_soc_samples=battery_soc_samples or [],
        export_enabled_samples=export_enabled_samples or [],
        slot_duration=timedelta(minutes=15),
    )


def test_returns_empty_when_no_inputs_are_available() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            slot_actuals_by_date={},
            max_battery_soc_percent=None,
            battery_soc_samples=[],
            export_enabled_samples=[],
        )
    )

    assert invalidated == {}


def test_invalidates_when_soc_reaches_threshold_and_export_turns_off() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            battery_soc_samples=[
                StateSample(timestamp=_dt(12, 0), value=84.0),
                StateSample(timestamp=_dt(12, 10), value=88.0),
            ],
            export_enabled_samples=[
                StateSample(timestamp=_dt(12, 0), value=True),
                StateSample(timestamp=_dt(12, 5), value=False),
            ],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_does_not_invalidate_when_export_stays_on() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            battery_soc_samples=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            export_enabled_samples=[StateSample(timestamp=_dt(12, 0), value=True)],
        )
    )

    assert invalidated == {}


def test_does_not_invalidate_when_soc_is_missing() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            battery_soc_samples=[],
            export_enabled_samples=[StateSample(timestamp=_dt(12, 0), value=False)],
        )
    )

    assert invalidated == {}


def test_does_not_invalidate_when_export_state_is_unknown() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            battery_soc_samples=[StateSample(timestamp=_dt(12, 0), value=90.0)],
            export_enabled_samples=[StateSample(timestamp=_dt(12, 0), value=None)],
        )
    )

    assert invalidated == {}


def test_uses_left_edge_inheritance_for_soc_and_export_state() -> None:
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            battery_soc_samples=[StateSample(timestamp=_dt(11, 55), value=91.0)],
            export_enabled_samples=[StateSample(timestamp=_dt(11, 59), value=False)],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}
