from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from ..controllables.config import (
    peek_controllable_kind,
    read_controllables,
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
) -> AppliancesRuntimeRegistry:
    """The appliance-kind controllables, as runtime objects.

    Since config version 7 the appliance kinds share one ``controllables:``
    list with the inverter. This registry stays appliance-only — projections,
    demand and the appliance websocket commands are meaningless for the
    inverter — so inverter entries are skipped rather than rejected. List
    positions are kept in the reported paths, so an error names the entry the
    user sees in the editor.
    """
    active_logger = logger or _LOGGER
    appliances_config = _read_appliances_list(config, logger=active_logger)
    if appliances_config is None:
        return AppliancesRuntimeRegistry()

    appliances = []
    seen_appliance_ids: set[str] = set()

    for index, raw_appliance in enumerate(appliances_config):
        if peek_controllable_kind(raw_appliance) == CONTROLLABLE_KIND_INVERTER:
            continue
        appliance_id = _peek_appliance_id(raw_appliance)

        try:
            appliance = _read_appliance_runtime(
                raw_appliance,
                path=f"controllables[{index}]",
            )
        except (
            ClimateApplianceConfigError,
            EvChargerConfigError,
            GenericApplianceConfigError,
        ) as err:
            _log_invalid_appliance(
                logger=active_logger,
                index=index,
                appliance_id=appliance_id,
                message=str(err),
            )
            continue

        if appliance.id in seen_appliance_ids:
            _log_invalid_appliance(
                logger=active_logger,
                index=index,
                appliance_id=appliance.id,
                message=f"duplicate appliance id {appliance.id!r}",
            )
            continue

        seen_appliance_ids.add(appliance.id)
        appliances.append(appliance)

    return AppliancesRuntimeRegistry.from_appliances(appliances)


def _read_appliances_list(
    config: Mapping[str, Any] | None,
    *,
    logger: logging.Logger,
) -> list[Any] | None:
    controllables = read_controllables(config)
    if controllables is None:
        return None

    if not isinstance(controllables, list):
        logger.error(
            "Ignoring controllables config: top-level 'controllables' must be a list"
        )
        return None

    return controllables


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
    index: int,
    appliance_id: str | None,
    message: str,
) -> None:
    location = f"controllables[{index}]"
    if appliance_id is not None:
        location += f" (id={appliance_id!r})"
    logger.error("Ignoring invalid appliance config at %s: %s", location, message)
