from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..const import (
    SOLAR_BIAS_DEFAULT_ENABLED,
    SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
    SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS,
    SOLAR_BIAS_DEFAULT_TRAINING_TIME,
    SOLAR_BIAS_DEFAULT_CLAMP_MIN,
    SOLAR_BIAS_DEFAULT_CLAMP_MAX,
    SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS,
    SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD,
    SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS,
    SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_EXPORT_W,
    SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_ACTUAL_FORECAST_RATIO,
)


@dataclass
class BiasConfig:
    enabled: bool
    min_history_days: int
    training_time: str
    clamp_min: float
    clamp_max: float
    daily_energy_entity_ids: list[str]
    total_energy_entity_id: str | None
    min_valid_slot_days: int = SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS
    aggregation_method: str = SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD
    max_interpolated_consecutive_slots: int = (
        SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS
    )
    slot_invalidation_max_battery_soc_percent: float | None = None
    slot_invalidation_curtailment_max_export_w: float = (
        SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_EXPORT_W
    )
    slot_invalidation_curtailment_max_actual_forecast_ratio: float = (
        SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_ACTUAL_FORECAST_RATIO
    )
    slot_invalidation_data_glitch_max_slot_wh: float | None = None
    slot_invalidation_data_glitch_min_neighbour_forecast_wh: float = 200.0
    slot_invalidation_data_glitch_backfill_max_minutes: int = 120
    max_training_window_days: int = SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS


@dataclass
class TrainerSample:
    date: str
    forecast_wh: float
    slot_forecast_wh: dict[str, float]


@dataclass
class SolarActualsWindow:
    slot_actuals_by_date: dict[str, dict[str, float]]
    invalidated_slots_by_date: dict[str, set[str]] = field(default_factory=dict)


@dataclass
class SolarBiasProfile:
    factors: dict[str, float]
    omitted_slots: list[str]


@dataclass
class SolarBiasMetadata:
    trained_at: str
    training_config_fingerprint: str
    usable_days: int
    dropped_days: list[dict[str, str]]
    factor_min: float | None
    factor_max: float | None
    factor_median: float | None
    omitted_slot_count: int
    last_outcome: str
    invalidated_slots_by_date: dict[str, list[str]] = field(default_factory=dict)
    invalidated_slot_count: int = 0
    error_reason: str | None = None
    interpolated_slot_count: int = 0


@dataclass
class TrainingOutcome:
    profile: SolarBiasProfile
    metadata: SolarBiasMetadata
    explainability: SolarBiasTrainingExplainability | None = None


@dataclass
class SolarBiasExplainability:
    fallback_reason: str | None
    trained_at: str | None
    usable_days: int
    dropped_days: int
    omitted_slot_count: int
    factor_min: float | None
    factor_max: float | None
    factor_median: float | None
    error: str | None = None


@dataclass
class SolarBiasAdjustmentResult:
    status: str
    effective_variant: str | None
    adjusted_points: list[dict[str, Any]]
    explainability: SolarBiasExplainability | None


@dataclass
class SolarBiasInspectorPoint:
    timestamp: str
    value_wh: float


@dataclass
class SolarBiasFactorPoint:
    slot: str
    factor: float


@dataclass
class SolarBiasPricePoint:
    """What a kilowatt-hour cost, or earned, in one slot of the inspected day.

    A rate rather than a quantity, so it is neither summed nor rebucketed the
    way the energy series are: two slots of the same price aggregate to that
    price, not to twice it.
    """

    slot: str  # "HH:MM"
    value: float


@dataclass
class SolarBiasImpactPoint:
    slot: str
    raw_wh: float | None
    corrected_wh: float | None
    impact_wh: float | None
    factor: float | None


@dataclass
class BatterySocPoint:
    slot: str  # "HH:MM"
    pct: float


