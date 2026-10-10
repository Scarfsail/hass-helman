"""The SolaX EV charger profile, as data.

Built against the SolaX charger behind ``solax_modbus``, whose entities sit on
one HA device of its config entry: the profile binds to that device. Each
entity is named by its domain and the unique id ``solax_modbus`` registers it
under, ``<name>_<key>`` with ``{name}`` standing for the entry's configured
name. The charger registers ``control_command`` both as a sensor and as a
select; the select is the one written.

The charge switch is a port of the ``switch.ev_nabijeni`` template helper on
prod: charging is the run mode reading ``Charging``, starting and stopping are
writes to the control command select, and stopping returns the use mode to
``ECO``. The use modes and the eco gear powers match prod; they are profile
constants, not the user's config.

The charger's ``id``, ``name``, ``icon``, ``limits``, ``vehicles``, groups,
whether it is schedulable and its place in the device tree stay user config.
"""

from __future__ import annotations

from ..controllables.spec import CONTROLLABLE_KIND_EV_CHARGER
from .profile import CHARGE_DEVICE_PATH, ChargingControl, VendorProfile

_USE_MODE = ("select", "{name}_charger_use_mode")

PROFILE = VendorProfile(
    id="solax_ev_charger",
    label="SolaX EV charger",
    device_kind=CONTROLLABLE_KIND_EV_CHARGER,
    platform="solax_modbus",
    binding="device",
    device_paths=(
        "consumption.energy_entity_id",
        "consumption.power_entity_id",
        CHARGE_DEVICE_PATH,
        "controls.use_mode",
        "controls.eco_gear",
    ),
    device_entities={
        "consumption.energy_entity_id": ("sensor", "{name}_charge_added_total"),
        "consumption.power_entity_id": ("sensor", "{name}_charge_power_total"),
        "controls.use_mode.entity_id": _USE_MODE,
        "controls.eco_gear.entity_id": ("select", "{name}_eco_gear"),
    },
    device_values={
        "controls.use_mode.values": {
            "Fast": {"behavior": "fixed_max_power"},
            "ECO": {"behavior": "surplus_aware"},
        },
        "controls.eco_gear.values": {
            "6A": {"min_power_kw": 3.5},
            "10A": {"min_power_kw": 6.9},
        },
    },
    charging=ChargingControl(
        state=(("sensor", "{name}_run_mode"), "Charging"),
        command=("select", "{name}_control_command"),
        on_option="Start Charging",
        off_option="Stop Charging",
        after_off=((_USE_MODE, "ECO"),),
    ),
)
