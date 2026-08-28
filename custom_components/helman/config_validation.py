from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .automation.config import AutomationConfigError, read_automation_config
from .automation.optimizer import build_optimizer
from .automation.spec import OPTIMIZER_SPECS
from .appliances.config import build_appliances_runtime_registry
from .appliances.climate_appliance import (
    ClimateApplianceConfigError,
    read_climate_appliance,
)
from .appliances.ev_charger import EvChargerConfigError, read_ev_charger_appliance
from .appliances.generic_appliance import (
    GenericApplianceConfigError,
    read_generic_appliance,
)
from .battery_state import describe_battery_entity_config_issue
from .grid_price_forecast_builder import (
    GridImportPriceConfigError,
    read_grid_import_price_config,
)
from .controllables.config import (
    CONTROLLABLE_ID_INVERTER,
    read_controllable_kinds_by_id,
)
from .controllables.spec import (
    CONTROLLABLE_KIND_INVERTER,
    CONTROLLABLE_SPECS,
    KNOWN_CONTROLLABLE_KINDS,
    appliance_controllable_kinds,
)
from .scheduling.schedule import describe_schedule_control_config_issue
from .const import (
    SOLAR_BIAS_AGGREGATION_METHODS,
    SOLAR_FORECAST_HISTORY_RETENTION_DAYS,
)
from .power_polarity import POWER_POLARITY_KEY, POWER_POLARITY_OPTIONS

#: The config keys config version 7 retired. Named here so the save path can
#: refuse them by name instead of silently ignoring a user's hand-edited YAML:
#: migration runs on load only, and rewriting someone's document under them is
#: worse than telling them what it is called now.
_RETIRED_CONFIG_KEYS = ("appliances", "scheduler")

#: The action options an inverter's ``controls.mode.options`` may carry, in the
#: order the editor lays them out. Read off the registry so a kind's declared
#: actions and the fields validated for it cannot drift.
_INVERTER_ACTION_OPTIONS = tuple(
    CONTROLLABLE_SPECS[CONTROLLABLE_KIND_INVERTER].action_option_attrs
)


@dataclass(frozen=True)
class ValidationIssue:
    section: str
    path: str
    code: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {
            "section": self.section,
            "path": self.path,
            "code": self.code,
            "message": self.message,
        }


@dataclass
class ValidationReport:
    errors: list[ValidationIssue] = field(default_factory=list)
    warnings: list[ValidationIssue] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not self.errors

    def add_error(self, *, section: str, path: str, code: str, message: str) -> None:
        self.errors.append(
            ValidationIssue(section=section, path=path, code=code, message=message)
        )

    def add_warning(
        self, *, section: str, path: str, code: str, message: str
    ) -> None:
        self.warnings.append(
            ValidationIssue(section=section, path=path, code=code, message=message)
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "errors": [issue.to_dict() for issue in self.errors],
            "warnings": [issue.to_dict() for issue in self.warnings],
        }


def validate_config_document(config: Mapping[str, Any] | None) -> ValidationReport:
    report = ValidationReport()
    if not isinstance(config, Mapping):
        report.add_error(
            section="root",
            path="config",
            code="invalid_type",
            message="config must be an object",
        )
        return report

    _validate_general_config(config, report)
    _validate_power_devices_config(config, report)
    _validate_training_config(config, report)
    _validate_controllables_config(config, report)
    _validate_automation_config(config, report)
    return report


def _validate_general_config(
    config: Mapping[str, Any],
    report: ValidationReport,
) -> None:
    section = "general"
    _validate_optional_string(report, section, "sources_title", config.get("sources_title"))
    _validate_optional_string(
        report, section, "consumers_title", config.get("consumers_title")
    )
    _validate_optional_string(report, section, "groups_title", config.get("groups_title"))
    _validate_optional_string(
        report,
        section,
        "others_group_label",
        config.get("others_group_label"),
    )
    _validate_optional_positive_int(
        report, section, "history_buckets", config.get("history_buckets")
    )
    _validate_optional_positive_int(
        report,
        section,
        "history_bucket_duration",
        config.get("history_bucket_duration"),
    )
    _validate_optional_bool(
        report, section, "show_empty_groups", config.get("show_empty_groups")
    )
    _validate_optional_bool(
        report, section, "show_others_group", config.get("show_others_group")
    )

    regex_value = config.get("power_sensor_name_cleaner_regex")
    if regex_value is not None:
        if not _is_non_empty_string(regex_value):
            report.add_error(
                section=section,
                path="power_sensor_name_cleaner_regex",
                code="invalid_type",
                message="power_sensor_name_cleaner_regex must be a non-empty string",
            )
        else:
            try:
                re.compile(regex_value.strip())
            except re.error as err:
                report.add_error(
                    section=section,
                    path="power_sensor_name_cleaner_regex",
                    code="invalid_regex",
                    message=f"power_sensor_name_cleaner_regex is invalid: {err}",
                )

    # training_time: HH:MM local-time string. Top-level since v6 — it schedules
    # the whole nightly training batch, not just solar bias training.
    training_time = config.get("training_time")
    if training_time is not None:
        if not _is_non_empty_string(training_time):
            report.add_error(
                section=section,
                path="training_time",
                code="invalid_type",
                message="training_time must be an HH:MM string",
            )
        else:
            match = re.match(r"^(\d{2}):(\d{2})$", training_time.strip())
            if not match:
                report.add_error(
                    section=section,
                    path="training_time",
                    code="invalid_format",
                    message="training_time must be an HH:MM string",
                )
            elif not (0 <= int(match.group(1)) <= 23 and 0 <= int(match.group(2)) <= 59):
                report.add_error(
                    section=section,
                    path="training_time",
                    code="invalid_value",
                    message="training_time must be a valid time",
                )

    device_label_text = config.get("device_label_text")
    if device_label_text is not None:
        _validate_device_label_text(device_label_text, report)


def _validate_power_devices_config(
    config: Mapping[str, Any],
    report: ValidationReport,
) -> None:
    raw_power_devices = config.get("power_devices")
    if raw_power_devices is None:
        return
    if not isinstance(raw_power_devices, Mapping):
        report.add_error(
            section="power_devices",
            path="power_devices",
            code="invalid_type",
            message="power_devices must be an object",
        )
        return

    _validate_house_config(raw_power_devices.get("house"), report)
    _validate_solar_config(config, raw_power_devices.get("solar"), report)
    _validate_battery_config(config, raw_power_devices.get("battery"), report)
    _validate_grid_config(config, raw_power_devices.get("grid"), report)


