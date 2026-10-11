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

The telemetry is what the EV charger detail reads, display only: the run mode
the charge switch also reads, the hardware's session counters, per-phase power,
its grid CT reading and its fault, link and setting registers. Domains and
unique ids are the prod registry's (``dev/solax_modbus/registry_snapshot.json``).
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
    telemetry={
        "run_mode": ("sensor", "{name}_run_mode"),
        "charge_mode": ("sensor", "{name}_charge_mode"),
        **{
            f"charge_power_l{phase}": ("sensor", f"{{name}}_charge_power_l{phase}")
            for phase in (1, 2, 3)
        },
        "active_phase": ("sensor", "{name}_active_charge_phase"),
        "session_energy": ("sensor", "{name}_charge_added"),
        "session_duration": ("sensor", "{name}_charge_duration"),
        "green_start_power": ("sensor", "{name}_green_mode_start_power"),
        "grid_power": ("sensor", "{name}_grid_power_total"),
        "temperature": ("sensor", "{name}_charger_temperature"),
        "fault_code": ("sensor", "{name}_fault_code"),
        "fault_description": ("sensor", "{name}_fault_description"),
        "network_status": ("sensor", "{name}_net_connected"),
        "firmware": ("sensor", "{name}_firmware_version"),
        "link_success_rate": ("sensor", "{name}_communication_success_rate"),
        "auth_priority": ("select", "{name}_auth_priority"),
        "main_breaker_limit": ("number", "{name}_main_breaker_limit"),
        "lock": ("switch", "{name}_electronic_lock"),
    },
    # The charger's OCPP-style run modes, as solax_modbus names them. Any other
    # (Reserved, Unavailable, Update, RFID Activation) is shown as read.
    run_mode_conditions={
        "Charging": "charging",
        "Preparing": "waiting",
        "SuspendedEV": "waiting",
        "SuspendedEVSE": "waiting",
        "Finishing": "waiting",
        "Available": "no_car",
        "Faulted": "fault",
    },
    charging=ChargingControl(
        state=(("sensor", "{name}_run_mode"), "Charging"),
        command=("select", "{name}_control_command"),
        on_option="Start Charging",
        off_option="Stop Charging",
        after_off=((_USE_MODE, "ECO"),),
    ),
)
