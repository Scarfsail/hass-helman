"""One hourly read of a period's meters and prices, shared by every span view.

The inspector's month and year views and the device reports ask the same
question of the recorder -- every meter's energy hour by hour, and the rate each
hour was bought and sold at -- so they ask it here, once:

* one :func:`~.recorder_statistics_span.query_hourly_statistics` call for the six
  meters, the caller's extra ids and both of Helman's price entities, plus the
  short-term tail the caller names;
* one :func:`~.recorder_statistics_span.query_price_history` call for the two
  rates, handed the rows the first read already fetched;
* the import rate resolved per hour with the precedence the inspector has always
  priced by: the recorded rate first, the configured window table where nothing
  was recorded. The export rate is recorded only.

What comes back is a :class:`~.span_history_model.SpanHistory`, which carries
no Home Assistant types, so whatever is built on it can be tested without them.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
import logging
from typing import Any

from homeassistant.core import HomeAssistant

from .const import GRID_EXPORT_PRICE_ENTITY_ID, GRID_IMPORT_PRICE_ENTITY_ID
from .recorder_statistics_span import (
    SpanStatistics,
    query_hourly_statistics,
    query_price_history,
)
from .span_history_model import (
    RATE_RECORDED,
    RATE_TARIFF,
    SpanHistory,
    SpanMeters,
    period_hours,
)

_LOGGER = logging.getLogger(__name__)


async def read_span_history(
    hass: HomeAssistant,
    *,
    meter_ids: SpanMeters,
    extra_ids: Sequence[str | None],
    local_start: datetime,
    local_end: datetime,
    tail_start: datetime | None,
    import_price_windows,
) -> SpanHistory:
    """The period's hourly energy, rows and rates, in one statistics read.

    ``tail_start`` is handed to the statistics read unchanged; see
    :func:`~.recorder_statistics_span.query_hourly_statistics` for what it does
    and :func:`~.span_history_model.recorder_tail_start` for one way of
    choosing it.

    A statistics read that fails costs the meters, not the call: it is logged
    and read as empty, and the price reader is then left to read its own rows,
    exactly as the inspector's span views always degraded.
    """
    try:
        span = await query_hourly_statistics(
            hass,
            [
                *meter_ids,
                *extra_ids,
                GRID_IMPORT_PRICE_ENTITY_ID,
                GRID_EXPORT_PRICE_ENTITY_ID,
            ],
            local_start=local_start,
            local_end=local_end,
            tail_start=tail_start,
        )
    except Exception:
        _LOGGER.exception("Failed to load statistics for a span read")
        span = SpanStatistics(rows={}, energy_kwh={})
        statistics_failed = True
    else:
        statistics_failed = False

    # Both rates through the one price reader every historical price goes
    # through, so a month's money and the day it is made of are priced from the
    # same tiers. The hourly rows this read already fetched are handed over
    # rather than re-queried; what the reader adds is the raw-state tier under
    # them, which covers the hours the statistics compiler has holes in.
    price_history = await query_price_history(
        hass,
        [GRID_IMPORT_PRICE_ENTITY_ID, GRID_EXPORT_PRICE_ENTITY_ID],
        local_start=local_start,
        local_end=local_end,
        statistics_rows=span.rows,
    )
    import_rows = price_history[GRID_IMPORT_PRICE_ENTITY_ID].hourly_means()
    export_rows = price_history[GRID_EXPORT_PRICE_ENTITY_ID].hourly_means()

    local_tz = local_start.tzinfo
    import_rate: dict[datetime, float] = {}
    import_rate_source: dict[datetime, str] = {}
    export_rate: dict[datetime, float] = {}
    # The window table is keyed on minute-of-day, so its rate for an hour
    # depends only on that hour's local clock reading: computed once per
    # hour-of-day rather than once per hour of a year.
    tariff_by_hour_of_day: dict[tuple[int, int], float | None] = {}
    for utc_hour in period_hours(local_start, local_end):
        rate = _hourly_rate(import_rows, utc_hour)
        if rate is not None:
            import_rate[utc_hour] = rate
            import_rate_source[utc_hour] = RATE_RECORDED
        else:
            local_hour = utc_hour.astimezone(local_tz)
            clock = (local_hour.hour, local_hour.minute)
            if clock not in tariff_by_hour_of_day:
                tariff_by_hour_of_day[clock] = _config_import_rate(
                    import_price_windows, local_hour
                )
            tariff = tariff_by_hour_of_day[clock]
            if tariff is not None:
                import_rate[utc_hour] = tariff
                import_rate_source[utc_hour] = RATE_TARIFF
        sell = _hourly_rate(export_rows, utc_hour)
        if sell is not None:
            export_rate[utc_hour] = sell

    return SpanHistory(
        meters=meter_ids,
        local_start=local_start,
        local_end=local_end,
        energy_kwh=span.energy_kwh,
        rows=span.rows,
        import_rate=import_rate,
        import_rate_source=import_rate_source,
        export_rate=export_rate,
        compiled_until=span.compiled_until,
        statistics_failed=statistics_failed,
    )


def _hourly_rate(
    rate_rows: dict[datetime, dict[str, Any]],
    utc_hour: datetime,
) -> float | None:
    """A price sensor's recorded rate for one hour, or None where it has none.

    Matched on the UTC instant, which is the only key that tells the fall-back
    day's two 02:00 hours apart -- and they can carry different rates.
    """
    row = rate_rows.get(utc_hour)
    return None if row is None else row.get("mean")


#: The finest grain the window table is sampled at when pricing a whole hour.
#:
#: Windows are configured in minutes and need not begin on the hour, so an hour
#: the tariff changes inside of has no single rate. One minute is exact for any
#: window a user can express and costs sixty lookups per hour of the day.
_TARIFF_SAMPLE_MINUTES = 1


def _config_import_rate(import_price_windows, local_hour: datetime) -> float | None:
    """The configured import tariff across ``local_hour``, or None.

    The rate is averaged over the hour's minutes rather than read off its start.
    A window boundary that does not land on the hour -- a night tariff ending at
    08:30, say -- otherwise mis-prices the crossing hour by the full difference
    between the two rates, and does so systematically: this fallback exists to
    price history older than the price sensor, so every such hour in a year view
    would carry the same error rather than it averaging out.

    Minutes no window covers are left out of the average rather than counted as
    zero; an hour no window covers at all is unpriced. Weighting is by time, not
    by energy, because the intra-hour shape of the import is exactly what
    statistics no longer hold.

    Known limitation, stated rather than engineered around: the window table
    holds no history, so hours older than the price sensor are priced at
    *today's* tariff. That is the approximation the day view already makes for
    a pre-sensor day; an approximate cost is more useful than a hole, and the
    device reports say how much of their money it is.
    """
    if import_price_windows is None:
        return None
    from .grid_price_forecast_builder import (
        GridImportPriceConfigError,
        lookup_grid_import_price,
    )

    # From the hour's actual local minute: in a fractional-offset zone a
    # statistics hour starts at HH:30.
    hour_start = local_hour.hour * 60 + local_hour.minute
    total = 0.0
    covered = 0
    for offset in range(0, 60, _TARIFF_SAMPLE_MINUTES):
        try:
            total += lookup_grid_import_price(
                windows=import_price_windows,
                minute_of_day=(hour_start + offset) % (24 * 60),
            )
        except GridImportPriceConfigError:
            continue
        covered += 1

    if covered == 0:
        _LOGGER.debug(
            "No import price window covers the hour from %02d:%02d; leaving it unpriced",
            local_hour.hour,
            local_hour.minute,
        )
        return None
    return total / covered