def _validate_training_config(
    config: Mapping[str, Any],
    report: ValidationReport,
) -> None:
    """The five history-window settings, relocated here since v14.

    A peer of ``power_devices``, not nested under it -- these settings are
    read by several entities' history rather than owned by one, which is the
    whole reason they moved. See ``_migrate_v13_to_v14`` for the load-side
    counterpart; this is the save-side half of "load migrates, save refuses"
    for their old paths.
    """
    section = "training"
    raw_training = config.get("training")
    if raw_training is None:
        return
    training = _require_mapping(raw_training, "training", section, report)
    if training is None:
        return

    house_consumption = training.get("house_consumption")
    if house_consumption is not None:
        house_consumption_map = _require_mapping(
            house_consumption,
            "training.house_consumption",
            section,
            report,
        )
        if house_consumption_map is not None:
            _validate_optional_positive_int(
                report,
                section,
                "training.house_consumption.min_history_days",
                house_consumption_map.get("min_history_days"),
            )
            _validate_optional_positive_int(
                report,
                section,
                "training.house_consumption.training_window_days",
                house_consumption_map.get("training_window_days"),
            )
            _validate_window_covers_minimum(
                report,
                section,
                minimum=house_consumption_map.get("min_history_days"),
                minimum_path="training.house_consumption.min_history_days",
                window=house_consumption_map.get("training_window_days"),
                window_path="training.house_consumption.training_window_days",
            )

    solar_bias = training.get("solar_bias")
    if solar_bias is not None:
        solar_bias_map = _require_mapping(
            solar_bias,
            "training.solar_bias",
            section,
            report,
        )
        if solar_bias_map is not None:
            for key in (
                "min_history_days",
                "max_training_window_days",
                "min_valid_slot_days",
            ):
                value = solar_bias_map.get(key)
                if value is None:
                    continue
                path = f"training.solar_bias.{key}"
                if isinstance(value, bool) or not isinstance(value, int) or not (
                    1 <= value <= 365
                ):
                    report.add_error(
                        section=section,
                        path=path,
                        code="invalid_range",
                        message=f"{path} must be an integer between 1 and 365",
                    )
            _validate_window_covers_minimum(
                report,
                section,
                minimum=solar_bias_map.get("min_history_days"),
                minimum_path="training.solar_bias.min_history_days",
                window=solar_bias_map.get("max_training_window_days"),
                window_path="training.solar_bias.max_training_window_days",
            )
            _validate_minimum_within_forecast_archive(
                report,
                section,
                minimum=solar_bias_map.get("min_history_days"),
                minimum_path="training.solar_bias.min_history_days",
            )


def _validate_window_covers_minimum(
    report: ValidationReport,
    section: str,
    *,
    minimum: object,
    minimum_path: str,
    window: object,
    window_path: str,
) -> None:
    """A minimum a trainer can never reach is a silent no-op, so refuse it.

    The window is the ceiling on what the trainer *asks* the recorder for; the
    minimum is the floor on what it will *trust*. Because no fetch returns rows
    older than the window, a minimum above it can never be met -- the house
    trainer would report ``insufficient_history`` on every run and the solar
    one would omit every slot, both for as long as the config stood. Each value
    is legitimate on its own, which is why nothing else here catches it.

    Only a relation between two integers is judged. Either one absent (the
    default applies), or non-integer (already reported by the per-value check),
    leaves this quiet rather than piling a second error onto the same field.
    """
    if not isinstance(minimum, int) or isinstance(minimum, bool):
        return
    if not isinstance(window, int) or isinstance(window, bool):
        return
    if minimum <= window:
        return
    report.add_error(
        section=section,
        path=minimum_path,
        code="invalid_relation",
        message=(
            f"{minimum_path} ({minimum}) must not exceed {window_path} ({window}); "
            "the trainer never sees history older than its window, so a higher "
            "minimum can never be met"
        ),
    )


def _validate_minimum_within_forecast_archive(
    report: ValidationReport,
    section: str,
    *,
    minimum: object,
    minimum_path: str,
) -> None:
    """The solar trainer's real ceiling is the archive, not the window.

    Its forecast side comes from Helman's own per-slot archive rather than the
    recorder, so no window reaches further back than that archive's retention
    however large it is set. A minimum above it is the same silent no-op
    :func:`_validate_window_covers_minimum` refuses -- every run reports
    ``insufficient_history`` -- but the relation that would betray it is
    against a constant, not against a sibling field, so nothing else sees it.
    """
    if not isinstance(minimum, int) or isinstance(minimum, bool):
        return
    if minimum <= SOLAR_FORECAST_HISTORY_RETENTION_DAYS:
        return
    report.add_error(
        section=section,
        path=minimum_path,
        code="invalid_relation",
        message=(
            f"{minimum_path} ({minimum}) must not exceed "
            f"{SOLAR_FORECAST_HISTORY_RETENTION_DAYS}; the trainer reads the "
            "forecast from Helman's own archive, which keeps that many days, "
            "so a higher minimum can never be met"
        ),
    )


def _validate_house_config(raw_house: object, report: ValidationReport) -> None:
    section = "power_devices"
    if raw_house is None:
        return
    house = _require_mapping(raw_house, "power_devices.house", section, report)
    if house is None:
        return

    entities = house.get("entities")
    if entities is not None:
        entity_map = _require_mapping(
            entities, "power_devices.house.entities", section, report
        )
        if entity_map is not None:
            _validate_optional_entity_id(
                report,
                section,
                "power_devices.house.entities.power",
                entity_map.get("power"),
            )
            _validate_power_polarity(report, section, "house", entity_map)

    _validate_optional_string(
        report,
        section,
        "power_devices.house.power_sensor_label",
        house.get("power_sensor_label"),
    )
    _validate_optional_string(
        report,
        section,
        "power_devices.house.power_switch_label",
        house.get("power_switch_label"),
    )
    _validate_optional_string(
        report,
        section,
        "power_devices.house.unmeasured_power_title",
        house.get("unmeasured_power_title"),
    )

    forecast = house.get("forecast")
    if forecast is None:
        return
    forecast_map = _require_mapping(
        forecast,
        "power_devices.house.forecast",
        section,
        report,
    )
    if forecast_map is None:
        return

    _validate_optional_entity_id(
        report,
        section,
        "power_devices.house.forecast.total_energy_entity_id",
        forecast_map.get("total_energy_entity_id"),
    )
    for retired_key, new_path in (
        ("min_history_days", "training.house_consumption.min_history_days"),
        ("training_window_days", "training.house_consumption.training_window_days"),
    ):
        if retired_key in forecast_map:
            report.add_error(
                section=section,
                path=f"power_devices.house.forecast.{retired_key}",
                code="retired_config_key",
                message=(
                    f"'power_devices.house.forecast.{retired_key}' moved to "
                    f"'{new_path}'"
                ),
            )
    if "deferrable_consumers" in forecast_map:
        report.add_error(
            section=section,
            path="power_devices.house.forecast.deferrable_consumers",
            code="retired_config_key",
            message=(
                "'deferrable_consumers' is no longer a config key; a controllable "
                "is a deferrable consumer when its 'consumption.energy_entity_id' "
                "is set and 'consumption.deferrable' is not false"
            ),
        )


