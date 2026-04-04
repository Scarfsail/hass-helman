from __future__ import annotations

from importlib import import_module

__all__ = [
    "AppliancesRuntimeRegistry",
    "ApplianceMetadataResponseDict",
    "ApplianceProjectionsResponseDict",
    "ApplianceProjectionPointDict",
    "ApplianceProjectionSeriesDict",
    "ApplianceDemandPoint",
    "ApplianceProjectionPlan",
    "ApplianceProjectionPlanPoint",
    "ApplianceProjectionSeries",
    "ProjectionInputBundle",
    "ApplianceExecutionMemory",
    "AppliancesExecutionResult",
    "AppliancesExecutor",
    "ApplianceScheduleActionDict",
    "ApplianceScheduleActionsDict",
    "EvChargerExecutor",
    "EvChargerApplianceResponseDict",
    "EvChargerApplianceRuntime",
    "EvChargerConfigError",
    "EvChargerEcoGearRuntime",
    "EvChargerUseModeRuntime",
    "EvVehicleRuntime",
    "build_appliances_response",
    "build_appliances_runtime_registry",
    "build_empty_appliance_projections_response",
    "build_empty_appliances_response",
    "build_appliance_projection_plan",
    "build_projection_input_bundle",
    "build_appliance_projections_response",
    "aggregate_appliance_demand_by_slot",
    "build_adjusted_house_forecast",
    "normalize_appliance_schedule_actions",
    "read_ev_charger_appliance",
    "read_appliance_schedule_actions",
]

_EXPORTS = {
    "AppliancesRuntimeRegistry": (".state", "AppliancesRuntimeRegistry"),
    "ApplianceMetadataResponseDict": (".dto", "ApplianceMetadataResponseDict"),
    "ApplianceProjectionsResponseDict": (
        ".projection_response",
        "ApplianceProjectionsResponseDict",
    ),
    "ApplianceProjectionPointDict": (".projection_response", "ApplianceProjectionPointDict"),
    "ApplianceProjectionSeriesDict": (".projection_response", "ApplianceProjectionSeriesDict"),
    "ApplianceDemandPoint": (".projection_builder", "ApplianceDemandPoint"),
    "ApplianceProjectionPlan": (".projection_builder", "ApplianceProjectionPlan"),
    "ApplianceProjectionPlanPoint": (
        ".projection_builder",
        "ApplianceProjectionPlanPoint",
    ),
    "ApplianceProjectionSeries": (".projection_builder", "ApplianceProjectionSeries"),
    "ProjectionInputBundle": (".projection_builder", "ProjectionInputBundle"),
    "ApplianceExecutionMemory": (".execution", "ApplianceExecutionMemory"),
    "AppliancesExecutionResult": (".execution", "AppliancesExecutionResult"),
    "AppliancesExecutor": (".execution", "AppliancesExecutor"),
    "ApplianceScheduleActionDict": (".schedule", "ApplianceScheduleActionDict"),
    "ApplianceScheduleActionsDict": (".schedule", "ApplianceScheduleActionsDict"),
    "EvChargerExecutor": (".execution", "EvChargerExecutor"),
    "EvChargerApplianceResponseDict": (".ev_charger", "EvChargerApplianceResponseDict"),
    "EvChargerApplianceRuntime": (".ev_charger", "EvChargerApplianceRuntime"),
    "EvChargerConfigError": (".ev_charger", "EvChargerConfigError"),
    "EvChargerEcoGearRuntime": (".ev_charger", "EvChargerEcoGearRuntime"),
    "EvChargerUseModeRuntime": (".ev_charger", "EvChargerUseModeRuntime"),
    "EvVehicleRuntime": (".ev_charger", "EvVehicleRuntime"),
    "build_appliances_response": (".dto", "build_appliances_response"),
    "build_appliances_runtime_registry": (".config", "build_appliances_runtime_registry"),
    "build_empty_appliance_projections_response": (
        ".projection_response",
        "build_empty_appliance_projections_response",
    ),
    "build_empty_appliances_response": (".dto", "build_empty_appliances_response"),
    "build_appliance_projection_plan": (".projection_builder", "build_appliance_projection_plan"),
    "build_projection_input_bundle": (".projection_builder", "build_projection_input_bundle"),
    "build_appliance_projections_response": (
        ".projection_response",
        "build_appliance_projections_response",
    ),
    "aggregate_appliance_demand_by_slot": (
        ".forecast_integration",
        "aggregate_appliance_demand_by_slot",
    ),
    "build_adjusted_house_forecast": (
        ".forecast_integration",
        "build_adjusted_house_forecast",
    ),
    "normalize_appliance_schedule_actions": (
        ".schedule",
        "normalize_appliance_schedule_actions",
    ),
    "read_ev_charger_appliance": (".ev_charger", "read_ev_charger_appliance"),
    "read_appliance_schedule_actions": (".schedule", "read_appliance_schedule_actions"),
}


def __getattr__(name: str):
    try:
        module_name, attr_name = _EXPORTS[name]
    except KeyError as err:
        raise AttributeError(name) from err
    module = import_module(module_name, __name__)
    value = getattr(module, attr_name)
    globals()[name] = value
    return value
