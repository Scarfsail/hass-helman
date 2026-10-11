"""The SolaX inverter profile, as data.

Built against the X3-Hybrid-10kW behind ``solax_modbus``. Each entity is named
by its domain and the unique id ``solax_modbus`` registers it under, with ``{name}`` standing
for the config entry's configured name: plain entities are ``<name>_<key>``,
the energy-dashboard ones ``<name> Energy Dashboard_<key>``. Resolving by
unique id rather than entity id is what keeps a renamed entity working.

Min SoC is the Self Use discharge floor, read-only. It does not flip with the
use mode Helman itself writes, and Self Use is the mode in which Helman lets
the battery discharge on its own.

Helman's inverter modes are a port of the writes the hand-made automation
behind ``input_select.rezim_fv`` made on prod: the use mode first, then, in
Manual Mode, the manual mode. The export limit follows every mode; its value
is the user's grid contract, never the profile's.

The ``telemetry`` the inverter detail reads is taken from the prod registry
(2026-10-10), each under the domain it is registered in: the unique id does not
follow the entity id (``number.solax_inverter_eps_min_soc`` is
``SolaX_eps_min_soc``), and several of these are numbers, selects or a switch
rather than sensors.

Site facts (``max_power``, the ``forecast`` blocks other than the house total,
prices, efficiencies) are deliberately absent: they are the user's config,
whatever hardware sits behind them.
"""

from __future__ import annotations

from ..const import (
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_ACTION_STOP_EXPORT,
)
from ..controllables.spec import CONTROLLABLE_KIND_INVERTER
from .profile import MODE_DEVICE_PATH, VendorProfile

_USE_MODE = ("select", "{name}_charger_use_mode")
_MANUAL_MODE = ("select", "{name}_manual_mode_select")

