from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any

from ..controllables.config import (
    effective_meter,
    is_schedulable,
    iter_device_paths,
    peek_controllable_kind,
    read_devices,
    resolve_device_name,
)
from ..controllables.spec import CONTROLLABLE_KIND_INVERTER
from .climate_appliance import ClimateApplianceConfigError, read_climate_appliance
from .ev_charger import EvChargerConfigError, read_ev_charger_appliance
from .generic_appliance import GenericApplianceConfigError, read_generic_appliance
from .state import AppliancesRuntimeRegistry

_LOGGER = logging.getLogger(__name__)

_CLIMATE_APPLIANCE_KIND = "climate"
_EV_CHARGER_KIND = "ev_charger"
_GENERIC_APPLIANCE_KIND = "generic"


def build_appliances_runtime_registry(
    config: Mapping[str, Any] | None,
    *,
    logger: logging.Logger | None = None,
    friendly_name: Callable[[str], str | None] | None = None,
) -> AppliancesRuntimeRegistry:
    """The schedulable appliance devices, as runtime objects.

    Since config version 20 the appliance kinds live in the ``devices:`` tree
    with the inverter and every passive device. This registry holds only what
    Helman may schedule — projections, demand and the appliance websocket
    commands are meaningless for the inverter and for a passive device — so
    those are skipped rather than rejected. Every level of the tree is walked:
    a schedulable child is as much an appliance as a top-level device.
    """
    active_logger = logger or _LOGGER
    if not _has_devices_list(config, logger=active_logger):
        return AppliancesRuntimeRegistry()

    appliances = []
    seen_appliance_ids: set[str] = set()
    visualization = config.get("visualization") if isinstance(config, Mapping) else None
    cleaner_regex = (
        visualization.get("power_sensor_name_cleaner_regex")
        if isinstance(visualization, Mapping)
        else None
    )

    for path, device, parent in iter_device_paths(config):
        if not isinstance(device, Mapping):
            continue
        if peek_controllable_kind(device) == CONTROLLABLE_KIND_INVERTER:
            continue
        if not is_schedulable(device):
            continue
        appliance_id = _peek_appliance_id(device)

        try:
            appliance = read_device_appliance(
                device,
                parent,
                path=path,
                friendly_name=friendly_name,
                cleaner_regex=cleaner_regex if isinstance(cleaner_regex, str) else None,
            )
        except (
            ClimateApplianceConfigError,
            EvChargerConfigError,
            GenericApplianceConfigError,
        ) as err:
            _log_invalid_appliance(
                logger=active_logger,
                path=path,
                appliance_id=appliance_id,
                message=str(err),
            )
            continue

        if appliance.id in seen_appliance_ids:
            _log_invalid_appliance(
                logger=active_logger,
                path=path,
                appliance_id=appliance.id,
                message=f"duplicate appliance id {appliance.id!r}",
            )
            continue

        seen_appliance_ids.add(appliance.id)
        appliances.append(appliance)

    return AppliancesRuntimeRegistry.from_appliances(appliances)


def _has_devices_list(
    config: Mapping[str, Any] | None,
    *,
    logger: logging.Logger,
) -> bool:
    devices = read_devices(config)
    if devices is None:
        return False

    if not isinstance(devices, list):
        logger.error("Ignoring devices config: top-level 'devices' must be a list")
        return False

    return True


def read_device_appliance(
    device: Mapping[str, Any],
    parent: Mapping[str, Any] | None,
    *,
    path: str,
    friendly_name: Callable[[str], str | None] | None = None,
    cleaner_regex: str | None = None,
):
    """One appliance device as its per-kind runtime object.

    The per-kind readers receive the default ``generic`` kind, the shared
    resolved name (the id when entity states are unavailable), and the device's
    effective meter — so a meterless child on ``history_average`` reads its
    parent's meter. These derived fields are never written to the document.
    """
    view = dict(device)
    view.setdefault("kind", _GENERIC_APPLIANCE_KIND)
    view["name"] = resolve_device_name(
        device,
        friendly_name=friendly_name or (lambda _entity_id: None),
        cleaner_regex=cleaner_regex,
    )
    meter = effective_meter(device, parent)
    consumption = device.get("consumption")
    if meter is not None and isinstance(consumption, Mapping):
        view["consumption"] = {**consumption, "energy_entity_id": meter}
    return _read_appliance_runtime(view, path=path)


def _peek_appliance_id(value: object) -> str | None:
    if not isinstance(value, Mapping):
        return None
    appliance_id = value.get("id")
    if not isinstance(appliance_id, str):
        return None
    stripped = appliance_id.strip()
    return stripped or None


def _peek_appliance_kind(value: object) -> str | None:
    if not isinstance(value, Mapping):
        return None
    appliance_kind = value.get("kind")
    if not isinstance(appliance_kind, str):
        return None
    stripped = appliance_kind.strip()
    return stripped or None


def _read_appliance_runtime(
    value: object,
    *,
    path: str,
):
    if not isinstance(value, Mapping):
        raise GenericApplianceConfigError(f"{path} must be an object")

    kind = _peek_appliance_kind(value)
    if kind == _CLIMATE_APPLIANCE_KIND:
        return read_climate_appliance(value, path=path)
    if kind == _EV_CHARGER_KIND:
        return read_ev_charger_appliance(value, path=path)
    if kind == _GENERIC_APPLIANCE_KIND:
        return read_generic_appliance(value, path=path)

    raise GenericApplianceConfigError(
        f"{path}.kind must be one of {_CLIMATE_APPLIANCE_KIND!r}, "
        f"{_EV_CHARGER_KIND!r}, {_GENERIC_APPLIANCE_KIND!r}"
    )


def _log_invalid_appliance(
    *,
    logger: logging.Logger,
    path: str,
    appliance_id: str | None,
    message: str,
) -> None:
    location = path
    if appliance_id is not None:
        location += f" (id={appliance_id!r})"
    logger.error("Ignoring invalid appliance config at %s: %s", location, message)
