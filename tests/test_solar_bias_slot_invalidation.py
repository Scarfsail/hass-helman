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


def test_unknown_blip_does_not_overwrite_known_export_carry() -> None:
    """Regression: in live recorder data the export switch sometimes flickers
    `off → unknown → off` within tens of milliseconds. The carry into a later
    slot must remain `False`, so the slot still invalidates when SoC peaks
    above the threshold."""
    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 11, 0, tzinfo=TZ), value=100.0),
            ],
            export_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 9, 0, tzinfo=TZ), value=False),
                StateSample(
                    timestamp=datetime(2026, 4, 15, 11, 38, 15, tzinfo=TZ),
                    value=None,  # unknown blip
                ),
                StateSample(
                    timestamp=datetime(2026, 4, 15, 11, 39, 24, tzinfo=TZ),
                    value=False,
                ),
            ],
        )
    )

    assert invalidated == {"2026-04-15": {"12:00"}}


def test_sub_second_transition_at_slot_boundary_starts_new_state() -> None:
    """Regression: a transition timestamped a few hundred milliseconds after
    the slot start (e.g. `14:00:00.220215`) should be treated as the new
    state for that slot, not as an in-window addition stacked on top of the
    previous-slot carry. Otherwise a slot whose actual export was `on`
    throughout invalidates spuriously because of the carried `False`."""
    slot_start = datetime(2026, 4, 15, 14, 0, tzinfo=TZ)
    slot_start_plus = datetime(2026, 4, 15, 14, 0, 0, 220215, tzinfo=TZ)
    next_slot_start = datetime(2026, 4, 15, 14, 15, tzinfo=TZ)

    invalidated = compute_invalidated_slots_for_window(
        _inputs(
            soc_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 12, 0, tzinfo=TZ), value=100.0),
            ],
            export_samples_utc=[
                StateSample(timestamp=datetime(2026, 4, 15, 9, 0, tzinfo=TZ), value=False),
                StateSample(timestamp=slot_start_plus, value=True),
            ],
            forecast_slot_starts_by_date={
                "2026-04-15": [slot_start, next_slot_start],
            },
            slot_keys_by_date={"2026-04-15": ["14:00", "14:15"]},
        )
    )

    # 14:00 still has a carried `False` followed by a same-slot `True`, so it
    # invalidates (one False is enough). The 14:15 slot must NOT invalidate:
    # by the time it starts the export switch has been `on` for 14m 59s.
    assert invalidated == {"2026-04-15": {"14:00"}}


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
