"""Buckets of a span of local days: a day, an ISO week or a calendar month.

Pure: no Home Assistant imports. Shared by the inspector's span aggregates and
the device reports. A bucket is named by the ISO date of the local day it
starts on -- a week by its Monday, a month by its first -- so every bucket of
every span carries the same kind of key.

The inspector snaps a month bucket outward to the whole month. A device report
instead clamps every bucket to the period (:func:`period_buckets`), and marks
a bucket the period cuts, or one still running, as ``partial``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, tzinfo

from .span_history_model import period_hours

#: The bucket sizes, smallest first.
BUCKETS = ("day", "week", "month")


def add_months(anchor: date, delta: int) -> date:
    """The first of the month ``delta`` months from ``anchor``'s month."""
    total = anchor.year * 12 + (anchor.month - 1) + delta
    year, month_index = divmod(total, 12)
    return date(year, month_index + 1, 1)


def bucket_start(local_date: date, bucket: str) -> date:
    """The first local day of the bucket ``local_date`` falls in."""
    if bucket == "day":
        return local_date
    if bucket == "week":
        # ISO weeks start on Monday.
        return local_date - timedelta(days=local_date.weekday())
    return local_date.replace(day=1)


def next_bucket_start(start: date, bucket: str) -> date:
    """The first local day of the bucket after the one starting on ``start``."""
    if bucket == "day":
        return start + timedelta(days=1)
    if bucket == "week":
        return start + timedelta(days=7)
    return add_months(start, 1)


def bucket_key(utc_hour: datetime, bucket: str, local_tz: tzinfo) -> str:
    """The bucket an hour belongs to, as the ISO date the bucket starts on.

    A month bucket is named by its first day rather than by ``YYYY-MM`` so that
    every row of every span carries the same kind of value in ``date``: the local
    date the bucket starts on.
    """
    return bucket_start(utc_hour.astimezone(local_tz).date(), bucket).isoformat()


def bucket_keys(start_date: date, end_date: date, bucket: str) -> list[str]:
    """Every bucket in the span, in order, whether or not it has data.

    The span is enumerated rather than read off the statistics, so a bucket the
    recorder holds nothing for still appears -- with nulls, which is a different
    statement from being absent.
    """
    keys: list[str] = []
    cursor = bucket_start(start_date, bucket)
    while cursor <= end_date:
        keys.append(cursor.isoformat())
        cursor = next_bucket_start(cursor, bucket)
    return keys


@dataclass(frozen=True)
class SpanBucket:
    """One bucket of a period, clamped to it: ``[local_start, local_end)``."""

    local_start: datetime
    local_end: datetime
    #: The period cuts the bucket, or the bucket ends after now.
    partial: bool

    @property
    def start_date(self) -> date:
        return self.local_start.date()

    @property
    def end_date(self) -> date:
        """The bucket's last local day, inclusive."""
        return self.local_end.date() - timedelta(days=1)

    @property
    def hours(self) -> list[datetime]:
        """The bucket's hours, as UTC instants: a DST week holds 167 or 169."""
        return period_hours(self.local_start, self.local_end)


def period_buckets(
    local_start: datetime, local_end: datetime, bucket: str, now: datetime
) -> list[SpanBucket]:
    """The buckets of ``[local_start, local_end)``, local midnights, clamped to it.

    A bucket the period starts or ends inside covers only the period's part of
    it and is ``partial``, and so is one that ends after ``now``: today's.
    """
    local_tz = local_start.tzinfo
    first, last = local_start.date(), local_end.date()

    def _midnight(day: date) -> datetime:
        return datetime.combine(day, time.min, tzinfo=local_tz)

    buckets: list[SpanBucket] = []
    cursor = bucket_start(first, bucket)
    while cursor < last:
        following = next_bucket_start(cursor, bucket)
        start, end = max(cursor, first), min(following, last)
        bucket_end = _midnight(end)
        buckets.append(
            SpanBucket(
                local_start=_midnight(start),
                local_end=bucket_end,
                partial=cursor < first or following > last or bucket_end > now,
            )
        )
        cursor = following
    return buckets