@dataclass
class SolarBiasApplianceComponent:
    """One consumer's contribution to a slot's house demand.

    ``switch_entity_id`` is the device's controlling switch where the power card
    knows one, so the inspector can offer the very same control; None otherwise.

    ``entity_id`` is the device's energy stat (the series the breakdown is summed
    from); ``power_entity_id`` is the live power sensor the power card reads, where
    the tree knows one, so clicking a box opens the same W sensor the card does.
    It is None for a scheduled appliance with no meter configured, which has
    demand to report but no sensor to open.

    ``deferrable`` says the consumer is a shiftable appliance — it came from the
    configured deferrable controllables rather than from the device tree alone. It
    is a property of the device, not of the slot: an appliance nothing scheduled
    still counts as deferrable in the slot it happened to run in.

    ``controllable_id`` is the controllable the row belongs to — the key the
    schedule stores assignments under — where there is one, so the inspector can
    resolve what is scheduled for the row right now. It is None for a consumer
    the roster names no controllable for.
    """

    entity_id: str | None
    label: str
    value_wh: float
    switch_entity_id: str | None = None
    power_entity_id: str | None = None
    deferrable: bool = False
    controllable_id: str | None = None


@dataclass
class SolarBiasHouseBreakdownPoint:
    """A slot's house demand split into each itemised consumer and the remainder.

    On the measured side ``unmeasured_wh`` is what no individual meter accounted
    for — the analogue of the power card's "unmeasured" node, NOT the forecast's
    non-deferrable base load. On the forecast side it IS that base load: the
    house forecast before any scheduled appliance was added to it. Either way it
    is "the part this slot's itemised appliances do not explain", which is why
    one shape and one renderer serve both.

    The parts reconcile with the matching house series: ``unmeasured_wh`` plus the
    sum of ``appliances`` equals that slot's houseActual/houseForecast value.
    """

    slot: str  # "HH:MM"
    unmeasured_wh: float
    appliances: list[SolarBiasApplianceComponent]


@dataclass
class BatterySocBoundsPoint:
    """The SoC window the battery was held within over one slot.

    The bounds are entities the inverter and its automations move during the
    day, so they are a series, not a constant: a slot's floor is whatever the
    floor was while that slot elapsed.
    """

    slot: str  # "HH:MM"
    min_pct: float | None
    max_pct: float | None


@dataclass
class SolarBiasContributionRow:
    date: str
    forecast_wh: float | None
    actual_wh: float | None
    ratio: float | None
    status: str
    reason: str | None = None


@dataclass
class SolarBiasSlotExplainability:
    factor: float | None
    raw_ratio: float | None
    clamped: bool
    forecast_sum_wh: float
    actual_sum_wh: float
    rows: list[SolarBiasContributionRow]
    interpolated: bool = False
    interpolation_anchors: tuple[str | None, str | None] | None = None


@dataclass
class SolarBiasTrainingExplainability:
    trained_at: str
    aggregation_method: str
    slots: dict[str, SolarBiasSlotExplainability]


