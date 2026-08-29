from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
import logging
from typing import Any
from zoneinfo import ZoneInfo

try:
    from homeassistant.components.recorder import get_instance
except Exception:  # pragma: no cover - Home Assistant API compatibility
    get_instance = lambda hass: None  # type: ignore[assignment]

try:
    from homeassistant.components.recorder.history import state_changes_during_period
except Exception:  # pragma: no cover - Home Assistant API compatibility
    state_changes_during_period = None  # type: ignore[assignment]
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..const import DOMAIN
from ..power_polarity import is_power_inverted
from .forecast_slot_history import (
    ForecastSlotWindow,
    load_spliced_forecast_slots_for_window,
)
from .models import BiasConfig, SolarActualsWindow
from .slot_invalidation import (
    InvalidationInputs,
    StateSample,
    compute_data_glitch_invalidations,
    compute_invalidated_slots_for_window,
)

try:
    from ..recorder_statistics_span import (
        query_hourly_statistics,
        query_oldest_state_date,
    )
except Exception:  # pragma: no cover - Home Assistant API compatibility
    query_hourly_statistics = None  # type: ignore[assignment]
    query_oldest_state_date = None  # type: ignore[assignment]
try:
    from ..recorder_hourly_series import (
        get_local_current_slot_start,
        query_cumulative_slot_energy_changes,
    )