def _validate_solar_config(
    config: Mapping[str, Any],
    raw_solar: object,
    report: ValidationReport,
) -> None:
    section = "power_devices"
    if raw_solar is None:
        return
    solar = _require_mapping(raw_solar, "power_devices.solar", section, report)
    if solar is None:
        return

    entities = solar.get("entities")
    if entities is not None:
        entity_map = _require_mapping(
            entities, "power_devices.solar.entities", section, report
        )
        if entity_map is not None:
            _validate_optional_entity_id(
                report,
                section,
                "power_devices.solar.entities.power",
                entity_map.get("power"),
            )
            _validate_power_polarity(report, section, "solar", entity_map)
            _validate_optional_entity_id(
                report,
                section,
                "power_devices.solar.entities.today_energy",
                entity_map.get("today_energy"),
            )

    forecast = solar.get("forecast")
    if forecast is None:
        return
    forecast_map = _require_mapping(
        forecast,
        "power_devices.solar.forecast",
        section,
        report,
    )
    if forecast_map is None:
        return

    _validate_optional_entity_id(
        report,
        section,
        "power_devices.solar.forecast.total_energy_entity_id",
        forecast_map.get("total_energy_entity_id"),
    )
    _validate_entity_id_list(
        report,
        section,
        "power_devices.solar.forecast.daily_energy_entity_ids",
        forecast_map.get("daily_energy_entity_ids"),
    )

    # bias_correction subtree validation
    bias = forecast_map.get("bias_correction")
    if bias is None:
        return
    bias_map = _require_mapping(
        bias,
        "power_devices.solar.forecast.bias_correction",
        section,
        report,
    )
    if bias_map is None:
        return

    base_path = "power_devices.solar.forecast.bias_correction"

    # enabled: optional bool
    _validate_optional_bool(
        report,
        section,
        f"{base_path}.enabled",
        bias_map.get("enabled"),
    )

    # The three day-count settings moved to training.solar_bias.*; the old
    # paths (including the legacy training_window_days alias) are refused
    # rather than validated.
    for retired_key, new_path in (
        ("min_history_days", "training.solar_bias.min_history_days"),
        ("max_training_window_days", "training.solar_bias.max_training_window_days"),
        ("training_window_days", "training.solar_bias.max_training_window_days"),
        ("min_valid_slot_days", "training.solar_bias.min_valid_slot_days"),
    ):
        if retired_key in bias_map:
            report.add_error(
                section=section,
                path=f"{base_path}.{retired_key}",
                code="retired_config_key",
                message=f"'{base_path}.{retired_key}' moved to '{new_path}'",
            )

    # clamp_min: float in (0, 1]
    clamp_min = bias_map.get("clamp_min")
    if clamp_min is not None:
        if isinstance(clamp_min, bool) or not isinstance(clamp_min, (int, float)):
            report.add_error(
                section=section,
                path=f"{base_path}.clamp_min",
                code="invalid_type",
                message=f"{base_path}.clamp_min must be a number",
            )
        else:
            if not (clamp_min > 0 and clamp_min <= 1):
                report.add_error(
                    section=section,
                    path=f"{base_path}.clamp_min",
                    code="invalid_range",
                    message=f"{base_path}.clamp_min must be > 0 and <= 1",
                )

    # clamp_max: float in [1, 10]
    clamp_max = bias_map.get("clamp_max")
    if clamp_max is not None:
        if isinstance(clamp_max, bool) or not isinstance(clamp_max, (int, float)):
            report.add_error(
                section=section,
                path=f"{base_path}.clamp_max",
                code="invalid_type",
                message=f"{base_path}.clamp_max must be a number",
            )
        else:
            if not (1 <= clamp_max <= 10):
                report.add_error(
                    section=section,
                    path=f"{base_path}.clamp_max",
                    code="invalid_range",
                    message=f"{base_path}.clamp_max must be between 1 and 10",
                )

    # aggregation_method: "ratio_of_sums" or "trimmed_mean"
    aggregation_method = bias_map.get("aggregation_method")
    if aggregation_method is not None:
        if not isinstance(aggregation_method, str):
            report.add_error(
                section=section,
                path=f"{base_path}.aggregation_method",
                code="invalid_type",
                message=f"{base_path}.aggregation_method must be a string",
            )
        elif aggregation_method not in SOLAR_BIAS_AGGREGATION_METHODS:
            report.add_error(
                section=section,
                path=f"{base_path}.aggregation_method",
                code="invalid_choice",
                message=f"{base_path}.aggregation_method must be one of {', '.join(SOLAR_BIAS_AGGREGATION_METHODS)}",
            )

    max_interpolated_consecutive_slots = bias_map.get("max_interpolated_consecutive_slots")
    if max_interpolated_consecutive_slots is not None:
        if (
            isinstance(max_interpolated_consecutive_slots, bool)
            or not isinstance(max_interpolated_consecutive_slots, int)
            or not (0 <= max_interpolated_consecutive_slots <= 24)
        ):
            report.add_error(
                section=section,
                path=f"{base_path}.max_interpolated_consecutive_slots",
                code="invalid_value",
                message=(
                    f"{base_path}.max_interpolated_consecutive_slots must be an integer "
                    "between 0 and 24"
                ),
            )

    slot_invalidation = bias_map.get("slot_invalidation")
    if slot_invalidation is not None:
        slot_invalidation_map = _require_mapping(
            slot_invalidation,
            f"{base_path}.slot_invalidation",
            section,
            report,
        )
        if slot_invalidation_map is not None:
            slot_invalidation_path = f"{base_path}.slot_invalidation"
            max_battery_soc_percent = slot_invalidation_map.get(
                "max_battery_soc_percent"
            )
            max_battery_soc_present = _has_value(max_battery_soc_percent)

            if max_battery_soc_present:
                if isinstance(max_battery_soc_percent, bool) or not isinstance(
                    max_battery_soc_percent, (int, float)
                ):
                    report.add_error(
                        section=section,
                        path=f"{slot_invalidation_path}.max_battery_soc_percent",
                        code="invalid_type",
                        message=(
                            f"{slot_invalidation_path}.max_battery_soc_percent must "
                            "be a number"
                        ),
                    )
                elif not (0 < max_battery_soc_percent <= 100):
                    report.add_error(
                        section=section,
                        path=f"{slot_invalidation_path}.max_battery_soc_percent",
                        code="invalid_range",
                        message=(
                            f"{slot_invalidation_path}.max_battery_soc_percent must "
                            "be greater than 0 and at most 100"
                        ),
                    )

            # Curtailment inference reads the signed grid power sensor to tell
            # "battery full and nothing exported" from "battery full and
            # exporting". Only required once the SoC threshold turns the rule
            # on — the data-glitch rules below never look at the grid.
            if max_battery_soc_present and not _has_grid_power_entity(config):
                report.add_error(
                    section=section,
                    path=f"{slot_invalidation_path}.max_battery_soc_percent",
                    code="missing_prerequisite",
                    message=(
                        f"{slot_invalidation_path}.max_battery_soc_percent requires "
                        "power_devices.grid.entities.power"
                    ),
                )

            if not _has_battery_capacity_entity(config):
                report.add_error(
                    section=section,
                    path=slot_invalidation_path,
                    code="missing_prerequisite",
                    message=(
                        f"{slot_invalidation_path} requires "
                        "power_devices.battery.entities.capacity"
                    ),
                )

            for key in (
                "curtailment_max_export_w",
                "data_glitch_max_slot_wh",
                "data_glitch_min_neighbour_forecast_wh",
            ):
                value = slot_invalidation_map.get(key)
                if value is None:
                    continue
                if isinstance(value, bool) or not isinstance(
                    value, (int, float)
                ):
                    report.add_error(
                        section=section,
                        path=f"{slot_invalidation_path}.{key}",
                        code="invalid_type",
                        message=(
                            f"{slot_invalidation_path}.{key} must be a number"
                        ),
                    )
                elif value < 0:
                    report.add_error(
                        section=section,
                        path=f"{slot_invalidation_path}.{key}",
                        code="invalid_range",
                        message=(
                            f"{slot_invalidation_path}.{key} must be >= 0"
                        ),
                    )

            ratio_value = slot_invalidation_map.get(
                "curtailment_max_actual_forecast_ratio"
            )
            ratio_path = (
                f"{slot_invalidation_path}.curtailment_max_actual_forecast_ratio"
            )
            if ratio_value is not None:
                if isinstance(ratio_value, bool) or not isinstance(
                    ratio_value, (int, float)
                ):
                    report.add_error(
                        section=section,
                        path=ratio_path,
                        code="invalid_type",
                        message=f"{ratio_path} must be a number",
                    )
                elif not (0 < ratio_value <= 1):
                    report.add_error(
                        section=section,
                        path=ratio_path,
                        code="invalid_range",
                        message=(
                            f"{ratio_path} must be greater than 0 and at most 1"
                        ),
                    )

            backfill_value = slot_invalidation_map.get(
                "data_glitch_backfill_max_minutes"
            )
            if backfill_value is not None:
                if isinstance(backfill_value, bool) or not isinstance(
                    backfill_value, (int, float)
                ):
                    report.add_error(
                        section=section,
                        path=f"{slot_invalidation_path}.data_glitch_backfill_max_minutes",
                        code="invalid_type",
                        message=(
                            f"{slot_invalidation_path}.data_glitch_backfill_max_minutes "
                            "must be a number"
                        ),
                    )
                elif backfill_value < 0:
                    report.add_error(
                        section=section,
                        path=f"{slot_invalidation_path}.data_glitch_backfill_max_minutes",
                        code="invalid_range",
                        message=(
                            f"{slot_invalidation_path}.data_glitch_backfill_max_minutes "
                            "must be >= 0"
                        ),
                    )

    # cross-field validation: clamp_min < clamp_max
    if (
        clamp_min is not None
        and clamp_max is not None
        and isinstance(clamp_min, (int, float))
        and isinstance(clamp_max, (int, float))
    ):
        try:
            if not (clamp_min < clamp_max):
                report.add_error(
                    section=section,
                    path=base_path,
                    code="invalid_relation",
                    message="clamp_min must be less than clamp_max",
                )
        except Exception:
            # in case values are not comparable
            report.add_error(
                section=section,
                path=base_path,
                code="invalid_relation",
                message="clamp_min must be less than clamp_max",
            )


