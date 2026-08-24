from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterator, Sequence
from functools import partial
from copy import deepcopy
from dataclasses import asdict
from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any, Literal
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..const import GRID_EXPORT_PRICE_ENTITY_ID, GRID_IMPORT_PRICE_ENTITY_ID
from .actuals import load_actuals_for_day, load_actuals_window
from .adjuster import adjust
from .forecast_history import load_forecast_points_for_day, load_trainer_samples
from .house_forecast_history import load_house_forecast_points_for_day
from .models import (
    BatterySocBoundsPoint,
    BatterySocPoint,
    BiasConfig,
    SolarBiasAdjustmentResult,
    SolarBiasApplianceComponent,
    SolarBiasContributionRow,
    SolarBiasExplainability,
    SolarBiasFactorPoint,
    SolarBiasHouseBreakdownPoint,
    SolarBiasImpactPoint,
    SolarBiasInspectorAvailability,
    SolarBiasInspectorDay,
    SolarBiasInspectorPoint,
    SolarBiasInspectorSeries,
    SolarBiasInspectorTotals,
    SolarBiasMetadata,
    SolarBiasMoneyPoint,
    SolarBiasMoneyTotals,
    SolarBiasPricePoint,
    SolarBiasProfile,
    SolarBiasSlotExplainability,
    SolarBiasTrainingExplainability,
    inspector_day_to_payload,
    navigation_range_payload,
    training_explainability_to_payload,
)
from .trainer import compute_fingerprint, train

if TYPE_CHECKING:
    from ..storage import SolarBiasCorrectionStore

_LOGGER = logging.getLogger(__name__)

#: How many buckets one span read may return, per bucket size.
#:
#: The cap is expressed in buckets because that is what a caller asks for, but
#: it is chosen for the *days* behind them: the read is hourly whatever the
#: bucket, so a month view over ~400 days is still ~9600 hours per statistic id
#: however few rows come back. A year of days and thirteen months are both about
#: the same span, which is the point -- the ceiling on the query is the same
#: either way, and it admits the year view the aggregate views are for.
_MAX_AGGREGATE_BUCKETS = {"day": 366, "month": 13}
#: How long the recorder's answer about where history begins is trusted for.
#:
#: The floor moves for two reasons and neither is urgent: a purge trims the far
#: end, a back-fill extends it. Six hours is short enough that neither goes
#: unnoticed for a session and long enough that the probe is invisible next to
#: the reads the views themselves issue.
_HISTORY_FLOOR_TTL = timedelta(hours=6)

#: How long a *failed* probe is left alone before it is tried again.
#:
#: Not the full TTL, because a failure is not an answer and pinning the shallow
#: fallback for six hours over a moment's unavailability is the wrong trade. Not
#: zero either, which is what "retry immediately" amounts to: the probe scans
#: every hourly row the meters own, so a recorder failing *after* that scan --
#: a lock, a timeout, executor pressure -- would have every inspector request
#: re-run it, on the one executor thread the day view's own reads queue behind.
#: Five minutes bounds that to something the reader will not notice and the
#: recorder can carry.
_HISTORY_FLOOR_RETRY = timedelta(minutes=5)

#: The price rails' own grid, matching the schedule's canonical slot.
PRICE_RAIL_SLOT_MINUTES = 15
MINUTES_PER_DAY = 24 * 60


class TrainingInProgressError(RuntimeError):
    pass


class BiasNotConfiguredError(RuntimeError):
    pass


