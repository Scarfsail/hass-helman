"""What a hardware profile declares."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


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
    """

    id: str
    label: str
    #: The device kind the profile goes on (``inverter``, ...).
    device_kind: str
    #: The integration that registers the profile's entities.
    platform: str
    entities: Mapping[str, str]
    values: Mapping[str, Any] = field(default_factory=dict)
    device_paths: tuple[str, ...] = ()

    @property
    def owned_config_paths(self) -> list[str]:
        return [*self.entities, *self.values]
