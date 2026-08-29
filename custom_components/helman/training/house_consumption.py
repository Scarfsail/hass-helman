from __future__ import annotations

import functools
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..consumption_forecast_profiles import (
    ConsumerHistoryData,
    fit_house_profile,
    profile_to_dict,
    rows_to_dict,
)
from ..recorder_statistics_span import query_spliced_hourly_energy
from ..storage import TrainingArtifactsStore

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class HouseTrainingRequest:
    """The live config the fit answers, read once per run."""

    total_energy_entity_id: str | None
    training_window_days: int
    min_history_days: int
    consumers_config: list[dict[str, Any]]
    config_fingerprint: str


class HouseConsumptionTrainingJob:
    """Fits the house consumption hour-of-week profile from recorder history.

    The only place the multi-day recorder read lives. It used to sit inside
    ``ConsumptionForecastBuilder.build()`` and therefore ran four times an hour,
    scanning the training window for the house meter and again for every
    deferrable consumer — on the recorder's own executor thread, with everything
    else queued behind it. That data is daily-stable, so it belongs here.

    Never raises for a training failure: it records the outcome itself, because
    the failure record is what keeps the previous profile alive and puts the
    banner on the card.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        store: TrainingArtifactsStore,
        *,
        read_request: Callable[[], HouseTrainingRequest],
        on_trained: Callable[[], Awaitable[None]],
    ) -> None:
        self._hass = hass
        self._store = store
        self._read_request = read_request
        self._on_trained = on_trained

    async def async_train(self) -> str:
        """Fit and store the profile. Returns the ``last_outcome`` recorded."""
        request = self._read_request()
        if request.total_energy_entity_id is None:
            outcome = "not_configured"
            await self._store.async_record_house_consumption_failure(
                last_outcome=outcome,
                error_reason=None,
            )
        # An entity that no longer exists would otherwise come back from the
        # recorder as an empty window and be reported as "not enough history",
        # which sends the user looking in the wrong place.
        elif self._hass.states.get(request.total_energy_entity_id) is None:
            outcome = "entity_missing"
            _LOGGER.warning(
                "House consumption training skipped: %s does not exist",
                request.total_energy_entity_id,
            )
            await self._store.async_record_house_consumption_failure(
                last_outcome=outcome,
                error_reason=request.total_energy_entity_id,
            )
        else:
            try:
                outcome = await self._async_fit_and_store(request)
            except Exception as err:  # noqa: BLE001 - recorded, not propagated
                _LOGGER.exception("House consumption profile training failed")
                outcome = "training_failed"
                await self._store.async_record_house_consumption_failure(
                    last_outcome=outcome,
                    error_reason=str(err) or err.__class__.__name__,
                )

        await self._on_trained()
        return outcome

    async def _async_fit_and_store(self, request: HouseTrainingRequest) -> str:
        local_now = dt_util.now()
        # One read for the meter and every consumer together. They share a
        # window and a grid, and the tail of that window is a single statistics
        # query for the whole set -- so asking per entity would multiply the
        # expensive half of the read by the number of consumers to get the same
        # rows back.
        rows_by_entity = await self._async_query_hourly_history(
            [
                request.total_energy_entity_id,
                *(
                    consumer["energy_entity_id"]
                    for consumer in request.consumers_config
                ),
            ],
            request.training_window_days,
            reference_time=local_now,
        )
        house_rows = rows_by_entity.get(request.total_energy_entity_id) or []
        consumer_histories = [
            ConsumerHistoryData(
                entity_id=consumer["energy_entity_id"],
                label=consumer["label"],
                values_by_ts=rows_to_dict(
                    rows_by_entity.get(consumer["energy_entity_id"]) or []
                ),
                # The read either happened for all of them or for none: a
                # failure raises out of ``async_train``, which records
                # ``training_failed`` and keeps the previous profile.
                query_succeeded=True,
            )
            for consumer in request.consumers_config
        ]
        profile = await self._hass.async_add_executor_job(
            functools.partial(
                fit_house_profile,
                house_rows,
                consumer_histories,
                today_local=local_now.date(),
            )
        )
        # Stored either way: ``assemble`` derives the insufficient_history
        # status from the profile's own history_days, so storing the short
        # profile is what lets the card say how short it is rather than just
        # "unavailable".
        outcome = (
            "insufficient_history"
            if profile.history_days < request.min_history_days
            else "profile_trained"
        )
        await self._store.async_record_house_consumption(
            data=profile_to_dict(profile),
            fingerprint=request.config_fingerprint,
            trained_at=dt_util.now().isoformat(),
            last_outcome=outcome,
        )
        return outcome

    async def _async_query_hourly_history(
        self,
        entity_ids: Sequence[str],
        training_window_days: int,
        *,
        reference_time,
    ) -> dict[str, list[dict]]:
        """Every entity's hourly energy over the training window, as raw rows.

        The window is spliced -- raw states for the recent part, hourly
        long-term statistics for whatever the recorder has already purged --
        because a configured ``training_window_days`` is a statement about how
        much history to fit on, not about how much of it survived
        ``purge_keep_days``. The row shape is unchanged: ``fit_house_profile``
        cannot tell which table an hour came from, and must not have to.
        """
        local_current_hour = reference_time.replace(
            minute=0,
            second=0,
            microsecond=0,
        )
        local_midnight = local_current_hour.replace(hour=0)
        energy_by_entity = await query_spliced_hourly_energy(
            self._hass,
            entity_ids,
            local_start=local_midnight - timedelta(days=training_window_days),
            local_end=local_current_hour,
        )
        return {
            entity_id: [
                {
                    "start": hour_start.timestamp(),
                    "change": change,
                }
                for hour_start, change in sorted(values_by_hour.items())
            ]
            for entity_id, values_by_hour in energy_by_entity.items()
        }