class SolarBiasCorrectionService:
    def __init__(
        self,
        hass: HomeAssistant,
        store: SolarBiasCorrectionStore,
        cfg: BiasConfig,
        *,
        canonical_solar_forecast_provider=None,
        battery_forecast_provider=None,
        battery_forecast_history=None,
        house_forecast_snapshot_provider=None,
        house_forecast_composition_provider=None,
        house_energy_entity_id_provider=None,
        house_deferrable_consumers_provider=None,
        house_scheduled_consumers_provider=None,
        house_device_consumers_provider=None,
        house_unmeasured_label_provider=None,
        battery_soc_entity_id_provider=None,
        battery_soc_bounds_provider=None,
        battery_soc_bounds_entity_id_provider=None,
        grid_import_energy_entity_id_provider=None,
        grid_export_energy_entity_id_provider=None,
        battery_charge_energy_entity_id_provider=None,
        battery_discharge_energy_entity_id_provider=None,
        grid_export_price_entity_id_provider=None,
        grid_import_price_config_provider=None,
        grid_price_snapshot_provider=None,
    ) -> None:
        self._hass = hass
        self._store = store
        self._cfg = cfg
        self._canonical_solar_forecast_provider = canonical_solar_forecast_provider
        self._battery_forecast_provider = battery_forecast_provider
        self._battery_forecast_history = battery_forecast_history
        self._house_forecast_snapshot_provider = house_forecast_snapshot_provider
        self._house_forecast_composition_provider = house_forecast_composition_provider
        self._house_energy_entity_id_provider = house_energy_entity_id_provider
        self._house_deferrable_consumers_provider = house_deferrable_consumers_provider
        self._house_scheduled_consumers_provider = house_scheduled_consumers_provider
        self._house_device_consumers_provider = house_device_consumers_provider
        self._house_unmeasured_label_provider = house_unmeasured_label_provider
        self._battery_soc_entity_id_provider = battery_soc_entity_id_provider
        self._battery_soc_bounds_provider = battery_soc_bounds_provider
        self._battery_soc_bounds_entity_id_provider = (
            battery_soc_bounds_entity_id_provider
        )
        self._grid_import_energy_entity_id_provider = grid_import_energy_entity_id_provider
        self._grid_export_energy_entity_id_provider = grid_export_energy_entity_id_provider
        self._battery_charge_energy_entity_id_provider = (
            battery_charge_energy_entity_id_provider
        )
        self._battery_discharge_energy_entity_id_provider = (
            battery_discharge_energy_entity_id_provider
        )
        self._grid_export_price_entity_id_provider = grid_export_price_entity_id_provider
        self._grid_import_price_config_provider = grid_import_price_config_provider
        self._grid_price_snapshot_provider = grid_price_snapshot_provider
        self._profile: SolarBiasProfile | None = None
        self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
        self._explainability: SolarBiasTrainingExplainability | None = None
        self._is_stale = False
        self._training_lock = asyncio.Lock()
        self._training_in_progress = False
        self._last_emitted_status: tuple[str, str] | None = None
        #: The recorder's last answer about where the meters' history begins, and
        #: when it was asked. ``None`` for "asked, and there is nothing" -- which
        #: is why the timestamp is what decides whether to re-ask, not the value.
        self._history_floor: date | None = None
        self._history_floor_probed_at: datetime | None = None
        #: How long the last attempt's outcome is trusted for -- the full TTL
        #: after an answer, a short retry window after a failure.
        self._history_floor_lifetime = _HISTORY_FLOOR_TTL
        #: Held across the probe so concurrent callers await one read rather than
        #: racing it. A card mounting into an aggregate view dispatches the day
        #: and span commands together, and both ask for the floor.
        self._history_floor_lock = asyncio.Lock()

    async def async_setup(self) -> None:
        stored = self._store.profile
        current_fingerprint = self._current_fingerprint
        if not isinstance(stored, dict):
            self._profile = None
            self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
            self._explainability = None
            self._is_stale = False
            return

        raw_profile = stored.get("profile")
        if raw_profile is None:
            profile = None
        else:
            profile = _profile_from_dict(raw_profile)
            if profile is None:
                self._profile = None
                self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
                self._explainability = None
                self._is_stale = False
                return

        metadata = _metadata_from_dict(stored.get("metadata"))
        if metadata is None:
            self._profile = None
            self._metadata = self._build_default_metadata(last_outcome="no_training_yet")
            self._explainability = None
            self._is_stale = False
            return

        self._profile = profile
        self._metadata = metadata
        self._explainability = _training_explainability_from_dict(
            stored.get("trainingExplainability", stored.get("training_explainability"))
        )
        self._is_stale = metadata.training_config_fingerprint != current_fingerprint

    def update_config(self, cfg: BiasConfig) -> None:
        self._cfg = cfg
        if self._metadata.last_outcome == "no_training_yet" and self._profile is None:
            self._is_stale = False
            return
        self._is_stale = (
            self._metadata.training_config_fingerprint != self._current_fingerprint
        )

    async def async_train(self) -> dict[str, Any]:
        if self._training_in_progress:
            raise TrainingInProgressError("Solar bias training already in progress")
        if not self._cfg.enabled:
            raise BiasNotConfiguredError("Solar bias correction is disabled")

        previous_profile = self._profile
        previous_metadata = self._metadata
        previous_explainability = self._explainability
        previous_is_stale = self._is_stale
        self._training_in_progress = True
        await self._training_lock.acquire()
        try:
            now = dt_util.now()
            samples = await load_trainer_samples(self._hass, self._cfg, now)
            actuals = await load_actuals_window(
                self._hass,
                self._cfg,
                days=self._cfg.max_training_window_days,
            )
            outcome = train(samples, actuals, self._cfg, now=now)
            payload = {
                "version": 2,
                "profile": asdict(outcome.profile),
                "metadata": asdict(outcome.metadata),
                "trainingExplainability": training_explainability_to_payload(outcome.explainability),
            }
            await self._store.async_save(payload)
            self._profile = outcome.profile
            self._metadata = outcome.metadata
            self._explainability = outcome.explainability
            self._is_stale = False
        except Exception as err:
            preserve_profile = self._should_preserve_profile(
                previous_profile,
                previous_metadata,
            )
            failure_metadata = self._build_failure_metadata(
                previous_metadata=previous_metadata,
                error_reason=str(err) or err.__class__.__name__,
                trained_at=(
                    previous_metadata.trained_at
                    if preserve_profile
                    else dt_util.now().isoformat()
                ),
                training_config_fingerprint=(
                    previous_metadata.training_config_fingerprint
                    if preserve_profile
                    else self._current_fingerprint
                ),
            )
            self._profile = previous_profile if preserve_profile else None
            self._metadata = failure_metadata
            self._explainability = previous_explainability if preserve_profile else None
            self._is_stale = previous_is_stale
            await self._store.async_save(self._serialize_state())
        finally:
            self._training_lock.release()
            self._training_in_progress = False

        payload = self.get_status_payload()
        self._hass.bus.async_fire("helman_solar_bias_trained", payload)
        return payload

    def build_adjustment_result(
        self,
        raw_points: list[dict[str, Any]],
        now,
    ) -> SolarBiasAdjustmentResult:
        del now
        status, effective_variant, fallback_reason = self._resolve_status()
        adjusted_points = _copy_points(raw_points)
        if effective_variant == "adjusted" and self._profile is not None:
            adjusted_points = adjust(raw_points, self._profile)

        explainability = SolarBiasExplainability(
            fallback_reason=fallback_reason,
            trained_at=self._trained_at,
            usable_days=self._metadata.usable_days,
            dropped_days=len(self._metadata.dropped_days),
            omitted_slot_count=self._metadata.omitted_slot_count,
            factor_min=self._metadata.factor_min,
            factor_max=self._metadata.factor_max,
            factor_median=self._metadata.factor_median,
            error=self._metadata.error_reason,
        )
        self._emit_status_changed_if_needed(status, effective_variant)
        return SolarBiasAdjustmentResult(
            status=status,
            effective_variant=effective_variant,
            adjusted_points=adjusted_points,
            explainability=explainability,
        )

    def get_status_payload(self) -> dict[str, Any]:
        status, effective_variant, fallback_reason = self._resolve_status()
        return {
            "enabled": self._cfg.enabled,
            "minHistoryDays": self._cfg.min_history_days,
            "slotInvalidationEnabled": self._is_slot_invalidation_enabled(),
            "status": status,
            "effectiveVariant": effective_variant,
            "trainedAt": self._trained_at,
            "nextScheduledTrainingAt": self._next_scheduled_training_at(),
            "trainingConfigFingerprint": self._current_fingerprint,
            "isStale": self._is_stale,
            "lastOutcome": self._metadata.last_outcome,
            "fallbackReason": fallback_reason,
            "usableDays": self._metadata.usable_days,
            "droppedDays": deepcopy(self._metadata.dropped_days),
            "omittedSlotCount": self._metadata.omitted_slot_count,
            "invalidatedSlotCount": self._metadata.invalidated_slot_count,
            "factorSummary": {
                "min": self._metadata.factor_min,
                "max": self._metadata.factor_max,
                "median": self._metadata.factor_median,
            },
            "errorReason": self._metadata.error_reason,
        }

    def _is_slot_invalidation_enabled(self) -> bool:
        # The SoC threshold is the whole switch since curtailment stopped
        # needing an entity of its own — everything else it reads has a default
        # or comes from the power devices already configured.
        return self._cfg.slot_invalidation_max_battery_soc_percent is not None

    def get_profile_payload(self) -> dict[str, Any] | None:
        if not self._has_usable_profile():
            return None

        return {
            "trainedAt": self._trained_at,
            "factors": deepcopy(self._profile.factors),
            "omittedSlots": list(self._profile.omitted_slots),
        }

    async def async_get_span_aggregates(
        self,
        raw_start_date: str,
        raw_end_date: str,
        bucket: str = "day",
        *,
        house_breakdown: bool = False,
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

        Note that the DST hazard :func:`_money_points` documents does *not* carry
        over. That one is about repeated ``"HH:MM"`` slot labels colliding on the
        fall-back day; here the hours arrive keyed by UTC instant, so the two
        occurrences of the repeated hour stay distinct, carry their own rates and
        both fold onto the same local date. Nothing to work around -- and nothing
        to re-implement the day view's workaround for.
        """
        bucket = bucket if bucket in _MAX_AGGREGATE_BUCKETS else "day"
        start_date = date.fromisoformat(raw_start_date)
        end_date = date.fromisoformat(raw_end_date)
        local_tz = ZoneInfo(str(self._hass.config.time_zone))
        local_now = dt_util.as_local(dt_util.now())

        # Month buckets describe whole months, so the requested edges are snapped
        # outward before anything else looks at them -- otherwise a span starting
        # mid-month would report a partial month as if it were a whole one.
        if bucket == "month":
            start_date = start_date.replace(day=1)
            end_date = _last_day_of_month(end_date)
        # Nothing is measured beyond now, and a span that reached past today
        # would only widen the recorder read. The month in progress stays, cut
        # short at today: a partial current month is the answer, not an absent
        # one.
        end_date = min(end_date, local_now.date())
        # The range travels with every answer, empty ones included: it is what
        # the card navigates by, and a span with no rows is exactly when the
        # reader is about to press an arrow.
        span_min_date, span_max_date = await self._async_navigation_range(
            local_now, view="span"
        )
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
        start_date = _trim_span_to_cap(start_date, end_date, bucket)

        local_start = datetime.combine(start_date, time(0, 0), tzinfo=local_tz)
        local_end = datetime.combine(
            end_date + timedelta(days=1), time(0, 0), tzinfo=local_tz
        )
        # Hourly statistics only exist for hours that have ended and been
        # compiled, so the bucket in progress is short by up to a couple of
        # hours -- and just after midnight a day bucket has no completed hour at
        # all. These views are history-only, so nothing draws in the gap's place.
        # Naming the newest bucket's start asks the span read to top those hours
        # up from the short-term table; a span that stops before today is fully
        # compiled and is not asked to.
        tail_start = None
        if end_date == local_now.date():
            newest_bucket_start = end_date if bucket == "day" else end_date.replace(day=1)
            tail_start = max(
                local_start,
                datetime.combine(newest_bucket_start, time(0, 0), tzinfo=local_tz),
            )

        def _entity_id(provider) -> str | None:
            return provider() if provider is not None else None

        (
            solar_entity,
            import_entity,
            export_entity,
            house_entity,
            charge_entity,
            discharge_entity,
        ) = self._energy_meter_entity_ids()
        soc_entity = _entity_id(self._battery_soc_entity_id_provider)
        # Two export rate sources, asked for together and resolved per hour
        # below: the mirror Helman publishes, whose statistics are the only ones
        # that exist on a setup whose sell-price entity declares no
        # ``state_class``, and the configured entity itself, which has its own
        # statistics only where the user's setup happens to produce them.
        export_price_entity = self._grid_export_price_entity_id()
        # The same roster the day view splits its house actual by, so a day
        # column and that day's slots itemise the same appliances under the same
        # labels. Resolved before the read because its meters join the one query
        # rather than adding a second: the discipline this docstring commits to
        # is one statistics read however wide the span, and a per-consumer read
        # would be one per appliance per span.
        #
        # Only where the caller asked for it. The day pills share this endpoint
        # and read six scalars a bucket, so resolving the roster for them would
        # widen a 31-day read by a meter per consumer for a field they never
        # look at.
        breakdown_consumers: list[dict] = []
        if house_breakdown:
            try:
                breakdown_consumers = await self._house_breakdown_consumers()
            except Exception:
                _LOGGER.exception("Failed to resolve house consumers for span aggregates")
                breakdown_consumers = []
        consumer_entities = [
            consumer["energy_entity_id"]
            for consumer in breakdown_consumers
            if consumer.get("energy_entity_id")
        ]

        from ..recorder_statistics_span import SpanStatistics, query_hourly_statistics

        try:
            span = await query_hourly_statistics(
                self._hass,
                [
                    solar_entity,
                    import_entity,
                    export_entity,
                    house_entity,
                    charge_entity,
                    discharge_entity,
                    soc_entity,
                    GRID_IMPORT_PRICE_ENTITY_ID,
                    GRID_EXPORT_PRICE_ENTITY_ID,
                    export_price_entity,
                    *consumer_entities,
                ],
                local_start=local_start,
                local_end=local_end,
                tail_start=tail_start,
            )
        except Exception:
            _LOGGER.exception("Failed to load statistics for span aggregates")
            span = SpanStatistics(rows={}, energy_kwh={})

        solar_kwh = _energy_by_bucket(span.energy_for(solar_entity), bucket, local_tz)
        imported_kwh = _energy_by_bucket(span.energy_for(import_entity), bucket, local_tz)
        exported_kwh = _energy_by_bucket(span.energy_for(export_entity), bucket, local_tz)
        house_kwh = _energy_by_bucket(span.energy_for(house_entity), bucket, local_tz)
        charged_kwh = _energy_by_bucket(span.energy_for(charge_entity), bucket, local_tz)
        discharged_kwh = _energy_by_bucket(
            span.energy_for(discharge_entity), bucket, local_tz
        )
        soc_by_bucket = _soc_bounds_by_bucket(span.rows_for(soc_entity), bucket, local_tz)
        # One fold per consumer through the same helper the six meters use, so a
        # consumer's bucket total is arrived at exactly as the house total it is
        # subtracted from.
        consumer_kwh_by_entity = {
            entity: _energy_by_bucket(span.energy_for(entity), bucket, local_tz)
            for entity in consumer_entities
        }

        import_price_config = self._grid_import_price_config()
        money_by_bucket = _money_by_bucket(
            span.energy_for(import_entity),
            span.energy_for(export_entity),
            span.rows_for(GRID_IMPORT_PRICE_ENTITY_ID),
            _prefer_rows(
                span.rows_for(GRID_EXPORT_PRICE_ENTITY_ID),
                span.rows_for(export_price_entity),
            ),
            bucket=bucket,
            local_tz=local_tz,
            import_price_windows=(
                None if import_price_config is None else import_price_config.windows
            ),
        )

        days: list[dict[str, Any]] = []
        for key in _bucket_keys(start_date, end_date, bucket):
            min_pct, max_pct = soc_by_bucket.get(key, (None, None))
            cost, gain = money_by_bucket.get(key, (None, None))
            days.append(
                {
                    "date": key,
                    "solarWh": _round_wh(solar_kwh.get(key)),
                    "gridImportKwh": _round_kwh(imported_kwh.get(key)),
                    "gridExportKwh": _round_kwh(exported_kwh.get(key)),
                    "batteryMinSocPct": min_pct,
                    "batteryMaxSocPct": max_pct,
                    "houseWh": _round_wh(house_kwh.get(key)),
                    "batteryChargeWh": _round_wh(charged_kwh.get(key)),
                    "batteryDischargeWh": _round_wh(discharged_kwh.get(key)),
                    "moneyCost": None if cost is None else round(cost, 3),
                    "moneyGain": None if gain is None else round(gain, 3),
                    "houseBreakdown": _bucket_house_breakdown(
                        breakdown_consumers,
                        consumer_kwh_by_entity,
                        key,
                        _round_wh(house_kwh.get(key)),
                    ),
                }
            )

        return {
            "bucket": bucket,
            "currency": self._resolve_span_currency(import_price_config),
            "days": days,
            "range": navigation_range,
        }

    def _resolve_span_currency(self, import_price_config) -> str | None:
        """The unit both money columns are in, resolved as the day view resolves it.

        Same order as the inspector day (the import windows first, then the live
        export channel, then the sell-price entity's own unit), because a span
        showing a different currency than the day it is made of would be a bug
        no reader could explain.
        """
        if import_price_config is not None and import_price_config.unit:
            return import_price_config.unit
        export_channel = self._grid_price_snapshot().get("export")
        if isinstance(export_channel, dict):
            unit = export_channel.get("unit")
            if isinstance(unit, str) and unit:
                return unit
        return self._grid_export_price_entity_unit()

    def _energy_meter_entity_ids(
        self,
    ) -> tuple[str | None, str | None, str | None, str | None, str | None, str | None]:
        """The six meters whose history the inspector actually draws.

        Solar, grid import, grid export, house, battery charge, battery
        discharge -- in that order, and always in that order, because two callers
        unpack this positionally. The house entry is the house's *own* meter and
        never solar/grid/battery arithmetic: the day view reads this same meter,
        and a second, subtractive definition of house load would disagree with
        the number sitting next to it.

        These are the meters, and only the meters. The battery SoC sensor and the
        price rails are read alongside them by the span aggregates, but they are
        not history in the sense that matters here -- a month with prices and no
        meters has nothing to draw -- which is why the history floor asks about
        this list rather than about everything the span read touches.
        """

        def _entity_id(provider) -> str | None:
            return provider() if provider is not None else None

        raw_solar_entity = self._cfg.total_energy_entity_id
        solar_entity = (
            raw_solar_entity.strip() if isinstance(raw_solar_entity, str) else None
        )
        return (
            solar_entity,
            _entity_id(self._grid_import_energy_entity_id_provider),
            _entity_id(self._grid_export_energy_entity_id_provider),
            _entity_id(self._house_energy_entity_id_provider),
            _entity_id(self._battery_charge_energy_entity_id_provider),
            _entity_id(self._battery_discharge_energy_entity_id_provider),
        )

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
        on a fresh install that still has to be browsable -- and not enough for
        the day view's floor, which :meth:`_day_view_floor` explains.
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
            self._energy_meter_entity_ids(),
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

    def _day_view_floor(self, local_now: datetime, aggregate_floor: date) -> date:
        """The oldest day the *day* view may be browsed back to.

        Shallower than the aggregate floor, and deliberately so. The two views
        read two different stores: the month and year views read long-term
        statistics, which the recorder keeps indefinitely, while the day view
        reads raw states through ``load_actuals_for_day``, which the recorder
        purges at ``purge_keep_days``. Handing the day view the statistics floor
        would give it a back arrow offering hundreds of days that can only ever
        draw empty.

        ``keep_days - 1``, not ``keep_days``: the recorder purges everything
        older than ``utcnow() - keep_days``, so the day that subtraction names
        is the one being deleted *through* rather than the oldest one kept. It
        has already lost its small hours by the time the nightly purge runs and
        loses the rest at the next one, so offering it means offering a chart
        that shrinks every night. One day later is the first that is whole.

        The ``max`` with the aggregate floor is the only guard needed: the day
        view can never usefully reach further back than the statistics do, and a
        retention setting longer than the recorded history would otherwise offer
        days that predate the meters entirely.

        The trainer's window is deliberately *not* consulted here, though an
        earlier draft did. ``usable_days`` counts samples the last training run
        built; it is evidence that raw states existed when it ran, not that they
        exist now. Shortening ``purge_keep_days`` after a run leaves that count
        untouched, and honouring it would hand back the very back arrow full of
        purged days this method exists to prevent. Where retention and the
        training window agree -- the ordinary case, since the trainer reads the
        same purged store -- the guard changed nothing anyway.
        """
        keep_days = self._purge_horizon_days()
        if keep_days is None:
            return aggregate_floor
        purge_horizon = local_now.date() - timedelta(days=keep_days - 1)
        return max(aggregate_floor, purge_horizon)

    async def _async_navigation_range(
        self, local_now: datetime, *, view: Literal["day", "span"]
    ) -> tuple[date, date]:
        """The dates the inspector's navigation may move between, inclusive.

        Forward is one answer for everyone: one day per configured daily-energy
        entity, which is how far the forecast reaches. Backwards is two, because
        the views read two different stores and are bounded by two different
        retention horizons -- see :meth:`_day_view_floor`. ``view`` names which
        payload is asking, and that is the only distinction that exists here.

        Both floors still come from one place, so neither payload can invent its
        own: the day floor is derived *from* the aggregate floor and can only be
        shallower than it, never deeper and never unrelated.
        """
        max_date = local_now.date() + timedelta(
            days=max(len(self._cfg.daily_energy_entity_ids) - 1, 0)
        )
        aggregate_floor = await self._async_history_floor(local_now)
        if view == "span":
            return aggregate_floor, max_date
        return self._day_view_floor(local_now, aggregate_floor), max_date

    async def async_get_inspector_day(self, raw_date: str) -> dict[str, Any]:
        target_date = date.fromisoformat(raw_date)
        local_now = dt_util.as_local(dt_util.now())
        today = local_now.date()
        min_date, max_date = await self._async_navigation_range(local_now, view="day")

        status, effective_variant, _fallback_reason = self._resolve_status()
        timezone = ZoneInfo(str(self._hass.config.time_zone))

        actuals_by_slot = {}
        if target_date <= today:
            actuals_by_slot = await load_actuals_for_day(
                self._hass,
                self._cfg,
                target_date,
                local_now=local_now,
            )

        if target_date >= today:
            provider = self._canonical_solar_forecast_provider
            if provider is not None:
                canonical_snapshot = await provider(reference_time=local_now)
            else:
                canonical_snapshot = None
            if not isinstance(canonical_snapshot, dict):
                canonical_snapshot = {}
            raw_points = _filter_points_to_local_date(
                canonical_snapshot.get("rawPoints") or canonical_snapshot.get("points") or [],
                target_date,
                timezone,
            )
            canonical_corrected = canonical_snapshot.get("correctedPoints") or []
            if effective_variant == "adjusted" and canonical_corrected:
                corrected_points = _filter_points_to_local_date(
                    canonical_corrected,
                    target_date,
                    timezone,
                )
            else:
                corrected_points = _copy_points(raw_points)
        else:
            raw_points = await load_forecast_points_for_day(
                self._hass,
                self._cfg,
                target_date,
                local_now=local_now,
            )
            corrected_points = _copy_points(raw_points)
            if effective_variant == "adjusted" and self._profile is not None:
                corrected_points = adjust(raw_points, self._profile)

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
        if target_date < today and actual_points and invalidated_slots:
            actual_points, invalidated_points = _partition_actual_points(
                actual_points,
                invalidated_slots=invalidated_slots,
            )

        # --- House forecast ---
        # The recorder history of the house forecast sensor (W → Wh) covers the
        # slots that have elapsed; the cached forecast snapshot (kWh → Wh) covers
        # the slots after the one in progress, because the recorder would hold the
        # last value flat across the rest of the day. The slot in progress sits
        # between them, in the snapshot's "currentSlot" field rather than its
        # "series", and is served from the live composition — total and parts from
        # the one vintage.
        current_slot_start = _current_slot_start(local_now) if target_date == today else None
        next_slot = (
            None if current_slot_start is None else current_slot_start + timedelta(minutes=15)
        )
        need_past = target_date <= today
        need_future = target_date >= today
        # How far the price recorder reads go: to the end of an elapsed day, and
        # on today only as far as the slot in progress, whose start already
        # carries the rate that applies to it. Everything past that is the live
        # feed's to fill, so the two halves meet without overlapping.
        price_history_end = next_slot or (
            datetime.combine(target_date, time(0, 0), tzinfo=timezone)
            + timedelta(days=1)
        )

        # Every cumulative meter the day's actual series need — house, both grid
        # sides, both battery sides and one per house consumer — is read in a
        # single recorder query up front. The recorder serves from one DB
        # executor thread, so gathering a read per meter would only queue them;
        # the batch turns ~18 serial round-trips into one. The consumer roster
        # has to be resolved first because it decides most of the entity ids.
        # The two steps degrade apart, the way the per-series loaders they came
        # from did: a roster that cannot be built costs the breakdown, and a
        # recorder that cannot be read costs the meter series, neither the other.
        breakdown_consumers_for_day: list[dict] = []
        slot_energy_by_entity: dict[str, dict[datetime, float]] = {}
        if need_past:
            try:
                breakdown_consumers_for_day = await self._house_breakdown_consumers()
            except Exception:
                _LOGGER.exception(
                    "Failed to load house consumer breakdown for inspector"
                )
            try:
                slot_energy_by_entity = await self._load_slot_energy_kwh_for_entities(
                    self._cumulative_meter_entity_ids(breakdown_consumers_for_day),
                    target_date,
                    timezone,
                )
            except Exception:
                _LOGGER.exception("Failed to load slot energy meters for inspector")
                slot_energy_by_entity = {}

        # Independent recorder/snapshot reads, so overlap them rather than
        # awaiting in turn.
        past_coros = (
            [
                self._guarded_points(
                    load_house_forecast_points_for_day(self._hass, target_date),
                    "house forecast history",
                ),
                self._guarded_points(
                    self._load_house_actual_for_date(target_date, slot_energy_by_entity),
                    "house actual",
                ),
                self._guarded_points(
                    self._load_battery_soc_actual_for_date(target_date, timezone),
                    "battery SoC actual",
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
                            self._grid_export_price_entity_id(),
                        ],
                        target_date,
                        timezone,
                        local_end=price_history_end,
                    ),
                    "price history",
                    count=2,
                ),
            ]
            if need_past
            else []
        )
        future_coros = (
            [self._get_battery_forecast_snapshot()] if need_future else []
        )
        gathered = await asyncio.gather(*past_coros, *future_coros)

        house_forecast_history_points: list[dict] = []
        house_actual_points: list[dict] = []
        battery_soc_actual_points: list[dict] = []
        grid_actual_series: tuple[list[dict], list[dict], list[dict]] = ([], [], [])
        battery_actual_points: list[dict] = []
        breakdown_consumers: list[dict] = []
        consumer_slot_maps: list[dict] = []
        recorded_import_price_points: list[dict] = []
        recorded_export_price_points: list[dict] = []
        if need_past:
            (
                house_forecast_history_points,
                house_actual_points,
                battery_soc_actual_points,
                grid_actual_series,
                battery_actual_points,
                recorded_price_series,
            ) = gathered[:6]
            recorded_import_price_points, recorded_export_price_points = (
                recorded_price_series
            )
            # Shaping only — the consumer meters came out of the batched read
            # above, so this is not another recorder round-trip.
            breakdown_consumers, consumer_slot_maps = (
                self._house_consumer_breakdown_for_date(
                    target_date,
                    breakdown_consumers_for_day,
                    slot_energy_by_entity,
                )
            )
        battery_snapshot = gathered[-1] if need_future else None

        # The breakdown decomposes the house actual already loaded, so it is
        # composed here rather than in its own recorder read: base load plus each
        # appliance reconciles to that slot's houseActual value.
        house_actual_breakdown_points = _build_house_actual_breakdown(
            house_actual_points,
            breakdown_consumers,
            consumer_slot_maps,
        )

        # Every actual series stops at the slot in progress, which is a forecast
        # like any other unfinished slot; the day's totals below still count it,
        # since a sum is an accumulation and not a slot-by-slot comparison, so the
        # drawn series and the summed series are held apart here.
        running_slot = (
            None if current_slot_start is None else current_slot_start.strftime("%H:%M")
        )
        drawn_actual_points = _drop_running_slot(actual_points, running_slot=running_slot)
        drawn_invalidated_points = _drop_running_slot(
            invalidated_points, running_slot=running_slot
        )
        drawn_house_actual_points = _drop_running_slot(
            house_actual_points, running_slot=running_slot
        )
        drawn_house_actual_breakdown_points = _drop_running_slot(
            house_actual_breakdown_points, running_slot=running_slot
        )
        drawn_battery_soc_actual_points = _drop_running_slot(
            battery_soc_actual_points, running_slot=running_slot
        )
        grid_actual_points, grid_import_actual_points, grid_export_actual_points = (
            grid_actual_series
        )
        drawn_grid_actual_points = _drop_running_slot(
            grid_actual_points, running_slot=running_slot
        )
        drawn_battery_actual_points = _drop_running_slot(
            battery_actual_points, running_slot=running_slot
        )

        house_forecast_breakdown_points: list[SolarBiasHouseBreakdownPoint] = []
        if need_future:
            # Only here, inside the need_future branch: the composition is read
            # off the pipeline the gather above has just built, so a past-only
            # day never touches it and no forecast rebuild can follow from
            # opening an old day.
            house_forecast_breakdown_points = _build_house_forecast_breakdown(
                self._get_house_forecast_composition(),
                self._house_scheduled_consumers(),
                target_date,
                next_slot=next_slot,
                metered_by_entity=breakdown_consumers,
            )
        current_slot_points = _house_forecast_total_for_slot(
            house_forecast_breakdown_points, slot_start=current_slot_start
        )

        house_forecast_points: list[dict] = []
        if need_past:
            # The archive stops where the composition takes over: at the slot in
            # progress when that slot has a composition, so its total and its
            # parts are one vintage and neither moves as the slot ages — and one
            # slot later when it has none, a lagging or cold pipeline being no
            # reason to leave a hole where the user is looking.
            house_forecast_points = _points_before(
                house_forecast_history_points,
                cutoff=current_slot_start if current_slot_points else next_slot,
            )
        house_forecast_points += current_slot_points
        if need_future:
            house_forecast_points += _house_forecast_points_from_snapshot(
                self._get_house_forecast_snapshot(),
                target_date,
                next_slot=next_slot,
            )

        # --- Battery SoC, grid and battery forecast ---
        # Elapsed slots come from the archive written as each snapshot was built,
        # since none of these series is recorded anywhere else and the live
        # snapshot starts at the current slot. Slots still ahead of the clock come
        # from that live snapshot, which begins one slot boundary after now.
        battery_soc_forecast_points: list[dict] = []
        grid_forecast_points: list[dict] = []
        battery_forecast_points: list[dict] = []
        grid_import_forecast_points: list[dict] = []
        grid_export_forecast_points: list[dict] = []
        if need_past:
            (
                battery_soc_forecast_points,
                grid_forecast_points,
                battery_forecast_points,
                grid_import_forecast_points,
                grid_export_forecast_points,
            ) = self._recorded_battery_forecast_points(
                target_date, cutoff=next_slot, timezone=timezone
            )
        if need_future:
            battery_soc_forecast_points += _filter_battery_soc_future(
                battery_snapshot,
                target_date=target_date,
                local_now=local_now,
                timezone=timezone,
            )
            future_net, future_import, future_export = _filter_grid_forecast_future(
                battery_snapshot,
                target_date=target_date,
                local_now=local_now,
                timezone=timezone,
            )
            grid_forecast_points += future_net
            grid_import_forecast_points += future_import
            grid_export_forecast_points += future_export
            battery_forecast_points += _filter_battery_forecast_future(
                battery_snapshot,
                target_date=target_date,
                local_now=local_now,
                timezone=timezone,
            )

        # --- Price rails ---
        # One rail per direction, spanning the whole day. Elapsed slots come
        # from the recorder — the import sensor Helman publishes, and the
        # configured sell-price entity, which has always recorded itself — and
        # slots the clock has not reached come from the live feed. The import
        # side then fills whatever is still empty from the window config, which
        # is derivable for any minute of any date; that is what makes the rail
        # whole on days that predate the sensor, and on the stretch past
        # recorder retention. It is a per-slot fill rather than a per-day
        # branch, because the ship day and the retention edge are each covered
        # in part: filling by day would either blank half a rail or overwrite a
        # day of recorded truth with today's tariff.
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
        # The export feed overrides the recorder rather than deferring to it.
        # Its attribute map is the settled day-ahead schedule for the whole day,
        # while the entity's recorded *state* is only ever a sample of whichever
        # hour was current when Home Assistant happened to be running — sparse
        # across any gap in uptime, and flat wherever it is sparse.
        for slot, value in _live_price_rail(
            price_snapshot.get("export"), target_date, timezone
        ).items():
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
            # An elapsed day has no live snapshot to read the unit off, so with
            # no import windows configured the export rail would draw bare
            # numbers. The sell-price entity states its own unit, and it is the
            # same entity the recorded rail came from.
            price_unit = self._grid_export_price_entity_unit()

        # Money, priced off the two grid directions and the rails just built.
        # The actual side is computed once from the *undropped* points and then
        # split the way every energy series is: the totals count the slot in
        # progress, the drawn series stops before it. The forecast side has no
        # such split, since no forecast series is ever dropped.
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
        drawn_money_actual_points = _drop_running_slot(
            money_actual_points, running_slot=running_slot
        )

        day = SolarBiasInspectorDay(
            date=target_date.isoformat(),
            timezone=str(self._hass.config.time_zone),
            status=status,
            effective_variant=effective_variant,
            trained_at=self._trained_at,
            min_date=min_date.isoformat(),
            max_date=max_date.isoformat(),
            series=SolarBiasInspectorSeries(
                raw=_inspector_points(raw_points),
                corrected=_inspector_points(corrected_points),
                actual=drawn_actual_points,
                invalidated=drawn_invalidated_points,
                factors=factors,
                impact=_impact_points_for_day(
                    raw_points,
                    corrected_points,
                ),
                house_forecast=_inspector_points_from_raw(house_forecast_points),
                house_actual=_inspector_points_from_raw(drawn_house_actual_points),
                house_actual_breakdown=drawn_house_actual_breakdown_points,
                house_forecast_breakdown=house_forecast_breakdown_points,
                battery_soc_forecast=_battery_soc_points_from_raw(battery_soc_forecast_points),
                battery_soc_actual=_battery_soc_points_from_raw(
                    drawn_battery_soc_actual_points
                ),
                grid_forecast=_inspector_points_from_raw(grid_forecast_points),
                grid_actual=_inspector_points_from_raw(drawn_grid_actual_points),
                battery_forecast=_inspector_points_from_raw(battery_forecast_points),
                battery_actual=_inspector_points_from_raw(drawn_battery_actual_points),
                import_price=_price_points(import_price_by_slot),
                export_price=_price_points(export_price_by_slot),
                money_actual=drawn_money_actual_points,
                money_forecast=money_forecast_points,
            ),
            totals=SolarBiasInspectorTotals(
                raw_wh=_sum_point_values(raw_points) if raw_points else None,
                corrected_wh=(
                    _sum_point_values(corrected_points) if corrected_points else None
                ),
                actual_wh=sum(actuals_by_slot.values()) if actuals_by_slot else None,
                house_forecast_wh=(
                    sum(p["wh"] for p in house_forecast_points)
                    if house_forecast_points
                    else None
                ),
                house_actual_wh=(
                    sum(p["wh"] for p in house_actual_points)
                    if house_actual_points
                    else None
                ),
                grid_forecast_wh=(
                    sum(p["wh"] for p in grid_forecast_points)
                    if grid_forecast_points
                    else None
                ),
                grid_actual_wh=(
                    sum(p["wh"] for p in grid_actual_points)
                    if grid_actual_points
                    else None
                ),
                battery_forecast_wh=(
                    sum(p["wh"] for p in battery_forecast_points)
                    if battery_forecast_points
                    else None
                ),
                battery_actual_wh=(
                    sum(p["wh"] for p in battery_actual_points)
                    if battery_actual_points
                    else None
                ),
                money_actual=_money_totals(money_actual_points),
                money_forecast=_money_totals(money_forecast_points),
            ),
            availability=SolarBiasInspectorAvailability(
                has_raw_forecast=bool(raw_points),
                has_corrected_forecast=bool(corrected_points),
                has_actuals=bool(drawn_actual_points),
                has_profile=has_profile,
                has_invalidated=bool(drawn_invalidated_points),
                has_house_forecast=bool(house_forecast_points),
                has_house_actual=bool(drawn_house_actual_points),
                has_house_actual_breakdown=bool(drawn_house_actual_breakdown_points),
                has_house_forecast_breakdown=bool(house_forecast_breakdown_points),
                has_battery_soc_forecast=bool(battery_soc_forecast_points),
                has_battery_soc_actual=bool(drawn_battery_soc_actual_points),
                has_grid_forecast=bool(grid_forecast_points),
                has_grid_actual=bool(drawn_grid_actual_points),
                has_battery_forecast=bool(battery_forecast_points),
                has_battery_actual=bool(drawn_battery_actual_points),
                has_import_price=bool(import_price_by_slot),
                has_export_price=bool(export_price_by_slot),
            ),
            is_today=target_date == today,
            is_future=target_date > today,
            training_explainability=self._explainability if has_profile else None,
            battery_soc_bounds=await self._battery_soc_bounds_for_date(
                target_date, timezone, need_past=need_past
            ),
            house_unmeasured_label=self._house_unmeasured_label(),
            price_unit=price_unit,
        )
        return inspector_day_to_payload(day)

    def _live_battery_soc_bounds(self) -> tuple[float | None, float | None]:
        if self._battery_soc_bounds_provider is None:
            return (None, None)
        try:
            return self._battery_soc_bounds_provider() or (None, None)
        except Exception:
            _LOGGER.exception("Battery SoC bounds provider failed")
            return (None, None)

    def _battery_soc_bounds_entity_ids(self) -> tuple[str | None, str | None]:
        if self._battery_soc_bounds_entity_id_provider is None:
            return (None, None)
        try:
            return self._battery_soc_bounds_entity_id_provider() or (None, None)
        except Exception:
            _LOGGER.exception("Battery SoC bounds entity id provider failed")
            return (None, None)

    async def _battery_soc_bounds_for_date(
        self, target_date: date, local_tz: ZoneInfo, *, need_past: bool
    ) -> list[BatterySocBoundsPoint]:
        """The SoC window per slot: recorded where the day has elapsed.

        Slots the clock has not reached — and elapsed slots the recorder has no
        reading for — fall back to the bounds set right now, which is the only
        window the battery forecast beyond them was ever built against.
        """
        min_entity_id, max_entity_id = self._battery_soc_bounds_entity_ids()
        min_by_slot: dict[str, float] = {}
        max_by_slot: dict[str, float] = {}
        if need_past and (min_entity_id or max_entity_id):
            min_by_slot, max_by_slot = await asyncio.gather(
                self._load_numeric_history_by_slot(
                    min_entity_id, target_date, local_tz, label="battery min SoC"
                ),
                self._load_numeric_history_by_slot(
                    max_entity_id, target_date, local_tz, label="battery max SoC"
                ),
            )

        live_min, live_max = self._live_battery_soc_bounds()
        points: list[BatterySocBoundsPoint] = []
        for slot_index in range(96):
            slot = f"{slot_index // 4:02d}:{(slot_index % 4) * 15:02d}"
            min_pct = min_by_slot.get(slot, live_min)
            max_pct = max_by_slot.get(slot, live_max)
            if min_pct is None and max_pct is None:
                continue
            points.append(
                BatterySocBoundsPoint(slot=slot, min_pct=min_pct, max_pct=max_pct)
            )
        return points

    def _get_house_forecast_snapshot(self) -> dict | None:
        if self._house_forecast_snapshot_provider is None:
            return None
        try:
            return self._house_forecast_snapshot_provider()
        except Exception:
            _LOGGER.exception("House forecast snapshot provider failed")
            return None

    def _get_house_forecast_composition(self) -> dict | None:
        """What the adjusted house forecast is made of, or None when unknown.

        A plain read of the pipeline the request has already built — never a
        rebuild, so opening an old day cannot trigger a forecast run.
        """
        if self._house_forecast_composition_provider is None:
            return None
        try:
            return self._house_forecast_composition_provider()
        except Exception:
            _LOGGER.exception("House forecast composition provider failed")
            return None

    async def _get_battery_forecast_snapshot(self) -> dict | None:
        if self._battery_forecast_provider is None:
            return None
        try:
            return await self._battery_forecast_provider()
        except Exception:
            _LOGGER.exception("Battery forecast provider failed")
            return None

    def _recorded_battery_forecast_points(
        self, target_date: date, *, cutoff: datetime | None, timezone: ZoneInfo
    ) -> tuple[list[dict], list[dict], list[dict], list[dict], list[dict]]:
        """Read archived SoC, grid and battery forecast slots for a day.

        Returns (soc, grid net, battery, grid import, grid export) points for
        slots starting before cutoff, or for the whole day when cutoff is None.
        A key added after a day was archived simply yields no points for it —
        days written before batteryNetWh have no battery series, and days
        written before the grid sides were split have the net but neither side.
        """
        empty: tuple[list[dict], list[dict], list[dict], list[dict], list[dict]] = (
            [], [], [], [], []
        )
        if self._battery_forecast_history is None:
            return empty
        try:
            slots = self._battery_forecast_history.slots_for_day(target_date)
        except Exception:
            _LOGGER.exception("Failed to read battery forecast history for inspector")
            return empty
        cutoff_minutes = _minutes_into_day(cutoff, target_date)
        soc_points: list[dict] = []
        grid_points: list[dict] = []
        battery_points: list[dict] = []
        grid_import_points: list[dict] = []
        grid_export_points: list[dict] = []
        for slot in sorted(slots):
            minutes = _slot_to_minutes(slot)
            if minutes is None or minutes >= cutoff_minutes:
                continue
            values = slots[slot]
            if not isinstance(values, dict):
                continue
            pct = values.get("socPct")
            if pct is not None:
                soc_points.append({"slot": slot, "pct": float(pct)})
            timestamp = datetime.combine(
                target_date, time(minutes // 60, minutes % 60), tzinfo=timezone
            )
            grid_net_wh = values.get("gridNetWh")
            if grid_net_wh is not None:
                grid_points.append(
                    {"timestamp": timestamp.isoformat(), "wh": float(grid_net_wh)}
                )
            grid_import_wh = values.get("gridImportWh")
            if grid_import_wh is not None:
                grid_import_points.append(
                    {"timestamp": timestamp.isoformat(), "wh": float(grid_import_wh)}
                )
            grid_export_wh = values.get("gridExportWh")
            if grid_export_wh is not None:
                grid_export_points.append(
                    {"timestamp": timestamp.isoformat(), "wh": float(grid_export_wh)}
                )
            battery_net_wh = values.get("batteryNetWh")
            if battery_net_wh is not None:
                battery_points.append(
                    {"timestamp": timestamp.isoformat(), "wh": float(battery_net_wh)}
                )
        return (
            soc_points,
            grid_points,
            battery_points,
            grid_import_points,
            grid_export_points,
        )

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
    ) -> dict[str, dict[datetime, float]]:
        """Per-15-min energy deltas of several cumulative meters, in one recorder read.

        Keyed by entity id, each value keyed by UTC slot start. Daily-resetting
        meters are fine here: the query unwraps total_increasing resets, and a
        single local day never spans the midnight reset boundary.

        Every cumulative-meter series the inspector draws comes through here, and
        it is deliberately a single call: the recorder serves its queries from one
        DB executor thread, so a read per meter is a serial round-trip per meter no
        matter how the awaits are arranged.
        """
        from ..recorder_hourly_series import (
            query_cumulative_slot_energy_changes_for_entities,
        )

        local_start = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
        return await query_cumulative_slot_energy_changes_for_entities(
            self._hass,
            list(entity_ids),
            local_start=local_start,
            local_end=local_start + timedelta(days=1),
            interval_minutes=15,
        )

    def _cumulative_meter_entity_ids(self, consumers: list[dict]) -> list[str]:
        """Every cumulative meter the inspector's actual series read for a day.

        The house meter, both grid sides, both battery sides and one per house
        consumer — the entity ids the single batched read has to cover. Missing
        providers and unconfigured meters drop out; the batch de-duplicates.

        A provider that raises costs only its own meter here. Its series still
        calls it and still fails, and its own error boundary still degrades that
        one series — which is what a failing provider cost before the reads were
        batched, and must keep costing now that they share a query.
        """

        def _entity_id(provider) -> str | None:
            if provider is None:
                return None
            try:
                return provider()
            except Exception:
                _LOGGER.exception("Meter entity id provider failed for inspector")
                return None

        candidates = [
            _entity_id(self._house_energy_entity_id_provider),
            _entity_id(self._grid_import_energy_entity_id_provider),
            _entity_id(self._grid_export_energy_entity_id_provider),
            _entity_id(self._battery_charge_energy_entity_id_provider),
            _entity_id(self._battery_discharge_energy_entity_id_provider),
            *(consumer["energy_entity_id"] for consumer in consumers),
        ]
        return [entity_id for entity_id in candidates if entity_id]

    async def _load_house_actual_for_date(
        self,
        target_date: date,
        slot_energy_by_entity: dict[str, dict[datetime, float]],
    ) -> list[dict]:
        """Load per-15-min house energy actuals for target_date."""
        if self._house_energy_entity_id_provider is None:
            return []
        entity_id = self._house_energy_entity_id_provider()
        if not entity_id:
            return []
        by_slot = slot_energy_by_entity.get(entity_id) or {}
        return _slot_energy_points(
            {slot: kwh * 1000.0 for slot, kwh in by_slot.items()},
            target_date,
        )

    @staticmethod
    def _normalize_consumers(raw_consumers: Any, *, deferrable: bool) -> list[dict]:
        """Coerce a provider's list to
        ``[{energy_entity_id, label, switch_entity_id, power_entity_id, deferrable, id}]``.

        Drops anything without a usable entity id and defaults a missing label to
        the entity id, so callers get a clean, deduplicable list. The switch and
        power sensor are optional — only the device tree knows them.

        ``deferrable`` is the caller's answer for the whole list: a provider is one
        roster, so which roster an entry came from is the only thing that decides it.

        ``id`` is the controllable id where the roster carries one — the key the
        forecast's scheduled demand is reported under, and None for a device the
        tree alone knows about.
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
            controllable_id = consumer.get("id")
            result.append(
                {
                    "energy_entity_id": eid,
                    "label": consumer.get("label", eid),
                    "switch_entity_id": switch if isinstance(switch, str) and switch else None,
                    "power_entity_id": power if isinstance(power, str) and power else None,
                    "deferrable": deferrable,
                    "id": (
                        controllable_id
                        if isinstance(controllable_id, str) and controllable_id
                        else None
                    ),
                }
            )
        return result

    def _house_deferrable_consumers(self) -> list[dict]:
        """The configured deferrable appliances: ``energy_entity_id`` + ``label``."""
        if self._house_deferrable_consumers_provider is None:
            return []
        try:
            raw = self._house_deferrable_consumers_provider() or []
        except Exception:
            _LOGGER.exception("House deferrable consumers provider failed")
            return []
        return self._normalize_consumers(raw, deferrable=True)

    def _house_scheduled_consumers(self) -> list[dict]:
        """Every schedulable controllable by id, for naming the forecast's rows.

        Taken raw rather than through :meth:`_normalize_consumers`, which exists
        to enforce a usable meter — the whole point here is that a scheduled
        appliance without one still gets a row.
        """
        if self._house_scheduled_consumers_provider is None:
            return []
        try:
            raw = self._house_scheduled_consumers_provider() or []
        except Exception:
            _LOGGER.exception("House scheduled consumers provider failed")
            return []
        return [consumer for consumer in raw if isinstance(consumer, dict)]

    def _house_unmeasured_label(self) -> str | None:
        """The power card's configured title for unmetered load, if any."""
        if self._house_unmeasured_label_provider is None:
            return None
        try:
            label = self._house_unmeasured_label_provider()
        except Exception:
            _LOGGER.exception("House unmeasured label provider failed")
            return None
        return label if isinstance(label, str) and label.strip() else None

    async def _house_device_consumers(self) -> list[dict]:
        """Individually-measured house devices from the shared device tree."""
        if self._house_device_consumers_provider is None:
            return []
        try:
            raw = await self._house_device_consumers_provider() or []
        except Exception:
            _LOGGER.exception("House device consumers provider failed")
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
        merged: list[dict] = []
        for consumer in deferrable:
            merged.append(
                {
                    **consumer,
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
                    slot_energy_by_entity.get(consumer["energy_entity_id"]) or {},
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

        def _entity_id(provider) -> str | None:
            return provider() if provider is not None else None

        import_entity = _entity_id(self._grid_import_energy_entity_id_provider)
        export_entity = _entity_id(self._grid_export_energy_entity_id_provider)
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
        """The price entities' recorder history sampled onto the day's slots.

        A price is a rate that only writes a new state when it changes, so a
        slot takes the last state at or before its start and the sampler carries
        it forward across the slots in between. Slots the entity has no reading
        for at all — before it existed, or past recorder retention — are simply
        absent; the caller decides whether it has anything better to put there.

        Both rails share this window and this sampler, so they share one recorder
        read: the recorder serves its queries from one DB executor thread, and a
        read per rail is a serial round-trip per rail no matter how the awaits
        are arranged. Returns one series per requested entity id, in order; an
        unconfigured entity yields an empty series.
        """
        from ..recorder_hourly_series import (
            query_slot_boundary_state_values_for_entities,
        )

        requested = list(entity_ids)
        if not any(requested):
            return tuple([] for _ in requested)

        local_start = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
        by_entity = await query_slot_boundary_state_values_for_entities(
            self._hass,
            [entity_id for entity_id in requested if entity_id],
            local_start=local_start,
            local_end=local_end,
            interval_minutes=15,
        )
        return tuple(
            [
                {
                    "slot": dt_util.as_local(boundary).strftime("%H:%M"),
                    "value": float(value),
                }
                for boundary, value in sorted(
                    (by_entity.get(entity_id) or {}).items()
                )
            ]
            if entity_id
            else []
            for entity_id in requested
        )

    def _grid_export_price_entity_unit(self) -> str | None:
        """The sell-price entity's own unit, for days with no live snapshot."""
        entity_id = self._grid_export_price_entity_id()
        if not entity_id:
            return None
        state = self._hass.states.get(entity_id)
        if state is None:
            return None
        unit = state.attributes.get("unit_of_measurement")
        return unit if isinstance(unit, str) and unit else None

    def _grid_export_price_entity_id(self) -> str | None:
        """The configured sell-price entity, read for its recorder history.

        Still read directly, even though Helman now mirrors it into
        ``sensor.helman_grid_export_price``: the mirror's *raw states* only go
        back to the day it started publishing, while this entity's reach back as
        far as the recorder keeps them. The day view prices elapsed slots from
        raw states, so it would lose every day older than the mirror. The
        aggregate views, which read hourly statistics rather than states, prefer
        the mirror -- see ``_prefer_rows``. Collapsing the two readers onto one
        source is #133.
        """
        if self._grid_export_price_entity_id_provider is None:
            return None
        try:
            return self._grid_export_price_entity_id_provider()
        except Exception:
            _LOGGER.exception("Failed to read the grid export price entity id")
            return None

    def _grid_import_price_config(self):
        """The validated import-price window table, or None when unconfigured.

        Invalid config is treated as absent rather than raised: the inspector
        renders whatever it can, and the config editor is where a broken window
        table gets reported.
        """
        if self._grid_import_price_config_provider is None:
            return None
        try:
            return self._grid_import_price_config_provider()
        except Exception:
            _LOGGER.exception("Failed to read the grid import price config")
            return None

    def _grid_price_snapshot(self) -> dict[str, Any]:
        """The live price feed, whose points start at the slot in progress."""
        if self._grid_price_snapshot_provider is None:
            return {}
        try:
            snapshot = self._grid_price_snapshot_provider()
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

        def _entity_id(provider) -> str | None:
            return provider() if provider is not None else None

        charge_entity = _entity_id(self._battery_charge_energy_entity_id_provider)
        discharge_entity = _entity_id(self._battery_discharge_energy_entity_id_provider)
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

    async def _load_battery_soc_actual_for_date(
        self, target_date: date, local_tz: ZoneInfo
    ) -> list[dict]:
        """Load per-15-min battery SoC history for target_date."""
        if self._battery_soc_entity_id_provider is None:
            return []
        by_slot = await self._load_numeric_history_by_slot(
            self._battery_soc_entity_id_provider(),
            target_date,
            local_tz,
            label="battery SoC",
        )
        return [{"slot": slot, "pct": pct} for slot, pct in by_slot.items()]

    async def _load_numeric_history_by_slot(
        self,
        entity_id: str | None,
        target_date: date,
        local_tz: ZoneInfo,
        *,
        label: str,
    ) -> dict[str, float]:
        """Sample a numeric entity's history onto the day's 15-minute slots.

        A slot takes the last value the entity held at or before its start, so
        an entity that goes unavailable holds its previous reading rather than
        leaving a hole. Slots before the entity's first reading are absent, as
        are slots the clock has not reached yet.
        """
        if not entity_id:
            return {}
        local_start = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
        local_end = local_start + timedelta(days=1)
        start_utc = dt_util.as_utc(local_start)
        end_utc = dt_util.as_utc(local_end)
        try:
            states_by_entity = await _get_significant_states_safe(
                self._hass, start_utc, end_utc, [entity_id]
            )
        except Exception:
            _LOGGER.exception("Failed to load %s history for inspector", label)
            return {}
        states = (states_by_entity or {}).get(entity_id) or []
        if not states:
            return {}
        timeline: list[tuple[datetime, float]] = []
        for state in states:
            raw = getattr(state, "state", None)
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            ts = getattr(state, "last_changed", None) or getattr(
                state, "last_updated", None
            )
            if ts is None:
                continue
            timeline.append((dt_util.as_local(ts), value))
        if not timeline:
            return {}
        timeline.sort(key=lambda pair: pair[0])
        _SLOT_MINUTES = 15
        local_now = datetime.now(local_tz)
        is_today = target_date == local_now.date()
        by_slot: dict[str, float] = {}
        cursor = 0
        current: float | None = None
        for slot_index in range(96):
            slot_start = local_start + timedelta(minutes=slot_index * _SLOT_MINUTES)
            if is_today and slot_start > local_now:
                break
            while cursor < len(timeline) and timeline[cursor][0] <= slot_start:
                current = timeline[cursor][1]
                cursor += 1
            if current is None:
                continue
            by_slot[f"{slot_start.hour:02d}:{slot_start.minute:02d}"] = current
        return by_slot

    @property
    def _current_fingerprint(self) -> str:
        return compute_fingerprint(self._cfg)

    @property
    def _trained_at(self) -> str | None:
        return self._metadata.trained_at or None

    def _resolve_status(self) -> tuple[str, str, str | None]:
        if not self._cfg.enabled:
            return ("disabled", "raw", "disabled")
        if self._is_stale:
            return (
                "config_changed_pending_retrain",
                "raw",
                "config_changed_pending_retrain",
            )
        if self._metadata.last_outcome == "profile_trained" and self._profile is not None:
            return ("applied", "adjusted", None)
        if self._metadata.last_outcome == "insufficient_history":
            return ("insufficient_history", "raw", "insufficient_history")
        if self._metadata.last_outcome == "training_failed":
            if self._profile is not None:
                return ("training_failed", "adjusted", None)
            return ("training_failed", "raw", "training_failed")
        return ("no_training_yet", "raw", "no_training_yet")

    def _emit_status_changed_if_needed(
        self,
        status: str,
        effective_variant: str,
    ) -> None:
        current = (status, effective_variant)
        if self._last_emitted_status == current:
            return
        self._last_emitted_status = current
        self._hass.bus.async_fire(
            "helman_solar_bias_status_changed",
            {"status": status, "effectiveVariant": effective_variant},
        )

    def _build_default_metadata(self, *, last_outcome: str) -> SolarBiasMetadata:
        return SolarBiasMetadata(
            trained_at="",
            training_config_fingerprint=self._current_fingerprint,
            usable_days=0,
            dropped_days=[],
            factor_min=None,
            factor_max=None,
            factor_median=None,
            omitted_slot_count=0,
            last_outcome=last_outcome,
            error_reason=None,
        )

    def _build_failure_metadata(
        self,
        *,
        previous_metadata: SolarBiasMetadata,
        error_reason: str,
        trained_at: str,
        training_config_fingerprint: str,
    ) -> SolarBiasMetadata:
        previous = previous_metadata
        return SolarBiasMetadata(
            trained_at=trained_at,
            training_config_fingerprint=training_config_fingerprint,
            usable_days=previous.usable_days,
            dropped_days=deepcopy(previous.dropped_days),
            factor_min=previous.factor_min,
            factor_max=previous.factor_max,
            factor_median=previous.factor_median,
            omitted_slot_count=previous.omitted_slot_count,
            last_outcome="training_failed",
            error_reason=error_reason,
        )

    def _should_preserve_profile(
        self,
        profile: SolarBiasProfile | None,
        metadata: SolarBiasMetadata,
    ) -> bool:
        if profile is None:
            return False

        if metadata.last_outcome not in ("profile_trained", "training_failed"):
            return False

        return metadata.usable_days >= self._cfg.min_history_days

    def _has_usable_profile(self) -> bool:
        if self._profile is None:
            return False
        if self._metadata.last_outcome == "profile_trained":
            return True
        return self._should_preserve_profile(self._profile, self._metadata)

    def _next_scheduled_training_at(self) -> str | None:
        if not self._cfg.enabled:
            return None
        try:
            hour_text, minute_text = self._cfg.training_time.split(":", maxsplit=1)
            hour = int(hour_text)
            minute = int(minute_text)
        except (AttributeError, ValueError):
            return None

        local_now = dt_util.as_local(dt_util.now())
        next_run = local_now.replace(
            hour=hour,
            minute=minute,
            second=0,
            microsecond=0,
        )
        if next_run <= local_now:
            next_run += timedelta(days=1)
        return next_run.isoformat()

    def _serialize_state(self) -> dict[str, Any]:
        return {
            "version": 2,
            "profile": None if self._profile is None else asdict(self._profile),
            "metadata": asdict(self._metadata),
            "trainingExplainability": training_explainability_to_payload(self._explainability),
        }


def _profile_from_dict(raw_value: Any) -> SolarBiasProfile | None:
    if not isinstance(raw_value, dict):
        return None

    raw_factors = raw_value.get("factors", raw_value)
    if not isinstance(raw_factors, dict):
        return None

    factors: dict[str, float] = {}
    for slot, value in raw_factors.items():
        if not isinstance(slot, str):
            continue
        try:
            factors[slot] = float(value)
        except (TypeError, ValueError):
            continue

    raw_omitted = raw_value.get("omitted_slots", raw_value.get("omittedSlots", []))
    omitted_slots = [slot for slot in raw_omitted if isinstance(slot, str)] if isinstance(raw_omitted, list) else []
    return SolarBiasProfile(factors=factors, omitted_slots=omitted_slots)


def _metadata_from_dict(raw_value: Any) -> SolarBiasMetadata | None:
    if not isinstance(raw_value, dict):
        return None

    trained_at = raw_value.get("trained_at")
    training_config_fingerprint = raw_value.get("training_config_fingerprint")
    usable_days = raw_value.get("usable_days")
    dropped_days = raw_value.get("dropped_days")
    omitted_slot_count = raw_value.get("omitted_slot_count")
    last_outcome = raw_value.get("last_outcome")

    if not isinstance(trained_at, str):
        return None
    if not isinstance(training_config_fingerprint, str):
        return None
    if not isinstance(usable_days, int):
        return None
    if not isinstance(dropped_days, list):
        return None
    if not isinstance(omitted_slot_count, int):
        return None
    if not isinstance(last_outcome, str):
        return None

    raw_invalidated_slots_by_date = raw_value.get("invalidated_slots_by_date", {})
    invalidated_slots_by_date: dict[str, list[str]] = {}
    if isinstance(raw_invalidated_slots_by_date, dict):
        for day, slots in raw_invalidated_slots_by_date.items():
            if not isinstance(day, str) or not isinstance(slots, list):
                continue
            invalidated_slots_by_date[day] = [
                slot for slot in slots if isinstance(slot, str)
            ]

    raw_invalidated_slot_count = raw_value.get("invalidated_slot_count", 0)
    invalidated_slot_count = (
        raw_invalidated_slot_count
        if isinstance(raw_invalidated_slot_count, int)
        else 0
    )

    return SolarBiasMetadata(
        trained_at=trained_at,
        training_config_fingerprint=training_config_fingerprint,
        usable_days=usable_days,
        dropped_days=deepcopy(dropped_days),
        factor_min=_optional_float(raw_value.get("factor_min")),
        factor_max=_optional_float(raw_value.get("factor_max")),
        factor_median=_optional_float(raw_value.get("factor_median")),
        omitted_slot_count=omitted_slot_count,
        last_outcome=last_outcome,
        invalidated_slots_by_date=invalidated_slots_by_date,
        invalidated_slot_count=invalidated_slot_count,
        error_reason=raw_value.get("error_reason") if isinstance(raw_value.get("error_reason"), str) else None,
    )


def _training_explainability_from_dict(
    raw_value: Any,
) -> SolarBiasTrainingExplainability | None:
    if not isinstance(raw_value, dict):
        return None
    trained_at = raw_value.get("trainedAt", raw_value.get("trained_at"))
    aggregation_method = raw_value.get(
        "aggregationMethod", raw_value.get("aggregation_method")
    )
    raw_slots = raw_value.get("slots")
    if not isinstance(trained_at, str) or not isinstance(aggregation_method, str):
        return None
    if not isinstance(raw_slots, dict):
        return None

    slots: dict[str, SolarBiasSlotExplainability] = {}
    for slot, raw_slot in raw_slots.items():
        if not isinstance(slot, str) or not isinstance(raw_slot, dict):
            continue
        raw_rows = raw_slot.get("rows")
        if not isinstance(raw_rows, list):
            continue
        rows: list[SolarBiasContributionRow] = []
        for raw_row in raw_rows:
            if not isinstance(raw_row, dict):
                continue
            date_value = raw_row.get("date")
            status = raw_row.get("status")
            if not isinstance(date_value, str) or not isinstance(status, str):
                continue
            reason = raw_row.get("reason")
            rows.append(
                SolarBiasContributionRow(
                    date=date_value,
                    forecast_wh=_optional_float(raw_row.get("forecastWh", raw_row.get("forecast_wh"))),
                    actual_wh=_optional_float(raw_row.get("actualWh", raw_row.get("actual_wh"))),
                    ratio=_optional_float(raw_row.get("ratio")),
                    status=status,
                    reason=reason if isinstance(reason, str) else None,
                )
            )
        raw_anchors = raw_slot.get(
            "interpolationAnchors", raw_slot.get("interpolation_anchors")
        )
        anchors: tuple[str | None, str | None] | None = None
        if isinstance(raw_anchors, dict):
            left = raw_anchors.get("left")
            right = raw_anchors.get("right")
            anchors = (
                left if isinstance(left, str) else None,
                right if isinstance(right, str) else None,
            )
        slots[slot] = SolarBiasSlotExplainability(
            factor=_optional_float(raw_slot.get("factor")),
            raw_ratio=_optional_float(raw_slot.get("rawRatio", raw_slot.get("raw_ratio"))),
            clamped=bool(raw_slot.get("clamped", False)),
            forecast_sum_wh=_optional_float(raw_slot.get("forecastSumWh", raw_slot.get("forecast_sum_wh"))) or 0.0,
            actual_sum_wh=_optional_float(raw_slot.get("actualSumWh", raw_slot.get("actual_sum_wh"))) or 0.0,
            rows=rows,
            interpolated=bool(raw_slot.get("interpolated", False)),
            interpolation_anchors=anchors,
        )

    return SolarBiasTrainingExplainability(
        trained_at=trained_at,
        aggregation_method=aggregation_method,
        slots=slots,
    )


def _optional_float(raw_value: Any) -> float | None:
    if raw_value is None:
        return None
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def _filter_points_to_local_date(
    points: list[dict[str, Any]],
    target_date: date,
    timezone: ZoneInfo,
) -> list[dict[str, Any]]:
    """Return points whose timestamp falls on `target_date` in `timezone`, preserving native granularity."""
    parse_datetime = getattr(dt_util, "parse_datetime", datetime.fromisoformat)
    filtered: list[tuple[datetime, dict[str, Any]]] = []
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str) or isinstance(value, bool):
            continue
        if not isinstance(value, (int, float)):
            continue
        parsed_timestamp = parse_datetime(timestamp)
        if parsed_timestamp is None:
            continue
        local_timestamp = dt_util.as_local(parsed_timestamp).astimezone(timezone)
        if local_timestamp.date() != target_date:
            continue
        filtered.append((local_timestamp, {"timestamp": timestamp, "value": float(value)}))
    filtered.sort(key=lambda item: item[0])
    return [point for _, point in filtered]


def _copy_points(raw_points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(point) for point in raw_points]


def _inspector_points(raw_points: list[dict[str, Any]]) -> list[SolarBiasInspectorPoint]:
    points: list[SolarBiasInspectorPoint] = []
    for point in raw_points:
        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str):
            continue
        try:
            value_wh = float(value)
        except (TypeError, ValueError):
            continue
        points.append(SolarBiasInspectorPoint(timestamp=timestamp, value_wh=value_wh))
    return points


def _sum_point_values(raw_points: list[dict[str, Any]]) -> float:
    total = 0.0
    for point in raw_points:
        try:
            total += float(point.get("value"))
        except (TypeError, ValueError):
            continue
    return total


def _partition_actual_points(
    actual_points: list[SolarBiasInspectorPoint],
    *,
    invalidated_slots: set[str],
) -> tuple[list[SolarBiasInspectorPoint], list[SolarBiasInspectorPoint]]:
    """Split actuals into kept vs invalidated using the actuals' own 15-min slot key.

    Both `actual_points` and `invalidated_slots` are at 15-minute granularity,
    so the comparison is direct. Earlier code mapped each actual to the
    *containing* forecast-published slot, which silently coarsened to hourly
    when raw forecast was hourly and dropped 15-min invalidations on the floor.
    """
    actual: list[SolarBiasInspectorPoint] = []
    invalidated: list[SolarBiasInspectorPoint] = []
    for point in actual_points:
        point_slot = point.timestamp[11:16]
        if point_slot in invalidated_slots:
            invalidated.append(point)
            continue
        actual.append(point)
    return actual, invalidated


def _factor_points_for_profile(
    profile: SolarBiasProfile | None,
) -> list[SolarBiasFactorPoint]:
    if profile is None:
        return []
    return [
        SolarBiasFactorPoint(slot=slot, factor=float(factor))
        for slot, factor in sorted(profile.factors.items())
    ]


def _impact_points_for_day(
    raw_points: list[dict[str, Any]],
    corrected_points: list[dict[str, Any]],
) -> list[SolarBiasImpactPoint]:
    corrected_by_slot: dict[str, float] = {}
    for point in corrected_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str):
            continue
        try:
            corrected_by_slot[timestamp[11:16]] = float(point.get("value"))
        except (TypeError, ValueError):
            continue

    impact: list[SolarBiasImpactPoint] = []
    for point in raw_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str):
            continue
        slot = timestamp[11:16]
        try:
            raw_wh = float(point.get("value"))
        except (TypeError, ValueError):
            continue
        corrected_wh = corrected_by_slot.get(slot)
        if corrected_wh is None:
            continue
        # Effective factor: corrected/raw. At 15-min granularity this equals
        # profile.factors[slot]; at hourly granularity (today/future buckets
        # aggregating four 15-min slots) it reflects the raw-weighted average
        # of the underlying sub-slot factors actually applied.
        effective_factor: float | None
        if raw_wh > 0.0:
            effective_factor = corrected_wh / raw_wh
        else:
            effective_factor = None
        impact.append(
            SolarBiasImpactPoint(
                slot=slot,
                raw_wh=raw_wh,
                corrected_wh=corrected_wh,
                impact_wh=corrected_wh - raw_wh,
                factor=effective_factor,
            )
        )
    return impact


