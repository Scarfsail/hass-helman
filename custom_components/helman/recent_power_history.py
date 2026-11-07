"""The live power sampling settings, under ``data_and_learning.recent_power_history`` since config version 32."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any

from .config_read import read_mapping

#: One default per key, and the only place they are spelled. A partial
#: ``recent_power_history`` object would otherwise replace the whole set, so
#: every reader resolves through :func:`read_recent_power_history` instead of
#: carrying a fallback of its own -- which is also how the tick and the history
#: payload once disagreed on the sampling interval (5 s against 1 s).
RECENT_POWER_HISTORY_DEFAULTS: dict[str, Any] = {
    "sampling_interval_seconds": 5,
    "samples": 60,
}


def read_recent_power_history(config: Mapping[str, Any]) -> dict[str, Any]:
    """``data_and_learning.recent_power_history`` with every omitted key filled from the defaults."""
    data_and_learning = read_mapping(config.get("data_and_learning"))
    return {
        **RECENT_POWER_HISTORY_DEFAULTS,
        **read_mapping(data_and_learning.get("recent_power_history")),
    }


def compact_recent_power_history(config: Mapping[str, Any]) -> dict[str, Any]:
    """Copy a validated document, omitting recent power history values at their defaults."""
    compacted = deepcopy(dict(config))
    data_and_learning = compacted.get("data_and_learning")
    if not isinstance(data_and_learning, dict):
        return compacted
    history = data_and_learning.get("recent_power_history")
    if not isinstance(history, dict):
        return compacted
    for key, default in RECENT_POWER_HISTORY_DEFAULTS.items():
        if key in history and type(history[key]) is type(default) and history[key] == default:
            del history[key]
    if not history:
        del data_and_learning["recent_power_history"]
    if not data_and_learning:
        del compacted["data_and_learning"]
    return compacted
