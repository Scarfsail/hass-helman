"""Every "is this appliance running?" question gets the same answer.

Four places ask it of a scheduled action: the snapshot reader
(``is_appliance_action_active``), each executor's driver (``is_enabled``), the
projection builder (a running action projects demand) and the coordinator's
projected-history filter. #495 found them equivalent on normalized documents;
this pins that for every kind over every action the normalizers accept, plus
the absent action, so collapsing them onto one predicate cannot change an
answer.
"""

from __future__ import annotations

import dataclasses
import unittest
from datetime import datetime

from _fakes import _climate_appliance, _generic_appliance, _valid_config

from custom_components.helman.appliances.config import (
    build_appliances_runtime_registry,
)
from custom_components.helman.appliances.drivers import (
    ClimateApplianceDriver,
    EvChargerDriver,
    GenericApplianceDriver,
)
from custom_components.helman.appliances.projection_builder import (
    ProjectionInputBundle,
    build_appliance_projection_plan,
)
from custom_components.helman.appliances.schedule import (
    is_appliance_action_active,
    normalize_appliance_schedule_actions,
)
from custom_components.helman.appliances.state import AppliancesRuntimeRegistry
from custom_components.helman.coordinator import HelmanCoordinator
from custom_components.helman.scheduling.schedule import (
    ScheduleDocument,
    format_slot_id,
)
from custom_components.helman.slot_grid import SLOT

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
SLOT_START = datetime.fromisoformat("2026-03-20T22:00:00+01:00")
SLOT_ID = format_slot_id(SLOT_START)

_DRIVERS = {
    "climate": ClimateApplianceDriver(),
    "ev_charger": EvChargerDriver(),
    "generic": GenericApplianceDriver(),
}

#: Raw actions per kind; whatever the normalizer accepts is what gets pinned.
_CANDIDATE_ACTIONS = {
    "generic": [
        {"on": True},
        {"on": False},
        {"on": True, "setBy": "automation", "conditionMet": False},
        {"on": False, "setBy": "user"},
    ],
    "climate": [
        {"mode": mode, **extra}
        for mode in ("heat", "cool", "off", "auto", "dry", "fan_only")
        for extra in ({}, {"setBy": "automation", "conditionMet": False})
    ],
    "ev_charger": [
        {"charge": False},
        {"charge": False, "vehicleId": "kona"},
        {"charge": True, "vehicleId": "kona", "useMode": "Fast"},
        {"charge": True, "vehicleId": "kona", "useMode": "ECO", "ecoGear": "6A"},
        {"charge": True, "vehicleId": "kona", "useMode": "ECO", "ecoGear": "10A"},
        {
            "charge": True,
            "vehicleId": "kona",
            "useMode": "Fast",
            "setBy": "automation",
            "conditionMet": False,
        },
    ],
}


def _registry() -> AppliancesRuntimeRegistry:
    config = _valid_config()
    config["devices"]["consumers"] += [
        _generic_appliance(strategy="history_average"),
        _climate_appliance(strategy="history_average"),
    ]
    return build_appliances_runtime_registry(config)


def _appliance_variants(registry: AppliancesRuntimeRegistry):
    """Each configured appliance, plus the climate capability shapes it can take."""
    for appliance in registry.appliances:
        yield appliance
        if appliance.kind == "climate":
            yield dataclasses.replace(appliance, supported_modes=("heat",))
            yield dataclasses.replace(appliance, supported_modes=("cool",))
            yield dataclasses.replace(appliance, stop_hvac_mode=None)


def _normalized_actions(appliance) -> list[dict]:
    registry = AppliancesRuntimeRegistry.from_appliances([appliance])
    actions = []
    for raw in _CANDIDATE_ACTIONS[appliance.kind]:
        try:
            normalized = normalize_appliance_schedule_actions(
                {appliance.id: raw},
                registry=registry,
                context="actions",
                mode="strict",
            )
        except ValueError:
            continue
        actions.append(normalized[appliance.id])
    return actions


def _projection_inputs() -> ProjectionInputBundle:
    """Enough forecast for the one pinned slot that a running charger draws."""
    slot_starts = [SLOT_START + SLOT * index for index in range(4)]
    current_slot_start = REFERENCE_TIME.replace(minute=0)
    return ProjectionInputBundle(
        current_slot_start=current_slot_start,
        reference_time=REFERENCE_TIME,
        current_house_kwh=0.2,
        house_series_by_slot={start: 0.2 for start in slot_starts},
        solar_by_slot_wh={start: 1500.0 for start in slot_starts},
    )


def _projects_demand(appliance, action) -> bool:
    plan = build_appliance_projection_plan(
        generated_at=REFERENCE_TIME.isoformat(),
        registry=AppliancesRuntimeRegistry.from_appliances([appliance]),
        schedule_document=ScheduleDocument(
            slots={} if action is None else {SLOT_ID: {appliance.id: action}}
        ),
        inputs=_projection_inputs(),
        hass=None,
        reference_time=REFERENCE_TIME,
        vehicle_remaining_capacity_kwh_by_vehicle_id={"kona": None},
    )
    return appliance.id in plan.appliances_by_id


class RunningPredicatesAgreeTests(unittest.TestCase):
    def test_every_kind_has_running_and_resting_actions(self) -> None:
        registry = _registry()
        self.assertEqual(
            {appliance.kind for appliance in registry.appliances},
            {"climate", "ev_charger", "generic"},
        )
        for appliance in registry.appliances:
            answers = {
                is_appliance_action_active(action, appliance=appliance)
                for action in _normalized_actions(appliance)
            }
            with self.subTest(kind=appliance.kind):
                self.assertEqual(answers, {True, False})

    def test_the_four_predicates_agree_on_every_normalized_action(self) -> None:
        checked = 0
        for appliance in _appliance_variants(_registry()):
            driver = _DRIVERS[appliance.kind]
            for action in _normalized_actions(appliance):
                running = is_appliance_action_active(action, appliance=appliance)
                with self.subTest(kind=appliance.kind, action=action):
                    self.assertEqual(driver.is_enabled(appliance, action), running)
                    self.assertEqual(_projects_demand(appliance, action), running)
                    # The history filter asks the same question of history_average
                    # appliances only; a charger has no projection config.
                    self.assertEqual(
                        HelmanCoordinator._is_projected_history_action_active(
                            appliance=appliance,
                            action=action,
                        ),
                        running and appliance.kind != "ev_charger",
                    )
                checked += 1
        self.assertGreater(checked, 15)

    def test_an_absent_action_is_not_running(self) -> None:
        for appliance in _registry().appliances:
            with self.subTest(kind=appliance.kind):
                self.assertFalse(_projects_demand(appliance, None))
                self.assertFalse(
                    HelmanCoordinator._is_projected_history_action_active(
                        appliance=appliance,
                        action=None,
                    )
                )


if __name__ == "__main__":
    unittest.main()
