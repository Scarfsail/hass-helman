from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)


class ConsumptionForecastBuilder:
    """Builds the house_consumption forecast payload.

    Increment 2: queries Recorder statistics, computes history availability,
    returns status-only payload (no forecast model yet).
    """

    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self._hass = hass
        self._config = config

    async def build(self) -> dict[str, Any]:
        power_devices = self._read_dict(self._config.get("power_devices"))
        house_config = self._read_dict(power_devices.get("house"))
        forecast_config = self._read_dict(house_config.get("forecast"))

        total_energy_entity_id = self._read_entity_id(
            forecast_config.get("total_energy_entity_id")
        )
        min_history_days = forecast_config.get("min_history_days", 14)
        training_window_days = forecast_config.get("training_window_days", 42)

        if total_energy_entity_id is None:
            return self._make_payload(
                status="not_configured",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
            )

        try:
            history_days = await self._query_history_days(
                total_energy_entity_id, training_window_days
            )
        except Exception:
            _LOGGER.exception(
                "Failed to query Recorder statistics for %s",
                total_energy_entity_id,
            )
            return self._make_payload(
                status="unavailable",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
            )

        if history_days < min_history_days:
            return self._make_payload(
                status="insufficient_history",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                history_days=history_days,
            )

        # Increment 3+ will build the actual forecast series here.
        return self._make_payload(
            status="available",
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            history_days=history_days,
        )

    async def _query_history_days(
        self, entity_id: str, training_window_days: int
    ) -> int:
        """Query Recorder statistics and return the number of days of usable history."""
        local_now = dt_util.now()
        local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        start_time = dt_util.as_utc(
            local_midnight - timedelta(days=training_window_days)
        )

        stat = await get_instance(self._hass).async_add_executor_job(
            statistics_during_period,
            self._hass,
            start_time,
            None,
            {entity_id},
            "hour",
            {"energy": "kWh"},
            {"change"},
        )

        rows = stat.get(entity_id, [])
        if not rows:
            return 0

        oldest_ts = rows[0]["start"]
        oldest_local = dt_util.as_local(dt_util.utc_from_timestamp(oldest_ts))
        today_local = local_now.date()
        return (today_local - oldest_local.date()).days

    @staticmethod
    def _make_payload(
        *,
        status: str,
        training_window_days: int,
        min_history_days: int,
        history_days: int = 0,
    ) -> dict[str, Any]:
        return {
            "status": status,
            "generatedAt": dt_util.now().isoformat(),
            "unit": "kWh",
            "resolution": "hour",
            "horizonHours": 168,
            "trainingWindowDays": training_window_days,
            "historyDaysAvailable": history_days,
            "requiredHistoryDays": min_history_days,
            "model": None,
            "series": [],
        }

    @staticmethod
    def _read_dict(raw_value: Any) -> dict[str, Any]:
        if isinstance(raw_value, dict):
            return raw_value
        return {}

    @staticmethod
    def _read_entity_id(raw_value: Any) -> str | None:
        if isinstance(raw_value, str) and raw_value.strip():
            return raw_value.strip()
        return None

    @staticmethod
    def _read_deferrable_consumers(raw_value: Any) -> list[dict[str, Any]]:
        if not isinstance(raw_value, list):
            return []
        result: list[dict[str, Any]] = []
        for item in raw_value:
            if not isinstance(item, dict):
                continue
            entity_id = item.get("energy_entity_id")
            if not isinstance(entity_id, str) or not entity_id.strip():
                continue
            result.append({
                "energy_entity_id": entity_id.strip(),
                "label": item.get("label", entity_id.strip()),
            })
        return result
