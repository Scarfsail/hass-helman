"""Back-fill the five battery-forecast entities' statistics from the retired store's file.

P1 (#187) retired ``BatteryForecastHistoryStore`` and published five entities in
its place. Its ``.storage`` file -- ``helman.battery_forecast_history`` -- is
still on disk, frozen at whatever it held on upgrade day: nothing reads it and
nothing prunes it any more, because ``_prune`` only ever ran inside
``record_snapshot`` and that code is gone. Meanwhile the five entities have no
recorder history before the release, so the inspector draws no battery or grid
forecast on any past day, and -- once those days age past ``purge_keep_days`` --
will draw none ever, there being no hourly statistics to fall back to either.

This module writes those statistics from the frozen file, once. It is modelled
on :mod:`.solar_forecast_backfill`, and the four traps
:mod:`.grid_export_price_backfill` records apply here unchanged:

* **The hourly figure is not an average of the samples.** The four Wh entities
  each publish *one 15-minute slot's* energy, and the reader
  :func:`~.solar_bias_correction.statistics_day._forecast_wh_points` recovers an
  hour's forecast energy as ``mean * _KWH_TO_WH * _SLOTS_PER_HOUR``. So the mean
  written for an hour is that hour's archived slot values *summed and divided by
  four* -- ``mean * 4`` then reconstructs the sum. Getting this wrong is a
  constant factor on every back-filled day and no error, which is why
  ``test_battery_forecast_backfill`` pins the round trip against what
  ``statistics_day`` actually reads back. ``socPct`` is a percentage, not an
  energy: its hourly figure is the plain mean of the hour's slots, its unit
  class ``unitless`` rather than ``energy``.
* **An hour Home Assistant has already compiled is never written.** The walk
  drops every hour at or after :func:`_first_hour_home_assistant_owns`, so the
  compiler's rows and the imported ones never describe one hour by two routes.
* **``async_import_statistics`` validates strictly**, so ``mean_type``,
  ``unit_class`` and a recorder-domain ``source`` are all passed explicitly, and
  differently for the percentage than for the four energies.
* **The import is paced**, in chunks with a pause between, so a queue of a
  quarter-year of hourly rows per entity does not monopolise the recorder.

Unlike ``solar_forecast_backfill``, whose source was perishable raw states, this
one's source is a static file -- which is why P3 could wait, and why an
interrupted run simply re-imports on the next start (``async_import_statistics``
upserts) rather than needing a resumable cursor. A per-entity done-marker keeps
a finished series from being walked again.

A missing or unreadable source file is a no-op: a fresh install never had one,
and a user may have cleaned it up already. The file is **not** deleted after a
successful back-fill -- the done-marker prevents a re-run, and deleting is
irreversible.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.components.recorder.models import (
    StatisticData,
    StatisticMeanType,
    StatisticMetaData,
)
from homeassistant.components.recorder.statistics import async_import_statistics
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import storage
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .solar_bias_correction.battery_forecast_history import (
    BATTERY_NET_FORECAST_CURRENT_ENTITY,
    BATTERY_SOC_FORECAST_CURRENT_ENTITY,
    GRID_EXPORT_FORECAST_CURRENT_ENTITY,
    GRID_IMPORT_FORECAST_CURRENT_ENTITY,
    GRID_NET_FORECAST_CURRENT_ENTITY,
)
from .solar_forecast_backfill import _first_hour_home_assistant_owns

_LOGGER = logging.getLogger(__name__)

#: The recorder's own domain, which ``async_import_statistics`` insists the
#: metadata's ``source`` equals -- the series belong to entities and live in the
#: recorder's own table.
_RECORDER_DOMAIN = "recorder"

#: The retired store's file. Its shape (v1)::
#:
#:     {"days": {"YYYY-MM-DD": {"HH:MM": {"socPct": float, "gridNetWh": float,
#:                                        "gridImportWh": float,
#:                                        "gridExportWh": float,
#:                                        "batteryNetWh": float}}}}
#:
#: ``batteryNetWh`` and the two grid sides arrived in later releases, so days
#: archived before each simply lack those keys; a missing key yields no sample
#: for that series rather than a zero, exactly as the retired store's readers
#: treated it.
_SOURCE_STORAGE_KEY = f"{DOMAIN}.battery_forecast_history"
_SOURCE_STORAGE_VERSION = 1

_STORAGE_KEY = f"{DOMAIN}.battery_forecast_backfill"
_STORAGE_VERSION = 1

_SLOT_MINUTES = 15
#: Fifteen-minute slots per statistics hour. The reader
#: ``statistics_day._forecast_wh_points`` multiplies an hour's mean by
#: ``_KWH_TO_WH * _SLOTS_PER_HOUR`` because each Wh entity publishes one slot's
#: Wh, so the mean written here is the hour's slot sum divided by this. Keep in
#: step with ``statistics_day._SLOTS_PER_HOUR``.
_SLOTS_PER_HOUR = 60 // _SLOT_MINUTES

#: How much history one import job covers before the walk pauses. Mirrors the
#: seven-day chunk the sibling back-fills read in; here the whole source is
#: already in memory, so the chunk only paces the write side.
_CHUNK = timedelta(days=7)
_CHUNK_PAUSE_SECONDS = 1.0


@dataclass(frozen=True)
class _Series:
    """One back-filled entity and how to read its value out of a slot map.

    ``is_energy`` splits the five two ways that matter downstream: the metadata
    (``energy`` / ``Wh`` versus ``unitless`` / ``%``) and the hourly figure (the
    slot sum over four, so the reader's ``mean * 4`` rebuilds it, versus the
    plain mean of a level).
    """

    entity_id: str
    slot_key: str
    is_energy: bool


_SERIES: tuple[_Series, ...] = (
    _Series(BATTERY_SOC_FORECAST_CURRENT_ENTITY, "socPct", is_energy=False),
    _Series(BATTERY_NET_FORECAST_CURRENT_ENTITY, "batteryNetWh", is_energy=True),
    _Series(GRID_NET_FORECAST_CURRENT_ENTITY, "gridNetWh", is_energy=True),
    _Series(GRID_IMPORT_FORECAST_CURRENT_ENTITY, "gridImportWh", is_energy=True),
    _Series(GRID_EXPORT_FORECAST_CURRENT_ENTITY, "gridExportWh", is_energy=True),
)


class BatteryForecastBackfillStore:
    """Which series have been back-filled, across restarts.

    Persisted payload shape (v1)::

        {"version": 1, "done": ["sensor.x", "sensor.y", ...]}

    Per entity rather than one flag for all five: the source is static, so a
    series once written is written for good, and a run cut short by a restart
    resumes by simply skipping the series it already finished. The list is keyed
    by entity id so a future rename cannot let a stale ``done`` latch over an id
    whose history was never touched.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._store = storage.Store(hass, _STORAGE_VERSION, _STORAGE_KEY)
        self._done: set[str] = set()

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        done = stored.get("done") if isinstance(stored, dict) else None
        if not isinstance(done, list):
            self._done = set()
            return
        self._done = {item for item in done if isinstance(item, str)}

    def done_for(self, entity_id: str) -> bool:
        return entity_id in self._done

    async def async_mark_done(self, entity_id: str) -> None:
        self._done.add(entity_id)
        await self._store.async_save(
            {"version": _STORAGE_VERSION, "done": sorted(self._done)}
        )