@dataclass
class SolarBiasInspectorSeries:
    raw: list[SolarBiasInspectorPoint]
    corrected: list[SolarBiasInspectorPoint]
    actual: list[SolarBiasInspectorPoint]
    factors: list[SolarBiasFactorPoint]
    invalidated: list[SolarBiasInspectorPoint] = field(default_factory=list)
    impact: list[SolarBiasImpactPoint] = field(default_factory=list)
    house_forecast: list[SolarBiasInspectorPoint] = field(default_factory=list)
    house_actual: list[SolarBiasInspectorPoint] = field(default_factory=list)
    house_actual_breakdown: list[SolarBiasHouseBreakdownPoint] = field(
        default_factory=list
    )
    house_forecast_breakdown: list[SolarBiasHouseBreakdownPoint] = field(
        default_factory=list
    )
    battery_soc_forecast: list[BatterySocPoint] = field(default_factory=list)
    battery_soc_actual: list[BatterySocPoint] = field(default_factory=list)
    grid_forecast: list[SolarBiasInspectorPoint] = field(default_factory=list)
    grid_actual: list[SolarBiasInspectorPoint] = field(default_factory=list)
    #: The two grid directions kept apart, alongside the signed net above. Money
    #: prices each at its own rate, which no rate applied to the net reproduces.
    grid_import_forecast: list[SolarBiasInspectorPoint] = field(default_factory=list)
    grid_export_forecast: list[SolarBiasInspectorPoint] = field(default_factory=list)
    grid_import_actual: list[SolarBiasInspectorPoint] = field(default_factory=list)
    grid_export_actual: list[SolarBiasInspectorPoint] = field(default_factory=list)
    battery_forecast: list[SolarBiasInspectorPoint] = field(default_factory=list)
    battery_actual: list[SolarBiasInspectorPoint] = field(default_factory=list)
    #: What the grid charged and paid per slot. Both rails span the whole day —
    #: recorder history behind the clock, the live price feed ahead of it — so
    #: unlike the forecast/actual pairs above there is no second series to hold
    #: the other half of the day.
    import_price: list[SolarBiasPricePoint] = field(default_factory=list)
    export_price: list[SolarBiasPricePoint] = field(default_factory=list)


@dataclass
class SolarBiasInspectorTotals:
    raw_wh: float | None
    corrected_wh: float | None
    actual_wh: float | None
    house_forecast_wh: float | None = None
    house_actual_wh: float | None = None
    grid_forecast_wh: float | None = None
    grid_actual_wh: float | None = None
    battery_forecast_wh: float | None = None
    battery_actual_wh: float | None = None


@dataclass
class SolarBiasInspectorAvailability:
    has_raw_forecast: bool
    has_corrected_forecast: bool
    has_actuals: bool
    has_profile: bool
    has_invalidated: bool = False
    has_house_forecast: bool = False
    has_house_actual: bool = False
    has_house_actual_breakdown: bool = False
    has_house_forecast_breakdown: bool = False
    has_battery_soc_forecast: bool = False
    has_battery_soc_actual: bool = False
    has_grid_forecast: bool = False
    has_grid_actual: bool = False
    has_battery_forecast: bool = False
    has_battery_actual: bool = False
    has_import_price: bool = False
    has_export_price: bool = False


@dataclass
class SolarBiasInspectorDay:
    date: str
    timezone: str
    status: str
    effective_variant: str | None
    trained_at: str | None
    min_date: str
    max_date: str
    series: SolarBiasInspectorSeries
    totals: SolarBiasInspectorTotals
    availability: SolarBiasInspectorAvailability
    is_today: bool
    is_future: bool
    training_explainability: SolarBiasTrainingExplainability | None = None
    battery_soc_bounds: list[BatterySocBoundsPoint] = field(default_factory=list)
    #: The power card's configured title for unmetered load; the breakdown reuses
    #: it so both views name the concept identically. None leaves the card's own
    #: localized fallback in place.
    house_unmeasured_label: str | None = None
    #: Currency-per-energy unit both price rails are quoted in, e.g. "CZK/kWh".
    #: One field rather than two: import and export are the two sides of the
    #: same meter and share a y-scale in the strip, so a payload that quoted
    #: them differently would be undrawable anyway.
    price_unit: str | None = None