def _actual_points_for_date(
    actuals_by_slot: dict[str, float],
    target_date: date,
    local_tz: ZoneInfo,
) -> list[SolarBiasInspectorPoint]:
    points: list[SolarBiasInspectorPoint] = []
    for slot, value in sorted(actuals_by_slot.items()):
        try:
            hour, minute = [int(part) for part in slot.split(":", 1)]
            timestamp = datetime.combine(
                target_date,
                time(hour=hour, minute=minute),
                tzinfo=local_tz,
            )
            points.append(
                SolarBiasInspectorPoint(
                    timestamp=timestamp.isoformat(),
                    value_wh=float(value),
                )
            )
        except (TypeError, ValueError):
            continue
    return points


async def _get_significant_states_safe(hass, start_utc, end_utc, entity_ids):
    """Wrapper around get_significant_states that handles import failures."""
    try:
        from homeassistant.components.recorder import get_instance
        from homeassistant.components.recorder.history import get_significant_states
    except Exception:
        return {}
    return await get_instance(hass).async_add_executor_job(
        partial(
            get_significant_states,
            hass,
            start_utc,
            end_utc,
            entity_ids,
            significant_changes_only=False,
        )
    )


def _house_forecast_points_from_snapshot(
    snapshot: dict | None,
    target_date: date,
    *,
    next_slot: datetime | None = None,
) -> list[dict]:
    """Extract 15-min house forecast Wh points for target_date from a cached snapshot.

    The snapshot is the adjusted house forecast, the one the battery simulation
    ran against: its nonDeferrable is the whole house, scheduled appliance
    demand included. Its deferrableConsumers band is the model's own account of
    those same appliances and must not be added on top.

    The snapshot series values are in kWh per canonical slot; convert to Wh.
    Pass next_slot for today so past slots are excluded and forecast starts
    seamlessly after the last actual slot.
    """
    if not isinstance(snapshot, dict):
        return []
    if snapshot.get("status") != "available":
        return []
    points: list[dict] = []
    for entry in snapshot.get("series") or []:
        if not isinstance(entry, dict):
            continue
        ts_raw = entry.get("timestamp")
        if not isinstance(ts_raw, str):
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=next_slot.tzinfo if next_slot else None)
        if ts.date() != target_date:
            continue
        if next_slot is not None and ts < next_slot:
            continue
        nd = entry.get("nonDeferrable") or {}
        nd_kwh = nd.get("value") if isinstance(nd, dict) else None
        if nd_kwh is None:
            continue
        try:
            nd_kwh = float(nd_kwh)
        except (TypeError, ValueError):
            continue
        points.append({"timestamp": ts_raw, "wh": nd_kwh * 1000})
    return points