def _validate_battery_config(
    config: Mapping[str, Any],
    raw_battery: object,
    report: ValidationReport,
) -> None:
    section = "power_devices"
    if raw_battery is None:
        return
    battery = _require_mapping(raw_battery, "power_devices.battery", section, report)
    if battery is None:
        return

    entities = battery.get("entities")
    if entities is not None:
        entity_map = _require_mapping(
            entities, "power_devices.battery.entities", section, report
        )
        if entity_map is not None:
            _validate_optional_entity_id(
                report,
                section,
                "power_devices.battery.entities.power",
                entity_map.get("power"),
            )
            _validate_power_polarity(report, section, "battery", entity_map)
            quartet_fields = (
                "remaining_energy",
                "capacity",
                "min_soc",
                "max_soc",
            )
            if any(_has_value(entity_map.get(field_name)) for field_name in quartet_fields):
                issue = describe_battery_entity_config_issue(dict(config))
                if issue is not None:
                    report.add_error(
                        section=section,
                        path="power_devices.battery.entities",
                        code="incomplete_battery_entities",
                        message=issue,
                    )
                for field_name in quartet_fields:
                    _validate_optional_entity_id(
                        report,
                        section,
                        f"power_devices.battery.entities.{field_name}",
                        entity_map.get(field_name),
                    )
            # Either charge/discharge meter is useful on its own, so unlike the
            # quartet above they carry no completeness requirement.
            for field_name in ("today_charge_energy", "today_discharge_energy"):
                _validate_optional_entity_id(
                    report,
                    section,
                    f"power_devices.battery.entities.{field_name}",
                    entity_map.get(field_name),
                )

    forecast = battery.get("forecast")
    if forecast is None:
        return
    forecast_map = _require_mapping(
        forecast,
        "power_devices.battery.forecast",
        section,
        report,
    )
    if forecast_map is None:
        return

    _validate_optional_probability(
        report,
        section,
        "power_devices.battery.forecast.charge_efficiency",
        forecast_map.get("charge_efficiency"),
    )
    _validate_optional_probability(
        report,
        section,
        "power_devices.battery.forecast.discharge_efficiency",
        forecast_map.get("discharge_efficiency"),
    )
    max_charge_present = _has_value(forecast_map.get("max_charge_power_w"))
    max_discharge_present = _has_value(forecast_map.get("max_discharge_power_w"))
    if max_charge_present != max_discharge_present:
        report.add_error(
            section=section,
            path="power_devices.battery.forecast",
            code="incomplete_battery_forecast",
            message=(
                "power_devices.battery.forecast.max_charge_power_w and "
                "power_devices.battery.forecast.max_discharge_power_w must be "
                "configured together"
            ),
        )
    _validate_optional_positive_number(
        report,
        section,
        "power_devices.battery.forecast.max_charge_power_w",
        forecast_map.get("max_charge_power_w"),
    )
    _validate_optional_positive_number(
        report,
        section,
        "power_devices.battery.forecast.max_discharge_power_w",
        forecast_map.get("max_discharge_power_w"),
    )