except Exception:  # pragma: no cover - test stub compatibility
    def get_local_current_slot_start(
        local_now: datetime,
        interval_minutes: int,
    ) -> datetime:
        floored_minute = (local_now.minute // interval_minutes) * interval_minutes
        return local_now.replace(
            minute=floored_minute,
            second=0,
            microsecond=0,
        )

    async def query_cumulative_slot_energy_changes(
        hass: HomeAssistant,
        entity_id: str,
        *,
        local_start: datetime,
        local_end: datetime,
        interval_minutes: int,
    ) -> dict[datetime, float]:
        del hass, entity_id, local_start, local_end, interval_minutes
        return {}


_LOGGER = logging.getLogger(__name__)


async def load_actuals_for_day(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> dict[str, float]:
    entity_id = _read_entity_id(cfg.total_energy_entity_id)
    if entity_id is None:
        return {}
    return await _read_day_slot_actuals(
        hass,
        entity_id,
        target_date,
        local_now=local_now,
    )


@dataclass(frozen=True)
class _StatisticsTail:
    """The part of the window raw states no longer reach, already read.

    ``splice_date`` is the first date served from raw states; every earlier day
    in the window is hour-grain and is served from ``statistics``. They are
    carried together because the same rows answer three questions -- the day's
    actuals, the hour's peak SoC and the hour's peak export -- and re-reading
    them per question is what #175's G4 exists to stop.
    """

    splice_date: date
    statistics: Any | None


async def load_actuals_window(
    hass: HomeAssistant,
    cfg: BiasConfig,
    days: int,
) -> SolarActualsWindow:
    """The training window's measured production, spliced across both tables.

    A day is read at fifteen-minute grain from raw states for as long as the
    recorder still holds them, and from hourly long-term statistics beyond that
    (#173). The seam is probed rather than assumed -- see
    :func:`_resolve_statistics_tail` -- and the tail is **one** statistics read
    for the meter, the battery SoC and the grid power together, replacing what
    was one raw query per day per entity and returned nothing past the purge
    horizon.

    Hour-grain days come back keyed ``HH:00`` with the whole hour's energy and
    are named in ``hourly_grain_dates``, because nothing downstream can tell the
    two grains apart from the numbers alone.
    """
    entity_id = _read_entity_id(cfg.total_energy_entity_id)
    if entity_id is None or days <= 0:
        return SolarActualsWindow(
            slot_actuals_by_date={},
            invalidated_slots_by_date={},
        )

    local_now = dt_util.as_local(datetime.now(timezone.utc))
    local_tz = local_now.tzinfo
    first_date = local_now.date() - timedelta(days=days)

    # Resolved before anything is read: which entities the tail read has to
    # cover depends on whether curtailment can run at all.
    curtailment_entities = _resolve_curtailment_entities(hass, cfg)
    tail = await _resolve_statistics_tail(
        hass,
        entity_id,
        curtailment_entities,
        first_date=first_date,
        last_date=local_now.date() - timedelta(days=1),
        local_tz=local_tz,
    )
    hourly_actuals_by_date = _hourly_actuals_by_date(
        tail.statistics.energy_for(entity_id) if tail.statistics is not None else {}
    )

    slot_actuals_by_date: dict[str, dict[str, float]] = {}
    hourly_grain_dates: set[str] = set()
    for offset in range(days, 0, -1):
        target_date = local_now.date() - timedelta(days=offset)
        if target_date < tail.splice_date:
            hourly_grain_dates.add(str(target_date))
            slot_actuals_by_date[str(target_date)] = hourly_actuals_by_date.get(
                str(target_date), {}
            )
            continue
        slot_actuals_by_date[str(target_date)] = await _read_day_slot_actuals(
            hass,
            entity_id,
            target_date,
            local_now=local_now,
        )

    invalidated_slots_by_date = await _load_invalidated_slots_for_window(
        hass,
        cfg,
        slot_actuals_by_date,
        curtailment_entities=curtailment_entities,
        hourly_grain_dates=hourly_grain_dates,
        tail=tail,
    )
    return SolarActualsWindow(
        slot_actuals_by_date=slot_actuals_by_date,
        invalidated_slots_by_date=invalidated_slots_by_date,
        hourly_grain_dates=hourly_grain_dates,
    )


async def _resolve_statistics_tail(
    hass: HomeAssistant,
    entity_id: str,
    curtailment_entities: tuple[str, str] | None,
    *,
    first_date: date,
    last_date: date,
    local_tz: Any,
) -> _StatisticsTail:
    """Probe where the meter's raw states begin, and read everything before it.

    The splice lands on the local midnight *after* the oldest raw state's date,
    not on it: states begin part-way through their first day, and an hour whose
    opening reading predates them has no delta to be computed from. That day was
    compiled into statistics while its states still existed, so handing it to
    them whole closes a hole rather than opening one. Raw states win every day
    from there on -- they see every meter tick, and the recent window is where
    resets and glitches actually happen.

    The SoC and grid sensors ride along in the same read even though the meter's
    horizon decides the splice. Their own horizons cannot move it: the tail's
    grain is set by what the *actuals* are read at, and a curtailment rule with
    no row for an hour already leaves that hour alone.
    """
    if query_hourly_statistics is None or query_oldest_state_date is None:
        return _StatisticsTail(splice_date=first_date, statistics=None)

    oldest_state_date = await query_oldest_state_date(
        hass, entity_id, local_tz=local_tz
    )
    # No raw state at all: the whole window is tail. The statistics table may
    # still hold every day of it, and saying "no history" while it does is the
    # bug #173 is about.
    splice_date = (
        min(max(oldest_state_date + timedelta(days=1), first_date), last_date + timedelta(days=1))
        if oldest_state_date is not None
        else last_date + timedelta(days=1)
    )
    if splice_date <= first_date:
        return _StatisticsTail(splice_date=first_date, statistics=None)

    statistics = await query_hourly_statistics(
        hass,
        [entity_id, *(curtailment_entities or ())],
        local_start=datetime.combine(first_date, time.min, tzinfo=local_tz),
        local_end=datetime.combine(splice_date, time.min, tzinfo=local_tz),
    )
    return _StatisticsTail(splice_date=splice_date, statistics=statistics)


def _hourly_actuals_by_date(
    energy_kwh_by_utc_hour: dict[datetime, float],
) -> dict[str, dict[str, float]]:
    """Hourly meter energy as ``{day: {"HH:00": wh}}``, in the actuals' own unit.

    Keyed by the hour's UTC instant on the way in and by the local date and hour
    on the way out, which is where the two halves of a fall-back day's repeated
    01:00 meet: they are *summed* into the one key rather than one replacing the
    other, so the day keeps all of its energy. The forecast tail folds its
    repeated hour the same way, so the hour's ratio is unaffected.
    """
    days: dict[str, dict[str, float]] = {}
    for utc_hour, value_kwh in sorted(energy_kwh_by_utc_hour.items()):
        local_hour = dt_util.as_local(utc_hour)
        slots = days.setdefault(local_hour.date().isoformat(), {})
        slot_key = f"{local_hour.hour:02d}:00"
        slots[slot_key] = round(slots.get(slot_key, 0.0) + value_kwh * 1000.0, 4)
    return days


async def _read_day_slot_actuals(
    hass: HomeAssistant,
    entity_id: str,
    target_date: date,
    *,
    local_now: datetime,
) -> dict[str, float]:
    local_start = datetime.combine(target_date, time.min, tzinfo=local_now.tzinfo)
    local_end = local_start + timedelta(days=1)
    if target_date == local_now.date():
        local_end = min(
            local_end,
            get_local_current_slot_start(local_now, interval_minutes=15),
        )
    values_by_slot = await query_cumulative_slot_energy_changes(
        hass,
        entity_id,
        local_start=local_start,
        local_end=local_end,
        interval_minutes=15,
    )
    return {
        dt_util.as_local(slot_start).strftime("%H:%M"): round(value_kwh * 1000.0, 4)
        for slot_start, value_kwh in sorted(values_by_slot.items())
    }


def _read_entity_id(raw_value: Any) -> str | None:
    if isinstance(raw_value, str):
        entity_id = raw_value.strip()
        if entity_id:
            return entity_id
    return None


async def _load_invalidated_slots_for_window(
    hass: HomeAssistant,
    cfg: BiasConfig,
    slot_actuals_by_date: dict[str, dict[str, float]],
    *,
    curtailment_entities: tuple[str, str] | None,
    hourly_grain_dates: set[str],
    tail: _StatisticsTail,
) -> dict[str, set[str]]:
    # Both layers test actuals against the same archived forecast the trainer
    # is fitted to, so the window is gathered once and shared.
    forecast = await _load_recorded_forecast_window(
        hass,
        cfg,
        slot_actuals_by_date,
        curtailment_entities=curtailment_entities,
    )

    # A day is judged at hour grain when *either* side of the ratio is hourly.
    # The meter's raw states and the forecast sensor's are purged on their own
    # schedules, so the two horizons need not agree -- and testing an hour's
    # actual against a quarter of an hour's forecast compares two different
    # measurements, in the direction that invents underdelivery.
    hourly_days = {
        day
        for day in slot_actuals_by_date
        if day in hourly_grain_dates or day in forecast.hourly_grain_dates
    }
    forecast_slot_starts_by_date, slot_keys_by_date = _build_day_grid_slot_inputs(
        hass,
        slot_actuals_by_date,
        hourly_days=hourly_days,
    )
    if not forecast_slot_starts_by_date:
        return {}

    forecast_slot_wh_by_date = _forecast_at_day_grain(
        forecast.slots_by_date, hourly_days
    )

    curtailment = await _load_curtailment_invalidations(
        hass,
        cfg,
        curtailment_entities,
        slot_actuals_by_date,
        forecast_slot_wh_by_date,
        forecast_slot_starts_by_date,
        slot_keys_by_date,
        hourly_days=hourly_days,
        tail=tail,
    )
    data_glitch = _load_data_glitch_invalidations(
        hass,
        cfg,
        slot_actuals_by_date,
        forecast_slot_wh_by_date,
        hourly_days=hourly_days,
    )
    return _expand_hourly_invalidations(
        _union_invalidations(curtailment, data_glitch),
        hourly_days,
    )


def _forecast_at_day_grain(
    forecast_slot_wh_by_date: dict[str, dict[str, float]],
    hourly_days: set[str],
) -> dict[str, dict[str, float]]:
    """Re-key an hour-grain day's forecast onto the grid it is tested against.

    The forecast arrives per fifteen-minute slot whichever table it came from --
    a tail day's four slots each carrying a quarter of the hour. An hour-grain
    day is tested per hour, so the hour's four slots are summed back into one
    ``HH:00`` entry: the hour's whole forecast energy, against the hour's whole
    actual. Summing rather than picking a slot is what makes the two sides
    comparable, and it is exact whether the quarters were split evenly or
    measured.
    """
    at_grain: dict[str, dict[str, float]] = {}
    for day, slots in forecast_slot_wh_by_date.items():
        if day not in hourly_days:
            at_grain[day] = slots
            continue
        hours: dict[str, float] = {}
        for slot_key, value in slots.items():
            try:
                hour = int(slot_key.split(":", 1)[0])
            except (AttributeError, ValueError):
                continue
            hours[f"{hour:02d}:00"] = hours.get(f"{hour:02d}:00", 0.0) + value
        at_grain[day] = hours
    return at_grain


def _expand_hourly_invalidations(
    invalidated_slots_by_date: dict[str, set[str]],
    hourly_days: set[str],
) -> dict[str, set[str]]:
    """An invalidated hour invalidates the four slots it covers.

    The rules ran on the hour because that is the resolution the evidence has,
    and the trainer trains those four slots on that hour's one ratio -- so
    leaving three of them in would keep the very slots the evidence says are
    unusable, all carrying the ratio of the hour that was thrown out.
    """
    expanded: dict[str, set[str]] = {}
    for day, slots in invalidated_slots_by_date.items():
        if day not in hourly_days:
            expanded[day] = slots
            continue
        day_slots: set[str] = set()
        for slot_key in slots:
            try:
                hour = int(slot_key.split(":", 1)[0])
            except (AttributeError, ValueError):
                continue
            day_slots.update(f"{hour:02d}:{minute:02d}" for minute in (0, 15, 30, 45))
        expanded[day] = day_slots
    return expanded


def _union_invalidations(
    *layers: dict[str, set[str]],
) -> dict[str, set[str]]:
    merged: dict[str, set[str]] = {}
    for layer in layers:
        for day, slots in layer.items():
            if not slots:
                continue
            merged.setdefault(day, set()).update(slots)
    return merged


def _resolve_curtailment_entities(
    hass: HomeAssistant,
    cfg: BiasConfig,
) -> tuple[str, str] | None:
    """``(battery SoC entity, grid power entity)`` when curtailment can run.

    None when the SoC threshold is unset — the rule is off — or when either
    sensor is missing from the runtime config, which is worth a warning: the
    user asked for curtailment invalidation and is not getting it.
    """
    if cfg.slot_invalidation_max_battery_soc_percent is None:
        return None

    soc_entity_id = _read_battery_soc_entity_id_from_runtime_config(hass)
    if soc_entity_id is None:
        _LOGGER.warning(
            "Solar bias slot invalidation is configured, but power_devices.battery.entities.capacity is unavailable at runtime; skipping curtailment invalidation for this training window"
        )
        return None

    grid_power_entity_id = _read_grid_power_entity_id_from_runtime_config(hass)
    if grid_power_entity_id is None:
        _LOGGER.warning(
            "Solar bias slot invalidation is configured, but power_devices.grid.entities.power is unavailable at runtime; skipping curtailment invalidation for this training window"
        )
        return None

    return (soc_entity_id, grid_power_entity_id)


async def _load_recorded_forecast_window(
    hass: HomeAssistant,
    cfg: BiasConfig,
    slot_actuals_by_date: dict[str, dict[str, float]],
    *,
    curtailment_entities: tuple[str, str] | None,
) -> ForecastSlotWindow:
    """Per-slot forecast for each day in the window, at the slot's own horizon.

    Read only when a rule actually needs it: curtailment's underdelivery test
    and the data-glitch zero-with-neighbour rule. One recorder read spans the
    whole window rather than one per day.

    Spliced exactly as the trainer's own copy is, and for the same reason: the
    forecast sensor's raw states are purged too, so a tail day judged against
    them would have no forecast at all and every rule that needs one would
    quietly stop firing on the deepest part of the window. Which days came back
    at hour grain is carried through rather than re-derived -- it decides the
    grid each day is tested on.

    It is the same *data* the trainer is fitted from -- so a capped slot is
    judged against the number the fit used -- but a second query for it:
    ``load_trainer_samples`` runs its own, and the two are reached from
    different call sites of ``async_train``. Worth folding into one read if the
    training run's query count ever matters; it is two reads a day today.
    """
    needed = (
        curtailment_entities is not None
        or cfg.slot_invalidation_data_glitch_min_neighbour_forecast_wh > 0
    )
    if not needed:
        return ForecastSlotWindow(slots_by_date={})

    dates: list[date] = []
    for day in slot_actuals_by_date:
        try:
            dates.append(date.fromisoformat(day))
        except ValueError:
            continue
    if not dates:
        return ForecastSlotWindow(slots_by_date={})

    return await load_spliced_forecast_slots_for_window(
        hass, first_date=min(dates), last_date=max(dates)
    )


async def _load_curtailment_invalidations(
    hass: HomeAssistant,
    cfg: BiasConfig,
    curtailment_entities: tuple[str, str] | None,
    slot_actuals_by_date: dict[str, dict[str, float]],
    forecast_slot_wh_by_date: dict[str, dict[str, float]],
    forecast_slot_starts_by_date: dict[str, list[datetime]],
    slot_keys_by_date: dict[str, list[str]],
    *,
    hourly_days: set[str],
    tail: _StatisticsTail,
) -> dict[str, set[str]]:
    """Curtailment, on whichever evidence each day of the window still has.

    A day raw states still cover contributes one sample per state change, as
    before. A day past that horizon contributes one sample per hour, built from
    the hourly statistics row's own ``min``/``max`` -- which are the exact
    bounds of the sensor over exactly that hour, so the peak the rule wants is
    read rather than approximated. Both kinds go into one list: they never
    overlap in time, the splice being a date boundary.

    Hour grain is coarser in both directions -- an hour's peak SoC is at least
    any of its slots' (more hours pass rule 1) and its peak export is at least
    any slot's (fewer pass rule 2) -- and the net is fewer invalidations, which
    is the conservative direction: a curtailed slot left in dilutes one factor,
    where a false invalidation costs the day a slot in ``min_valid_slot_days``.
    """
    max_battery_soc_percent = cfg.slot_invalidation_max_battery_soc_percent
    if curtailment_entities is None or max_battery_soc_percent is None:
        return {}
    soc_entity_id, grid_power_entity_id = curtailment_entities

    if not forecast_slot_wh_by_date:
        _LOGGER.warning(
            "Solar bias slot invalidation is configured, but no archived per-slot forecast is available for the training window; curtailment invalidation cannot tell clipping from a cloudy slot and is skipped"
        )
        return {}

    # ``InvalidationInputs`` is documented as positive-is-export, and the test
    # downstream only ever looks at the positive side. A grid sensor configured
    # the other way round would therefore read every export as an import: the
    # curtailment filter inverts, invalidating exporting slots and keeping
    # genuinely curtailed ones. Normalise here rather than widening that
    # contract, which several call sites rely on.
    grid_power_inverted = _read_grid_power_inverted_from_runtime_config(hass)

    soc_samples_utc: list[StateSample] = []
    grid_power_samples_utc: list[StateSample] = []

    state_days = [
        day for day in forecast_slot_starts_by_date if day not in hourly_days
    ]
    if state_days:
        window_start_utc = min(
            slot_start
            for day in state_days
            for slot_start in forecast_slot_starts_by_date[day]
        )
        window_end_utc = max(_resolve_day_end_utc(hass, day) for day in state_days)
        soc_samples_utc += await _load_state_samples_for_entity(
            hass,
            soc_entity_id,
            window_start_utc,
            window_end_utc,
        )
        state_grid_samples = await _load_state_samples_for_entity(
            hass,
            grid_power_entity_id,
            window_start_utc,
            window_end_utc,
        )
        if grid_power_inverted:
            state_grid_samples = [
                StateSample(
                    timestamp=sample.timestamp,
                    value=None if sample.value is None else -sample.value,
                )
                for sample in state_grid_samples
            ]
        grid_power_samples_utc += state_grid_samples

    hour_starts_utc = [
        hour_start
        for day in forecast_slot_starts_by_date
        if day in hourly_days
        for hour_start in forecast_slot_starts_by_date[day]
    ]
    if hour_starts_utc and tail.statistics is not None:
        soc_samples_utc += _hourly_peak_samples(
            tail.statistics.rows_for(soc_entity_id),
            hour_starts_utc,
            peak=_row_max,
        )
        grid_power_samples_utc += _hourly_peak_samples(
            tail.statistics.rows_for(grid_power_entity_id),
            hour_starts_utc,
            # An inverted sensor calls an export negative, so the hour's biggest
            # export is the row's ``min`` negated -- reading ``max`` there turns
            # "never exported" into "exported all hour" and silently stops the
            # rule from ever firing again.
            peak=_negated_row_min if grid_power_inverted else _row_max,
        )

    return compute_invalidated_slots_for_window(
        InvalidationInputs(
            max_battery_soc_percent=max_battery_soc_percent,
            max_export_w=cfg.slot_invalidation_curtailment_max_export_w,
            max_actual_forecast_ratio=(
                cfg.slot_invalidation_curtailment_max_actual_forecast_ratio
            ),
            soc_samples_utc=soc_samples_utc,
            grid_power_samples_utc=grid_power_samples_utc,
            slot_actuals_by_date=slot_actuals_by_date,
            forecast_slot_wh_by_date=forecast_slot_wh_by_date,
            forecast_slot_starts_by_date=forecast_slot_starts_by_date,
            slot_keys_by_date=slot_keys_by_date,
        )
    )


def _row_max(row: dict[str, Any]) -> Any:
    return row.get("max")


def _negated_row_min(row: dict[str, Any]) -> Any:
    value = row.get("min")
    return None if value is None else -value


def _hourly_peak_samples(
    rows_by_utc_hour: dict[datetime, dict[str, Any]],
    hour_starts_utc: list[datetime],
    *,
    peak,
) -> list[StateSample]:
    """One sample per hour, carrying that hour's peak of the quantity.

    Every hour of every hour-grain day gets a sample, including the hours with
    no row: a ``None`` there is what stops the previous hour's peak being
    carried into it. Curtailment needs positive evidence per rule, and an hour
    the recorder compiled nothing for has none.
    """
    samples: list[StateSample] = []
    for hour_start in hour_starts_utc:
        row = rows_by_utc_hour.get(hour_start)
        raw_value = peak(row) if row is not None else None
        samples.append(
            StateSample(
                timestamp=hour_start,
                value=_parse_numeric_state_value(raw_value),
            )
        )
    return samples


def _load_data_glitch_invalidations(
    hass: HomeAssistant,
    cfg: BiasConfig,
    slot_actuals_by_date: dict[str, dict[str, float]],
    forecast_slot_wh_by_date: dict[str, dict[str, float]],
    *,
    hourly_days: set[str],
) -> dict[str, set[str]]:
    """The glitch rules, run once per grain because their cap is per slot.

    ``max_slot_wh`` is what a fifteen-minute slot cannot physically exceed, so
    an hour-grain day measured against it would report every sunny hour as a
    meter spike. The hour's ceiling is four of those, and that is the only
    difference between the two runs -- the rules themselves are unchanged, the
    backfill walk and the neighbour radius both being in minutes already.
    """
    max_slot_wh = _resolve_data_glitch_max_slot_wh(hass, cfg)
    min_neighbour_forecast_wh = (
        cfg.slot_invalidation_data_glitch_min_neighbour_forecast_wh
    )
    backfill_max_minutes = cfg.slot_invalidation_data_glitch_backfill_max_minutes

    if max_slot_wh is None and min_neighbour_forecast_wh <= 0:
        return {}

    def _run(days: dict[str, dict[str, float]], *, slot_cap: float | None):
        if not days:
            return {}
        return compute_data_glitch_invalidations(
            slot_actuals_by_date=days,
            # Rule (3) is the only one that reads the forecast, and a zero floor
            # turns it off; the shared window may still have been read for
            # curtailment.
            forecast_slot_wh_by_date=(
                {
                    day: slots
                    for day, slots in forecast_slot_wh_by_date.items()
                    if day in days
                }
                if min_neighbour_forecast_wh > 0
                else {}
            ),
            max_slot_wh=slot_cap,
            min_neighbour_forecast_wh=min_neighbour_forecast_wh,
            backfill_max_minutes=backfill_max_minutes,
        )

    return _union_invalidations(
        _run(
            {
                day: slots
                for day, slots in slot_actuals_by_date.items()
                if day not in hourly_days
            },
            slot_cap=max_slot_wh,
        ),
        _run(
            {
                day: slots
                for day, slots in slot_actuals_by_date.items()
                if day in hourly_days
            },
            slot_cap=None if max_slot_wh is None else max_slot_wh * 4.0,
        ),
    )


def _resolve_data_glitch_max_slot_wh(
    hass: HomeAssistant,
    cfg: BiasConfig,
) -> float | None:
    if cfg.slot_invalidation_data_glitch_max_slot_wh is not None:
        return cfg.slot_invalidation_data_glitch_max_slot_wh
    solar_max_power_w = _read_solar_max_power_from_runtime_config(hass)
    if solar_max_power_w is None or solar_max_power_w <= 0:
        return None
    # 15-minute slot at full inverter output, with 5% headroom.
    return solar_max_power_w * 0.25 * 1.05


def _read_solar_max_power_from_runtime_config(hass: HomeAssistant) -> float | None:
    runtime_config = getattr(
        hass.data.get(DOMAIN, {}).get("coordinator"),
        "config",
        None,
    )
    if not isinstance(runtime_config, dict):
        return None
    solar_config = runtime_config.get("power_devices", {}).get("solar", {})
    raw_value = solar_config.get("max_power")
    if isinstance(raw_value, bool) or raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return float(raw_value)
    if isinstance(raw_value, str):
        try:
            return float(raw_value.strip())
        except ValueError:
            return None
    return None


def _read_battery_soc_entity_id_from_runtime_config(hass: HomeAssistant) -> str | None:
    return _read_device_entity_id_from_runtime_config(hass, "battery", "capacity")


def _read_grid_power_entity_id_from_runtime_config(hass: HomeAssistant) -> str | None:
    """The signed grid power sensor.

    Its own convention is whatever ``power_polarity`` says; callers here
    normalise to positive-is-export via
    :func:`_read_grid_power_inverted_from_runtime_config`.
    """
    return _read_device_entity_id_from_runtime_config(hass, "grid", "power")


def _read_grid_power_inverted_from_runtime_config(hass: HomeAssistant) -> bool:
    """Whether the configured grid sensor reads positive-is-import."""
    runtime_config = getattr(
        hass.data.get(DOMAIN, {}).get("coordinator"),
        "config",
        None,
    )
    if not isinstance(runtime_config, dict):
        return False
    power_devices = runtime_config.get("power_devices")
    if not isinstance(power_devices, dict):
        return False
    return is_power_inverted(power_devices.get("grid"), "grid")


def _read_device_entity_id_from_runtime_config(
    hass: HomeAssistant,
    device: str,
    entity_key: str,
) -> str | None:
    runtime_config = getattr(
        hass.data.get(DOMAIN, {}).get("coordinator"),
        "config",
        None,
    )
    if not isinstance(runtime_config, dict):
        return None

    device_config = runtime_config.get("power_devices", {}).get(device, {})
    entities = device_config.get("entities", {})
    if not isinstance(entities, dict):
        return None
    return _read_entity_id(entities.get(entity_key))


def _build_day_grid_slot_inputs(
    hass: HomeAssistant,
    slot_actuals_by_date: dict[str, dict[str, float]],
    *,
    hourly_days: set[str],
) -> tuple[dict[str, list[datetime]], dict[str, list[str]]]:
    """Produce each day's own grid: 96 slots, or 24 hours past the splice.

    Curtailment is inferred from physical state (battery SoC and grid export)
    read over the whole day, so the grid is the day's own slots rather than
    whatever slots the historical forecast happens to publish. Past the raw
    states' horizon the finest that state can be read at is the hour, which is
    also the grain that day is trained at -- so the day is tested on its own
    twenty-four hours and an invalidated hour is expanded to its four slots
    afterwards.
    """
    local_tz = ZoneInfo(str(hass.config.time_zone))
    slot_starts_by_date: dict[str, list[datetime]] = {}
    slot_keys_by_date: dict[str, list[str]] = {}

    for day in sorted(slot_actuals_by_date):
        try:
            date.fromisoformat(day)
        except ValueError:
            continue

        minutes = (0,) if day in hourly_days else (0, 15, 30, 45)
        day_slot_starts: list[datetime] = []
        day_slot_keys: list[str] = []
        for hour in range(24):
            for minute in minutes:
                slot_key = f"{hour:02d}:{minute:02d}"
                slot_start = _build_utc_slot_start(day, slot_key, local_tz)
                if slot_start is None:
                    continue
                day_slot_starts.append(slot_start)
                day_slot_keys.append(slot_key)

        if day_slot_starts:
            slot_starts_by_date[day] = day_slot_starts
            slot_keys_by_date[day] = day_slot_keys

    return slot_starts_by_date, slot_keys_by_date


def _build_utc_slot_start(
    day: str,
    slot_key: str,
    local_tz: ZoneInfo,
) -> datetime | None:
    try:
        target_date = date.fromisoformat(day)
        hour_text, minute_text = slot_key.split(":", 1)
        local_slot_start = datetime.combine(
            target_date,
            time(int(hour_text), int(minute_text)),
            tzinfo=local_tz,
        )
    except (TypeError, ValueError):
        return None
    return dt_util.as_utc(local_slot_start)


def _resolve_day_end_utc(hass: HomeAssistant, day: str) -> datetime:
    local_tz = ZoneInfo(str(hass.config.time_zone))
    local_day_end = datetime.combine(
        date.fromisoformat(day) + timedelta(days=1),
        time.min,
        tzinfo=local_tz,
    )
    return dt_util.as_utc(local_day_end)


async def _load_state_samples_for_entity(
    hass: HomeAssistant,
    entity_id: str,
    utc_start: datetime,
    utc_end: datetime,
) -> list[StateSample]:
    if state_changes_during_period is None:
        return []

    recorder = get_instance(hass)
    if recorder is None:
        return []

    history = await recorder.async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            entity_id,
            False,
            False,
            None,
            True,
        )
    )
    states = history.get(entity_id) or history.get(entity_id.lower()) or []
    if not states:
        # A configured entity the recorder knows nothing about — typically one
        # that was renamed or deleted while the config kept pointing at it.
        # Without this the rule that reads it degrades to a silent no-op.
        _LOGGER.warning(
            "No recorder history for %s over the solar bias training window; the rules reading it cannot fire",
            entity_id,
        )

    samples: list[StateSample] = []
    for state in states:
        timestamp = getattr(state, "last_updated", None) or getattr(
            state,
            "last_changed",
            None,
        )
        if timestamp is None:
            continue
        samples.append(
            StateSample(
                timestamp=dt_util.as_utc(timestamp),
                value=_parse_numeric_state_value(getattr(state, "state", None)),
            )
        )
    return samples


def _parse_numeric_state_value(raw_value: Any) -> float | None:
    if isinstance(raw_value, bool) or raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return float(raw_value)
    if isinstance(raw_value, str):
        value_text = raw_value.strip()
        if not value_text:
            return None
        try:
            return float(value_text)
        except ValueError:
            return None
    return None