def _house_forecast_current_slot_points(
    snapshot: dict | None, target_date: date
) -> list[dict]:
    """The snapshot's `currentSlot` entry as a base point, if it is on this day.

    Same shape as the series entries — `build_adjusted_house_forecast` adds
    demand to it exactly as it does to them — but it is held apart from the
    series, so it has to be asked for by name. At most one point.
    """
    if not isinstance(snapshot, dict) or snapshot.get("status") != "available":
        return []
    entry = snapshot.get("currentSlot")
    if not isinstance(entry, dict):
        return []
    ts_raw = entry.get("timestamp")
    if not isinstance(ts_raw, str):
        return []
    try:
        ts = datetime.fromisoformat(ts_raw)
    except ValueError:
        return []
    if ts.date() != target_date:
        return []
    non_deferrable = entry.get("nonDeferrable")
    value = non_deferrable.get("value") if isinstance(non_deferrable, dict) else None
    try:
        wh = float(value) * 1000
    except (TypeError, ValueError):
        return []
    return [{"timestamp": ts_raw, "wh": wh}]


def _live_price_rail(
    channel: Any,
    target_date: date,
    timezone: ZoneInfo,
) -> dict[str, float]:
    """The live price feed's points for one day, keyed by local ``HH:MM`` slot.

    The two channels do not have the same reach, and assuming they do was a
    bug. The import channel is built forward from the slot in progress, so it
    answers only for what is still ahead. The export channel is the sell-price
    entity's attribute map, which carries the whole day at its own resolution —
    *including hours that have already elapsed* — because that is how a
    day-ahead spot feed publishes.

    Each point is carried forward across the slots that follow it until the next
    one, so an hourly feed fills the quarter-hours between its points rather
    than leaving three of every four empty for something coarser to guess at.
    Slots before the feed's first point stay absent, which is what leaves the
    elapsed half of a day to the recorder.
    """
    if not isinstance(channel, dict):
        return {}
    by_slot: dict[str, float] = {}
    for point in channel.get("points") or []:
        if not isinstance(point, dict):
            continue
        raw_timestamp = point.get("timestamp")
        if not isinstance(raw_timestamp, str):
            continue
        try:
            parsed = datetime.fromisoformat(raw_timestamp)
        except ValueError:
            continue
        local_timestamp = parsed.astimezone(timezone)
        if local_timestamp.date() != target_date:
            continue
        try:
            value = float(point.get("value"))
        except (TypeError, ValueError):
            continue
        by_slot[local_timestamp.strftime("%H:%M")] = value
    if not by_slot:
        return {}

    filled: dict[str, float] = {}
    carried: float | None = None
    for minutes in range(0, MINUTES_PER_DAY, PRICE_RAIL_SLOT_MINUTES):
        label = f"{minutes // 60:02d}:{minutes % 60:02d}"
        if label in by_slot:
            carried = by_slot[label]
        if carried is not None:
            filled[label] = carried
    return filled


