"""The SolaX inverter profile, as data.

Built against the X3-Hybrid-10kW behind ``solax_modbus``. Each entity is named
by the unique id ``solax_modbus`` registers it under, with ``{name}`` standing
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
from .profile import VendorProfile

_USE_MODE = "{name}_charger_use_mode"
_MANUAL_MODE = "{name}_manual_mode_select"

PROFILE = VendorProfile(
    id="solax_inverter",
    label="SolaX inverter",
    device_kind=CONTROLLABLE_KIND_INVERTER,
    platform="solax_modbus",
    entities={
        "energy_nodes.solar.entities.power": "{name}_pv_power_total",
        "energy_nodes.solar.entities.today_energy": "{name}_today_s_solar_energy",
        "training.solar_bias.total_energy_entity_id": "{name}_total_solar_energy",
        "energy_nodes.battery.entities.power": (
            "{name} Energy Dashboard_solax_battery_power"
        ),
        "energy_nodes.battery.entities.capacity": "{name}_battery_capacity",
        "energy_nodes.battery.entities.remaining_energy": (
            "{name}_remaining_battery_capacity"
        ),
        "energy_nodes.battery.entities.min_soc": "{name}_selfuse_discharge_min_soc",
        "energy_nodes.battery.entities.max_soc": "{name}_battery_charge_upper_soc",
        "energy_nodes.battery.entities.today_charge_energy": (
            "{name}_battery_input_energy_today"
        ),
        "energy_nodes.battery.entities.today_discharge_energy": (
            "{name}_battery_output_energy_today"
        ),
        "energy_nodes.grid.entities.power": "{name} Energy Dashboard_solax_grid_power",
        "energy_nodes.grid.entities.today_import": "{name}_today_s_import_energy",
        "energy_nodes.grid.entities.today_export": "{name}_today_s_export_energy",
        "energy_nodes.house.entities.power": (
            "{name} Energy Dashboard_solax_home_consumption_power"
        ),
        "energy_nodes.house.entities.today_energy": (
            "{name} Energy Dashboard_solax_home_consumption_energy"
        ),
        "energy_nodes.house.forecast.total_energy_entity_id": (
            "{name} Energy Dashboard_solax_home_consumption_energy"
        ),
    },
    values={
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
    export_limit="{name}_export_control_user_limit",
)