def inspector_day_to_payload(day: SolarBiasInspectorDay) -> dict[str, Any]:
    return {
        "date": day.date,
        "timezone": day.timezone,
        "status": day.status,
        "effectiveVariant": day.effective_variant,
        "trainedAt": day.trained_at,
        "range": {
            "minDate": day.min_date,
            "maxDate": day.max_date,
            "canGoPrevious": day.date > day.min_date,
            "canGoNext": day.date < day.max_date,
            "isToday": day.is_today,
            "isFuture": day.is_future,
        },
        "series": {
            "raw": [_inspector_point_payload(point) for point in day.series.raw],
            "corrected": [
                _inspector_point_payload(point) for point in day.series.corrected
            ],
            "actual": [_inspector_point_payload(point) for point in day.series.actual],
            "invalidated": [
                _inspector_point_payload(point) for point in day.series.invalidated
            ],
            "factors": [
                {"slot": point.slot, "factor": point.factor}
                for point in day.series.factors
            ],
            "impact": [_impact_point_payload(point) for point in day.series.impact],
            "houseForecast": [_inspector_point_payload(p) for p in day.series.house_forecast],
            "houseActual": [_inspector_point_payload(p) for p in day.series.house_actual],
            "houseActualBreakdown": [
                _house_breakdown_payload(p) for p in day.series.house_actual_breakdown
            ],
            "houseForecastBreakdown": [
                _house_breakdown_payload(p) for p in day.series.house_forecast_breakdown
            ],
            "batterySocForecast": [
                {"slot": p.slot, "pct": p.pct} for p in day.series.battery_soc_forecast
            ],
            "batterySocActual": [
                {"slot": p.slot, "pct": p.pct} for p in day.series.battery_soc_actual
            ],
            "gridForecast": [_inspector_point_payload(p) for p in day.series.grid_forecast],
            "gridActual": [_inspector_point_payload(p) for p in day.series.grid_actual],
            "gridImportForecast": [
                _inspector_point_payload(p) for p in day.series.grid_import_forecast
            ],
            "gridExportForecast": [
                _inspector_point_payload(p) for p in day.series.grid_export_forecast
            ],
            "gridImportActual": [
                _inspector_point_payload(p) for p in day.series.grid_import_actual
            ],
            "gridExportActual": [
                _inspector_point_payload(p) for p in day.series.grid_export_actual
            ],
            "batteryForecast": [
                _inspector_point_payload(p) for p in day.series.battery_forecast
            ],
            "batteryActual": [
                _inspector_point_payload(p) for p in day.series.battery_actual
            ],
            "importPrice": [
                {"slot": point.slot, "value": point.value}
                for point in day.series.import_price
            ],
            "exportPrice": [
                {"slot": point.slot, "value": point.value}
                for point in day.series.export_price
            ],
        },
        "totals": {
            "rawWh": day.totals.raw_wh,
            "correctedWh": day.totals.corrected_wh,
            "actualWh": day.totals.actual_wh,
            "houseForecastWh": day.totals.house_forecast_wh,
            "houseActualWh": day.totals.house_actual_wh,
            "gridForecastWh": day.totals.grid_forecast_wh,
            "gridActualWh": day.totals.grid_actual_wh,
            "batteryForecastWh": day.totals.battery_forecast_wh,
            "batteryActualWh": day.totals.battery_actual_wh,
        },
        "availability": {
            "hasRawForecast": day.availability.has_raw_forecast,
            "hasCorrectedForecast": day.availability.has_corrected_forecast,
            "hasActuals": day.availability.has_actuals,
            "hasProfile": day.availability.has_profile,
            "hasInvalidated": day.availability.has_invalidated,
            "hasHouseForecast": day.availability.has_house_forecast,
            "hasHouseActual": day.availability.has_house_actual,
            "hasHouseActualBreakdown": day.availability.has_house_actual_breakdown,
            "hasHouseForecastBreakdown": day.availability.has_house_forecast_breakdown,
            "hasBatterySocForecast": day.availability.has_battery_soc_forecast,
            "hasBatterySocActual": day.availability.has_battery_soc_actual,
            "hasGridForecast": day.availability.has_grid_forecast,
            "hasGridActual": day.availability.has_grid_actual,
            "hasBatteryForecast": day.availability.has_battery_forecast,
            "hasBatteryActual": day.availability.has_battery_actual,
            "hasImportPrice": day.availability.has_import_price,
            "hasExportPrice": day.availability.has_export_price,
        },
        "houseUnmeasuredLabel": day.house_unmeasured_label,
        "priceUnit": day.price_unit,
        "batterySocBounds": [
            {"slot": p.slot, "minPct": p.min_pct, "maxPct": p.max_pct}
            for p in day.battery_soc_bounds
        ],
        "trainingExplainability": training_explainability_to_payload(
            day.training_explainability
        ),
    }


