"""The nightly training time, parsed once for everyone who reads it.

Its own module rather than part of ``batch``: the bias service reports the next
run too, and ``batch`` imports the bias service, so the service importing
``batch`` would be circular.
"""

from __future__ import annotations

from datetime import timedelta

from homeassistant.util import dt as dt_util


def parse_training_time(training_time: str) -> tuple[int, int]:
    hour_text, minute_text = training_time.split(":", maxsplit=1)
    hour = int(hour_text)
    minute = int(minute_text)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"Invalid training time: {training_time}")
    return hour, minute


def next_scheduled_training_at(training_time: str) -> str | None:
    """The next local occurrence of ``training_time`` (``HH:MM``), as ISO.

    ``None`` when the time cannot be parsed. The one source for both the
    batch's own status and the bias service's ``nextScheduledTrainingAt``.
    """
    try:
        hour, minute = parse_training_time(training_time)
    except (AttributeError, ValueError):
        return None
    local_now = dt_util.as_local(dt_util.now())
    next_run = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if next_run <= local_now:
        next_run += timedelta(days=1)
    return next_run.isoformat()