async def async_backfill_battery_forecast_statistics(
    hass: HomeAssistant,
    *,
    source_storage_key: str = _SOURCE_STORAGE_KEY,
) -> None:
    """Write the five battery-forecast entities' hourly statistics from the frozen file.

    Never raises. Nothing depended on these rows before this ran, so a failure
    here is logged rather than taken out on whatever started the task.
    """
    try:
        marker = BatteryForecastBackfillStore(hass)
        await marker.async_load()
        pending = [series for series in _SERIES if not marker.done_for(series.entity_id)]
        if not pending:
            return

        days = await _load_source_days(hass, source_storage_key)
        if not days:
            # A fresh install never had the file, and a user may have cleaned it
            # up. Neither is an error, and neither is anything to mark done --
            # the file could yet be restored from a backup.
            return

        timezone = ZoneInfo(str(hass.config.time_zone))
        written = 0
        for series in pending:
            written += await _backfill_series(hass, series, days, timezone)
            await marker.async_mark_done(series.entity_id)

        _LOGGER.info(
            "Back-filled %d hourly battery forecast statistics across %d series from %s",
            written,
            len(pending),
            source_storage_key,
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        _LOGGER.exception("Failed to back-fill battery forecast statistics")


async def _load_source_days(
    hass: HomeAssistant, source_storage_key: str
) -> dict[str, Any] | None:
    """The retired store's ``days`` map, or ``None`` when there is nothing to read."""
    source = storage.Store(hass, _SOURCE_STORAGE_VERSION, source_storage_key)
    try:
        raw = await source.async_load()
    except (HomeAssistantError, OSError, ValueError):
        # A corrupt or half-written file: not an error worth raising over, since
        # a fresh install has none either and nothing depends on these rows.
        _LOGGER.debug(
            "Battery forecast history store %s is unreadable; nothing to back-fill",
            source_storage_key,
        )
        return None
    days = raw.get("days") if isinstance(raw, dict) else None
    return days if isinstance(days, dict) and days else None


async def _backfill_series(
    hass: HomeAssistant,
    series: _Series,
    days: dict[str, Any],
    timezone: ZoneInfo,
) -> int:
    """Import one series' hourly rows, paced in chunks. Returns the row count."""
    first_owned = await _first_hour_home_assistant_owns(hass, series.entity_id)
    rows = _hourly_rows(series, days, timezone, before=first_owned)
    if not rows:
        return 0

    metadata = _metadata(series)
    written = 0
    for chunk in _in_chunks(rows):
        async_import_statistics(hass, metadata, chunk)
        written += len(chunk)
        await asyncio.sleep(_CHUNK_PAUSE_SECONDS)
    return written


def _hourly_rows(
    series: _Series,
    days: dict[str, Any],
    timezone: ZoneInfo,
    *,
    before: datetime,
) -> list[StatisticData]:
    """One row per hour the file has any slot for, strictly before ``before``.

    An hour with no sample for this series -- the whole hole, or a series whose
    key had not been added when the day was archived -- is omitted rather than
    carried, so a gap in the source stays a gap here.
    """
    samples_by_hour: dict[datetime, list[float]] = {}
    for day_iso, slots in days.items():
        if not isinstance(slots, dict):
            continue
        try:
            day = date.fromisoformat(day_iso)
        except (TypeError, ValueError):
            continue
        for slot_label, values in slots.items():
            if not isinstance(values, dict):
                continue
            raw_value = values.get(series.slot_key)
            if raw_value is None:
                continue
            try:
                value = float(raw_value)
            except (TypeError, ValueError):
                continue
            slot_local = _parse_slot(day, slot_label, timezone)
            if slot_local is None:
                continue
            hour_utc = dt_util.as_utc(slot_local).replace(
                minute=0, second=0, microsecond=0
            )
            if hour_utc >= before:
                continue
            samples_by_hour.setdefault(hour_utc, []).append(value)

    rows: list[StatisticData] = []
    for hour_utc in sorted(samples_by_hour):
        samples = samples_by_hour[hour_utc]
        if series.is_energy:
            # The hour's slot sum over four: the reader multiplies an hour's
            # mean by _SLOTS_PER_HOUR to recover the hour's forecast energy. No
            # min/max -- for an hour the source archived fewer than four slots
            # for, this synthetic mean falls outside the raw slot values' range,
            # and scaling those by four would only invent a band. Nothing reads
            # them and the recorder's columns are nullable, so leaving them off
            # is the honest row.
            rows.append(
                StatisticData(start=hour_utc, mean=sum(samples) / _SLOTS_PER_HOUR)
            )
        else:
            # A percentage is a level; its hourly figure is the plain mean of
            # the slots archived for the hour, which always lies within their
            # range, so min/max stay meaningful and are kept.
            rows.append(
                StatisticData(
                    start=hour_utc,
                    mean=sum(samples) / len(samples),
                    min=min(samples),
                    max=max(samples),
                )
            )
    return rows


def _in_chunks(rows: list[StatisticData]) -> list[list[StatisticData]]:
    """``rows`` cut into runs no wider than :data:`_CHUNK`, order preserved."""
    if not rows:
        return []
    chunks: list[list[StatisticData]] = [[rows[0]]]
    for row in rows[1:]:
        if row["start"] - chunks[-1][0]["start"] >= _CHUNK:
            chunks.append([])
        chunks[-1].append(row)
    return chunks


def _parse_slot(
    day: date, slot_label: Any, timezone: ZoneInfo
) -> datetime | None:
    """A slot-boundary ``"HH:MM"`` label on ``day`` as a local datetime.

    Rejects anything off the 15-minute grid, the same guard the retired store's
    ``_is_slot_label`` applied on the way in.
    """
    if not isinstance(slot_label, str):
        return None
    hour_text, _, minute_text = slot_label.partition(":")
    try:
        hour = int(hour_text)
        minute = int(minute_text)
    except ValueError:
        return None
    if not (0 <= hour < 24 and 0 <= minute < 60 and minute % _SLOT_MINUTES == 0):
        return None
    return datetime.combine(day, time(hour, minute), tzinfo=timezone)


def _metadata(series: _Series) -> StatisticMetaData:
    """What the imported rows describe, in the shape the recorder validates.

    ``source`` is the recorder's own domain -- an entity-id-shaped series lives
    in the recorder's table and ``async_import_statistics`` rejects anything
    else. The four Wh series convert within ``energy``; ``socPct`` is a
    percentage, whose unit class is ``unitless`` -- naming ``energy`` there is an
    outright rejection, and both are stated explicitly because the entities
    carry no device class the recorder could infer them from.
    """
    if series.is_energy:
        return StatisticMetaData(
            mean_type=StatisticMeanType.ARITHMETIC,
            has_sum=False,
            name=None,
            source=_RECORDER_DOMAIN,
            statistic_id=series.entity_id,
            unit_class="energy",
            unit_of_measurement="Wh",
        )
    return StatisticMetaData(
        mean_type=StatisticMeanType.ARITHMETIC,
        has_sum=False,
        name=None,
        source=_RECORDER_DOMAIN,
        statistic_id=series.entity_id,
        unit_class="unitless",
        unit_of_measurement="%",
    )
