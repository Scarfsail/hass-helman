from __future__ import annotations

from typing import Any

from homeassistant.util import dt as dt_util

from .const import (
    BATTERY_CAPACITY_FORECAST_DEFAULT_CHARGE_EFFICIENCY,
    BATTERY_CAPACITY_FORECAST_DEFAULT_DISCHARGE_EFFICIENCY,
    BATTERY_CAPACITY_FORECAST_HORIZON_HOURS,
)


class BatteryCapacityForecastBuilder:
    def __init__(self, config: dict[str, Any]) -> None:
        self._config = config

    def build(self) -> dict[str, Any]:
        power_devices = self._read_dict(self._config.get("power_devices"))
        battery_config = self._read_dict(power_devices.get("battery"))
        forecast_config = self._read_dict(battery_config.get("forecast"))

        charge_efficiency = self._read_probability(
            forecast_config.get("charge_efficiency"),
            BATTERY_CAPACITY_FORECAST_DEFAULT_CHARGE_EFFICIENCY,
        )
        discharge_efficiency = self._read_probability(
            forecast_config.get("discharge_efficiency"),
            BATTERY_CAPACITY_FORECAST_DEFAULT_DISCHARGE_EFFICIENCY,
        )
        max_charge_power_w = self._read_positive_float(
            forecast_config.get("max_charge_power_w")
        )
        max_discharge_power_w = self._read_positive_float(
            forecast_config.get("max_discharge_power_w")
        )

        return self._make_payload(
            status="not_configured",
            charge_efficiency=charge_efficiency,
            discharge_efficiency=discharge_efficiency,
            max_charge_power_w=max_charge_power_w,
            max_discharge_power_w=max_discharge_power_w,
        )

    @staticmethod
    def _make_payload(
        *,
        status: str,
        charge_efficiency: float,
        discharge_efficiency: float,
        max_charge_power_w: float | None,
        max_discharge_power_w: float | None,
    ) -> dict[str, Any]:
        return {
            "status": status,
            "generatedAt": dt_util.now().isoformat(),
            "startedAt": None,
            "unit": "kWh",
            "resolution": "hour",
            "horizonHours": BATTERY_CAPACITY_FORECAST_HORIZON_HOURS,
            "model": None,
            "nominalCapacityKwh": None,
            "currentRemainingEnergyKwh": None,
            "currentSoc": None,
            "minSoc": None,
            "maxSoc": None,
            "chargeEfficiency": charge_efficiency,
            "dischargeEfficiency": discharge_efficiency,
            "maxChargePowerW": max_charge_power_w,
            "maxDischargePowerW": max_discharge_power_w,
            "partialReason": None,
            "coverageUntil": None,
            "series": [],
        }

    @staticmethod
    def _read_dict(raw_value: Any) -> dict[str, Any]:
        if isinstance(raw_value, dict):
            return raw_value
        return {}

    @staticmethod
    def _read_float(raw_value: Any) -> float | None:
        if isinstance(raw_value, bool) or raw_value is None:
            return None

        if isinstance(raw_value, (int, float)):
            return float(raw_value)

        if isinstance(raw_value, str):
            stripped = raw_value.strip()
            if not stripped or stripped.lower() in {"unknown", "unavailable", "none"}:
                return None

            try:
                return float(stripped)
            except ValueError:
                return None

        return None

    @classmethod
    def _read_positive_float(cls, raw_value: Any) -> float | None:
        parsed = cls._read_float(raw_value)
        if parsed is None or parsed <= 0:
            return None
        return parsed

    @classmethod
    def _read_probability(cls, raw_value: Any, default: float) -> float:
        parsed = cls._read_float(raw_value)
        if parsed is None or parsed <= 0 or parsed > 1:
            return default
        return parsed
