from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any

from ..controllables.config import (
    effective_meter,
    is_schedulable,
    iter_device_paths,
    read_consumers,
    read_name_cleaner_regex,
    resolve_device_name,
)
from ..controllables.spec import (
    CONTROLLABLE_KIND_GENERIC,
    appliance_controllable_kinds,
    spec_for,
)
from .errors import ApplianceConfigError
from .state import AppliancesRuntimeRegistry

_LOGGER = logging.getLogger(__name__)


def build_appliances_runtime_registry(
    config: Mapping[str, Any] | None,
    *,
    logger: logging.Logger | None = None,
    friendly_name: Callable[[str], str | None] | None = None,
) -> AppliancesRuntimeRegistry:
    """The schedulable appliance devices, as runtime objects.

    Since config version 20 the appliance kinds live in the ``devices:`` tree
    with every passive device. This registry holds only what Helman may
    schedule — projections, demand and the appliance websocket commands are
    meaningless for a passive device — so those are skipped rather than
    rejected. Every level of the tree is walked:
    a schedulable child is as much an appliance as a top-level device.
    """
    active_logger = logger or _LOGGER
    if not _has_devices_list(config, logger=active_logger):
        return AppliancesRuntimeRegistry()

    appliances = []
    seen_appliance_ids: set[str] = set()
    cleaner_regex = read_name_cleaner_regex(config)

    for path, device, parent in iter_device_paths(config):
        if not isinstance(device, Mapping):
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
                cleaner_regex=cleaner_regex,
            )
        except ApplianceConfigError as err:
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
    devices = read_consumers(config)
    if devices is None:
        return False

    if not isinstance(devices, list):
        logger.error("Ignoring devices config: 'devices.consumers' must be a list")
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
    view.setdefault("kind", CONTROLLABLE_KIND_GENERIC)
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
        raise ApplianceConfigError(path, "must be an object")

    kind = _peek_appliance_kind(value)
    appliance_kinds = appliance_controllable_kinds()
    if kind not in appliance_kinds:
        allowed = ", ".join(repr(kind) for kind in sorted(appliance_kinds))
        raise ApplianceConfigError(f"{path}.kind", f"must be one of {allowed}")
    return spec_for(kind).read(value, path=path)


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
