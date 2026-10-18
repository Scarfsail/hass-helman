"""Solar inspector: inspector day, span aggregates and history floor."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any, Protocol
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..battery_state import read_battery_entity_config, read_battery_soc_bounds_config
from ..const import GRID_EXPORT_PRICE_ENTITY_ID, GRID_IMPORT_PRICE_ENTITY_ID
from ..controllables.config import read_carved_meters, read_schedulable_consumers
from ..grid_price_forecast_builder import (
    GridImportPriceConfigError,
    read_grid_import_price_config,
)
from ..slot_grid import (
    SLOT,
    SLOT_LABELS,
    SLOT_MINUTES,
)
from ..recorder_states import read_states
from ..slot_grid import (
    floor_to_slot as _current_slot_start,
)
from ..solar_bias_correction.actuals import (
    load_actuals_for_day,
    slot_actuals_from_batched_slot_energy,
)
from ..solar_bias_correction.adjuster import adjust
from ..solar_bias_correction.battery_forecast_history import (
    BATTERY_NET_FORECAST_CURRENT_ENTITY,
    BATTERY_SOC_FORECAST_CURRENT_ENTITY,
    GRID_EXPORT_FORECAST_CURRENT_ENTITY,
    GRID_IMPORT_FORECAST_CURRENT_ENTITY,
    GRID_NET_FORECAST_CURRENT_ENTITY,
    load_battery_forecast_points_for_day,
)
from ..solar_bias_correction.forecast_history import (
    forecast_points_from_slot_map,
    load_archived_forecast_points,
)
from ..solar_bias_correction.house_forecast_history import (
    HOUSE_FORECAST_CURRENT_ENTITY,
    load_house_forecast_points_for_day,
)
from ..solar_bias_correction.models import (
    BatterySocBoundsPoint,
    BiasConfig,
    SolarBiasHouseBreakdownPoint,
    SolarBiasInspectorAvailability,
    SolarBiasInspectorDay,
    SolarBiasInspectorPoint,
    SolarBiasInspectorSeries,
    SolarBiasInspectorTotals,
    SolarBiasMetadata,
    SolarBiasProfile,
    SolarBiasTrainingExplainability,
    inspector_day_to_payload,
    navigation_range_payload,
)
from ..solar_bias_correction.statistics_day import (
    HOUR_MINUTES,
    StatisticsDay,
    load_statistics_day,
)
from ..span_buckets import bucket_keys
from ..span_history_model import read_span_meters

if TYPE_CHECKING:
    from ..recorder_slot_energy import SlotEnergyBatch

from .day import (
    DayForecastAndActualSeries,
    DayMeters,
    DayPriceRails,
    DaySolar,
    _actual_points_for_date,
    _battery_soc_points_from_raw,
    _build_day_house_forecast,
    _build_house_actual_breakdown,
    _build_house_forecast_breakdown,
    _compose_inspector_series,
    _compose_inspector_totals,
    _consumer_own_energy,
    _consumer_slot_map,
    _copy_points,
    _drop_running_slot,
    _factor_points_for_profile,
    _fill_import_rail_from_config,
    _filter_battery_forecast_future,
    _filter_battery_soc_future,
    _filter_grid_forecast_future,
    _filter_points_to_local_date,
    _house_forecast_points_from_snapshot,
    _house_forecast_total_for_slot,
    _impact_points_for_day,
    _inspector_points,
    _inspector_points_from_raw,
    _live_price_rail,
    _merge_battery_forecast_future,
    _money_points,
    _money_totals,
    _normalize_consumers,
    _numeric_history_by_slot,
    _partition_actual_points,
    _points_before,
    _points_from,
    _price_points,
    _round_kwh,
    _round_wh,
    _slot_energy_points,
    _slot_points_before,
    _sum_point_values,
)
from .span import (
    _MAX_AGGREGATE_BUCKETS,
    _bucket_house_breakdown,
    _energy_by_bucket,
    _fold_span_aggregates_days,
    _house_forecast_by_bucket,
    _money_by_bucket,
    _resolve_span_bounds,
    _soc_bounds_by_bucket,
)

_LOGGER = logging.getLogger(__name__)

_HISTORY_FLOOR_TTL = timedelta(hours=6)
_HISTORY_FLOOR_RETRY = timedelta(minutes=5)
_NOT_SET = object()


class InspectorLiveSources(Protocol):
    async def canonical_solar_forecast(
        self, *, reference_time: datetime
    ) -> dict[str, Any] | None: ...

    async def battery_forecast(self) -> dict[str, Any] | None: ...

    def house_forecast_snapshot(self) -> dict[str, Any] | None: ...

    def house_forecast_composition(self) -> dict[str, Any] | None: ...

    async def house_device_consumers(self) -> list[dict[str, Any]]: ...

    def battery_soc_bounds(self) -> tuple[float, float] | None: ...

    def grid_price_snapshot(
        self, reference_time: datetime | None = None
    ) -> dict[str, Any]: ...


class SolarInspector:
    def __init__(
        self,
        hass: HomeAssistant,
        store: Any = None,
        cfg: BiasConfig | None = None,
        *,
        config: dict[str, Any] | None = None,
        live_sources: InspectorLiveSources | None = None,
        bias_service: Any = None,
    ) -> None:
        self._hass = hass
        self._config = config or {}
        self._live_sources = live_sources
        self._bias_service = bias_service
        self._store = store
        if self._bias_service is None and store is not None and cfg is not None:
            from ..solar_bias_correction.service import SolarBiasCorrectionService
            self._bias_service = SolarBiasCorrectionService(hass, store, cfg)

        self._explicit_profile: Any = _NOT_SET
        self._explicit_metadata: Any = _NOT_SET
        self._explicit_explainability: Any = _NOT_SET
        self._explicit_cfg: Any = cfg if cfg is not None else _NOT_SET
        self._explicit_is_stale: Any = _NOT_SET

        self._history_floor: date | None = None
        self._history_floor_probed_at: datetime | None = None
        self._history_floor_lifetime = _HISTORY_FLOOR_TTL
        self._history_floor_lock = asyncio.Lock()

    @property
    def _profile(self) -> SolarBiasProfile | None:
        if self._explicit_profile is not _NOT_SET:
            return self._explicit_profile
        if self._bias_service is not None:
            return getattr(self._bias_service, "_profile", None)
        return None

    @_profile.setter
    def _profile(self, value: SolarBiasProfile | None) -> None:
        self._explicit_profile = value

    @property
    def _metadata(self) -> SolarBiasMetadata:
        if self._explicit_metadata is not _NOT_SET:
            return self._explicit_metadata
        if self._bias_service is not None:
            return getattr(self._bias_service, "_metadata", self._build_default_metadata())
        return self._build_default_metadata()

    @_metadata.setter
    def _metadata(self, value: SolarBiasMetadata) -> None:
        self._explicit_metadata = value

    @property
    def _explainability(self) -> SolarBiasTrainingExplainability | None:
        if self._explicit_explainability is not _NOT_SET:
            return self._explicit_explainability
        if self._bias_service is not None:
            return getattr(self._bias_service, "_explainability", None)
        return None

    @_explainability.setter
    def _explainability(self, value: SolarBiasTrainingExplainability | None) -> None:
        self._explicit_explainability = value

    @property
    def _cfg(self) -> BiasConfig | None:
        if self._explicit_cfg is not _NOT_SET:
            return self._explicit_cfg
        if self._bias_service is not None:
            return getattr(self._bias_service, "_cfg", None)
        return None

    @_cfg.setter
    def _cfg(self, value: BiasConfig | None) -> None:
        self._explicit_cfg = value

    @property
    def _is_stale(self) -> bool:
        if self._explicit_is_stale is not _NOT_SET:
            return self._explicit_is_stale
        if self._bias_service is not None:
            return getattr(self._bias_service, "_is_stale", False)
        return False

    @_is_stale.setter
    def _is_stale(self, value: bool) -> None:
        self._explicit_is_stale = value

    def _build_default_metadata(self, last_outcome: str = "no_training_yet") -> SolarBiasMetadata:
        return SolarBiasMetadata(
            trained_at="",
            training_config_fingerprint="",
            usable_days=0,
            dropped_days=[],
            factor_min=None,
            factor_max=None,
            factor_median=None,
            omitted_slot_count=0,
            last_outcome=last_outcome,
            error_reason=None,
        )

    @property
    def _trained_at(self) -> str | None:
        if self._explicit_metadata is not _NOT_SET and self._explicit_metadata is not None:
            return getattr(self._explicit_metadata, "trained_at", None)
        if self._bias_service is not None and hasattr(self._bias_service, "_trained_at"):
            return self._bias_service._trained_at
        metadata = self._metadata
        return getattr(metadata, "trained_at", None) or None

    def _resolve_status(self) -> tuple[str, str, str | None]:
        if self._cfg is None or not getattr(self._cfg, "enabled", True):
            return ("disabled", "raw", "disabled")
        if getattr(self, "_is_stale", False):
            return (
                "config_changed_pending_retrain",
                "raw",
                "config_changed_pending_retrain",
            )
        metadata = self._metadata
        profile = self._profile
        last_outcome = getattr(metadata, "last_outcome", "no_training_yet") if metadata else "no_training_yet"
        if last_outcome == "profile_trained" and profile is not None:
            return ("applied", "adjusted", None)
        if last_outcome == "insufficient_history":
            return ("insufficient_history", "raw", "insufficient_history")
        if last_outcome == "training_failed":
            if profile is not None:
                return ("training_failed", "adjusted", None)
            return ("training_failed", "raw", "training_failed")
        return ("no_training_yet", "raw", "no_training_yet")

    def _should_preserve_profile(
        self,
        profile: SolarBiasProfile | None,
        metadata: SolarBiasMetadata,
    ) -> bool:
        if profile is None:
            return False
        if metadata.last_outcome not in ("profile_trained", "training_failed"):
            return False
        min_history_days = getattr(self._cfg, "min_history_days", 0) if self._cfg else 0
        return metadata.usable_days >= min_history_days

    def _has_usable_profile(self) -> bool:
        profile = self._profile
        metadata = self._metadata
        if profile is None:
            return False
        if metadata is not None and getattr(metadata, "last_outcome", None) == "profile_trained":
            return True
        return self._should_preserve_profile(profile, metadata) if metadata is not None else False

    async def _canonical_solar_forecast(self, reference_time: datetime) -> dict[str, Any] | None:
        if self._live_sources is not None and hasattr(self._live_sources, "canonical_solar_forecast"):
            res = self._live_sources.canonical_solar_forecast(reference_time=reference_time)
            if asyncio.iscoroutine(res):
                return await res
            return res
        return None

    _consumer_own_energy = staticmethod(_consumer_own_energy)
    _normalize_consumers = staticmethod(_normalize_consumers)
    _consumer_slot_map = staticmethod(_consumer_slot_map)

    async def _resolve_span_consumer_roster(
        self, house_breakdown: bool
    ) -> tuple[list[dict], list[str]]:
        breakdown_consumers: list[dict] = []
        if house_breakdown:
            try:
                breakdown_consumers = await self._house_breakdown_consumers()
            except Exception:
                _LOGGER.exception("Failed to resolve house consumers for span aggregates")
                breakdown_consumers = []
        consumer_entities = list(
            dict.fromkeys(
                entity
                for consumer in breakdown_consumers
                for entity in (
                    consumer["energy_entity_id"],
                    *consumer["metered_children"],
                )
            )
        )
        return breakdown_consumers, consumer_entities

    async def async_get_span_aggregates(
        self,
        raw_start_date: str,
        raw_end_date: str,
        bucket: str = "day",
        *,
        house_breakdown: bool = False,
        house_forecast: bool = False,
    ) -> dict[str, Any]:
        """Measured figures for a span of history, bucketed into local days or months.

        One statistics read for the whole span, however wide it is -- plus a
        short second one over the last few hours when the span reaches today,
        because the hourly table stops at the last compiled hour and the bucket
        in progress would otherwise be hours short. The inspector
        has two consumers for this: the day pills, which compare a week of days,
        and the aggregate views, which draw a month of days or a year of months.
        Asking ``async_get_inspector_day`` once per bucket would be a full
        inspector day -- actuals, forecast history and training -- for a handful
        of numbers apiece, and reading raw states across a year would be millions
        of rows for the same handful.

        So the meters, the battery SoC and both price sensors are read once, from
        Home Assistant's hourly long-term statistics, and folded here. Hourly is
        the finest grain statistics offer, and it is enough: energy sums, SoC
        bounds take min/max, and money is priced per hour rather than per bucket
        because a bucket's kWh times its mean rate is not what the meter cost --
        the expensive hours are rarely the ones the house imported in.

        ``bucket`` is ``"day"`` (one row per local day, what the pills ask for)
        or ``"month"`` (one row per local month, with the span snapped outward to
        whole months first). Both walk the same fold; only the key differs.

        ``house_forecast`` adds ``houseForecastWh`` to every row: what the house
        forecast predicted for the bucket, folded from the forecast sensor's
        hourly means. It joins the one read rather than adding a second, which
        is why the pills can carry it for a month of days.

        Note that the DST hazard :func:`_money_points` documents does *not* carry
        over. That one is about repeated ``"HH:MM"`` slot labels colliding on the
        fall-back day; here the hours arrive keyed by UTC instant, so the two
        occurrences of the repeated hour stay distinct, carry their own rates and
        both fold onto the same local date. Nothing to work around -- and nothing
        to re-implement the day view's workaround for.
        """
        local_tz = ZoneInfo(str(self._hass.config.time_zone))
        local_now = dt_util.as_local(dt_util.now())
        bucket, start_date, end_date, local_start, local_end, tail_start = (
            _resolve_span_bounds(
                raw_start_date, raw_end_date, bucket, local_tz, local_now
            )
        )
        # The range travels with every answer, empty ones included: it is what
        # the card navigates by, and a span with no rows is exactly when the
        # reader is about to press an arrow.
        span_min_date, span_max_date = await self._async_navigation_range(local_now)
        navigation_range = navigation_range_payload(
            span_min_date.isoformat(), span_max_date.isoformat()
        )
        if end_date < start_date:
            return {
                "bucket": bucket,
                "currency": None,
                "days": [],
                "range": navigation_range,
            }

        meters = read_span_meters(self._config)
        soc_entity = self._battery_soc_entity_id()
        breakdown_consumers, consumer_entities = (
            await self._resolve_span_consumer_roster(house_breakdown)
        )

        from ..span_history import read_span_history

        import_price_config = self._grid_import_price_config()
        # The meters, the SoC, the roster and both price rails in the one read
        # every span view shares, with the import rate already resolved per
        # hour -- recorded first, today's window table where nothing was
        # recorded. See :func:`_money_by_bucket` for why per hour.
        house_forecast_entity = HOUSE_FORECAST_CURRENT_ENTITY if house_forecast else None
        history = await read_span_history(
            self._hass,
            meter_ids=meters,
            extra_ids=[soc_entity, *consumer_entities, house_forecast_entity],
            local_start=local_start,
            local_end=local_end,
            tail_start=tail_start,
            import_price_windows=(
                None if import_price_config is None else import_price_config.windows
            ),
        )

        days = _fold_span_aggregates_days(
            history=history,
            meters=meters,
            soc_entity=soc_entity,
            house_forecast_entity=house_forecast_entity,
            breakdown_consumers=breakdown_consumers,
            start_date=start_date,
            end_date=end_date,
            bucket=bucket,
            local_tz=local_tz,
            house_forecast=house_forecast,
        )

        return {
            "bucket": bucket,
            "currency": await self._resolve_span_currency(import_price_config),
            "days": days,
            "range": navigation_range,
        }

    # --- What a span read needs, for callers outside this service -------------
    #
    # The device reports read the same span as the aggregate views, so they need
    # the same inputs. These are the public names for them; the private ones stay
    # this service's own.

    async def async_resolve_span_currency(self, import_price_config) -> str | None:
        """The money columns' unit. See :meth:`_resolve_span_currency`."""
        return await self._resolve_span_currency(import_price_config)

    async def async_history_floor(self, local_now: datetime) -> date:
        """The oldest date history may be browsed back to. See :meth:`_async_history_floor`."""
        return await self._async_history_floor(local_now)

    async def _resolve_span_currency(self, import_price_config) -> str | None:
        """The unit both money columns are in, resolved as the day view resolves it.

        Same order as the inspector day (the import windows first, then the live
        export channel, then Helman's own export rate), because a span showing a
        different currency than the day it is made of would be a bug no reader
        could explain.
        """
        if import_price_config is not None and import_price_config.unit:
            return import_price_config.unit
        export_channel = self._grid_price_snapshot().get("export")
        if isinstance(export_channel, dict):
            unit = export_channel.get("unit")
            if isinstance(unit, str) and unit:
                return unit
        return await self._grid_export_price_unit()

    async def _async_history_floor(self, local_now: datetime) -> date:
        """The oldest date the inspector may be browsed back to.

        The recorder's answer where it has one, and the bias trainer's window
        where it does not. The trainer's window is the floor this used to be --
        ``today - usable_days``, a count of usable *training samples* -- and it
        was wrong in the only way a bound can be: it hid data that exists. It
        stays as the fallback because a fresh install with no compiled statistics
        yet still has to be able to browse the days it has, and because taking
        the *minimum* of the two means this change can only ever widen the range,
        never narrow one somebody is already using.

        Cached, and deliberately not forever. A purge moves the true floor
        forward and a back-fill moves it back, so the answer is re-asked every
        :data:`_HISTORY_FLOOR_TTL`; between refreshes it is a field read, which
        is what lets both payloads ask on every request without either of them
        having to know it is a database read.

        The lock is not an optimisation. Both payloads are dispatched at once
        when a card mounts, and a probe that merely *deduplicated* the read would
        let the second caller past a stamp the first had not yet filled in --
        handing it the fallback while the first got the recorder's answer. The
        two payloads would then disagree about ``minDate`` on exactly the load
        this whole change exists to fix. Queueing behind the read instead means
        every caller sees the same answer.
        """
        fallback = self._trainer_window_floor(local_now)

        if self._history_floor_is_stale(local_now):
            async with self._history_floor_lock:
                # Re-checked under the lock: whoever queued behind the probe
                # wants its answer, not a second read of the same rows.
                if self._history_floor_is_stale(local_now):
                    await self._async_refresh_history_floor(local_now)

        probed = self._history_floor
        return fallback if probed is None else min(probed, fallback)

    def _trainer_window_floor(self, local_now: datetime) -> date:
        """The oldest day the bias trainer demonstrably read.

        ``usable_days`` counts training samples the last run actually built, so
        this date is evidence about a moment that has passed rather than a claim
        about now. That is enough for the one thing it is used for -- standing in
        as the aggregate floor when the recorder has no statistics to point at,
        on a fresh install that still has to be browsable.
        """
        return local_now.date() - timedelta(days=max(self._metadata.usable_days, 0))

    def _history_floor_is_stale(self, local_now: datetime) -> bool:
        cached_at = self._history_floor_probed_at
        if cached_at is None:
            return True
        return local_now - cached_at >= self._history_floor_lifetime

    async def _async_refresh_history_floor(self, local_now: datetime) -> None:
        """Ask the recorder again, and remember how the asking went.

        A probe that came back empty *is* an answer -- a fresh install with no
        compiled statistics -- and is trusted for the full TTL like any other. A
        probe that raised is not an answer, and is trusted only until
        :data:`_HISTORY_FLOOR_RETRY` has passed. Both halves matter: caching a
        failure for six hours would pin the shallow fallback over a moment's
        unavailability, and not caching it at all would put the probe's
        full-history scan in front of every inspector request for as long as the
        recorder stayed unwell.

        Note that a failure leaves ``_history_floor`` alone rather than clearing
        it. A floor already learned is still the best answer available, and a
        recorder that has stopped answering is no reason to narrow the range
        under a reader mid-session.
        """
        try:
            self._history_floor = await self._async_probe_history_floor()
        except Exception:
            _LOGGER.exception("Failed to probe the recorder for the history floor")
            self._history_floor_lifetime = _HISTORY_FLOOR_RETRY
        else:
            self._history_floor_lifetime = _HISTORY_FLOOR_TTL
        self._history_floor_probed_at = local_now

    async def _async_probe_history_floor(self) -> date | None:
        """Ask the recorder where the meters' statistics begin, or ``None``.

        ``None`` means the recorder answered and there is nothing yet. Failure
        is raised rather than folded into that answer, so the caller can tell the
        two apart and decline to cache one of them; it is
        :meth:`_async_refresh_history_floor` that keeps a failure from costing
        the reader anything more than the shallower range.

        The import is deferred, and it runs inside this coroutine, so the
        caller's ``except`` covers it: ``recorder_statistics_span`` reaches into
        the recorder integration, which need not be set up, and an import error
        is one more way the recorder cannot answer -- not a reason for the whole
        inspector request to fail.
        """
        from ..recorder_statistics_span import query_oldest_statistics_date

        return await query_oldest_statistics_date(
            self._hass,
            read_span_meters(self._config),
            local_tz=ZoneInfo(str(self._hass.config.time_zone)),
        )

    def _purge_horizon_days(self) -> int | None:
        """How many days of raw state the recorder is keeping, or ``None``.

        ``keep_days`` is the recorder's own ``purge_keep_days`` setting, and it
        is the same number ``Recorder._purge`` turns into
        ``utcnow() - timedelta(days=self.keep_days)``. Reading it means the day
        view's floor *is* the purge horizon rather than a guess about where the
        purge has got to.

        ``None`` for every way of there not being a horizon to speak of -- the
        recorder integration is not set up, ``get_instance`` raises, the
        attribute is missing or is not a usable count, or ``auto_purge`` is off
        and nothing is being trimmed at all. Every one of them is answered the
        same way by the caller: leave the day view on the aggregate floor, which
        is what it had before this method existed, and which errs towards
        offering a day rather than hiding one.

        ``auto_purge`` is the case worth spelling out, because ``keep_days``
        keeps its configured value while purging is disabled. Flooring on it
        then would hide raw states the recorder is deliberately still holding.
        The recorder's own schema pins ``keep_days`` at one day or more
        (``vol.Range(min=1)``), so anything below that is a value this code does
        not understand rather than a shorter horizon.
        """
        try:
            from homeassistant.components.recorder import get_instance

            recorder = get_instance(self._hass)
            if not getattr(recorder, "auto_purge", True):
                return None
            keep_days = recorder.keep_days
        except Exception:
            # Debug rather than silent: "the recorder is not set up" and "the
            # attribute this code reads has moved" produce the same answer here,
            # and only one of them is a state worth knowing about. Without a
            # trace, a rename upstream would quietly restore the deep floor and
            # the un-drawable days it was introduced to remove.
            _LOGGER.debug("No recorder purge horizon available", exc_info=True)
            return None
        if isinstance(keep_days, bool) or not isinstance(keep_days, int):
            return None
        return keep_days if keep_days >= 1 else None

    def _day_reads_statistics(
        self, target_date: date, local_now: datetime
    ) -> bool | None:
        """Which store this day's measured series come from.

        ``False`` for raw states at fifteen minutes, ``True`` for long-term
        statistics at sixty, ``None`` for "no horizon to decide by -- try raw and
        see". One answer for the whole day, deliberately: the purge cuts through
        exactly one day, and stitching that day's surviving quarter-hours onto
        the rest of its hours would buy finer resolution on one day out of the
        whole history in exchange for a chart carrying two bar widths and a
        totals path that has to avoid double-counting the boundary hour.

        The recorder purges everything older than ``utcnow() - keep_days``, so
        ``today - keep_days`` names the day being deleted *through* -- it has
        already lost its small hours and loses the rest at the next nightly
        purge. It therefore reads from statistics along with everything older,
        and ``today - keep_days + 1`` is the oldest day still whole in raw state.
        """
        keep_days = self._purge_horizon_days()
        if keep_days is None:
            return None
        return target_date <= local_now.date() - timedelta(days=keep_days)

    async def _load_statistics_day(
        self,
        target_date: date,
        local_tz: ZoneInfo,
        meter_entity_ids: list[str],
    ) -> StatisticsDay:
        """The day's measured series from long-term statistics, in one read.

        Every id the day needs in one call, for the reason the raw path batches
        its own: the recorder serves from a single DB executor thread, so a query
        per series is a serial round-trip per series however the awaits are
        arranged.

        Unconfigured meters remain absent from the shared config reader.
        """
        from ..solar_bias_correction.house_forecast_history import (
            HOUSE_FORECAST_CURRENT_ENTITY,
        )

        solar_entity = read_span_meters(self._config).solar
        return await load_statistics_day(
            self._hass,
            target_date,
            local_tz=local_tz,
            solar_entity_id=solar_entity,
            meter_entity_ids=meter_entity_ids,
            battery_soc_entity_id=self._battery_soc_entity_id(),
            house_forecast_entity_id=HOUSE_FORECAST_CURRENT_ENTITY,
            # The five battery-forecast entities are Helman's own, pinned by id
            # like the house forecast above rather than resolved from config.
            battery_soc_forecast_entity_id=BATTERY_SOC_FORECAST_CURRENT_ENTITY,
            battery_net_forecast_entity_id=BATTERY_NET_FORECAST_CURRENT_ENTITY,
            grid_net_forecast_entity_id=GRID_NET_FORECAST_CURRENT_ENTITY,
            grid_import_forecast_entity_id=GRID_IMPORT_FORECAST_CURRENT_ENTITY,
            grid_export_forecast_entity_id=GRID_EXPORT_FORECAST_CURRENT_ENTITY,
        )

    async def _async_navigation_range(self, local_now: datetime) -> tuple[date, date]:
        """The dates the inspector's navigation may move between, inclusive.

        One answer for every view, in both directions. Forward is one day per
        configured daily-energy entity, which is how far the forecast reaches.
        Backwards is the recorder's statistics floor -- and it is the day view's
        floor too, since :meth:`_day_reads_statistics` lets a day older than the
        purge horizon draw its measured series from those same statistics. The
        day view used to stop shallower, at the purge horizon, because its
        actuals could only come from raw states; a day the aggregate views can
        draw as a bar can now be opened, which is the whole point of there being
        one floor again.
        """
        daily_entities = (
            self._cfg.daily_energy_entity_ids if self._cfg is not None else []
        )
        max_date = local_now.date() + timedelta(
            days=max(len(daily_entities) - 1, 0)
        )
        return await self._async_history_floor(local_now), max_date

    async def _load_day_meters(
        self,
        target_date: date,
        local_now: datetime,
        timezone: ZoneInfo,
        need_past: bool,
    ) -> DayMeters:
        breakdown_consumers_for_day: list[dict] = []
        slot_energy_by_entity: dict[str, dict[datetime, float]] = {}
        statistics_day = StatisticsDay()
        actuals_by_slot: dict[str, float] = {}
        reads_statistics = False
        solar_meter_entity_id: str | None = None
        meter_entity_ids: list[str] = []

        if need_past:
            today = local_now.date()
            decided = self._day_reads_statistics(target_date, local_now)
            reads_statistics = decided is True
            # Only an elapsed day can be judged by an empty read: today reads
            # empty every night before dawn and has nothing compiled at all just
            # after midnight, so its emptiness says nothing about a purge.
            undecided = decided is None and target_date < today
            try:
                breakdown_consumers_for_day = await self._house_breakdown_consumers()
            except Exception:
                _LOGGER.exception(
                    "Failed to load house consumer breakdown for inspector"
                )
            solar_meter_entity_id = read_span_meters(self._config).solar
            meter_entity_ids = self._cumulative_meter_entity_ids(
                breakdown_consumers_for_day,
                solar_entity_id=solar_meter_entity_id,
            )
            if not reads_statistics:
                meters_answered = True
                try:
                    meter_batch = await self._load_slot_energy_kwh_for_entities(
                        meter_entity_ids,
                        target_date,
                        timezone,
                    )
                except Exception:
                    _LOGGER.exception("Failed to load slot energy meters for inspector")
                    slot_energy_by_entity = {}
                    meters_answered = False
                else:
                    slot_energy_by_entity = meter_batch.by_entity
                # The solar meter is *in* that batch, parsed and sampled by the
                # same helper the actuals reader used and against the same
                # liveness trace, so the day's actuals are a cutoff away from
                # deltas already in hand rather than a second read of the same
                # meter (#245).
                if meters_answered:
                    actuals_by_slot = slot_actuals_from_batched_slot_energy(
                        slot_energy_by_entity.get(solar_meter_entity_id)
                        if solar_meter_entity_id
                        else None,
                        target_date,
                        local_now=local_now,
                    )
                elif self._cfg is not None:
                    # The solar series used to be its own read, so a batch that
                    # failed cost the meter series and left the solar curve
                    # drawn. Keeping that: the batch is one query for nineteen
                    # meters, and letting all of them take the solar series down
                    # with them would blank the whole day -- the purge heuristic
                    # below cannot rescue it either, since it only trusts a read
                    # that answered. One extra query, on the failure path only.
                    try:
                        actuals_by_slot = await load_actuals_for_day(
                            self._hass,
                            self._cfg,
                            target_date,
                            local_now=local_now,
                        )
                    except Exception:
                        _LOGGER.exception(
                            "Failed to load solar actuals for inspector"
                        )
                # Nothing anywhere in raw state on an elapsed day, with no
                # horizon to have predicted it: the recorder has been trimmed
                # past this day even though it will not say so. Judged on the
                # whole raw read rather than on solar alone, because a setup with
                # no solar meter configured would otherwise send every elapsed
                # day it has to statistics -- and only on a read that *answered*,
                # because a recorder that raised has said nothing about what it
                # holds. Reading a momentary failure as a purge would tell the
                # user their detailed history is gone and lock the width toggle
                # to the hour on a day whose raw states are intact.
                if (
                    undecided
                    and meters_answered
                    and not actuals_by_slot
                    and not any(slot_energy_by_entity.values())
                ):
                    reads_statistics = True
            if reads_statistics:
                statistics_day = await self._load_statistics_day(
                    target_date, timezone, meter_entity_ids
                )
                slot_energy_by_entity = statistics_day.energy_kwh_by_entity
                actuals_by_slot = statistics_day.solar_actuals_by_slot

        return DayMeters(
            reads_statistics=reads_statistics,
            slot_energy_by_entity=slot_energy_by_entity,
            actuals_by_slot=actuals_by_slot,
            statistics_day=statistics_day,
            breakdown_consumers_for_day=breakdown_consumers_for_day,
            solar_meter_entity_id=solar_meter_entity_id,
            meter_entity_ids=meter_entity_ids,
        )

    async def _load_day_solar(
        self,
        target_date: date,
        local_now: datetime,
        timezone: ZoneInfo,
        need_past: bool,
        need_future: bool,
        next_slot: datetime | None,
        reads_statistics: bool,
        statistics_day: StatisticsDay,
        actuals_by_slot: dict[str, float],
        effective_variant: str,
    ) -> DaySolar:
        # --- Solar forecast ---
        # Spliced at the current slot exactly like the battery, house and price
        # series below. An elapsed slot comes from the archive, which holds what
        # the provider said before that slot ran; the source republishes the
        # whole day and revises slots after the fact, so taking today's elapsed
        # half from the live snapshot would draw each actual beside a forecast
        # issued after it -- and redraw the same bar differently once the day
        # became yesterday. Slots the clock has not reached have no history to
        # prefer, so they come from the snapshot the rest of the system is
        # acting on.
        raw_points: list[dict[str, Any]] = []
        corrected_points: list[dict[str, Any]] = []
        if need_past:
            # On a statistics day the elapsed half comes from the same one hourly
            # read as every other measured series -- ``solar_forecast_by_slot``,
            # already folded to this day and at hour grain -- rather than from
            # ``load_archived_forecast_points``, whose raw states are exactly what
            # is gone. The same ``reads_statistics`` fork the house forecast, SoC
            # and price rails take below, and the point shape is identical either
            # way so the current-slot splice cannot tell them apart.
            if reads_statistics:
                archived_source = forecast_points_from_slot_map(
                    statistics_day.solar_forecast_by_slot, target_date, timezone
                )
            else:
                archived_source = await self._guarded_points(
                    load_archived_forecast_points(self._hass, target_date, timezone),
                    "solar forecast history",
                )
            archived_points = _points_before(archived_source, cutoff=next_slot)
            raw_points += archived_points
            # Corrected the same way a past day is corrected -- by applying the
            # profile in force now, not the one that happened to be in force
            # when the slot ran. The snapshot's own correctedPoints cover the
            # future half only.
            if effective_variant == "adjusted" and self._profile is not None:
                corrected_points += adjust(archived_points, self._profile)
            else:
                corrected_points += _copy_points(archived_points)
        if need_future:
            canonical_snapshot = await self._canonical_solar_forecast(local_now)
            if not isinstance(canonical_snapshot, dict):
                canonical_snapshot = {}
            future_raw = _points_from(
                _filter_points_to_local_date(
                    canonical_snapshot.get("rawPoints")
                    or canonical_snapshot.get("points")
                    or [],
                    target_date,
                    timezone,
                ),
                start=next_slot,
            )
            raw_points += future_raw
            canonical_corrected = canonical_snapshot.get("correctedPoints") or []
            if effective_variant == "adjusted" and canonical_corrected:
                corrected_points += _points_from(
                    _filter_points_to_local_date(
                        canonical_corrected,
                        target_date,
                        timezone,
                    ),
                    start=next_slot,
                )
            else:
                corrected_points += _copy_points(future_raw)

        has_profile = self._has_usable_profile()

        factors = _factor_points_for_profile(self._profile if has_profile else None)
        actual_points = _actual_points_for_date(
            actuals_by_slot,
            target_date,
            timezone,
        )
        invalidated_points: list[SolarBiasInspectorPoint] = []
        invalidated_slots = set(
            self._metadata.invalidated_slots_by_date.get(target_date.isoformat(), [])
        )
        if target_date < local_now.date() and actual_points and invalidated_slots:
            actual_points, invalidated_points = _partition_actual_points(
                actual_points,
                invalidated_slots=invalidated_slots,
            )

        return DaySolar(
            raw_points=raw_points,
            corrected_points=corrected_points,
            actual_points=actual_points,
            invalidated_points=invalidated_points,
            factors=factors,
            has_profile=has_profile,
        )

    def _day_forecast_past_coros(
        self,
        target_date: date,
        timezone: ZoneInfo,
        price_history_end: datetime,
        next_slot: datetime | None,
        reads_statistics: bool,
        statistics_day: StatisticsDay,
        slot_energy_by_entity: dict[str, dict[datetime, float]],
        soc_entity_id: str | None,
        bounds_entity_ids: tuple[str | None, str | None],
        need_past: bool,
    ) -> list[Any]:
        if not need_past:
            return []
        numeric_entity_ids = [
            *([soc_entity_id] if soc_entity_id else []),
            *bounds_entity_ids,
        ]
        return [
            self._already(statistics_day.house_forecast_points)
            if reads_statistics
            else self._guarded_points(
                load_house_forecast_points_for_day(self._hass, target_date),
                "house forecast history",
            ),
            self._guarded_points(
                self._load_house_actual_for_date(target_date, slot_energy_by_entity),
                "house actual",
            ),
            self._load_numeric_history_by_slot_for_entities(
                numeric_entity_ids, target_date, timezone
            ),
            self._guarded_point_sets(
                self._load_grid_actual_for_date(target_date, slot_energy_by_entity),
                "grid actual",
                count=3,
            ),
            self._guarded_points(
                self._load_battery_actual_for_date(target_date, slot_energy_by_entity),
                "battery actual",
            ),
            self._guarded_point_sets(
                self._load_recorded_price_rails(
                    [
                        GRID_IMPORT_PRICE_ENTITY_ID,
                        GRID_EXPORT_PRICE_ENTITY_ID,
                    ],
                    target_date,
                    timezone,
                    local_end=price_history_end,
                ),
                "price history",
                count=2,
            ),
            self._recorded_battery_forecast_points(
                target_date,
                cutoff=next_slot,
                timezone=timezone,
                reads_statistics=reads_statistics,
                statistics_day=statistics_day,
            ),
        ]

    def _unpack_day_forecast_past(
        self,
        gathered: list[Any],
        target_date: date,
        need_past: bool,
        reads_statistics: bool,
        statistics_day: StatisticsDay,
        soc_entity_id: str | None,
        breakdown_consumers_for_day: list[dict],
        slot_energy_by_entity: dict[str, dict[datetime, float]],
    ) -> tuple[
        list[dict],
        list[dict],
        list[dict],
        list[dict],
        dict[str, dict[str, float]],
        tuple[list[dict], list[dict], list[dict]],
        list[dict],
        list[dict],
        list[dict],
        tuple[list[dict], list[dict], list[dict], list[dict], list[dict]],
        list[dict],
    ]:
        if not need_past:
            return ([], [], [], [], {}, ([], [], []), [], [], [], ([], [], [], [], []), [])
        (
            house_forecast_history_points,
            house_actual_points,
            numeric_history_by_entity,
            grid_actual_series,
            battery_actual_points,
            recorded_price_series,
            battery_forecast_series,
        ) = gathered[:7]
        battery_soc_actual_points = (
            statistics_day.battery_soc_points
            if reads_statistics
            else self._battery_soc_actual_points(
                soc_entity_id, numeric_history_by_entity
            )
        )
        recorded_import_price_points, recorded_export_price_points = (
            recorded_price_series
        )
        breakdown_consumers, consumer_slot_maps = (
            self._house_consumer_breakdown_for_date(
                target_date,
                breakdown_consumers_for_day,
                slot_energy_by_entity,
            )
        )
        house_actual_breakdown_points = _build_house_actual_breakdown(
            house_actual_points,
            breakdown_consumers,
            consumer_slot_maps,
        )
        return (
            house_forecast_history_points,
            house_actual_points,
            house_actual_breakdown_points,
            battery_soc_actual_points,
            numeric_history_by_entity,
            grid_actual_series,
            battery_actual_points,
            recorded_import_price_points,
            recorded_export_price_points,
            battery_forecast_series,
            breakdown_consumers,
        )

    async def _load_day_forecast_and_actual_series(
        self,
        target_date: date,
        local_now: datetime,
        timezone: ZoneInfo,
        need_past: bool,
        need_future: bool,
        next_slot: datetime | None,
        current_slot_start: datetime | None,
        reads_statistics: bool,
        statistics_day: StatisticsDay,
        slot_energy_by_entity: dict[str, dict[datetime, float]],
        breakdown_consumers_for_day: list[dict],
    ) -> DayForecastAndActualSeries:
        price_history_end = next_slot or (
            datetime.combine(target_date, time(0, 0), tzinfo=timezone)
            + timedelta(days=1)
        )
        wants_raw_soc = need_past and not reads_statistics
        soc_entity_id = self._battery_soc_entity_id() if wants_raw_soc else None
        bounds_entity_ids = self._battery_soc_bounds_entity_ids()

        past_coros = self._day_forecast_past_coros(
            target_date=target_date,
            timezone=timezone,
            price_history_end=price_history_end,
            next_slot=next_slot,
            reads_statistics=reads_statistics,
            statistics_day=statistics_day,
            slot_energy_by_entity=slot_energy_by_entity,
            soc_entity_id=soc_entity_id,
            bounds_entity_ids=bounds_entity_ids,
            need_past=need_past,
        )
        future_coros = (
            [self._get_battery_forecast_snapshot()] if need_future else []
        )
        gathered = await asyncio.gather(*past_coros, *future_coros)

        (
            house_forecast_history_points,
            house_actual_points,
            house_actual_breakdown_points,
            battery_soc_actual_points,
            numeric_history_by_entity,
            grid_actual_series,
            battery_actual_points,
            recorded_import_price_points,
            recorded_export_price_points,
            battery_forecast_series,
            breakdown_consumers,
        ) = self._unpack_day_forecast_past(
            gathered,
            target_date,
            need_past,
            reads_statistics,
            statistics_day,
            soc_entity_id,
            breakdown_consumers_for_day,
            slot_energy_by_entity,
        )
        battery_snapshot = gathered[-1] if need_future else None

        house_forecast_points, house_forecast_breakdown_points = _build_day_house_forecast(
            self._get_house_forecast_composition() if need_future else None,
            self._house_scheduled_consumers() if need_future else [],
            target_date,
            current_slot_start=current_slot_start,
            next_slot=next_slot,
            breakdown_consumers=breakdown_consumers,
            house_forecast_history_points=house_forecast_history_points,
            snapshot=self._get_house_forecast_snapshot() if need_future else None,
            need_past=need_past,
            need_future=need_future,
        )

        if need_future:
            battery_forecast_series = _merge_battery_forecast_future(
                battery_forecast_series,
                battery_snapshot,
                target_date=target_date,
                local_now=local_now,
                timezone=timezone,
            )
        (
            battery_soc_forecast_points,
            grid_forecast_points,
            battery_forecast_points,
            grid_import_forecast_points,
            grid_export_forecast_points,
        ) = battery_forecast_series

        return DayForecastAndActualSeries(
            house_forecast_points=house_forecast_points,
            house_actual_points=house_actual_points,
            house_actual_breakdown_points=house_actual_breakdown_points,
            house_forecast_breakdown_points=house_forecast_breakdown_points,
            battery_soc_forecast_points=battery_soc_forecast_points,
            battery_soc_actual_points=battery_soc_actual_points,
            grid_forecast_points=grid_forecast_points,
            grid_actual_series=grid_actual_series,
            battery_forecast_points=battery_forecast_points,
            battery_actual_points=battery_actual_points,
            grid_import_forecast_points=grid_import_forecast_points,
            grid_export_forecast_points=grid_export_forecast_points,
            recorded_import_price_points=recorded_import_price_points,
            recorded_export_price_points=recorded_export_price_points,
            numeric_history_by_entity=numeric_history_by_entity,
            bounds_entity_ids=bounds_entity_ids,
        )

    async def _load_day_price_rails(
        self,
        target_date: date,
        timezone: ZoneInfo,
        need_future: bool,
        running_slot: str | None,
        recorded_import_price_points: list[dict],
        recorded_export_price_points: list[dict],
        grid_actual_series: tuple[list[dict], list[dict], list[dict]],
        grid_import_forecast_points: list[dict],
        grid_export_forecast_points: list[dict],
    ) -> DayPriceRails:
        import_price_by_slot: dict[str, float] = {
            point["slot"]: point["value"] for point in recorded_import_price_points
        }
        export_price_by_slot: dict[str, float] = {
            point["slot"]: point["value"] for point in recorded_export_price_points
        }
        price_snapshot = self._grid_price_snapshot() if need_future else {}
        for slot, value in _live_price_rail(
            price_snapshot.get("import"), target_date, timezone
        ).items():
            import_price_by_slot.setdefault(slot, value)
        for slot, value in _live_price_rail(
            price_snapshot.get("export"), target_date, timezone
        ).items():
            if running_slot is not None and slot < running_slot:
                continue
            export_price_by_slot[slot] = value

        import_price_config = self._grid_import_price_config()
        price_unit: str | None = None
        if import_price_config is not None:
            price_unit = import_price_config.unit
            _fill_import_rail_from_config(
                import_price_by_slot, import_price_config.windows
            )
        if price_unit is None:
            export_channel = price_snapshot.get("export")
            if isinstance(export_channel, dict):
                unit = export_channel.get("unit")
                price_unit = unit if isinstance(unit, str) and unit else None
        if price_unit is None:
            price_unit = await self._grid_export_price_unit()

        grid_actual_points, grid_import_actual_points, grid_export_actual_points = (
            grid_actual_series
        )
        money_actual_points = _money_points(
            grid_import_actual_points,
            grid_export_actual_points,
            import_price_by_slot,
            export_price_by_slot,
        )
        money_forecast_points = _money_points(
            grid_import_forecast_points,
            grid_export_forecast_points,
            import_price_by_slot,
            export_price_by_slot,
        )

        return DayPriceRails(
            import_price_by_slot=import_price_by_slot,
            export_price_by_slot=export_price_by_slot,
            price_unit=price_unit,
            money_actual_points=money_actual_points,
            money_forecast_points=money_forecast_points,
        )

    def _compose_inspector_day(
        self,
        *,
        target_date: date,
        local_now: datetime,
        min_date: date,
        max_date: date,
        status: str,
        effective_variant: str,
        meters: DayMeters,
        solar: DaySolar,
        series: DayForecastAndActualSeries,
        price_rails: DayPriceRails,
        running_slot: str | None,
    ) -> dict[str, Any]:
        drawn_actual_points = _drop_running_slot(solar.actual_points, running_slot=running_slot)
        drawn_invalidated_points = _drop_running_slot(
            solar.invalidated_points, running_slot=running_slot
        )
        drawn_house_actual_points = _drop_running_slot(
            series.house_actual_points, running_slot=running_slot
        )
        drawn_house_actual_breakdown_points = _drop_running_slot(
            series.house_actual_breakdown_points, running_slot=running_slot
        )
        drawn_battery_soc_actual_points = _drop_running_slot(
            series.battery_soc_actual_points, running_slot=running_slot
        )
        grid_actual_points, _, _ = series.grid_actual_series
        drawn_grid_actual_points = _drop_running_slot(
            grid_actual_points, running_slot=running_slot
        )
        drawn_battery_actual_points = _drop_running_slot(
            series.battery_actual_points, running_slot=running_slot
        )
        drawn_money_actual_points = _drop_running_slot(
            price_rails.money_actual_points, running_slot=running_slot
        )

        today = local_now.date()
        composed_series = _compose_inspector_series(
            solar=solar,
            series=series,
            price_rails=price_rails,
            drawn_actual_points=drawn_actual_points,
            drawn_invalidated_points=drawn_invalidated_points,
            drawn_house_actual_points=drawn_house_actual_points,
            drawn_house_actual_breakdown_points=drawn_house_actual_breakdown_points,
            drawn_battery_soc_actual_points=drawn_battery_soc_actual_points,
            drawn_grid_actual_points=drawn_grid_actual_points,
            drawn_battery_actual_points=drawn_battery_actual_points,
            drawn_money_actual_points=drawn_money_actual_points,
        )
        composed_totals = _compose_inspector_totals(
            solar=solar,
            series=series,
            price_rails=price_rails,
            actuals_by_slot=meters.actuals_by_slot,
            grid_actual_points=grid_actual_points,
        )
        day = SolarBiasInspectorDay(
            date=target_date.isoformat(),
            timezone=str(self._hass.config.time_zone),
            status=status,
            effective_variant=effective_variant,
            trained_at=self._trained_at,
            min_date=min_date.isoformat(),
            max_date=max_date.isoformat(),
            series=composed_series,
            totals=composed_totals,
            availability=SolarBiasInspectorAvailability(
                has_profile=solar.has_profile,
            ),
            is_today=target_date == today,
            is_future=target_date > today,
            training_explainability=self._explainability if solar.has_profile else None,
            battery_soc_bounds=self._battery_soc_bounds_for_date(
                series.bounds_entity_ids, series.numeric_history_by_entity
            ),
            price_unit=price_rails.price_unit,
            data_granularity_minutes=HOUR_MINUTES if meters.reads_statistics else SLOT_MINUTES,
        )
        return inspector_day_to_payload(day)

    async def async_get_inspector_day(self, raw_date: str) -> dict[str, Any]:
        target_date = date.fromisoformat(raw_date)
        local_now = dt_util.as_local(dt_util.now())
        today = local_now.date()
        min_date, max_date = await self._async_navigation_range(local_now)

        status, effective_variant, _fallback_reason = self._resolve_status()
        timezone = ZoneInfo(str(self._hass.config.time_zone))

        need_past = target_date <= today
        need_future = target_date >= today

        current_slot_start = _current_slot_start(local_now) if target_date == today else None
        next_slot = (
            None if current_slot_start is None else current_slot_start + SLOT
        )
        running_slot = (
            None if current_slot_start is None else current_slot_start.strftime("%H:%M")
        )

        meters = await self._load_day_meters(
            target_date, local_now, timezone, need_past
        )
        solar = await self._load_day_solar(
            target_date,
            local_now,
            timezone,
            need_past,
            need_future,
            next_slot,
            meters.reads_statistics,
            meters.statistics_day,
            meters.actuals_by_slot,
            effective_variant,
        )
        series = await self._load_day_forecast_and_actual_series(
            target_date,
            local_now,
            timezone,
            need_past,
            need_future,
            next_slot,
            current_slot_start,
            meters.reads_statistics,
            meters.statistics_day,
            meters.slot_energy_by_entity,
            meters.breakdown_consumers_for_day,
        )
        price_rails = await self._load_day_price_rails(
            target_date,
            timezone,
            need_future,
            running_slot,
            series.recorded_import_price_points,
            series.recorded_export_price_points,
            series.grid_actual_series,
            series.grid_import_forecast_points,
            series.grid_export_forecast_points,
        )

        return self._compose_inspector_day(
            target_date=target_date,
            local_now=local_now,
            min_date=min_date,
            max_date=max_date,
            status=status,
            effective_variant=effective_variant,
            meters=meters,
            solar=solar,
            series=series,
            price_rails=price_rails,
            running_slot=running_slot,
        )

    def _live_battery_soc_bounds(self) -> tuple[float | None, float | None]:
        if self._live_sources is None or not hasattr(self._live_sources, "battery_soc_bounds"):
            return (None, None)
        try:
            return self._live_sources.battery_soc_bounds() or (None, None)
        except Exception:
            _LOGGER.exception("Battery SoC bounds failed")
            return (None, None)

    def _battery_soc_bounds_entity_ids(self) -> tuple[str | None, str | None]:
        bounds = read_battery_soc_bounds_config(self._config)
        if bounds is None:
            return (None, None)
        return (bounds.min_soc_entity_id, bounds.max_soc_entity_id)

    def _battery_soc_bounds_for_date(
        self,
        bounds_entity_ids: tuple[str | None, str | None],
        numeric_history_by_entity: dict[str, dict[str, float]],
    ) -> list[BatterySocBoundsPoint]:
        """The SoC window per slot: recorded where the day has elapsed.

        Slots the clock has not reached — and elapsed slots the recorder has no
        reading for — fall back to the bounds set right now, which is the only
        window the battery forecast beyond them was ever built against. That
        fallback is also what a failed read leaves behind, which is why the two
        bound sensors joining the SoC sensor's one batched read (#245) cannot
        turn a recorder problem into a drawn zero.
        """
        min_entity_id, max_entity_id = bounds_entity_ids
        min_by_slot = (
            numeric_history_by_entity.get(min_entity_id) or {} if min_entity_id else {}
        )
        max_by_slot = (
            numeric_history_by_entity.get(max_entity_id) or {} if max_entity_id else {}
        )

        live_min, live_max = self._live_battery_soc_bounds()
        points: list[BatterySocBoundsPoint] = []
        for slot in SLOT_LABELS:
            min_pct = min_by_slot.get(slot, live_min)
            max_pct = max_by_slot.get(slot, live_max)
            if min_pct is None and max_pct is None:
                continue
            points.append(
                BatterySocBoundsPoint(slot=slot, min_pct=min_pct, max_pct=max_pct)
            )
        return points

    def _get_house_forecast_snapshot(self) -> dict | None:
        if self._live_sources is None or not hasattr(self._live_sources, "house_forecast_snapshot"):
            return None
        try:
            return self._live_sources.house_forecast_snapshot()
        except Exception:
            _LOGGER.exception("House forecast snapshot failed")
            return None

    def _get_house_forecast_composition(self) -> dict | None:
        """What the adjusted house forecast is made of, or None when unknown.

        A plain read of the pipeline the request has already built — never a
        rebuild, so opening an old day cannot trigger a forecast run.
        """
        if self._live_sources is None or not hasattr(self._live_sources, "house_forecast_composition"):
            return None
        try:
            return self._live_sources.house_forecast_composition()
        except Exception:
            _LOGGER.exception("House forecast composition failed")
            return None

    async def _get_battery_forecast_snapshot(self) -> dict | None:
        if self._live_sources is None or not hasattr(self._live_sources, "battery_forecast"):
            return None
        try:
            res = self._live_sources.battery_forecast()
            if asyncio.iscoroutine(res):
                return await res
            return res
        except Exception:
            _LOGGER.exception("Battery forecast failed")
            return None

    async def _recorded_battery_forecast_points(
        self,
        target_date: date,
        *,
        cutoff: datetime | None,
        timezone: ZoneInfo,
        reads_statistics: bool,
        statistics_day: StatisticsDay,
    ) -> tuple[list[dict], list[dict], list[dict], list[dict], list[dict]]:
        """The recorded SoC, grid and battery forecast curves for a day.

        Returns ``(soc, grid net, battery net, grid import, grid export)`` for
        slots starting before ``cutoff``, or the whole day when ``cutoff`` is
        None — the shapes the retired store's reader produced, unchanged.

        On a day the recorder still holds raw states for, the five come from the
        published entities' history, held forward across the slots they cover
        exactly as the house forecast's own reader does. On a day older than
        ``purge_keep_days`` they come from :meth:`_load_statistics_day` instead,
        like every other measured series on that path — already trimmed to the
        day, and at hour grain. A series is empty when the entity had no state
        (or no statistics row) for the day: the two grid sides and the battery
        net began publishing after the SoC and net-grid pair, so a deep past day
        can carry the older series without the newer.
        """
        if reads_statistics:
            return (
                statistics_day.battery_soc_forecast_points,
                statistics_day.grid_net_forecast_points,
                statistics_day.battery_net_forecast_points,
                statistics_day.grid_import_forecast_points,
                statistics_day.grid_export_forecast_points,
            )
        try:
            soc, grid_net, battery_net, grid_import, grid_export = (
                await load_battery_forecast_points_for_day(
                    self._hass, target_date, timezone
                )
            )
        except Exception:
            _LOGGER.exception("Failed to read battery forecast history for inspector")
            return ([], [], [], [], [])
        return (
            _slot_points_before(soc, cutoff=cutoff, target_date=target_date),
            _points_before(grid_net, cutoff=cutoff),
            _points_before(battery_net, cutoff=cutoff),
            _points_before(grid_import, cutoff=cutoff),
            _points_before(grid_export, cutoff=cutoff),
        )

    @staticmethod
    async def _already(value):
        """A value that is already in hand, in coroutine shape.

        The day's gather mixes loaders with series a statistics read has already
        produced. Wrapping the latter keeps the gather one list of six in one
        order, so the unpacking below it stays a single tuple assignment rather
        than growing a second shape for the statistics path to be unpacked by.
        There is no error boundary because there is nothing left to fail:
        :meth:`_load_statistics_day` has already degraded to empty series.
        """
        return value

    async def _guarded_points(self, coro, description: str) -> list[dict]:
        """Await a series loader, degrading to an empty series if it fails.

        One failing series must not take down the whole inspector day, and the
        loaders run concurrently, so each needs its own error boundary.
        """
        try:
            return await coro
        except Exception:
            _LOGGER.exception("Failed to load %s for inspector", description)
            return []

    async def _guarded_point_sets(
        self, coro, description: str, *, count: int
    ) -> tuple[list[dict], ...]:
        """The same boundary for a loader that returns several series at once.

        A loader returning a tuple cannot share :meth:`_guarded_points`: its
        empty-list failure value would be unpacked by the caller and raise,
        turning one dead meter into a dead inspector day — the exact opposite of
        what the boundary is for. The degraded value has to have the loader's
        own shape.
        """
        try:
            return await coro
        except Exception:
            _LOGGER.exception("Failed to load %s for inspector", description)
            return tuple([] for _ in range(count))

    async def _load_slot_energy_kwh_for_entities(
        self, entity_ids: Sequence[str], target_date: date, local_tz: ZoneInfo
    ) -> SlotEnergyBatch:
        """Per-15-min energy deltas of several cumulative meters, in one recorder read.

        ``by_entity`` is keyed by entity id, each value keyed by UTC slot start,
        and ``liveness_instants`` is the read's record of when the recorder was
        writing, which is how a meter that is simply quiet is told apart from a
        recorder that was down (see ``_is_carry_stale``). Daily-resetting
        meters are fine here: the query unwraps total_increasing resets, and a
        single local day never spans the midnight reset boundary.

        Every cumulative-meter series the inspector draws comes through here, and
        it is deliberately a single call: the recorder serves its queries from one
        DB executor thread, so a read per meter is a serial round-trip per meter no
        matter how the awaits are arranged.
        """
        from ..recorder_slot_energy import (
            query_cumulative_slot_energy_changes_for_entities,
        )

        local_start = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
        return await query_cumulative_slot_energy_changes_for_entities(
            self._hass,
            list(entity_ids),
            local_start=local_start,
            local_end=local_start + timedelta(days=1),
            interval_minutes=SLOT_MINUTES,
        )

    def _cumulative_meter_entity_ids(
        self, consumers: list[dict], *, solar_entity_id: str | None
    ) -> list[str]:
        """Every cumulative meter the inspector's actual series read for a day.

        The house meter, both grid sides, both battery sides, the solar meter
        and one per house consumer — the entity ids the single batched read has
        to cover. Missing providers and unconfigured meters drop out; the batch
        de-duplicates.

        The solar meter is in the roster twice over: its publishes are part of
        the evidence that the recorder was up (issue #208), and its own actual
        series is the batch's solar column rather than a read of its own
        (#245). ``solar_entity_id`` is passed in when the caller has already
        resolved it, so one inspector day resolves it once.

        """

        meters = read_span_meters(self._config)
        candidates = [
            solar_entity_id,
            meters.house,
            meters.grid_import,
            meters.grid_export,
            meters.battery_charge,
            meters.battery_discharge,
            *(consumer["energy_entity_id"] for consumer in consumers),
            *(
                child
                for consumer in consumers
                for child in consumer["metered_children"]
            ),
        ]
        return [entity_id for entity_id in candidates if entity_id]

    async def _load_house_actual_for_date(
        self,
        target_date: date,
        slot_energy_by_entity: dict[str, dict[datetime, float]],
    ) -> list[dict]:
        """Load per-15-min house energy actuals for target_date."""
        entity_id = read_span_meters(self._config).house
        if not entity_id:
            return []
        by_slot = slot_energy_by_entity.get(entity_id) or {}
        return _slot_energy_points(
            {slot: kwh * 1000.0 for slot, kwh in by_slot.items()},
            target_date,
        )

    @staticmethod
    def _consumer_own_energy(
        consumer: dict,
        energy_by_entity: dict[str, dict[datetime, float]],
        *,
        slot: timedelta,
    ) -> dict[datetime, float]:
        """A consumer's own energy per slot: its meter minus its metered children.

        The forecast and the house trainer subtract a carved meter's own energy,
        so the breakdown does too — otherwise a sub-meter that is a row of its
        own would be taken out of the house twice.
        """
        # Imported here: the recorder module needs Home Assistant's recorder,
        # which this module's import-time tests stub out.
        from ..shared_meter_fit import own_energy_changes

        return own_energy_changes(
            energy_by_entity.get(consumer["energy_entity_id"]) or {},
            [
                energy_by_entity.get(child) or {}
                for child in consumer["metered_children"]
            ],
            slot=slot,
        )

    @staticmethod
    def _normalize_consumers(raw_consumers: Any, *, deferrable: bool) -> list[dict]:
        """Coerce a provider's list to
        ``[{energy_entity_id, label, switch_entity_id, power_entity_id, deferrable, ids,
        metered_children}]``.

        Drops anything without a usable entity id and defaults a missing label to
        the entity id, so callers get a clean, deduplicable list. The switch and
        power sensor are optional — only the device tree knows them.

        ``deferrable`` is the caller's answer for the whole list: a provider is one
        roster, so which roster an entry came from is the only thing that decides it.

        ``ids`` are the controllable ids the roster carries for the meter — the
        keys the forecast's scheduled demand is reported under, several for a
        meter shared by several devices, and empty for a device the tree alone
        knows about. ``metered_children`` are the sub-meters behind a carved
        meter, empty for everything else.
        """
        result: list[dict] = []
        for consumer in raw_consumers or []:
            if not isinstance(consumer, dict):
                continue
            entity_id = consumer.get("energy_entity_id")
            if not isinstance(entity_id, str) or not entity_id.strip():
                continue
            eid = entity_id.strip()
            switch = consumer.get("switch_entity_id")
            power = consumer.get("power_entity_id")
            raw_ids = consumer.get("ids")
            raw_children = consumer.get("metered_children")
            result.append(
                {
                    "energy_entity_id": eid,
                    "label": consumer.get("label", eid),
                    "switch_entity_id": switch if isinstance(switch, str) and switch else None,
                    "power_entity_id": power if isinstance(power, str) and power else None,
                    "deferrable": deferrable,
                    "ids": [
                        controllable_id
                        for controllable_id in (
                            raw_ids if isinstance(raw_ids, list) else ()
                        )
                        if isinstance(controllable_id, str) and controllable_id
                    ],
                    "metered_children": [
                        child
                        for child in (
                            raw_children if isinstance(raw_children, list) else ()
                        )
                        if isinstance(child, str) and child
                    ],
                }
            )
        return result

    def _house_deferrable_consumers(self) -> list[dict]:
        return self._normalize_consumers(read_carved_meters(self._config), deferrable=True)

    def _house_scheduled_consumers(self) -> list[dict]:
        return read_schedulable_consumers(self._config)

    async def _house_device_consumers(self) -> list[dict]:
        """Individually-measured house devices from the shared device tree."""
        if self._live_sources is None or not hasattr(self._live_sources, "house_device_consumers"):
            return []
        try:
            raw = self._live_sources.house_device_consumers()
            if asyncio.iscoroutine(raw):
                raw = await raw
            raw = raw or []
        except Exception:
            _LOGGER.exception("House device consumers failed")
            return []
        return self._normalize_consumers(raw, deferrable=False)

    async def _house_breakdown_consumers(self) -> list[dict]:
        """The full set the house actual is split by: deferrable appliances first,
        then any other individually-measured device not already among them.

        Deferrable consumers lead because they are the forecast-facing appliances;
        device-tree consumers fill in the rest of the metered house. De-duped by
        entity id so an appliance that is both a scheduled consumer and a tree node
        appears once, and the remainder stays true rather than double-subtracting
        it. A deferrable consumer that IS also a tree node keeps its own label but
        adopts the tree's switch and power sensor, which is the only place either
        is known — otherwise the appliances most likely to have them would lose
        them to the dedup. It also keeps its ``deferrable`` flag: being metered by
        the tree as well does not make a shiftable appliance unshiftable.

        The one label it gives up is a bare entity id. The roster falls back to
        the meter's id when no single device's name fits — a meter shared by
        several controllables, or one that declares no name — and the tree's
        display name for the same sensor is the better name wherever it has one.
        """
        deferrable = self._house_deferrable_consumers()
        device = await self._house_device_consumers()
        switch_by_entity = {
            consumer["energy_entity_id"]: consumer["switch_entity_id"]
            for consumer in device
            if consumer["switch_entity_id"]
        }
        power_by_entity = {
            consumer["energy_entity_id"]: consumer["power_entity_id"]
            for consumer in device
            if consumer["power_entity_id"]
        }
        label_by_entity = {
            consumer["energy_entity_id"]: consumer["label"] for consumer in device
        }
        merged: list[dict] = []
        for consumer in deferrable:
            merged.append(
                {
                    **consumer,
                    "label": (
                        label_by_entity.get(consumer["energy_entity_id"])
                        if consumer["label"] == consumer["energy_entity_id"]
                        else None
                    )
                    or consumer["label"],
                    "switch_entity_id": (
                        consumer["switch_entity_id"]
                        or switch_by_entity.get(consumer["energy_entity_id"])
                    ),
                    "power_entity_id": (
                        consumer["power_entity_id"]
                        or power_by_entity.get(consumer["energy_entity_id"])
                    ),
                }
            )
        seen = {consumer["energy_entity_id"] for consumer in merged}
        for consumer in device:
            if consumer["energy_entity_id"] in seen:
                continue
            seen.add(consumer["energy_entity_id"])
            merged.append(consumer)
        return merged

    @staticmethod
    def _consumer_slot_map(
        by_slot_utc: dict[datetime, float], target_date: date
    ) -> dict[str, float]:
        """One consumer's per-slot energy (Wh) for the day, keyed by local "HH:MM"."""
        by_slot: dict[str, float] = {}
        for slot_start_utc, kwh in by_slot_utc.items():
            slot_local = dt_util.as_local(slot_start_utc)
            if slot_local.date() != target_date:
                continue
            slot = f"{slot_local.hour:02d}:{slot_local.minute:02d}"
            by_slot[slot] = kwh * 1000.0
        return by_slot

    def _house_consumer_breakdown_for_date(
        self,
        target_date: date,
        consumers: list[dict],
        slot_energy_by_entity: dict[str, dict[datetime, float]],
    ) -> tuple[list[dict], list[dict]]:
        """The consumer list and its per-slot energy maps, aligned by index.

        Returns ``(consumers, slot_maps)`` from a single source so the compose step
        never re-reads the list and can zip them safely. The meters were read with
        the rest of the day's cumulative meters in one recorder query, so this is
        pure shaping. Any failure degrades to no breakdown.
        """
        try:
            if not consumers:
                return [], []
            slot_maps = [
                self._consumer_slot_map(
                    self._consumer_own_energy(
                        consumer, slot_energy_by_entity, slot=SLOT
                    ),
                    target_date,
                )
                for consumer in consumers
            ]
            return consumers, slot_maps
        except Exception:
            _LOGGER.exception("Failed to load house consumer breakdown for inspector")
            return [], []

    async def _load_grid_actual_for_date(
        self,
        target_date: date,
        slot_energy_by_entity: dict[str, dict[datetime, float]],
    ) -> tuple[list[dict], list[dict], list[dict]]:
        """Load per-15-min grid energy for target_date, as (net, imported, exported).

        Net is positive when exporting and negative when importing, matching the
        sign of the grid forecast and of gridNetKwh elsewhere in the project.
        The two sides are each a positive magnitude of their own direction.

        The meters are read separately and always have been; what changed is
        that both sides now survive the call. Netting them here discards the
        one thing money needs — a slot can import at one rate and export at
        another, and no rate applied to the net reproduces what was charged.

        Only one of the two meters needs to be configured; the missing side
        contributes zero, the same way a snapshot slot without one of the grid
        fields does.
        """

        meters = read_span_meters(self._config)
        import_entity = meters.grid_import
        export_entity = meters.grid_export
        if not import_entity and not export_entity:
            return [], [], []

        imported = slot_energy_by_entity.get(import_entity) or {} if import_entity else {}
        exported = slot_energy_by_entity.get(export_entity) or {} if export_entity else {}
        slots = imported.keys() | exported.keys()
        net_wh_by_slot = {
            slot: (exported.get(slot, 0.0) - imported.get(slot, 0.0)) * 1000.0
            for slot in slots
        }
        import_wh_by_slot = {slot: imported.get(slot, 0.0) * 1000.0 for slot in slots}
        export_wh_by_slot = {slot: exported.get(slot, 0.0) * 1000.0 for slot in slots}
        return (
            _slot_energy_points(net_wh_by_slot, target_date),
            _slot_energy_points(import_wh_by_slot, target_date),
            _slot_energy_points(export_wh_by_slot, target_date),
        )

    async def _load_recorded_price_rails(
        self,
        entity_ids: Sequence[str | None],
        target_date: date,
        local_tz: ZoneInfo,
        *,
        local_end: datetime,
    ) -> tuple[list[dict], ...]:
        """The day's two rails, resolved from the best tier each slot has.

        The shaping half of :func:`~..recorder_statistics_span.query_price_history`:
        that reader decides where each slot's rate comes from — raw states where
        the recorder still holds them, the containing hour's statistical mean
        where it does not — and this labels the result by local slot. Slots no
        tier covered are simply absent; the caller decides whether it has
        anything better to put there.

        Both rails share this window, so they share the reader's reads: the
        recorder serves its queries from one DB executor thread, and a read per
        rail is a serial round-trip per rail no matter how the awaits are
        arranged. Returns one series per requested entity id, in order; an
        unconfigured entity yields an empty series.
        """
        from ..recorder_statistics_span import query_price_history

        requested = list(entity_ids)
        if not any(requested):
            return tuple([] for _ in requested)

        local_start = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
        by_entity = await query_price_history(
            self._hass,
            [entity_id for entity_id in requested if entity_id],
            local_start=local_start,
            local_end=local_end,
        )
        return tuple(
            [
                {
                    "slot": dt_util.as_local(slot).strftime("%H:%M"),
                    "value": float(value),
                }
                for slot, value in sorted(
                    (
                        by_entity[entity_id].by_slot
                        if entity_id in by_entity
                        else {}
                    ).items()
                )
            ]
            if entity_id
            else []
            for entity_id in requested
        )

    async def _grid_export_price_unit(self) -> str | None:
        """Helman's own export rate unit, for days with no live snapshot.

        The sensor states it while it is publishing; its statistics metadata
        states it when the sensor is not, which is what an elapsed day opened
        after a restart needs. The configured sell-price entity is not asked:
        it is an ingestion source, and its unit reaches here through the sensor
        that mirrors it.
        """
        from ..recorder_statistics_span import query_statistics_unit

        states = getattr(self._hass, "states", None)
        state = states.get(GRID_EXPORT_PRICE_ENTITY_ID) if states is not None else None
        unit = state.attributes.get("unit_of_measurement") if state is not None else None
        if isinstance(unit, str) and unit:
            return unit
        return await query_statistics_unit(self._hass, GRID_EXPORT_PRICE_ENTITY_ID)

    def _grid_import_price_config(self):
        """The validated import-price window table, or None when unconfigured.

        Invalid config is treated as absent rather than raised: the inspector
        renders whatever it can, and the config editor is where a broken window
        table gets reported.
        """
        try:
            return read_grid_import_price_config(self._config)
        except GridImportPriceConfigError:
            _LOGGER.exception("Failed to read the grid import price config")
            return None

    def _grid_price_snapshot(self) -> dict[str, Any]:
        """The live price feed, whose points start at the slot in progress."""
        if self._live_sources is None or not hasattr(self._live_sources, "grid_price_snapshot"):
            return {}
        try:
            snapshot = self._live_sources.grid_price_snapshot()
        except Exception:
            _LOGGER.exception("Failed to read the live grid price snapshot")
            return {}
        return snapshot if isinstance(snapshot, dict) else {}

    async def _load_battery_actual_for_date(
        self,
        target_date: date,
        slot_energy_by_entity: dict[str, dict[datetime, float]],
    ) -> list[dict]:
        """Load per-15-min net battery energy for target_date.

        Positive is charged into the battery, negative is discharged out of it,
        matching the sign of the archived batteryNetWh.

        These are the inverter's own charge/discharge meters rather than a
        difference of the stored-energy level, so round-trip losses stay on the
        side of the battery that actually paid them.

        Only one of the two meters needs to be configured; the missing side
        contributes zero, the same way the grid meters behave.
        """

        meters = read_span_meters(self._config)
        charge_entity = meters.battery_charge
        discharge_entity = meters.battery_discharge
        if not charge_entity and not discharge_entity:
            return []

        charged = slot_energy_by_entity.get(charge_entity) or {} if charge_entity else {}
        discharged = (
            slot_energy_by_entity.get(discharge_entity) or {} if discharge_entity else {}
        )
        net_wh_by_slot = {
            slot: (charged.get(slot, 0.0) - discharged.get(slot, 0.0)) * 1000.0
            for slot in charged.keys() | discharged.keys()
        }
        return _slot_energy_points(net_wh_by_slot, target_date)

    def _battery_soc_entity_id(self) -> str | None:
        battery = read_battery_entity_config(self._config)
        return battery.capacity_entity_id if battery is not None else None

    @staticmethod
    def _battery_soc_actual_points(
        soc_entity_id: str | None,
        numeric_history_by_entity: dict[str, dict[str, float]],
    ) -> list[dict]:
        """Per-15-min battery SoC history, shaped out of the numeric batch."""
        if not soc_entity_id:
            return []
        by_slot = numeric_history_by_entity.get(soc_entity_id) or {}
        return [{"slot": slot, "pct": pct} for slot, pct in by_slot.items()]

    async def _load_numeric_history_by_slot_for_entities(
        self,
        entity_ids: Sequence[str | None],
        target_date: date,
        local_tz: ZoneInfo,
    ) -> dict[str, dict[str, float]]:
        """Sample several numeric entities' history onto the day's 15-minute slots.

        The battery SoC sensor and the two SoC-bound sensors share a day, a grid
        and a sampling rule, and used to cost a recorder round-trip each. The
        recorder answers from one DB executor thread, so those were three serial
        trips however they were awaited; ``read_states`` takes a list
        of entity ids, which makes them one (#245). Each entity's timeline is
        still parsed and sampled on its own, so nothing about the per-series
        semantics changes -- only how often the recorder is asked.

        Returned keyed by entity id; an entity the recorder has nothing for maps
        to ``{}``, and so does every entity when the read fails, which leaves
        each series to its own missing-data fallback rather than to zeros.
        """
        entity_ids = [entity_id for entity_id in dict.fromkeys(entity_ids) if entity_id]
        if not entity_ids:
            return {}
        local_start = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
        local_end = local_start + timedelta(days=1)
        try:
            states_by_entity = await read_states(
                self._hass,
                list(entity_ids),
                local_start,
                local_end,
                include_start_state=True,
                no_attributes=True,
            )
        except Exception:
            # Named, because one read now carries the SoC sensor and both bound
            # sensors: without the ids the log no longer says which series went
            # missing, and all three go at once.
            _LOGGER.exception(
                "Failed to load numeric history for inspector: %s",
                ", ".join(entity_ids),
            )
            return {}
        return {
            entity_id: _numeric_history_by_slot(
                (states_by_entity or {}).get(entity_id) or [],
                target_date,
                local_start=local_start,
                local_tz=local_tz,
            )
            for entity_id in entity_ids
        }

