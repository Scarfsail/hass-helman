from __future__ import annotations

from .const import (
    BATTERY_CAPACITY_FORECAST_DEFAULT_CHARGE_EFFICIENCY,
    BATTERY_CAPACITY_FORECAST_DEFAULT_DISCHARGE_EFFICIENCY,
    BATTERY_DEFAULT_MAX_POWER_W,
    DAY_CONTEXT_DEFAULT_DEFICIT_BELOW_RATIO,
    DAY_CONTEXT_DEFAULT_SURPLUS_ABOVE_RATIO,
    GRID_DEFAULT_MAX_POWER_W,
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
    SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD,
    SOLAR_BIAS_DEFAULT_CLAMP_MAX,
    SOLAR_BIAS_DEFAULT_CLAMP_MIN,
    SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_ACTUAL_FORECAST_RATIO,
    SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_EXPORT_W,
    SOLAR_BIAS_DEFAULT_DATA_GLITCH_BACKFILL_MAX_MINUTES,
    SOLAR_BIAS_DEFAULT_DATA_GLITCH_MIN_NEIGHBOUR_FORECAST_WH,
    SOLAR_BIAS_DEFAULT_ENABLED,
    SOLAR_BIAS_DEFAULT_LIVE_DAY_RATIO_ENABLED,
    SOLAR_BIAS_DEFAULT_LIVE_DAY_RATIO_FULL_CONFIDENCE_SHARE,
    SOLAR_BIAS_DEFAULT_LIVE_DAY_RATIO_MAX_RATIO,
    SOLAR_BIAS_DEFAULT_LIVE_DAY_RATIO_MIN_RATIO,
    SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS,
    SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS,
    SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
    SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS,
    SOLAR_BIAS_DEFAULT_TRAINING_TIME,
    SOLAR_DEFAULT_MAX_POWER_W,
)
from .recent_power_history import RECENT_POWER_HISTORY_DEFAULTS

#: What an unset optional config field is actually worth at runtime, keyed by
#: its dotted path in the config document.
#:
#: The editor draws these as placeholders. Values are imported from
#: ``const.py`` rather than written out here: the reader and the hint have
#: to be the same number, and the only way to guarantee that is to have one
#: number.
#:
#: A path belongs here only when a reader really falls back to that constant
#: when the key is absent -- a hint that disagrees with the runtime is worse
#: than no hint. Fields whose absence means "off"/"no limit" (the slot
#: invalidation thresholds that read as ``None``, the battery power caps) are
#: deliberately left out. A boolean or a select has no placeholder to show,
#: but its control still has to *stand* on the default rather than on an empty
#: value, so those paths belong here too and the editor reads them from here.
CONFIG_FIELD_DEFAULTS: dict[str, object] = {
    **{
        f"data_and_learning.recent_power_history.{key}": value
        for key, value in RECENT_POWER_HISTORY_DEFAULTS.items()
    },
    # ``training/batch.py`` schedules the nightly batch from what
    # ``read_bias_config`` resolves here.
    "data_and_learning.training_time": SOLAR_BIAS_DEFAULT_TRAINING_TIME,
    # solar_bias_correction/models.py: read_bias_config
    "data_and_learning.solar_bias.min_history_days": SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
    "data_and_learning.solar_bias.max_training_window_days": (
        SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS
    ),
    "data_and_learning.solar_bias.min_valid_slot_days": SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS,
    "data_and_learning.solar_bias.enabled": SOLAR_BIAS_DEFAULT_ENABLED,
    "data_and_learning.solar_bias.aggregation_method": SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD,
    "data_and_learning.solar_bias.clamp_min": SOLAR_BIAS_DEFAULT_CLAMP_MIN,
    "data_and_learning.solar_bias.clamp_max": SOLAR_BIAS_DEFAULT_CLAMP_MAX,
    "data_and_learning.solar_bias.max_interpolated_consecutive_slots": (
        SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS
    ),
    "data_and_learning.solar_bias.live_day_ratio.enabled": (
        SOLAR_BIAS_DEFAULT_LIVE_DAY_RATIO_ENABLED
    ),
    "data_and_learning.solar_bias.live_day_ratio.full_confidence_share": (
        SOLAR_BIAS_DEFAULT_LIVE_DAY_RATIO_FULL_CONFIDENCE_SHARE
    ),
    "data_and_learning.solar_bias.live_day_ratio.min_ratio": (
        SOLAR_BIAS_DEFAULT_LIVE_DAY_RATIO_MIN_RATIO
    ),
    "data_and_learning.solar_bias.live_day_ratio.max_ratio": (
        SOLAR_BIAS_DEFAULT_LIVE_DAY_RATIO_MAX_RATIO
    ),
    "data_and_learning.solar_bias.slot_invalidation.curtailment_max_export_w": (
        SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_EXPORT_W
    ),
    "data_and_learning.solar_bias.slot_invalidation.curtailment_max_actual_forecast_ratio": (
        SOLAR_BIAS_DEFAULT_CURTAILMENT_MAX_ACTUAL_FORECAST_RATIO
    ),
    "data_and_learning.solar_bias.slot_invalidation.data_glitch_min_neighbour_forecast_wh": (
        SOLAR_BIAS_DEFAULT_DATA_GLITCH_MIN_NEIGHBOUR_FORECAST_WH
    ),
    "data_and_learning.solar_bias.slot_invalidation.data_glitch_backfill_max_minutes": (
        SOLAR_BIAS_DEFAULT_DATA_GLITCH_BACKFILL_MAX_MINUTES
    ),
    # consumption_forecast_builder.py: read_house_training_window_config
    "data_and_learning.house_consumption.min_history_days": (
        HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS
    ),
    "data_and_learning.house_consumption.training_window_days": (
        HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS
    ),
    # battery_state.py: read_battery_forecast_settings
    "energy_nodes.battery.forecast.charge_efficiency": (
        BATTERY_CAPACITY_FORECAST_DEFAULT_CHARGE_EFFICIENCY
    ),
    "energy_nodes.battery.forecast.discharge_efficiency": (
        BATTERY_CAPACITY_FORECAST_DEFAULT_DISCHARGE_EFFICIENCY
    ),
    # tree_builder.py: _max_power_w, the scale the cards draw each flow at.
    # The default applies to the card scale only: an unset solar max_power keeps
    # the solar-bias glitch cap and the solar detail's stated maximum off.
    "energy_nodes.solar.max_power": SOLAR_DEFAULT_MAX_POWER_W,
    "energy_nodes.battery.max_power": BATTERY_DEFAULT_MAX_POWER_W,
    "energy_nodes.grid.max_power": GRID_DEFAULT_MAX_POWER_W,
    # automation/config.py: _read_day_context
    "automation.day_context.deficit_below_ratio": (
        DAY_CONTEXT_DEFAULT_DEFICIT_BELOW_RATIO
    ),
    "automation.day_context.surplus_above_ratio": (
        DAY_CONTEXT_DEFAULT_SURPLUS_ABOVE_RATIO
    ),
}