def _fill_import_rail_from_config(
    by_slot: dict[str, float],
    windows,
) -> None:
    """Price every slot the rail is still missing straight from the window table.

    In place and per slot, never per day: the day the import sensor ships and
    the day recorder retention runs out are each covered in part, so anything
    coarser would either blank the covered half or overwrite recorded truth with
    today's tariff.

    Imported lazily, like the other cross-module helpers here — the builder
    module pulls in Home Assistant's core, which several importers of this
    module deliberately do without.
    """
    from ..grid_price_forecast_builder import (
        GridImportPriceConfigError,
        lookup_grid_import_price,
    )

    for slot_index in range(96):
        minute_of_day = slot_index * 15
        slot = f"{minute_of_day // 60:02d}:{minute_of_day % 60:02d}"
        if slot in by_slot:
            continue
        try:
            by_slot[slot] = lookup_grid_import_price(
                windows=windows,
                minute_of_day=minute_of_day,
            )
        except GridImportPriceConfigError:
            _LOGGER.debug(
                "No import price window covers %s; leaving the slot empty", slot
            )


def _price_points(by_slot: dict[str, float]) -> list[SolarBiasPricePoint]:
    """Order a slot-keyed rail into the payload's drawable sequence."""
    return [
        SolarBiasPricePoint(slot=slot, value=value)
        for slot, value in sorted(by_slot.items())
    ]


