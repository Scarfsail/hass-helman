from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .automation.config import AutomationConfigError, read_automation_config
from .automation.optimizers.surplus_appliance import (
    SurplusApplianceValidationError,
    validate_surplus_appliance_optimizer_config,
)
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
from .scheduling.schedule import describe_schedule_control_config_issue

SUPPORTED_EDITABLE_APPLIANCE_KINDS = ("climate", "ev_charger", "generic")


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
    _validate_scheduler_control_config(config, report)
    _validate_automation_config(config, report)
    _validate_appliances_config(config, report)
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
    _validate_optional_positive_int(
        report,
        section,
        "power_devices.house.forecast.min_history_days",
        forecast_map.get("min_history_days"),
    )
    _validate_optional_positive_int(
        report,
        section,
        "power_devices.house.forecast.training_window_days",
        forecast_map.get("training_window_days"),
    )
    _validate_deferrable_consumers(
        forecast_map.get("deferrable_consumers"),
        report,
        section,
        "power_devices.house.forecast.deferrable_consumers",
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
            _validate_optional_entity_id(
                report,
                section,
                "power_devices.solar.entities.today_energy",
                entity_map.get("today_energy"),
            )
            _validate_optional_entity_id(
                report,
                section,
                "power_devices.solar.entities.remaining_today_energy_forecast",
                entity_map.get("remaining_today_energy_forecast"),
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

    # min_history_days: int in [1, 365]
    min_hist = bias_map.get("min_history_days")
    if min_hist is not None:
        if isinstance(min_hist, bool) or not isinstance(min_hist, int) or not (
            1 <= min_hist <= 365
        ):
            report.add_error(
                section=section,
                path=f"{base_path}.min_history_days",
                code="invalid_range",
                message=f"{base_path}.min_history_days must be an integer between 1 and 365",
            )

    # max_training_window_days: int in [1, 365]
    max_training_window_days = bias_map.get("max_training_window_days")
    if max_training_window_days is not None:
        if isinstance(max_training_window_days, bool) or not isinstance(
            max_training_window_days, int
        ) or not (1 <= max_training_window_days <= 365):
            report.add_error(
                section=section,
                path=f"{base_path}.max_training_window_days",
                code="invalid_range",
                message=f"{base_path}.max_training_window_days must be an integer between 1 and 365",
            )

    # legacy training_window_days: int in [1, 365]
    training_window_days = bias_map.get("training_window_days")
    if training_window_days is not None:
        if isinstance(training_window_days, bool) or not isinstance(
            training_window_days, int
        ) or not (1 <= training_window_days <= 365):
            report.add_error(
                section=section,
                path=f"{base_path}.training_window_days",
                code="invalid_range",
                message=f"{base_path}.training_window_days must be an integer between 1 and 365",
            )

    # training_time: HH:MM local-time string
    training_time = bias_map.get("training_time")
    if training_time is not None:
        if not _is_non_empty_string(training_time):
            report.add_error(
                section=section,
                path=f"{base_path}.training_time",
                code="invalid_type",
                message=f"{base_path}.training_time must be an HH:MM string",
            )
        else:
            tt = training_time.strip()
            m = re.match(r"^(\d{2}):(\d{2})$", tt)
            if not m:
                report.add_error(
                    section=section,
                    path=f"{base_path}.training_time",
                    code="invalid_format",
                    message=f"{base_path}.training_time must be an HH:MM string",
                )
            else:
                hh = int(m.group(1))
                mm = int(m.group(2))
                if not (0 <= hh <= 23 and 0 <= mm <= 59):
                    report.add_error(
                        section=section,
                        path=f"{base_path}.training_time",
                        code="invalid_value",
                        message=f"{base_path}.training_time must be a valid time",
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
            export_enabled_entity_id = slot_invalidation_map.get(
                "export_enabled_entity_id"
            )
            max_battery_soc_present = _has_value(max_battery_soc_percent)
            export_enabled_entity_present = _has_value(export_enabled_entity_id)

            if max_battery_soc_present != export_enabled_entity_present:
                report.add_error(
                    section=section,
                    path=slot_invalidation_path,
                    code="incomplete_slot_invalidation",
                    message=(
                        f"{slot_invalidation_path}.max_battery_soc_percent and "
                        f"{slot_invalidation_path}.export_enabled_entity_id must be "
                        "configured together"
                    ),
                )

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

            if export_enabled_entity_present:
                _validate_optional_entity_id(
                    report,
                    section,
                    f"{slot_invalidation_path}.export_enabled_entity_id",
                    export_enabled_entity_id,
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
            _validate_optional_entity_id(
                report,
                section,
                "power_devices.grid.entities.power",
                entity_map.get("power"),
            )

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


def _validate_scheduler_control_config(
    config: Mapping[str, Any],
    report: ValidationReport,
) -> None:
    section = "scheduler_control"
    raw_scheduler = config.get("scheduler")
    if raw_scheduler is None:
        return
    scheduler = _require_mapping(raw_scheduler, "scheduler", section, report)
    if scheduler is None:
        return

    raw_control = scheduler.get("control")
    if raw_control is None:
        return
    control = _require_mapping(raw_control, "scheduler.control", section, report)
    if control is None:
        return

    action_option_map = control.get("action_option_map")
    if action_option_map is not None:
        option_map = _require_mapping(
            action_option_map,
            "scheduler.control.action_option_map",
            section,
            report,
        )
        if option_map is not None:
            for key in (
                "normal",
                "stop_charging",
                "stop_discharging",
                "charge_to_target_soc",
                "discharge_to_target_soc",
                "stop_export",
            ):
                _validate_optional_string(
                    report,
                    section,
                    f"scheduler.control.action_option_map.{key}",
                    option_map.get(key),
                )

    issue = describe_schedule_control_config_issue(config)
    if issue is not None:
        report.add_error(
            section=section,
            path="scheduler.control",
            code="invalid_scheduler_control",
            message=issue,
        )

    mode_entity_id = control.get("mode_entity_id")
    _validate_optional_entity_id(
        report,
        section,
        "scheduler.control.mode_entity_id",
        mode_entity_id,
        allowed_domains=("input_select", "select"),
    )


def _validate_appliances_config(
    config: Mapping[str, Any],
    report: ValidationReport,
) -> None:
    section = "appliances"
    raw_appliances = config.get("appliances")
    if raw_appliances is None:
        return
    if not isinstance(raw_appliances, list):
        report.add_error(
            section=section,
            path="appliances",
            code="invalid_type",
            message="appliances must be a list",
        )
        return

    seen_appliance_ids: set[str] = set()
    for index, raw_appliance in enumerate(raw_appliances):
        path = f"appliances[{index}]"
        if not isinstance(raw_appliance, Mapping):
            report.add_error(
                section=section,
                path=path,
                code="invalid_type",
                message=f"{path} must be an object",
            )
            continue

        raw_kind = raw_appliance.get("kind")
        if not _is_non_empty_string(raw_kind):
            report.add_error(
                section=section,
                path=f"{path}.kind",
                code="required",
                message=f"{path}.kind must be a non-empty string",
            )
            continue

        kind = raw_kind.strip()
        if kind not in SUPPORTED_EDITABLE_APPLIANCE_KINDS:
            report.add_warning(
                section=section,
                path=path,
                code="unsupported_kind",
                message=(
                    f"Appliance kind {kind!r} is preserved but not editable in this "
                    "version"
                ),
            )
            continue

        try:
            appliance = _read_supported_appliance(raw_appliance, path=path, kind=kind)
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
            continue

        if appliance.id in seen_appliance_ids:
            report.add_error(
                section=section,
                path=f"{path}.id",
                code="duplicate_appliance_id",
                message=f"duplicate appliance id {appliance.id!r}",
            )
            continue

        seen_appliance_ids.add(appliance.id)


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
    for index, optimizer in enumerate(automation_config.execution_optimizers):
        if optimizer.kind != "surplus_appliance":
            continue
        try:
            validate_surplus_appliance_optimizer_config(
                optimizer,
                appliance_registry=appliance_registry,
            )
        except SurplusApplianceValidationError as err:
            report.add_error(
                section="automation",
                path=f"automation.optimizers[{index}].params.{err.field}",
                code="invalid_value",
                message=str(err),
            )


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


def _validate_deferrable_consumers(
    value: object,
    report: ValidationReport,
    section: str,
    path: str,
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

    seen_entity_ids: set[str] = set()
    for index, raw_item in enumerate(value):
        item_path = f"{path}[{index}]"
        if not isinstance(raw_item, Mapping):
            report.add_error(
                section=section,
                path=item_path,
                code="invalid_type",
                message=f"{item_path} must be an object",
            )
            continue

        energy_entity_id = raw_item.get("energy_entity_id")
        _validate_optional_entity_id(
            report,
            section,
            f"{item_path}.energy_entity_id",
            energy_entity_id,
        )
        if _is_non_empty_string(energy_entity_id):
            entity_id = energy_entity_id.strip()
            if entity_id in seen_entity_ids:
                report.add_error(
                    section=section,
                    path=f"{item_path}.energy_entity_id",
                    code="duplicate_entity_id",
                    message=f"duplicate deferrable consumer entity id {entity_id!r}",
                )
            seen_entity_ids.add(entity_id)

        _validate_optional_string(
            report,
            section,
            f"{item_path}.label",
            raw_item.get("label"),
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
    power_devices = config.get("power_devices")
    if not isinstance(power_devices, Mapping):
        return False

    battery = power_devices.get("battery")
    if not isinstance(battery, Mapping):
        return False

    entities = battery.get("entities")
    if not isinstance(entities, Mapping):
        return False

    return _has_value(entities.get("capacity"))
