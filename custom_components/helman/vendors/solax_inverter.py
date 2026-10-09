"""The SolaX inverter profile, as data.

Built against the X3-Hybrid-10kW behind ``solax_modbus``. Each entity is named
by the unique id ``solax_modbus`` registers it under, with ``{name}`` standing
for the config entry's configured name: plain entities are ``<name>_<key>``,
the energy-dashboard ones ``<name> Energy Dashboard_<key>``. Resolving by
unique id rather than entity id is what keeps a renamed entity working.

Min SoC is the Self Use discharge floor, read-only. It does not flip with the
use mode Helman itself writes, and Self Use is the mode in which Helman lets
the battery discharge on its own.

Site facts (``max_power``, the ``forecast`` blocks other than the house total,
prices, efficiencies) are deliberately absent: they are the user's config,
whatever hardware sits behind them.
"""

from __future__ import annotations

from ..controllables.spec import CONTROLLABLE_KIND_INVERTER
from .profile import VendorProfile

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
)
