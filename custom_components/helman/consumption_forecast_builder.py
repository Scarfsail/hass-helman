from __future__ import annotations

from typing import Any


class ConsumptionForecastBuilder:
    """Builds the house_consumption forecast payload.

    Increment 1: returns a well-formed stub with status not_configured.
    """

    def __init__(self, config: dict) -> None:
        self._config = config

    def build(self) -> dict[str, Any]:
        power_devices = self._read_dict(self._config.get("power_devices"))
        house_config = self._read_dict(power_devices.get("house"))
        forecast_config = self._read_dict(house_config.get("forecast"))

        total_energy_entity_id = self._read_entity_id(
            forecast_config.get("total_energy_entity_id")
        )
        min_history_days = forecast_config.get("min_history_days", 14)
        training_window_days = forecast_config.get("training_window_days", 42)
        if total_energy_entity_id is None:
            return {
                "status": "not_configured",
                "generatedAt": None,
                "unit": "kWh",
                "resolution": "hour",
                "horizonHours": 168,
                "trainingWindowDays": training_window_days,
                "historyDaysAvailable": 0,
                "requiredHistoryDays": min_history_days,
                "model": None,
                "series": [],
            }

        # Increment 2+ will implement actual forecast generation here.
        return {
            "status": "not_configured",
            "generatedAt": None,
            "unit": "kWh",
            "resolution": "hour",
            "horizonHours": 168,
            "trainingWindowDays": training_window_days,
            "historyDaysAvailable": 0,
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