def _inspector_point_payload(point: SolarBiasInspectorPoint) -> dict[str, Any]:
    return {"timestamp": point.timestamp, "valueWh": point.value_wh}


def _house_breakdown_payload(point: SolarBiasHouseBreakdownPoint) -> dict[str, Any]:
    return {
        "slot": point.slot,
        "unmeasuredWh": point.unmeasured_wh,
        "appliances": [
            {
                "entityId": c.entity_id,
                "label": c.label,
                "wh": c.value_wh,
                "switchEntityId": c.switch_entity_id,
                "powerEntityId": c.power_entity_id,
                "deferrable": c.deferrable,
                "controllableId": c.controllable_id,
            }
            for c in point.appliances
        ],
    }


def _impact_point_payload(point: SolarBiasImpactPoint) -> dict[str, Any]:
    return {
        "slot": point.slot,
        "rawWh": point.raw_wh,
        "correctedWh": point.corrected_wh,
        "impactWh": point.impact_wh,
        "factor": point.factor,
    }


def training_explainability_to_payload(
    explainability: SolarBiasTrainingExplainability | None,
) -> dict[str, Any] | None:
    if explainability is None:
        return None
    return {
        "trainedAt": explainability.trained_at,
        "aggregationMethod": explainability.aggregation_method,
        "slots": {
            slot: {
                "factor": details.factor,
                "rawRatio": details.raw_ratio,
                "clamped": details.clamped,
                "forecastSumWh": details.forecast_sum_wh,
                "actualSumWh": details.actual_sum_wh,
                "interpolated": details.interpolated,
                "interpolationAnchors": (
                    {
                        "left": details.interpolation_anchors[0],
                        "right": details.interpolation_anchors[1],
                    }
                    if details.interpolation_anchors is not None
                    else None
                ),
                "rows": [
                    {
                        "date": row.date,
                        "forecastWh": row.forecast_wh,
                        "actualWh": row.actual_wh,
                        "ratio": row.ratio,
                        "status": row.status,
                        "reason": row.reason,
                    }
                    for row in details.rows
                ],
            }
            for slot, details in sorted(explainability.slots.items())
        },
    }


def _read_number(raw_value: Any, default: float) -> float:
    if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
        return float(raw_value)
    return default