PROFILE = VendorProfile(
    id="solax_inverter",
    label="SolaX inverter",
    device_kind=CONTROLLABLE_KIND_INVERTER,
    platform="solax_modbus",
    # The follow-up moves it to device binding once the device-aware snapshot
    # shows whether every entity sits on one HA device.
    binding="entry",
    entities={
        "energy_nodes.solar.entities.power": ("sensor", "{name}_pv_power_total"),
        "energy_nodes.solar.entities.today_energy": (
            "sensor",
            "{name}_today_s_solar_energy",
        ),
        "training.solar_bias.total_energy_entity_id": (
            "sensor",
            "{name}_total_solar_energy",
        ),
        "energy_nodes.battery.entities.power": (
            "sensor",
            "{name} Energy Dashboard_solax_battery_power",
        ),
        "energy_nodes.battery.entities.capacity": ("sensor", "{name}_battery_capacity"),
        "energy_nodes.battery.entities.remaining_energy": (
            "sensor",
            "{name}_remaining_battery_capacity",
        ),
        "energy_nodes.battery.entities.min_soc": (
            "number",
            "{name}_selfuse_discharge_min_soc",
        ),
        "energy_nodes.battery.entities.max_soc": (
            "number",
            "{name}_battery_charge_upper_soc",
        ),
        "energy_nodes.battery.entities.today_charge_energy": (
            "sensor",
            "{name}_battery_input_energy_today",
        ),
        "energy_nodes.battery.entities.today_discharge_energy": (
            "sensor",
            "{name}_battery_output_energy_today",
        ),
        "energy_nodes.grid.entities.power": (
            "sensor",
            "{name} Energy Dashboard_solax_grid_power",
        ),
        "energy_nodes.grid.entities.today_import": (
            "sensor",
            "{name}_today_s_import_energy",
        ),
        "energy_nodes.grid.entities.today_export": (
            "sensor",
            "{name}_today_s_export_energy",
        ),
        "energy_nodes.house.entities.power": (
            "sensor",
            "{name} Energy Dashboard_solax_home_consumption_power",
        ),
        "energy_nodes.house.entities.today_energy": (
            "sensor",
            "{name} Energy Dashboard_solax_home_consumption_energy",
        ),
        "energy_nodes.house.forecast.total_energy_entity_id": (
            "sensor",
            "{name} Energy Dashboard_solax_home_consumption_energy",
        ),
    },
    values={
        "energy_nodes.solar.entities.power_polarity": "positive_is_production",
        "energy_nodes.house.entities.power_polarity": "positive_is_consumption",
        "energy_nodes.battery.entities.power_polarity": "positive_is_discharging",
        "energy_nodes.grid.entities.power_polarity": "positive_is_import",
    },
    modes={
        SCHEDULE_ACTION_NORMAL: ((_USE_MODE, "Self Use Mode"),),
        SCHEDULE_ACTION_STOP_CHARGING: ((_USE_MODE, "Feedin Priority"),),
        SCHEDULE_ACTION_STOP_DISCHARGING: (
            (_USE_MODE, "Manual Mode"),
            (_MANUAL_MODE, "Stop Charge and Discharge"),
        ),
        SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC: (
            (_USE_MODE, "Manual Mode"),
            (_MANUAL_MODE, "Force Charge"),
        ),
        SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC: (
            (_USE_MODE, "Manual Mode"),
            (_MANUAL_MODE, "Force Discharge"),
        ),
        SCHEDULE_ACTION_STOP_EXPORT: ((_USE_MODE, "Self Use Mode"),),
    },
    device_paths=(MODE_DEVICE_PATH,),
    export_limit=("number", "{name}_export_control_user_limit"),
    telemetry={
        "use_mode": _USE_MODE,
        "manual_mode": _MANUAL_MODE,
        "run_mode": ("sensor", "{name}_run_mode"),
        "export_limit": ("number", "{name}_export_control_user_limit"),
        "pv_power_limit": ("number", "{name}_remotecontrol_pv_power_limit"),
        "main_breaker_limit": ("number", "{name}_main_breaker_current_limit"),
        "battery_charge_max_current": ("number", "{name}_battery_charge_max_current"),
        "battery_discharge_max_current": (
            "number",
            "{name}_battery_discharge_max_current",
        ),
        "eps_min_soc": ("number", "{name}_eps_min_soc"),
        "eps_restart_soc": ("number", "{name}_eps_restart_soc"),
        "remote_control": ("select", "{name}_remotecontrol_power_control"),
        "remote_control_mode": ("select", "{name}_remotecontrol_power_control_mode"),
        "active_power_target": ("sensor", "{name}_active_power_target"),
        "active_power_real": ("sensor", "{name}_active_power_real"),
        **{
            f"ac_{quantity}_l{phase}": ("sensor", f"{{name}}_inverter_{quantity}_l{phase}")
            for quantity in ("power", "voltage", "current", "frequency")
            for phase in (1, 2, 3)
        },
        "phase_balance": ("switch", "{name}_phase_power_balance_x3"),
        "inverter_temperature": ("sensor", "{name}_inverter_temperature"),
        "link_success_rate": ("sensor", "{name}_communication_success_rate"),
        "link_quarantined_registers": (
            "sensor",
            "{name}_communication_quarantined_registers",
        ),
        "firmware": ("sensor", "{name}_software_version"),
        "hardware_version": ("sensor", "{name}_hardware_version"),
        "rated_power": ("sensor", "{name}_inverter_power_type"),
        "mppt_count": ("sensor", "{name}_mppt_count"),
        "lock_state": ("select", "{name}_lock_state"),
        "grid_mode_runtime": ("sensor", "{name}_grid_mode_runtime"),
        "eps_mode_runtime": ("sensor", "{name}_eps_mode_runtime"),
        # The grid detail: the meter's per-phase power and import/export power,
        # and the grid frequency the inverter reads.
        **{
            f"grid_power_l{phase}": ("sensor", f"{{name}}_measured_power_l{phase}")
            for phase in (1, 2, 3)
        },
        "grid_import": ("sensor", "{name}_grid_import"),
        "grid_export": ("sensor", "{name}_grid_export"),
        "grid_frequency": ("sensor", "{name}_grid_frequency"),
        # The battery detail. Units per solax_modbus plugin_solax.py: V, A
        # (signed), °C, Wh (``chargeable_energy``: to 100 % SoC), W, kWh (the
        # lifetime totals), V (cells). ``max_charge_rate`` is the plugin's
        # BMS charge current × battery voltage, falling back to the inverter's
        # charge current setting when the BMS current is not read; the BMS
        # currents, lifetime totals, cells, type, temperature extremes and
        # connect state are disabled by default in the plugin.
        "battery_voltage": ("sensor", "{name}_battery_voltage_charge"),
        "battery_current": ("sensor", "{name}_battery_current_charge"),
        "battery_temperature": ("sensor", "{name}_battery_temperature"),
        "chargeable_energy": ("sensor", "{name}_chargeable_battery_capacity"),
        "max_charge_rate": ("sensor", "{name}_bms_max_charge"),
        "bdc_status": ("sensor", "{name}_bdc_status"),
        "bms_charge_max_current": ("sensor", "{name}_bms_charge_max_current"),
        "bms_discharge_max_current": ("sensor", "{name}_bms_discharge_max_current"),
        "input_energy_total": ("sensor", "{name}_battery_input_energy_total"),
        "output_energy_total": ("sensor", "{name}_battery_output_energy_total"),
        "cell_voltage_high": ("sensor", "{name}_cell_voltage_high"),
        "cell_voltage_low": ("sensor", "{name}_cell_voltage_low"),
        "cell_voltage_difference": (
            "sensor",
            "{name}_battery_voltage_cell_difference",
        ),
        "battery_type": ("sensor", "{name}_battery_type"),
        "battery_temp_high": ("sensor", "{name}_battery_temp_high"),
        "battery_temp_low": ("sensor", "{name}_battery_temp_low"),
        "bms_connect_state": ("sensor", "{name}_bms_connect_state"),
        "battery_heating": ("switch", "{name}_battery_heating"),
        **{
            f"battery_heating_{edge}_{period}": (
                "time",
                f"{{name}}_battery_heating_{edge}_time_{period}",
            )
            for period in (1, 2)
            for edge in ("start", "end")
        },
        # The house detail: the EPS output's measured active power per phase
        # (W), what the house draws from the inverter while off-grid.
        **{
            f"eps_power_l{phase}": ("sensor", f"{{name}}_eps_power_active_l{phase}")
            for phase in (1, 2, 3)
        },
        # The solar detail: each MPPT string's DC power (W), voltage (V) and
        # current (A), and the shade-tolerance (``Off``/``Low``/``Middle``/
        # ``High``) setting per string, a select.
        **{
            f"pv_{quantity}_{string}": ("sensor", f"{{name}}_pv_{quantity}_{string}")
            for quantity in ("power", "voltage", "current")
            for string in (1, 2)
        },
        **{
            f"shade_fix_pv{string}": (
                "select",
                f"{{name}}_shadow_fix_function_level_pv{string}_gmppt",
            )
            for string in (1, 2)
        },
    },
    # ``measured_power_l*`` reads positive while feeding in: on the dev mirror
    # (2026-10-10) ``measured_power`` +405 W sat beside the energy dashboard's
    # grid power -405 W, whose own polarity is positive_is_import.
    grid_phase_power_polarity="positive_is_export",
    # Gen4+ run_mode strings (solax_modbus plugin_solax.py, register 0x9).
    run_mode_conditions={
        "Off-Grid": "off_grid",
        "Fault": "fault",
        "Permanent Fault Mode": "fault",
    },
    # Gen4 register 0x17 (solax_modbus plugin_solax.py); Gen6 swaps the
    # numbers but keeps the strings.
    bms_connect_conditions={"Disconnected": "bms_disconnected"},
)