def _energy_kwh_by_slot(points: list) -> dict[str, float]:
    """One direction's energy in kWh, keyed by the local ``HH:MM`` slot label.

    Takes the raw loader points -- ``{"timestamp", "wh"}`` -- as every other
    summing helper here does. The label is read off the timestamp's local time
    text rather than parsed into a datetime, which is what brings the energy
    series onto the same key the price rails are already built on.
    """
    by_slot: dict[str, float] = {}
    for point in points:
        timestamp = point["timestamp"]
        if not isinstance(timestamp, str) or len(timestamp) < 16:
            continue
        slot = timestamp[11:16]
        by_slot[slot] = by_slot.get(slot, 0.0) + point["wh"] / 1000.0
    return by_slot


def _money_points(
    import_points: list,
    export_points: list,
    import_price_by_slot: dict[str, float],
    export_price_by_slot: dict[str, float],
) -> list[SolarBiasMoneyPoint]:
    """Cost and gain per slot, for one vintage.

    Computed per slot and then summed, never as a day's energy times an average
    rate: the expensive hours are rarely the ones the house imported in.

    A slot appears when either direction has energy *and* a rate to value it at.
    A direction with energy but no rate contributes nothing rather than zero --
    a day past the recorder's reach has real exported kWh whose rate is simply
    unknown, and calling that "earned nothing" would be a claim the data does
    not support.

    Known limitation, once a year: on the autumn DST fall-back day the local
    ``HH:MM`` labels repeat, so the repeated hour's two occurrences share four
    slot keys. Energy accumulates across both (right), while a rail holds one
    rate per label and therefore prices the combined kWh at whichever of the two
    hours was written last. The whole inspector keys slots by local label -- the
    rails arrive that way -- so this is the convention's cost rather than this
    helper's, and pricing money by timestamp alone would only make it disagree
    with the rail drawn above it.
    """
    imported = _energy_kwh_by_slot(import_points)
    exported = _energy_kwh_by_slot(export_points)
    points: list[SolarBiasMoneyPoint] = []
    for slot_index in range(96):
        slot = f"{slot_index // 4:02d}:{(slot_index % 4) * 15:02d}"
        import_kwh = imported.get(slot)
        export_kwh = exported.get(slot)
        cost_rate = import_price_by_slot.get(slot)
        gain_rate = export_price_by_slot.get(slot)
        priced_cost = import_kwh is not None and cost_rate is not None
        priced_gain = export_kwh is not None and gain_rate is not None
        if not priced_cost and not priced_gain:
            continue
        points.append(
            SolarBiasMoneyPoint(
                slot=slot,
                cost=import_kwh * cost_rate if priced_cost else 0.0,
                gain=export_kwh * gain_rate if priced_gain else 0.0,
            )
        )
    return points