def _validate_grid_config(
    config: Mapping[str, Any],
    raw_grid: object,
    report: ValidationReport,
) -> None:
    section = "power_devices"
    if raw_grid is None:
        return
    grid = _require_mapping(raw_grid, "power_devices.grid", section, report)
    if grid is None:
        return

    entities = grid.get("entities")
    if entities is not None:
        entity_map = _require_mapping(
            entities, "power_devices.grid.entities", section, report
        )
        if entity_map is not None:
            for key in ("power", "today_import", "today_export"):
                _validate_optional_entity_id(
                    report,
                    section,
                    f"power_devices.grid.entities.{key}",
                    entity_map.get(key),
                )
            _validate_power_polarity(report, section, "grid", entity_map)

    forecast = grid.get("forecast")
    if forecast is None:
        return
    forecast_map = _require_mapping(
        forecast,
        "power_devices.grid.forecast",
        section,
        report,
    )
    if forecast_map is None:
        return

    _validate_optional_entity_id(
        report,
        section,
        "power_devices.grid.forecast.sell_price_entity_id",
        forecast_map.get("sell_price_entity_id"),
    )

    if any(
        key in forecast_map for key in ("import_price_unit", "import_price_windows")
    ):
        try:
            read_grid_import_price_config({"power_devices": {"grid": {"forecast": forecast_map}}})
        except GridImportPriceConfigError as err:
            report.add_error(
                section=section,
                path="power_devices.grid.forecast",
                code="invalid_import_price_config",
                message=str(err),
            )


def _validate_controllables_config(
    config: Mapping[str, Any],
    report: ValidationReport,
) -> None:
    """One walk over ``controllables:``, covering all four kinds.

    Replaces the pair of validators that grew from the old split — one for
    ``appliances``, one for ``scheduler.control``. They enforced the same
    rules with different words; the only genuinely kind-specific part left is
    which reader turns an entry into a runtime object, and that is a dispatch
    on ``kind``.

    Three rules exist only because the list is now shared: the inverter is a
    singleton, its id is reserved, and ids are unique across every kind, not
    just among appliances. All three are what makes ``controllable_id`` usable
    as an optimizer target.
    """
    section = "controllables"
    for retired_key in _RETIRED_CONFIG_KEYS:
        if retired_key in config:
            report.add_error(
                section=section,
                path=retired_key,
                code="retired_config_key",
                message=(
                    f"{retired_key!r} is no longer a config key; the inverter and "
                    "the appliances are configured together under 'controllables'"
                ),
            )

    raw_controllables = config.get("controllables")
    if raw_controllables is None:
        return
    if not isinstance(raw_controllables, list):
        report.add_error(
            section=section,
            path="controllables",
            code="invalid_type",
            message="controllables must be a list",
        )
        return

    seen_ids: set[str] = set()
    seen_energy_entity_ids: set[str] = set()
    seen_inverter = False
    for index, raw_controllable in enumerate(raw_controllables):
        path = f"controllables[{index}]"
        if not isinstance(raw_controllable, Mapping):
            report.add_error(
                section=section,
                path=path,
                code="invalid_type",
                message=f"{path} must be an object",
            )
            continue

        raw_kind = raw_controllable.get("kind")
        if not _is_non_empty_string(raw_kind):
            report.add_error(
                section=section,
                path=f"{path}.kind",
                code="required",
                message=f"{path}.kind must be a non-empty string",
            )
            continue

        kind = raw_kind.strip()
        if kind not in KNOWN_CONTROLLABLE_KINDS:
            report.add_warning(
                section=section,
                path=path,
                code="unsupported_kind",
                message=(
                    f"Controllable kind {kind!r} is preserved but not editable in "
                    "this version"
                ),
            )
            continue

        # Before the id check, deliberately: a second inverter almost always
        # also reuses the reserved id, and "you have two inverters" is the
        # finding, not "this id is taken".
        if kind == CONTROLLABLE_KIND_INVERTER and seen_inverter:
            report.add_error(
                section=section,
                path=path,
                code="duplicate_inverter",
                message=(
                    "only one controllable may be the inverter; Helman drives a "
                    "single battery inverter"
                ),
            )
            continue

        if not _validate_controllable_id(
            raw_controllable, path=path, kind=kind, seen_ids=seen_ids, report=report
        ):
            continue

        _validate_controllable_consumption(
            raw_controllable,
            path=path,
            kind=kind,
            seen_energy_entity_ids=seen_energy_entity_ids,
            report=report,
        )

        if kind == CONTROLLABLE_KIND_INVERTER:
            seen_inverter = True
            _validate_inverter_controllable(config, raw_controllable, path, report)
            continue

        try:
            _read_supported_appliance(raw_controllable, path=path, kind=kind)
        except (
            ClimateApplianceConfigError,
            EvChargerConfigError,
            GenericApplianceConfigError,
        ) as err:
            report.add_error(
                section=section,
                path=path,
                code="invalid_appliance",
                message=str(err),
            )


def _validate_controllable_consumption(
    raw_controllable: Mapping[str, Any],
    *,
    path: str,
    kind: str,
    seen_energy_entity_ids: set[str],
    report: ValidationReport,
) -> None:
    """The ``consumption`` block: the meter, and who may declare one.

    The per-kind appliance readers already check the shape of
    ``consumption.projection``, and the meter itself when a projection needs it.
    What only this function can see is everything *across* entries and outside
    the appliance kinds: a meter on an EV charger (which has no projection to
    hang validation off), the same meter claimed by two devices, and a
    ``consumption`` block on the inverter.

    The inverter is refused the block outright rather than field by field. It is
    not house consumption — it is what moves energy in and out of the battery —
    so a meter, a deferrable flag and a demand projection are all equally
    meaningless on it, and one error saying so beats three saying almost the
    same thing.
    """
    section = "controllables"

    if "projection" in raw_controllable:
        report.add_error(
            section=section,
            path=f"{path}.projection",
            code="retired_config_key",
            message=(
                f"{path}.projection moved to {path}.consumption.projection, and its "
                "'history_average.energy_entity_id' to "
                f"{path}.consumption.energy_entity_id"
            ),
        )

    raw_consumption = raw_controllable.get("consumption")
    if raw_consumption is None:
        return

    if kind == CONTROLLABLE_KIND_INVERTER:
        report.add_error(
            section=section,
            path=f"{path}.consumption",
            code="consumption_not_allowed",
            message=(
                "the inverter has no consumption of its own; it moves energy "
                "rather than drawing it"
            ),
        )
        return

    if not isinstance(raw_consumption, Mapping):
        report.add_error(
            section=section,
            path=f"{path}.consumption",
            code="invalid_type",
            message=f"{path}.consumption must be an object",
        )
        return

    energy_entity_id = raw_consumption.get("energy_entity_id")
    deferrable = raw_consumption.get("deferrable")
    if deferrable is not None and not isinstance(deferrable, bool):
        report.add_error(
            section=section,
            path=f"{path}.consumption.deferrable",
            code="invalid_type",
            message=f"{path}.consumption.deferrable must be true or false",
        )
    elif deferrable is True and energy_entity_id is None:
        # Only an *explicit* true earns this: the user asked for something that
        # will not happen. The default is silent — an appliance with a fixed
        # projection and no meter is an ordinary config, not a half-finished
        # one. Not an error either way: it configures nothing but breaks
        # nothing, and a half-filled form mid-edit should not read as broken.
        report.add_warning(
            section=section,
            path=f"{path}.consumption",
            code="deferrable_without_meter",
            message=(
                f"{path} counts as a deferrable consumer only once "
                "'consumption.energy_entity_id' names its energy meter"
            ),
        )

    if energy_entity_id is None:
        return

    _validate_optional_entity_id(
        report,
        section,
        f"{path}.consumption.energy_entity_id",
        energy_entity_id,
        allowed_domains=("sensor",),
    )
    if not _is_non_empty_string(energy_entity_id):
        return

    entity_id = energy_entity_id.strip()
    if entity_id in seen_energy_entity_ids:
        report.add_error(
            section=section,
            path=f"{path}.consumption.energy_entity_id",
            code="duplicate_entity_id",
            message=(
                f"energy meter {entity_id!r} is already claimed by another "
                "controllable; two devices sharing one meter would be counted twice"
            ),
        )
    seen_energy_entity_ids.add(entity_id)


