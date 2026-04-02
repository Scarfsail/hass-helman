from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from .ev_charger import EvChargerConfigError, read_ev_charger_appliance
from .state import AppliancesRuntimeRegistry

_LOGGER = logging.getLogger(__name__)

_EV_CHARGER_KIND = "ev_charger"


def build_appliances_runtime_registry(
    config: Mapping[str, Any] | None,
    *,
    logger: logging.Logger | None = None,
) -> AppliancesRuntimeRegistry:
    active_logger = logger or _LOGGER
    appliances_config = _read_appliances_list(config, logger=active_logger)
    if appliances_config is None:
        return AppliancesRuntimeRegistry()

    appliances = []
    seen_appliance_ids: set[str] = set()

    for index, raw_appliance in enumerate(appliances_config):
        appliance_id = _peek_appliance_id(raw_appliance)
        kind = _peek_appliance_kind(raw_appliance)

        try:
            if kind != _EV_CHARGER_KIND:
                raise EvChargerConfigError(
                    f"appliances[{index}].kind must be {_EV_CHARGER_KIND!r}"
                )
            appliance = read_ev_charger_appliance(
                raw_appliance,
                path=f"appliances[{index}]",
            )
        except EvChargerConfigError as err:
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
    if config is None or not isinstance(config, Mapping):
        return None

    appliances = config.get("appliances")
    if appliances is None:
        return None

    if not isinstance(appliances, list):
        logger.error("Ignoring appliances config: top-level 'appliances' must be a list")
        return None

    return appliances


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


def _log_invalid_appliance(
    *,
    logger: logging.Logger,
    index: int,
    appliance_id: str | None,
    message: str,
) -> None:
    location = f"appliances[{index}]"
    if appliance_id is not None:
        location += f" (id={appliance_id!r})"
    logger.error("Ignoring invalid appliance config at %s: %s", location, message)