def _money_totals(
    points: list[SolarBiasMoneyPoint],
) -> SolarBiasMoneyTotals | None:
    """Sum a money series, or None where the day priced nothing at all."""
    if not points:
        return None
    cost = sum(point.cost for point in points)
    gain = sum(point.gain for point in points)
    return SolarBiasMoneyTotals(cost=cost, gain=gain, net=cost - gain)


# --- Span aggregates: bucketing the hourly statistics ------------------------
#
# Everything below folds ``{utc_hour: StatisticsRow}`` maps -- what
# ``recorder_statistics_span.query_hourly_statistics`` returns -- into buckets
# keyed by an ISO date. The hour keys are UTC instants (see that function for
# why they must not be local ones), so every fold converts before it keys. Day
# and month differ only in that key, so the folds themselves are written once.


def _bucket_key(utc_hour: datetime, bucket: str, local_tz: ZoneInfo) -> str:
    """The bucket an hour belongs to, as the ISO date the payload reports.

    A month bucket is named by its first day rather than by ``YYYY-MM`` so that
    every row of every span carries the same kind of value in ``date``: the local
    date the bucket starts on.
    """
    local_date = utc_hour.astimezone(local_tz).date()
    return (
        local_date.isoformat()
        if bucket == "day"
        else local_date.replace(day=1).isoformat()
    )


def _bucket_keys(start_date: date, end_date: date, bucket: str) -> list[str]:
    """Every bucket in the span, in order, whether or not it has data.

    The span is enumerated rather than read off the statistics, so a bucket the
    recorder holds nothing for still appears -- with nulls, which is a different
    statement from being absent.
    """
    if bucket == "day":
        keys: list[str] = []
        cursor = start_date
        while cursor <= end_date:
            keys.append(cursor.isoformat())
            cursor += timedelta(days=1)
        return keys

    keys = []
    cursor = start_date.replace(day=1)
    last = end_date.replace(day=1)
    while cursor <= last:
        keys.append(cursor.isoformat())
        cursor = _add_months(cursor, 1)
    return keys


def _add_months(anchor: date, delta: int) -> date:
    """The first of the month ``delta`` months from ``anchor``'s month."""
    total = anchor.year * 12 + (anchor.month - 1) + delta
    year, month_index = divmod(total, 12)
    return date(year, month_index + 1, 1)


def _last_day_of_month(anchor: date) -> date:
    return _add_months(anchor, 1) - timedelta(days=1)


def _trim_span_to_cap(start_date: date, end_date: date, bucket: str) -> date:
    """Move the span's start forward until it fits :data:`_MAX_AGGREGATE_BUCKETS`.

    The recent end is what a reader is looking at, so the far end is what gets
    dropped -- the same choice the day pills have always made.
    """
    cap = _MAX_AGGREGATE_BUCKETS[bucket]
    if bucket == "day":
        return max(start_date, end_date - timedelta(days=cap - 1))
    return max(start_date, _add_months(end_date.replace(day=1), -(cap - 1)))


def _energy_by_bucket(
    hourly_kwh: dict[datetime, float],
    bucket: str,
    local_tz: ZoneInfo,
) -> dict[str, float]:
    """A meter's energy per bucket, folded from its per-hour energy.

    The hourly figures arrive already differenced and reset-unwrapped from
    :mod:`..recorder_statistics_span`; the only thing left to decide here is
    which local day or month each UTC hour belongs to. Deliberately not the
    statistics ``change`` column -- see that module's docstring for what that
    column does to a meter that glitches.

    A bucket appears here only if at least one of its hours reported energy, so a
    caller can tell "nothing recorded" from "recorded zero".
    """
    totals: dict[str, float] = {}
    for utc_hour, kwh in hourly_kwh.items():
        key = _bucket_key(utc_hour, bucket, local_tz)
        totals[key] = totals.get(key, 0.0) + kwh
    return totals


def _soc_bounds_by_bucket(
    rows: dict[datetime, dict[str, Any]],
    bucket: str,
    local_tz: ZoneInfo,
) -> dict[str, tuple[float | None, float | None]]:
    """The lowest and highest SoC each bucket reached.

    Statistics carry the true per-hour min and max, so folding them is exact --
    strictly better than scanning raw states, which sees only what has not been
    purged yet and quietly reports the surviving extremes as the day's.

    The cost of that exactness: ``min``/``max`` exist only for an entity Home
    Assistant compiles statistics for, which means a SoC sensor declaring
    ``state_class: measurement``. A template or REST sensor without one reports
    ``None`` for every bucket here, where the raw-state scan this replaced would
    have read any numeric sensor. The pills draw such a battery as having no SoC
    history at all rather than showing a wrong one, which is the safer of the two
    failures but is a behaviour change worth knowing about.
    """
    bounds: dict[str, tuple[float | None, float | None]] = {}
    for utc_hour, row in rows.items():
        low_value = row.get("min")
        high_value = row.get("max")
        if low_value is None and high_value is None:
            continue
        key = _bucket_key(utc_hour, bucket, local_tz)
        low, high = bounds.get(key, (None, None))
        if low_value is not None:
            low = low_value if low is None else min(low, low_value)
        if high_value is not None:
            high = high_value if high is None else max(high, high_value)
        bounds[key] = (low, high)
    return bounds


def _money_by_bucket(
    import_kwh_by_hour: dict[datetime, float],
    export_kwh_by_hour: dict[datetime, float],
    import_rate_rows: dict[datetime, dict[str, Any]],
    export_rate_rows: dict[datetime, dict[str, Any]],
    *,
    bucket: str,
    local_tz: ZoneInfo,
    import_price_windows,
) -> dict[str, tuple[float | None, float | None]]:
    """Cost and gain per bucket, priced hour by hour.

    Never a bucket's kWh times a bucket's mean rate: the expensive hours are
    rarely the ones the house imported in, which is the same reason
    :func:`_money_points` prices the day per slot.

    Both rails follow the inspector day's precedence -- recorded history first.
    The import rate is the price sensor Helman publishes, whose hourly ``mean``
    is real tariff history from the day the feature shipped; the configured
    window table fills only the hours statistics have nothing for, per hour and
    never per bucket, because the sensor's ship date and the recorder's retention
    edge each fall mid-span and anything coarser would either blank a covered
    stretch or overwrite recorded truth with today's tariff.

    Known limitation, stated rather than engineered around: the window table is
    keyed on minute-of-day and holds no history, so buckets older than the price
    sensor are priced at *today's* tariff. That is the approximation the day view
    already makes for a pre-sensor day; a year view simply shows more of them. An
    approximate cost is more useful here than a hole.

    A second one, in the same spirit: an hour with neither a recorded rate nor a
    window covering it contributes its energy to no total at all, so a bucket
    straddling the price sensor's ship date reports the cost of the hours it
    could price without saying which those were. ``None`` is reserved for a
    bucket nothing in which could be priced. A setup with import windows
    configured -- the normal one -- always has the fallback and never lands
    here.

    The export rate has no such fill -- there is no table to fall back on, since
    a spot export price is not derivable from config. Its rows come from the
    mirror Helman publishes for exactly this reason (the configured sell-price
    entity typically declares no ``state_class`` and so has no statistics at
    all), merged with the configured entity's own rows where it has any. An hour
    neither covers is unpriced and its ``gain`` is None -- the honest answer,
    since "earned nothing" is a claim the data does not support. The day view
    lets the *live* export feed override the recorder; history has no live feed,
    so that does not carry over.

    Returns ``{bucket_key: (cost, gain)}`` with either side None where nothing in
    the bucket could be priced.
    """
    cost: dict[str, float] = {}
    gain: dict[str, float] = {}

    for utc_hour, kwh in import_kwh_by_hour.items():
        rate = _hourly_rate(import_rate_rows, utc_hour)
        if rate is None:
            rate = _config_import_rate(
                import_price_windows, utc_hour.astimezone(local_tz)
            )
        if rate is None:
            continue
        key = _bucket_key(utc_hour, bucket, local_tz)
        cost[key] = cost.get(key, 0.0) + kwh * rate

    for utc_hour, kwh in export_kwh_by_hour.items():
        rate = _hourly_rate(export_rate_rows, utc_hour)
        if rate is None:
            continue
        key = _bucket_key(utc_hour, bucket, local_tz)
        gain[key] = gain.get(key, 0.0) + kwh * rate

    return {key: (cost.get(key), gain.get(key)) for key in cost.keys() | gain.keys()}


def _prefer_rows(
    preferred: dict[datetime, dict[str, Any]],
    fallback: dict[datetime, dict[str, Any]],
) -> dict[datetime, dict[str, Any]]:
    """Two hourly series of the same quantity, merged hour by hour.

    Per hour rather than per series, for the reason the import rail already
    merges per hour: the seam between the two falls mid-span. Helman's export
    price mirror covers every hour from the moment it started publishing plus
    whatever its back-fill reached, and the configured sell-price entity covers
    whatever hours its own statistics happen to hold -- usually none, since such
    an entity typically declares no ``state_class``. Choosing one series for the
    whole span would either blank the hours only the other one covers or discard
    Helman's own record in favour of a third party's.

    Helman's own series wins where both have the hour *and its row carries a
    rate*. They mirror the same number, so they agree; where they somehow do
    not, the one Helman archived is the one it can account for. But a row is not
    the same as a reading: the span read folds five-minute tail rows onto their
    containing hour and emits a row whether or not any of them carried a mean,
    so the hour in progress can arrive present-but-empty -- and preferring it on
    presence alone would blank an hour the fallback could have priced.
    """
    if not fallback:
        return preferred
    if not preferred:
        return fallback
    merged = dict(fallback)
    for hour, row in preferred.items():
        if row.get("mean") is None and merged.get(hour, {}).get("mean") is not None:
            continue
        merged[hour] = row
    return merged


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
#: window a user can express and costs sixty lookups on a path that only runs
#: for hours long-term statistics have no recorded rate for.
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

    Imported lazily, like the other cross-module helpers here -- the builder
    module pulls in Home Assistant's core, which several importers of this module
    deliberately do without.
    """
    if import_price_windows is None:
        return None
    from ..grid_price_forecast_builder import (
        GridImportPriceConfigError,
        lookup_grid_import_price,
    )

    hour_start = local_hour.hour * 60
    total = 0.0
    covered = 0
    for offset in range(0, 60, _TARIFF_SAMPLE_MINUTES):
        try:
            total += lookup_grid_import_price(
                windows=import_price_windows,
                minute_of_day=hour_start + offset,
            )
        except GridImportPriceConfigError:
            continue
        covered += 1

    if covered == 0:
        _LOGGER.debug(
            "No import price window covers %02d:00-%02d:59; leaving the hour unpriced",
            local_hour.hour,
            local_hour.hour,
        )
        return None
    return total / covered


def _round_wh(value_kwh: float | None) -> float | None:
    """kWh from statistics, reported as the payload's Wh."""
    return None if value_kwh is None else round(value_kwh * 1000.0, 1)


def _round_kwh(value_kwh: float | None) -> float | None:
    return None if value_kwh is None else round(value_kwh, 3)


def _current_slot_start(local_now: datetime) -> datetime:
    """Return the start of the 15-min slot containing local_now.

    Imported lazily, like the other recorder_hourly_series helpers here, because
    that module imports the recorder integration at module scope.
    """
    from ..recorder_hourly_series import get_local_current_slot_start

    return get_local_current_slot_start(local_now, interval_minutes=15)


def _next_slot_boundary(local_now: datetime) -> datetime:
    """Return the start of the first 15-min slot that begins after the slot containing now."""
    return _current_slot_start(local_now) + timedelta(minutes=15)


def _slot_to_minutes(slot: str) -> int | None:
    """Turn an "HH:MM" slot label into minutes past midnight."""
    hour_text, _, minute_text = slot.partition(":")
    try:
        hour = int(hour_text)
        minute = int(minute_text)
    except ValueError:
        return None
    if not (0 <= hour < 24 and 0 <= minute < 60):
        return None
    return hour * 60 + minute


def _minutes_into_day(cutoff: datetime | None, target_date: date) -> int:
    """Minutes past midnight of target_date at cutoff, or the full day.

    A cutoff on a later date (the 23:45 slot rolls over) covers the whole day.
    """
    if cutoff is None or cutoff.date() > target_date:
        return 24 * 60
    return cutoff.hour * 60 + cutoff.minute


def _points_before(points: list[dict], *, cutoff: datetime | None) -> list[dict]:
    """Drop timestamped points that start at or after cutoff."""
    if cutoff is None:
        return points
    kept: list[dict] = []
    for point in points:
        try:
            ts = datetime.fromisoformat(point["timestamp"])
        except (KeyError, TypeError, ValueError):
            continue
        if ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)
        if ts < cutoff.replace(tzinfo=None):
            kept.append(point)
    return kept


def _slot_energy_points(
    wh_by_slot_utc: dict[datetime, float],
    target_date: date,
) -> list[dict]:
    """Turn UTC-keyed slot energies into local per-slot inspector points.

    The slot in progress is kept: it is partial, so the chart must not draw it
    (see ``_drop_running_slot``), but the day's total is an accumulation and
    counts every Wh the meter has recorded.
    """
    points: list[dict] = []
    for slot_start_utc, wh in sorted(wh_by_slot_utc.items()):
        slot_local = dt_util.as_local(slot_start_utc)
        if slot_local.date() != target_date:
            continue
        points.append({"timestamp": slot_local.isoformat(), "wh": wh})
    return points


def _point_field(point: Any, name: str) -> Any:
    """Read a field off an inspector point, dict-shaped or dataclass-shaped."""
    return point.get(name) if isinstance(point, dict) else getattr(point, name, None)