def _validate_controllable_id(
    raw_controllable: Mapping[str, Any],
    *,
    path: str,
    kind: str,
    seen_ids: set[str],
    report: ValidationReport,
) -> bool:
    """Uniqueness plus the one reserved id. ``False`` stops further checks.

    The inverter must carry ``id: inverter`` — not merely may. Optimizers name
    what they act on by controllable id, including the three that drive the
    inverter, so an inverter entry with some other id (or none) would leave
    ``target.controllable_id`` with nothing to resolve against. The alternative
    was to resolve the inverter by *kind* at targeting time, which would make
    ``controllable_id`` mean "an id, except sometimes a kind". The migration and
    the "Add inverter" draft both always write it, so this only bites a
    hand-authored document.

    Every other kind must name itself, and the appliance readers already say so.
    """
    section = "controllables"
    raw_id = raw_controllable.get("id")
    if kind == CONTROLLABLE_KIND_INVERTER and (
        not _is_non_empty_string(raw_id) or raw_id.strip() != CONTROLLABLE_ID_INVERTER
    ):
        report.add_error(
            section=section,
            path=f"{path}.id",
            code="required_controllable_id",
            message=(
                f"the inverter controllable must have id "
                f"{CONTROLLABLE_ID_INVERTER!r}; optimizers target it by that id"
            ),
        )
        return False
    if not _is_non_empty_string(raw_id):
        return True

    controllable_id = raw_id.strip()
    if (
        controllable_id == CONTROLLABLE_ID_INVERTER
        and kind != CONTROLLABLE_KIND_INVERTER
    ):
        report.add_error(
            section=section,
            path=f"{path}.id",
            code="reserved_controllable_id",
            message=(
                f"controllable id {CONTROLLABLE_ID_INVERTER!r} is reserved for the "
                "inverter"
            ),
        )
        return False

    if controllable_id in seen_ids:
        report.add_error(
            section=section,
            path=f"{path}.id",
            code="duplicate_controllable_id",
            message=f"duplicate controllable id {controllable_id!r}",
        )
        return False

    seen_ids.add(controllable_id)
    return True


def _validate_inverter_controllable(
    config: Mapping[str, Any],
    raw_controllable: Mapping[str, Any],
    path: str,
    report: ValidationReport,
) -> None:
    section = "controllables"
    raw_controls = raw_controllable.get("controls")
    if raw_controls is None:
        return
    controls = _require_mapping(raw_controls, f"{path}.controls", section, report)
    if controls is None:
        return

    raw_mode = controls.get("mode")
    if raw_mode is None:
        return
    mode = _require_mapping(raw_mode, f"{path}.controls.mode", section, report)
    if mode is None:
        return

    raw_options = mode.get("options")
    if raw_options is not None:
        options = _require_mapping(
            raw_options, f"{path}.controls.mode.options", section, report
        )
        if options is not None:
            for key in _INVERTER_ACTION_OPTIONS:
                _validate_optional_string(
                    report,
                    section,
                    f"{path}.controls.mode.options.{key}",
                    options.get(key),
                )

    # Reads the document rather than this entry: the runtime resolves the
    # inverter by kind, so what must be complete is whichever entry it picks.
    issue = describe_schedule_control_config_issue(config)
    if issue is not None:
        report.add_error(
            section=section,
            path=f"{path}.controls.mode",
            code="invalid_inverter_control",
            message=issue,
        )

    _validate_optional_entity_id(
        report,
        section,
        f"{path}.controls.mode.entity_id",
        mode.get("entity_id"),
        allowed_domains=("input_select", "select"),
    )


def _validate_automation_config(
    config: Mapping[str, Any],
    report: ValidationReport,
) -> None:
    if "automation" not in config:
        return

    try:
        automation_config = read_automation_config(config)
    except AutomationConfigError as err:
        report.add_error(
            section="automation",
            path=err.path,
            code=err.code,
            message=str(err),
        )
        return

    appliance_registry = build_appliances_runtime_registry(config)
    battery_issue = describe_battery_entity_config_issue(config)
    controllable_kinds_by_id = read_controllable_kinds_by_id(config)
    seen_export_price = False
    # `execution_optimizers` drops the disabled ones, so its index is not the
    # index the path has to address — and the two differ exactly when a
    # disabled optimizer exists, which is when
    # `required_appliance_optimizer_disabled` fires. Ids are unique by then
    # (`_read_optimizers` rejects duplicates), so they carry the mapping.
    document_index_by_optimizer_id = {
        optimizer.id: document_index
        for document_index, optimizer in enumerate(automation_config.optimizers)
    }
    earliest_planner_index = _earliest_planner_index_by_controllable(automation_config)
    controllables_planned_by_disabled = _controllables_planned_by_disabled_optimizer(
        automation_config
    )
    # Enabled optimizers only, deliberately: a disabled optimizer with a broken
    # group is a config the user parked, not an error to surface.
    for index, optimizer in enumerate(automation_config.execution_optimizers):
        path = (
            "automation.optimizers"
            f"[{document_index_by_optimizer_id[optimizer.id]}]"
        )
        if optimizer.kind in _BATTERY_DEPENDENT_KINDS and battery_issue is not None:
            report.add_error(
                section="automation",
                path=path,
                code="battery_required",
                message=(
                    f"{optimizer.kind} optimizer {optimizer.id!r} requires a "
                    f"configured battery: {battery_issue}"
                ),
            )
        if not _validate_optimizer_target(
            optimizer, controllable_kinds_by_id, path=path, report=report
        ):
            # Building would fail again on the same id, in the appliance
            # registry's words this time. One finding per fault.
            continue

        _validate_requires_appliance(
            optimizer,
            index=index,
            controllable_kinds_by_id=controllable_kinds_by_id,
            earliest_planner_index=earliest_planner_index,
            controllables_planned_by_disabled=controllables_planned_by_disabled,
            path=path,
            report=report,
        )

        # Building is the validation: the generic reader has already checked the
        # declared schema, so what is left is the runtime resolution (appliance
        # lookups, authorable modes) that only a builder can do.
        try:
            build_optimizer(
                optimizer,
                control_config=None,
                appliance_registry=appliance_registry,
                path=path,
            )
        except AutomationConfigError as err:
            report.add_error(
                section="automation",
                path=err.path,
                code=err.code,
                message=str(err),
            )

        if optimizer.kind == "export_price":
            seen_export_price = True
        elif optimizer.kind == "charge_hold" and seen_export_price:
            report.add_warning(
                section="automation",
                path=path,
                code="charge_hold_after_export_price",
                message=(
                    f"charge_hold optimizer {optimizer.id!r} is ordered after an "
                    "export_price optimizer; export_price's stop_export will win "
                    "shared inverter slots. Place charge_hold first."
                ),
            )


