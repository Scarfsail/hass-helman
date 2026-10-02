"""What one span read hands back, kept free of Home Assistant imports.

:func:`~.span_history.read_span_history` is the read; this module is its result
and the small rules about it that need no recorder, so the device dataset built
on top of it can be tested with nothing stubbed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

#: How far back from the newest moment a period reaches the short-term tail is read.
#:
#: The hourly table lags real time by up to ~2 hours (see
#: :mod:`.recorder_statistics_span`), so three hours covers the lag with an hour
#: to spare. Elapsed hours, not wall-clock ones: the arithmetic is on UTC
#: instants, so a DST change does not shorten or lengthen it.
TAIL_LOOKBACK = timedelta(hours=3)

#: Where an hour's import rate came from.
RATE_RECORDED = "recorded"
#: The configured window table: today's tariff, applied to the past.
RATE_TARIFF = "tariff"


class SpanMeters(NamedTuple):
    """The six meters a span read is about, in the order the inspector keeps them.

    A tuple, so the inspector's positional unpacking keeps working; named, so the
    device dataset can ask for a meter by its role. ``None`` is a meter that is
    not configured.
    """

    solar: str | None
    grid_import: str | None
    grid_export: str | None
    house: str | None
    battery_charge: str | None
    battery_discharge: str | None


@dataclass(frozen=True)
class SpanHistory:
    """Hourly meter energy, statistics rows and resolved rates over one period.

    Every map is keyed by the hour's **UTC** start, for the reason
    :class:`~.recorder_statistics_span.SpanStatistics` gives: the autumn
    fall-back day lives one local hour twice.
    """

    meters: SpanMeters
    local_start: datetime
    local_end: datetime
    #: ``{statistic_id: {utc_hour: kwh}}``: differenced, reset-unwrapped energy
    #: for every id read, never the statistics ``change``/``sum`` columns.
    energy_kwh: dict[str, dict[datetime, float]]
    #: ``{statistic_id: {utc_hour: row}}``, for ``mean``/``min``/``max``.
    rows: dict[str, dict[datetime, dict[str, Any]]]
    #: ``{utc_hour: rate}``: the recorded rate first, the configured window
    #: table where nothing was recorded. An hour with neither is absent.
    import_rate: dict[datetime, float]
    #: ``{utc_hour: RATE_RECORDED | RATE_TARIFF}`` for every key of ``import_rate``.
    import_rate_source: dict[datetime, str]
    #: ``{utc_hour: rate}``, recorded only: there is no table to fall back on.
    export_rate: dict[datetime, float]
    #: ``{statistic_id: utc_instant}``: how far the hourly table had compiled
    #: each id when it was read, before the tail was merged.
    compiled_until: dict[str, datetime] = field(default_factory=dict)

    def energy_for(self, statistic_id: str | None) -> dict[datetime, float]:
        """One id's hourly energy, or an empty map for an unconfigured one."""
        if not statistic_id:
            return {}
        return self.energy_kwh.get(statistic_id) or {}

    def rows_for(self, statistic_id: str | None) -> dict[datetime, dict[str, Any]]:
        """One id's hourly rows, or an empty map for an unconfigured one."""
        if not statistic_id:
            return {}
        return self.rows.get(statistic_id) or {}


def period_hours(local_start: datetime, local_end: datetime) -> list[datetime]:
    """Every hour in ``[local_start, local_end)``, as UTC instants, in order.

    Floored to the UTC hour, which is how statistics rows are keyed: in a zone
    with a half-hour offset, local midnight falls mid-hour.
    """
    cursor = local_start.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    end = local_end.astimezone(timezone.utc)
    hours: list[datetime] = []
    while cursor < end:
        hours.append(cursor)
        cursor += timedelta(hours=1)
    return hours


def recorder_tail_start(
    local_start: datetime, local_end: datetime, now: datetime
) -> datetime | None:
    """Where a period's short-term tail read starts, or ``None`` for no tail.

    The hourly table follows the recorder, not the calendar, so the tail is
    read whenever the period's end is later than ``now - TAIL_LOOKBACK``, and it
    is anchored to the earlier of now and the period end: a period ending
    tonight still reads today's recent hours, and yesterday's period fetched
    just after midnight reads its last three.
    """
    period_end = local_end.astimezone(timezone.utc)
    utc_now = now.astimezone(timezone.utc)
    if period_end <= utc_now - TAIL_LOOKBACK:
        return None
    tail_end = min(utc_now, period_end)
    return max(local_start.astimezone(timezone.utc), tail_end - TAIL_LOOKBACK)
