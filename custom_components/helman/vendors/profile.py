"""What a hardware profile declares."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


#: The device path a profile with ``modes`` owns: the inverter mode control.
MODE_DEVICE_PATH = "controls.mode"


@dataclass(frozen=True)
class VendorProfile:
    """One piece of hardware, described as the config it fills in.

    ``entities`` and ``values`` are keyed by absolute *config paths* (dotted,
    such as ``energy_nodes.battery.entities.min_soc``); an entity is named by
    the unique-id template its integration registers it under, ``{name}``
    standing for the config entry's configured name. ``device_paths`` are
    relative to the device carrying the ``vendor`` key, such as
    ``controls.mode``. Every path a profile fills is owned: the stored config
    may not also set it.

    A profile with ``modes`` is driven through Helman's own inverter mode
    select, so it owns the device's ``controls.mode`` and points it there.
    """

    id: str
    label: str
    #: The device kind the profile goes on (``inverter``, ...).
    device_kind: str
    #: The integration that registers the profile's entities.
    platform: str
    entities: Mapping[str, str]
    values: Mapping[str, Any] = field(default_factory=dict)
    #: Each inverter action kind → the vendor writes that apply it, in order:
    #: ``(unique-id template of a select, option)``.
    modes: Mapping[str, tuple[tuple[str, str], ...]] = field(default_factory=dict)
    #: The unique-id template of the export limit number written after a mode:
    #: ``0`` for ``stop_export``, the grid's ``max_allowed_export_power``
    #: otherwise.
    export_limit: str | None = None

    @property
    def device_paths(self) -> tuple[str, ...]:
        """The paths, relative to the device, the profile owns there."""
        return (MODE_DEVICE_PATH,) if self.modes else ()

    @property
    def owned_config_paths(self) -> list[str]:
        return [*self.entities, *self.values]