def _earliest_planner_index_by_controllable(
    automation_config: Any,
) -> dict[str, int]:
    """For each controllable, the earliest enabled optimizer that plans it.

    Indices are positions in ``execution_optimizers`` — the order the pipeline
    actually runs — because that is what decides whether one optimizer can see
    another's writes.
    """
    earliest: dict[str, int] = {}
    for index, optimizer in enumerate(automation_config.execution_optimizers):
        earliest.setdefault(optimizer.controllable_id, index)
    return earliest


def _controllables_planned_by_disabled_optimizer(
    automation_config: Any,
) -> frozenset[str]:
    """Controllables whose only optimizer is switched off.

    Reads the *full* optimizer list rather than ``execution_optimizers``, which
    is enabled-only by design: a disabled optimizer is exactly what this has to
    see. A controllable that also has an enabled optimizer is not in here — the
    ordering check owns that case.
    """
    enabled_ids = {
        optimizer.controllable_id
        for optimizer in automation_config.execution_optimizers
    }
    return frozenset(
        optimizer.controllable_id
        for optimizer in automation_config.optimizers
        if not optimizer.enabled and optimizer.controllable_id not in enabled_ids
    )


def _validate_requires_appliance(
    optimizer: Any,
    *,
    index: int,
    controllable_kinds_by_id: Mapping[str, str],
    earliest_planner_index: Mapping[str, int],
    controllables_planned_by_disabled: frozenset[str],
    path: str,
    report: ValidationReport,
) -> None:
    """Can the ``requires_appliance`` mask see the plan it depends on?

    The mask reads the *schedule* and never looks at ``setBy``, so a provider
    scheduled by hand works and needs no optimizer at all — that case is silent
    here on purpose. What it cannot see is an automation-owned lane that does
    not exist yet when it runs, and there are two ways to arrange that:

    * The provider's optimizer sits *after* this one. Every run strips all
      automation-owned actions and re-plans in order, so its lane is empty at
      the moment this mask reads it.
    * The provider's only optimizer is *disabled*. The strip is blanket, so its
      lane is wiped and never rewritten.

    Both are warnings, not errors: they do not prove the dependent is dead, only
    that the automation-owned half of the provider's plan is invisible. A config
    that hand-schedules the provider and parks its optimizer is working as
    intended. Naming a controllable that does not exist, is not an appliance, or
    is this optimizer's own target is an error — none of those can ever plan
    anything for this mask to read.
    """
    appliance_kinds = appliance_controllable_kinds()
    for group in optimizer.conditions:
        provider_id = group.condition_values.get("requires_appliance")
        if not isinstance(provider_id, str):
            continue
        group_path = f"{path}.conditions[{group.index}].requires_appliance"

        if provider_id == optimizer.controllable_id:
            report.add_error(
                section="automation",
                path=group_path,
                code="self_referential_required_appliance",
                message=(
                    f"optimizer {optimizer.id!r} requires appliance "
                    f"{provider_id!r}, which is its own target; an appliance "
                    "cannot depend on itself"
                ),
            )
            continue

        kind = controllable_kinds_by_id.get(provider_id)
        if kind is None or kind not in appliance_kinds:
            report.add_error(
                section="automation",
                path=group_path,
                code="unknown_required_appliance",
                message=(
                    f"optimizer {optimizer.id!r} requires appliance "
                    f"{provider_id!r}, which is not a configured appliance"
                ),
            )
            continue

        planner_index = earliest_planner_index.get(provider_id)
        if planner_index is not None and planner_index > index:
            report.add_warning(
                section="automation",
                path=group_path,
                code="required_appliance_planned_later",
                message=(
                    f"optimizer {optimizer.id!r} requires appliance "
                    f"{provider_id!r}, which is planned by a later optimizer; "
                    "its planned slots are invisible here. Move that optimizer "
                    "first, or schedule the appliance manually."
                ),
            )
        elif provider_id in controllables_planned_by_disabled:
            report.add_warning(
                section="automation",
                path=group_path,
                code="required_appliance_optimizer_disabled",
                message=(
                    f"optimizer {optimizer.id!r} requires appliance "
                    f"{provider_id!r}, whose only optimizer is disabled; its "
                    "planned slots are cleared every run and are invisible "
                    "here. Enable that optimizer, or schedule the appliance "
                    "manually."
                ),
            )


def _validate_optimizer_target(
    optimizer: Any,
    controllable_kinds_by_id: Mapping[str, str],
    *,
    path: str,
    report: ValidationReport,
) -> bool:
    """Does this optimizer name a controllable its kind can actually drive?

    Two findings, both of which used to be silence. An id naming nothing was
    caught only for appliance targets, and only when the builder ran; an
    optimizer pointed at a controllable of the wrong kind was caught for no
    target at all — a ``charge_hold`` aimed at a boiler was accepted and then
    did nothing useful, because the kinds decide which schedule domain gets
    written and a boiler's domain takes no inverter action.

    The compatible kinds come from ``CONTROLLABLE_SPECS``' ``optimizer_kinds``
    via :attr:`OptimizerSpec.controllable_kinds`, so this is the enforcement of
    a declaration rather than a second list to keep in step. ``ev_charger``
    declares no optimizer kind, so an ``appliance_runtime`` aimed at a charger
    lands here as ``incompatible_target`` — the same rejection
    ``resolve_appliance_target`` already made at build time, moved to where the
    user can see it against the field they typed.
    """
    controllable_id = optimizer.controllable_id
    kind = controllable_kinds_by_id.get(controllable_id)
    if kind is None:
        report.add_error(
            section="automation",
            path=f"{path}.target.controllable_id",
            code="unknown_controllable",
            message=(
                f"optimizer {optimizer.id!r} targets controllable "
                f"{controllable_id!r}, which is not configured"
            ),
        )
        return False

    allowed = OPTIMIZER_SPECS[optimizer.kind].controllable_kinds
    if kind not in allowed:
        report.add_error(
            section="automation",
            path=f"{path}.target.controllable_id",
            code="incompatible_target",
            message=(
                f"{optimizer.kind} optimizer {optimizer.id!r} cannot drive "
                f"controllable {controllable_id!r} of kind {kind!r}; "
                + (
                    f"it drives: {', '.join(allowed)}"
                    if allowed
                    else "no controllable kind accepts this optimizer kind"
                )
            ),
        )
        return False
    return True