def read_bias_config(config: dict[str, Any]) -> BiasConfig:
    forecast = (
        config.get("power_devices", {}).get("solar", {}).get("forecast", {})
    )
    bias = forecast.get("bias_correction") or {}

    enabled = bias.get("enabled", SOLAR_BIAS_DEFAULT_ENABLED)
    min_history_days = bias.get(
        "min_history_days", SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS
    )
    max_training_window_days = bias.get(
        "max_training_window_days",
        bias.get(
            "training_window_days", SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS
        ),
    )
    # Top-level since v6 — the schedule drives the whole nightly training
    # batch. The retired bias key still wins when present so a document the
    # migration has not touched yet keeps its authored time.
    training_time = bias.get(
        "training_time",
        config.get("training_time", SOLAR_BIAS_DEFAULT_TRAINING_TIME),
    )
    clamp_min = bias.get("clamp_min", SOLAR_BIAS_DEFAULT_CLAMP_MIN)
    clamp_max = bias.get("clamp_max", SOLAR_BIAS_DEFAULT_CLAMP_MAX)
    raw_min_valid_slot_days = bias.get(
        "min_valid_slot_days", SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS
    )
    min_valid_slot_days = SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS
    if isinstance(raw_min_valid_slot_days, (int, float)) and not isinstance(
        raw_min_valid_slot_days, bool
    ):
        min_valid_slot_days = int(raw_min_valid_slot_days)
    aggregation_method = bias.get("aggregation_method", SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD)
    raw_max_interp = bias.get(
        "max_interpolated_consecutive_slots",
        SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS,
    )
    max_interpolated_consecutive_slots = (
        SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS
    )
    if isinstance(raw_max_interp, (int, float)) and not isinstance(raw_max_interp, bool):
        max_interpolated_consecutive_slots = max(0, int(raw_max_interp))
    slot_invalidation = bias.get("slot_invalidation") or {}

    daily_energy_entity_ids = forecast.get("daily_energy_entity_ids") or []
    total_energy_entity_id = bias.get("total_energy_entity_id") or forecast.get(
        "total_energy_entity_id"
    )
    max_battery_soc_percent = slot_invalidation.get("max_battery_soc_percent")
    slot_invalidation_max_battery_soc_percent = None
    if isinstance(max_battery_soc_percent, (int, float)) and not isinstance(
        max_battery_soc_percent, bool
    ):
        slot_invalidation_max_battery_soc_percent = float(max_battery_soc_percent)

    curtailment_max_export_w = _read_number(
        slot_invalidation.get("curtailment_max_export_w"),
        SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_EXPORT_W,
    )
    curtailment_max_actual_forecast_ratio = _read_number(
        slot_invalidation.get("curtailment_max_actual_forecast_ratio"),
        SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_ACTUAL_FORECAST_RATIO,
    )

    glitch_max_slot_wh = slot_invalidation.get("data_glitch_max_slot_wh")
    slot_invalidation_data_glitch_max_slot_wh: float | None = None
    if isinstance(glitch_max_slot_wh, (int, float)) and not isinstance(
        glitch_max_slot_wh, bool
    ):
        slot_invalidation_data_glitch_max_slot_wh = float(glitch_max_slot_wh)

    glitch_min_neighbour = slot_invalidation.get(
        "data_glitch_min_neighbour_forecast_wh", 200.0
    )
    slot_invalidation_data_glitch_min_neighbour_forecast_wh = 200.0
    if isinstance(glitch_min_neighbour, (int, float)) and not isinstance(
        glitch_min_neighbour, bool
    ):
        slot_invalidation_data_glitch_min_neighbour_forecast_wh = float(
            glitch_min_neighbour
        )

    glitch_backfill = slot_invalidation.get("data_glitch_backfill_max_minutes", 120)
    slot_invalidation_data_glitch_backfill_max_minutes = 120
    if isinstance(glitch_backfill, (int, float)) and not isinstance(
        glitch_backfill, bool
    ):
        slot_invalidation_data_glitch_backfill_max_minutes = int(glitch_backfill)

    return BiasConfig(
        enabled=enabled,
        min_history_days=min_history_days,
        training_time=training_time,
        clamp_min=clamp_min,
        clamp_max=clamp_max,
        min_valid_slot_days=min_valid_slot_days,
        aggregation_method=aggregation_method,
        max_interpolated_consecutive_slots=max_interpolated_consecutive_slots,
        daily_energy_entity_ids=daily_energy_entity_ids,
        total_energy_entity_id=total_energy_entity_id,
        slot_invalidation_max_battery_soc_percent=(
            slot_invalidation_max_battery_soc_percent
        ),
        slot_invalidation_curtailment_max_export_w=curtailment_max_export_w,
        slot_invalidation_curtailment_max_actual_forecast_ratio=(
            curtailment_max_actual_forecast_ratio
        ),
        slot_invalidation_data_glitch_max_slot_wh=(
            slot_invalidation_data_glitch_max_slot_wh
        ),
        slot_invalidation_data_glitch_min_neighbour_forecast_wh=(
            slot_invalidation_data_glitch_min_neighbour_forecast_wh
        ),
        slot_invalidation_data_glitch_backfill_max_minutes=(
            slot_invalidation_data_glitch_backfill_max_minutes
        ),
        max_training_window_days=max_training_window_days,
    )
