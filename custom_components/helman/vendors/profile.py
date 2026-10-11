"""What a hardware profile declares."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

#: The device path a profile with ``modes`` owns: the inverter mode control.
MODE_DEVICE_PATH = "controls.mode"

#: The device path a profile with ``charging`` owns: the charge switch.
CHARGE_DEVICE_PATH = "controls.charge"

#: An entity of the profile's integration: ``(domain, unique-id template)``.
#: The domain matters because one unique id can be registered in several
#: domains, such as a SolaX charger's ``control_command`` sensor and select.
EntityTemplate = tuple[str, str]


@dataclass(frozen=True)
class ChargingControl:
    """How Helman's own EV charging switch drives the charger.

    A command write is issued twice when the command select already shows that
    option, so the charger acts on a command it already displays; the
    ``after_off`` writes are issued once each, after the off command.
    """

    #: The entity whose state says the charger is charging, and that state.
    state: tuple[EntityTemplate, str]
    #: The select the start and stop commands are written to.
    command: EntityTemplate
    on_option: str
    off_option: str
    after_off: tuple[tuple[EntityTemplate, str], ...] = ()

    @property
    def templates(self) -> list[EntityTemplate]:
        """Every entity the switch reads or writes."""
        return [
            self.state[0],
            self.command,
            *(template for template, _option in self.after_off),
        ]


@dataclass(frozen=True)
class VendorProfile:
    """One piece of hardware, described as the config it fills in.

    ``entities`` and ``values`` are keyed by absolute *config paths* (dotted,
    such as ``energy_nodes.battery.entities.min_soc``); an entity is named by
    its domain and the unique-id template its integration registers it under,
    ``{name}`` standing for the config entry's configured name.
    ``device_paths`` are relative to the device carrying the ``profile`` key,
    such as ``controls.mode``, and so are the keys of ``device_entities`` and
    ``device_values``. Every path a profile fills is owned: the stored config
    may not also set it, at the path or under it.

    A profile binds to a config entry of its integration (``binding="entry"``)
    or to one HA device of it (``binding="device"``); a device-bound profile
    resolves only the entities on that device.

    A profile with ``modes`` is driven through Helman's own inverter mode
    select, and one with ``charging`` through Helman's own EV charging switch;
    each points its owned control there.

    ``telemetry`` names read-only readings the node details show, by metric
    key (``inverter_temperature``, ...). They are not config: they never
    enter the config document or :attr:`owned_config_paths`, and resolve
    through :func:`~custom_components.helman.vendors.resolve_vendor_telemetry`.
    """

    id: str
    label: str
    #: The device kind the profile goes on (``inverter``, ``ev_charger``, ...).
    device_kind: str
    #: The integration that registers the profile's entities.
    platform: str
    binding: Literal["entry", "device"]
    entities: Mapping[str, EntityTemplate] = field(default_factory=dict)
    values: Mapping[str, Any] = field(default_factory=dict)
    #: The paths, relative to the device, the profile owns there.
    device_paths: tuple[str, ...] = ()
    device_entities: Mapping[str, EntityTemplate] = field(default_factory=dict)
    device_values: Mapping[str, Any] = field(default_factory=dict)
    #: Each inverter action kind → the vendor writes that apply it, in order:
    #: ``(select, option)``.
    modes: Mapping[str, tuple[tuple[EntityTemplate, str], ...]] = field(
        default_factory=dict
    )
    #: The export limit number written after a mode: ``0`` for
    #: ``stop_export``, the grid's ``max_allowed_export_power`` otherwise.
    export_limit: EntityTemplate | None = None
    charging: ChargingControl | None = None
    telemetry: Mapping[str, EntityTemplate] = field(default_factory=dict)
    #: A ``run_mode`` telemetry state → what the hardware reports by it: for
    #: an inverter the condition its details promote (``off_grid`` or
    #: ``fault``), for an EV charger its status (``charging``, ``waiting``,
    #: ``no_car`` or ``fault``). Any other state is shown as read, without a
    #: verdict.
    run_mode_conditions: Mapping[str, str] = field(default_factory=dict)
    #: A ``bms_connect_state`` telemetry state → the condition the battery
    #: detail promotes for it (``bms_disconnected``): an explicit hardware
    #: report, never inferred from other readings.
    bms_connect_conditions: Mapping[str, str] = field(default_factory=dict)
    #: Which way the ``grid_power_l*`` telemetry reads positive
    #: (``positive_is_import`` or ``positive_is_export``), the vocabulary of the
    #: grid's ``power_polarity``; ``None`` when the profile has no phase power.
    grid_phase_power_polarity: str | None = None

    @property
    def owned_config_paths(self) -> list[str]:
        return [*self.entities, *self.values]