#: Kinds that need a *battery entity* configured. Deliberately not folded into
#: the capability gate above: that one asks which controllable a kind may drive,
#: and all three inverter kinds may drive the inverter. This asks something else
#: — whether the battery these two reason about is wired up at all — and
#: ``export_price``, which drives the same inverter, does not need it.
_BATTERY_DEPENDENT_KINDS = frozenset({"charge_hold", "charge_from_grid"})


def _read_supported_appliance(
    raw_appliance: Mapping[str, Any],
    *,
    path: str,
    kind: str,
):
    if kind == "climate":
        return read_climate_appliance(raw_appliance, path=path)
    if kind == "ev_charger":
        return read_ev_charger_appliance(raw_appliance, path=path)
    if kind == "generic":
        return read_generic_appliance(raw_appliance, path=path)
    raise ValueError(f"Unsupported editable appliance kind {kind!r}")


def _validate_device_label_text(
    value: object,
    report: ValidationReport,
) -> None:
    section = "general"
    if not isinstance(value, Mapping):
        report.add_error(
            section=section,
            path="device_label_text",
            code="invalid_type",
            message="device_label_text must be an object",
        )
        return

    for category_key, category_value in value.items():
        if not _is_non_empty_string(category_key):
            report.add_error(
                section=section,
                path="device_label_text",
                code="invalid_key",
                message="device_label_text keys must be non-empty strings",
            )
            continue
        if not isinstance(category_value, Mapping):
            report.add_error(
                section=section,
                path=f"device_label_text.{category_key}",
                code="invalid_type",
                message=f"device_label_text.{category_key} must be an object",
            )
            continue
        for label_name, badge_text in category_value.items():
            if not _is_non_empty_string(label_name):
                report.add_error(
                    section=section,
                    path=f"device_label_text.{category_key}",
                    code="invalid_key",
                    message=(
                        f"device_label_text.{category_key} keys must be non-empty strings"
                    ),
                )
            if not _is_non_empty_string(badge_text):
                report.add_error(
                    section=section,
                    path=f"device_label_text.{category_key}.{label_name}",
                    code="invalid_type",
                    message=(
                        f"device_label_text.{category_key}.{label_name} must be a "
                        "non-empty string"
                    ),
                )


def _validate_entity_id_list(
    report: ValidationReport,
    section: str,
    path: str,
    value: object,
    *,
    allowed_domains: tuple[str, ...] | None = None,
) -> None:
    if value is None:
        return
    if not isinstance(value, list):
        report.add_error(
            section=section,
            path=path,
            code="invalid_type",
            message=f"{path} must be a list",
        )
        return

    for index, item in enumerate(value):
        _validate_optional_entity_id(
            report,
            section,
            f"{path}[{index}]",
            item,
            allowed_domains=allowed_domains,
        )


def _validate_optional_entity_id(
    report: ValidationReport,
    section: str,
    path: str,
    value: object,
    *,
    allowed_domains: tuple[str, ...] | None = None,
) -> None:
    if value is None:
        return
    if not _is_non_empty_string(value):
        report.add_error(
            section=section,
            path=path,
            code="invalid_entity_id",
            message=f"{path} must be a non-empty entity id string",
        )
        return

    entity_id = value.strip()
    domain, separator, object_id = entity_id.partition(".")
    if not separator or not object_id:
        report.add_error(
            section=section,
            path=path,
            code="invalid_entity_id",
            message=f"{path} must be a valid entity id",
        )
        return

    if allowed_domains is not None and domain not in allowed_domains:
        formatted_domains = ", ".join(repr(item) for item in allowed_domains)
        report.add_error(
            section=section,
            path=path,
            code="invalid_domain",
            message=f"{path} must use one of {formatted_domains} domains",
        )


def _validate_optional_positive_int(
    report: ValidationReport,
    section: str,
    path: str,
    value: object,
) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        report.add_error(
            section=section,
            path=path,
            code="invalid_positive_int",
            message=f"{path} must be a positive integer",
        )


def _validate_optional_positive_number(
    report: ValidationReport,
    section: str,
    path: str,
    value: object,
) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        report.add_error(
            section=section,
            path=path,
            code="invalid_positive_number",
            message=f"{path} must be a positive number",
        )


def _validate_optional_probability(
    report: ValidationReport,
    section: str,
    path: str,
    value: object,
) -> None:
    if value is None:
        return
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or value <= 0
        or value > 1
    ):
        report.add_error(
            section=section,
            path=path,
            code="invalid_probability",
            message=f"{path} must be a number greater than 0 and at most 1",
        )


def _validate_optional_string(
    report: ValidationReport,
    section: str,
    path: str,
    value: object,
) -> None:
    if value is None:
        return
    if not _is_non_empty_string(value):
        report.add_error(
            section=section,
            path=path,
            code="invalid_type",
            message=f"{path} must be a non-empty string",
        )


def _validate_power_polarity(
    report: ValidationReport,
    section: str,
    device: str,
    entity_map: Mapping[str, Any],
) -> None:
    """Check ``power_polarity`` against the device's own vocabulary.

    Each device offers a different pair, so a value that is perfectly valid on
    the battery is meaningless on the grid. Rejecting it by name is the point:
    silently ignoring it would leave the user with a config that reads as
    configured and behaves as if it were not.
    """
    path = f"power_devices.{device}.entities.{POWER_POLARITY_KEY}"
    value = entity_map.get(POWER_POLARITY_KEY)
    if value is None:
        return
    options = POWER_POLARITY_OPTIONS[device]
    if not isinstance(value, str):
        report.add_error(
            section=section,
            path=path,
            code="invalid_type",
            message=f"{path} must be a string",
        )
    elif value not in options:
        report.add_error(
            section=section,
            path=path,
            code="invalid_choice",
            message=f"{path} must be one of {', '.join(options)}",
        )


def _validate_optional_bool(
    report: ValidationReport,
    section: str,
    path: str,
    value: object,
) -> None:
    if value is None:
        return
    if not isinstance(value, bool):
        report.add_error(
            section=section,
            path=path,
            code="invalid_type",
            message=f"{path} must be a boolean",
        )


def _require_mapping(
    value: object,
    path: str,
    section: str,
    report: ValidationReport,
) -> Mapping[str, Any] | None:
    if not isinstance(value, Mapping):
        report.add_error(
            section=section,
            path=path,
            code="invalid_type",
            message=f"{path} must be an object",
        )
        return None
    return value


def _is_non_empty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _has_value(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _has_battery_capacity_entity(config: Mapping[str, Any]) -> bool:
    return _has_device_entity(config, "battery", "capacity")


def _has_grid_power_entity(config: Mapping[str, Any]) -> bool:
    return _has_device_entity(config, "grid", "power")


def _has_device_entity(
    config: Mapping[str, Any],
    device: str,
    entity_key: str,
) -> bool:
    power_devices = config.get("power_devices")
    if not isinstance(power_devices, Mapping):
        return False

    device_config = power_devices.get(device)
    if not isinstance(device_config, Mapping):
        return False

    entities = device_config.get("entities")
    if not isinstance(entities, Mapping):
        return False

    return _has_value(entities.get(entity_key))