def _drop_running_slot(points: list, *, running_slot: str | None) -> list:
    """Drop actual points in or after the slot in progress.

    A slot that has not finished has only partial actuals, and comparing a
    part-slot measurement against a whole-slot forecast is a category error. The
    aggregated buckets already apply this rule; applying it here applies it to
    every actual series at the native 15-minute width too.

    Points are matched on their local ``HH:MM`` slot, carried either as a ``slot``
    label or inside an ISO ``timestamp``; every series here is already filtered to
    the day in question, and ``running_slot`` is only set for today.
    """
    if running_slot is None:
        return points

    def _slot_of(point: Any) -> str | None:
        slot = _point_field(point, "slot")
        if isinstance(slot, str):
            return slot
        timestamp = _point_field(point, "timestamp")
        if isinstance(timestamp, str) and len(timestamp) >= 16:
            return timestamp[11:16]
        return None

    return [
        point
        for point in points
        if (slot := _slot_of(point)) is None or slot < running_slot
    ]


def _bucket_house_breakdown(
    consumers: list[dict],
    consumer_kwh_by_entity: dict[str, dict[str, float]],
    key: str,
    house_wh: float | None,
) -> dict[str, Any] | None:
    """One bucket's house split into per-consumer parts and the remainder.

    The bucket-level twin of :func:`_build_house_actual_breakdown`, and
    deliberately the same arithmetic: each consumer's energy over the bucket,
    clamped at zero, and a remainder that is the house total minus their sum,
    clamped at zero so a meter that momentarily over-reports never reads
    negative. The payload keys match ``_house_breakdown_payload``'s appliance
    shape exactly, so the frontend parses a bucket's breakdown with the types it
    already has for a slot's.

    ``None`` -- and so no panel at all -- where there is nothing to split by or
    nothing to split: no consumers configured, or a bucket the house meter
    reported no energy for.
    """
    if not consumers or house_wh is None:
        return None
    appliances: list[dict[str, Any]] = []
    measured_sum = 0.0
    for consumer in consumers:
        entity_id = consumer.get("energy_entity_id")
        by_bucket = consumer_kwh_by_entity.get(entity_id) or {}
        wh = max(0.0, float(by_bucket.get(key, 0.0)) * 1000.0)
        measured_sum += wh
        appliances.append(
            {
                "entityId": entity_id,
                "label": consumer["label"],
                "wh": round(wh, 4),
                "switchEntityId": consumer.get("switch_entity_id"),
                "powerEntityId": consumer.get("power_entity_id"),
                "deferrable": bool(consumer.get("deferrable")),
                "controllableId": consumer.get("id"),
            }
        )
    return {
        "unmeasuredWh": round(max(0.0, float(house_wh) - measured_sum), 4),
        "appliances": appliances,
    }


def _build_house_actual_breakdown(
    house_actual_points: list[dict],
    consumers: list[dict],
    consumer_slot_maps: list[dict],
) -> list[SolarBiasHouseBreakdownPoint]:
    """Split each house-actual slot into per-consumer parts and the remainder.

    The remainder is the house total minus every itemised consumer that slot,
    clamped at zero so a meter that momentarily over-reports never shows a
    negative figure. It is "what no individual meter accounted for" — deliberately
    NOT the forecast's non-deferrable base load, which remains a separate concept.
    With no consumers configured — or the consumer reads having failed and yielded
    no maps — the breakdown is empty and the panel falls back to the plain house
    figure.
    """
    if not consumers or len(consumer_slot_maps) != len(consumers):
        return []
    points: list[SolarBiasHouseBreakdownPoint] = []
    for point in house_actual_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str) or len(timestamp) < 16:
            continue
        slot = timestamp[11:16]
        house_wh = point.get("wh")
        if not isinstance(house_wh, (int, float)):
            continue
        appliances: list[SolarBiasApplianceComponent] = []
        measured_sum = 0.0
        for consumer, slot_map in zip(consumers, consumer_slot_maps):
            wh = max(0.0, float(slot_map.get(slot, 0.0)))
            measured_sum += wh
            appliances.append(
                SolarBiasApplianceComponent(
                    entity_id=consumer["energy_entity_id"],
                    label=consumer["label"],
                    value_wh=round(wh, 4),
                    switch_entity_id=consumer.get("switch_entity_id"),
                    power_entity_id=consumer.get("power_entity_id"),
                    deferrable=bool(consumer.get("deferrable")),
                    controllable_id=consumer.get("id"),
                )
            )
        unmeasured_wh = round(max(0.0, float(house_wh) - measured_sum), 4)
        points.append(
            SolarBiasHouseBreakdownPoint(
                slot=slot, unmeasured_wh=unmeasured_wh, appliances=appliances
            )
        )
    return points


def _forecast_appliance_component(
    appliance_id: str,
    energy_kwh: float,
    consumer: dict | None,
    metered_by_entity_id: dict[str, dict],
) -> SolarBiasApplianceComponent:
    """One scheduled appliance's row, named and flagged as its controllable is.

    A controllable the roster does not know at all keeps its id as a last-resort
    label — it is the only name there is — but never as an entity id, and it is
    reported non-deferrable rather than assumed shiftable.
    """
    consumer = consumer or {}
    entity_id = consumer.get("energy_entity_id")
    metered = metered_by_entity_id.get(entity_id) if entity_id else None
    return SolarBiasApplianceComponent(
        entity_id=entity_id,
        label=consumer.get("label") or appliance_id,
        value_wh=round(energy_kwh * 1000.0, 4),
        switch_entity_id=(metered or {}).get("switch_entity_id"),
        power_entity_id=(metered or {}).get("power_entity_id"),
        deferrable=bool(consumer.get("deferrable")),
        controllable_id=appliance_id,
    )


def _build_house_forecast_breakdown(
    composition: dict | None,
    consumers: list[dict],
    target_date: date,
    *,
    next_slot: datetime | None,
    metered_by_entity: list[dict] | None = None,
) -> list[SolarBiasHouseBreakdownPoint]:
    """Split each forecast slot into the base load plus every appliance scheduled in it.

    The two halves come off the same pipeline snapshot the adjusted forecast was
    built from: ``original_house_forecast`` is the house before any appliance was
    added, and ``demand_points`` is what the planner added to it. Since the
    adjusted nonDeferrable is exactly their sum, the parts reconcile with the
    houseForecast series the chart draws, slot for slot — the same guarantee the
    measured breakdown gives against houseActual.

    An appliance is named by the schedulable consumer sharing its controllable id,
    so a given device is one row with one name — and one deferrability — whether
    the slot is past or future. One with no meter configured still gets a row,
    named after the controllable and carrying no entity id: there is no sensor to
    open, and passing the bare id off as one would offer the card a more-info
    dialog for an entity that does not exist.

    ``metered_by_entity`` is the measured breakdown's own roster, already merged
    with the device tree, and is how a forecast row picks up the switch and power
    sensor its measured twin shows. It is empty on a day with no past half, which
    is also a day with no measured panel to look asymmetric beside.

    With no composition to read — a cold pipeline — the breakdown is empty and the
    card falls back to the plain forecast figure.
    """
    if not isinstance(composition, dict):
        return []
    original = composition.get("original_house_forecast")
    # The slot in progress is not in the snapshot's series — it rides alongside it
    # as `currentSlot`, and the planner schedules into it like any other. Reading
    # only the series would leave the slot the user is most likely looking at as
    # the one slot with no composition at all.
    base_points = _house_forecast_current_slot_points(original, target_date) + (
        _house_forecast_points_from_snapshot(original, target_date, next_slot=next_slot)
    )
    if not base_points:
        return []

    consumer_by_id = {
        consumer["id"]: consumer for consumer in consumers if consumer.get("id")
    }
    metered_by_entity_id = {
        consumer["energy_entity_id"]: consumer for consumer in metered_by_entity or []
    }
    # Slot ids are local ISO timestamps; the breakdown is keyed "HH:MM" like the
    # rest of the inspector, so convert once here and drop other days rather than
    # letting the same clock time on two dates collide.
    demand_by_slot: dict[str, dict[str, float]] = {}
    for demand_point in composition.get("demand_points") or ():
        try:
            slot_start = datetime.fromisoformat(demand_point.slot_id)
        except (AttributeError, TypeError, ValueError):
            continue
        if slot_start.date() != target_date:
            continue
        slot = slot_start.strftime("%H:%M")
        by_appliance = demand_by_slot.setdefault(slot, {})
        by_appliance[demand_point.appliance_id] = (
            by_appliance.get(demand_point.appliance_id, 0.0)
            # The whole slot's scheduled energy, not the part of it still to come:
            # the breakdown is drawn against a whole-slot forecast, so the slot in
            # progress must report the same figure at 13:16 as at 13:29.
            + float(demand_point.scheduled_energy_kwh)
        )

    points: list[SolarBiasHouseBreakdownPoint] = []
    for point in base_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str) or len(timestamp) < 16:
            continue
        slot = timestamp[11:16]
        appliances = [
            _forecast_appliance_component(
                appliance_id,
                energy_kwh,
                consumer_by_id.get(appliance_id),
                metered_by_entity_id,
            )
            for appliance_id, energy_kwh in demand_by_slot.get(slot, {}).items()
        ]
        points.append(
            SolarBiasHouseBreakdownPoint(
                slot=slot,
                unmeasured_wh=round(float(point["wh"]), 4),
                appliances=appliances,
            )
        )
    return points


def _house_forecast_total_for_slot(
    breakdown_points: list[SolarBiasHouseBreakdownPoint],
    *,
    slot_start: datetime | None,
) -> list[dict]:
    """The one slot's house forecast total, summed from its own composition.

    The slot in progress is the only slot whose total is not read from a series:
    the archive's sample of it predates the schedule the composition describes, so
    reading the two from different vintages is what made its deferrable share melt
    across the slot. Summing the parts instead makes the total agree with them by
    construction. At most one point, and none at all on a day that is not today or
    with no composition to sum.
    """
    if slot_start is None:
        return []
    slot = slot_start.strftime("%H:%M")
    for point in breakdown_points:
        if point.slot != slot:
            continue
        total_wh = point.unmeasured_wh + sum(
            appliance.value_wh for appliance in point.appliances
        )
        return [{"timestamp": slot_start.isoformat(), "wh": round(total_wh, 4)}]
    return []


def _iter_future_snapshot_entries(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> Iterator[tuple[datetime, dict]]:
    """Yield (local timestamp, entry) for snapshot slots on target_date not yet started."""
    if not isinstance(snapshot, dict):
        return
    next_slot = _next_slot_boundary(local_now)
    for entry in snapshot.get("series") or []:
        if not isinstance(entry, dict):
            continue
        ts_raw = entry.get("timestamp")
        if not isinstance(ts_raw, str):
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except ValueError:
            continue
        ts_local = ts.astimezone(timezone) if ts.tzinfo else ts.replace(tzinfo=timezone)
        if ts_local.date() != target_date:
            continue
        if ts_local < next_slot:
            continue
        yield ts_local, entry


def _filter_battery_soc_future(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> list[dict]:
    """Extract future battery SoC forecast slots for target_date from the snapshot."""
    points: list[dict] = []
    for ts_local, entry in _iter_future_snapshot_entries(
        snapshot, target_date=target_date, local_now=local_now, timezone=timezone
    ):
        pct = entry.get("socPct")
        if pct is None:
            continue
        slot = f"{ts_local.hour:02d}:{ts_local.minute:02d}"
        points.append({"slot": slot, "pct": float(pct)})
    return points


def _filter_grid_forecast_future(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Extract future grid energy slots for target_date from the snapshot.

    Returns (net, imported, exported). Net is positive when exporting and
    negative when importing, matching gridNetKwh in the scheduling and forecast
    cards; the two sides are each positive magnitudes of their own direction.

    Both are produced because they answer different questions. The chart draws
    one signed series and wants the net; money has to price each side at its own
    rate, and a slot that both imported and exported cannot be recovered from
    the net after the fact.
    """
    net_points: list[dict] = []
    import_points: list[dict] = []
    export_points: list[dict] = []
    for ts_local, entry in _iter_future_snapshot_entries(
        snapshot, target_date=target_date, local_now=local_now, timezone=timezone
    ):
        imported = entry.get("importedFromGridKwh")
        exported = entry.get("exportedToGridKwh")
        if imported is None and exported is None:
            continue
        timestamp = ts_local.isoformat()
        imported_wh = float(imported or 0.0) * 1000.0
        exported_wh = float(exported or 0.0) * 1000.0
        net_points.append({"timestamp": timestamp, "wh": exported_wh - imported_wh})
        import_points.append({"timestamp": timestamp, "wh": imported_wh})
        export_points.append({"timestamp": timestamp, "wh": exported_wh})
    return net_points, import_points, export_points


def _filter_battery_forecast_future(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> list[dict]:
    """Extract future net battery energy slots for target_date from the snapshot.

    Positive is charging, negative is discharging, matching the sign of the
    archived batteryNetWh.
    """
    points: list[dict] = []
    for ts_local, entry in _iter_future_snapshot_entries(
        snapshot, target_date=target_date, local_now=local_now, timezone=timezone
    ):
        charged = entry.get("chargedKwh")
        discharged = entry.get("dischargedKwh")
        if charged is None and discharged is None:
            continue
        net_kwh = float(charged or 0.0) - float(discharged or 0.0)
        points.append({"timestamp": ts_local.isoformat(), "wh": net_kwh * 1000.0})
    return points


def _inspector_points_from_raw(raw: list[dict]) -> list[SolarBiasInspectorPoint]:
    return [
        SolarBiasInspectorPoint(timestamp=p["timestamp"], value_wh=float(p["wh"]))
        for p in raw
        if "timestamp" in p and "wh" in p
    ]


def _battery_soc_points_from_raw(raw: list[dict]) -> list[BatterySocPoint]:
    return [
        BatterySocPoint(slot=p["slot"], pct=float(p["pct"]))
        for p in raw
        if "slot" in p and "pct" in p
    ]
