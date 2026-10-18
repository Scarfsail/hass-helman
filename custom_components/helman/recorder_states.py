from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import datetime
import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)


def numeric_timeline(
    states: Sequence[Any] | None,
    *,
    keep_non_numeric: bool = False,
) -> list[tuple[datetime, float]] | list[tuple[datetime, float | None]]:
    """Build a sorted timeline of (instant_local, numeric_value) from recorded states.

    Timestamp precedence is last_updated (the recorder's sort column), falling
    back to last_changed. Non-numeric states (unavailable, unknown, strings) are
    dropped by default; when keep_non_numeric is True, they are retained as None
    (e.g. hold-breakers for forecast sampling).
    """
    if not states:
        return []

    timeline: list[tuple[datetime, Any]] = []
    for state in states:
        raw = state.get("state") if isinstance(state, dict) else getattr(state, "state", None)
        try:
            value: float | None = float(raw)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            if not keep_non_numeric:
                continue
            value = None

        ts = (
            (state.get("last_updated") or state.get("last_changed"))
            if isinstance(state, dict)
            else (getattr(state, "last_updated", None) or getattr(state, "last_changed", None))
        )
        if ts is None:
            continue
        timeline.append((dt_util.as_local(ts), value))

    if not timeline:
        return []
    timeline.sort(key=lambda pair: pair[0])
    return timeline


def _query_states_sync(
    hass: HomeAssistant,
    ids: list[str],
    start_utc: datetime,
    end_utc: datetime,
    include_start_state: bool,
    no_attributes: bool,
    recorder_instance: Any = None,
) -> dict[str, list[Any]]:
    """Query significant states on the recorder executor and handle lowercase key fallback."""
    get_sig_states = getattr(recorder_instance, "get_significant_states", None)
    if get_sig_states is None:
        try:
            from homeassistant.components.recorder.history import (
                get_significant_states as get_sig_states,
            )
        except Exception:  # pragma: no cover
            return {eid: [] for eid in ids}

    try:
        history = get_sig_states(
            hass,
            start_utc,
            end_utc,
            ids,
            include_start_time_state=include_start_state,
            significant_changes_only=False,
            no_attributes=no_attributes,
        ) or {}
    except TypeError:
        # Fallback for test stubs / fakes that do not accept all keyword arguments
        try:
            history = get_sig_states(
                hass,
                start_utc,
                end_utc,
                ids,
            ) or {}
        except Exception:
            return {eid: [] for eid in ids}
    except Exception:
        return {eid: [] for eid in ids}

    return {
        eid: list(history.get(eid) or history.get(eid.lower()) or [])
        for eid in ids
    }


async def read_states(
    hass: HomeAssistant,
    ids: Iterable[str],
    start: datetime,
    end: datetime,
    *,
    include_start_state: bool = False,
    no_attributes: bool = True,
) -> dict[str, list[Any]]:
    """Read recorder states for multiple entity IDs over [start, end].

    Handles import guards, running on the recorder executor, and lowercase-key
    fallbacks. Returns a dict mapping each requested entity ID to its list of states
    (empty list if absent or on query failure).
    """
    clean_ids = [eid for eid in dict.fromkeys(ids) if eid]
    if not clean_ids:
        return {}

    utc_start = dt_util.as_utc(start)
    utc_end = dt_util.as_utc(end)

    try:
        from homeassistant.components.recorder import get_instance

        recorder = get_instance(hass)
    except Exception:  # pragma: no cover
        return {eid: [] for eid in clean_ids}

    if recorder is None:
        return {eid: [] for eid in clean_ids}

    try:
        return await recorder.async_add_executor_job(
            _query_states_sync,
            hass,
            clean_ids,
            utc_start,
            utc_end,
            include_start_state,
            no_attributes,
            recorder,
        )
    except Exception:
        _LOGGER.exception("Failed to read recorder states for: %s", ", ".join(clean_ids))
        return {eid: [] for eid in clean_ids}
