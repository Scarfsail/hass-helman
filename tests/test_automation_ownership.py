from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SLOT_ID = "2026-03-20T21:00:00+01:00"
NEXT_SLOT_ID = "2026-03-20T21:30:00+01:00"
THIRD_SLOT_ID = "2026-03-20T22:00:00+01:00"


def _install_import_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]

    scheduling_pkg = sys.modules.get("custom_components.helman.scheduling")
    if scheduling_pkg is None:
        scheduling_pkg = types.ModuleType("custom_components.helman.scheduling")
        sys.modules["custom_components.helman.scheduling"] = scheduling_pkg
    scheduling_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "scheduling")
    ]

    try:
        import homeassistant.util.dt  # type: ignore  # noqa: F401
        import homeassistant.core  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
        homeassistant_pkg = sys.modules.get("homeassistant")
        if homeassistant_pkg is None:
            homeassistant_pkg = types.ModuleType("homeassistant")
            sys.modules["homeassistant"] = homeassistant_pkg

        core_mod = sys.modules.get("homeassistant.core")
        if core_mod is None:
            core_mod = types.ModuleType("homeassistant.core")
            sys.modules["homeassistant.core"] = core_mod
        core_mod.HomeAssistant = type("HomeAssistant", (), {})

        util_pkg = sys.modules.get("homeassistant.util")
        if util_pkg is None:
            util_pkg = types.ModuleType("homeassistant.util")
            sys.modules["homeassistant.util"] = util_pkg

        dt_mod = sys.modules.get("homeassistant.util.dt")
        if dt_mod is None:
            dt_mod = types.ModuleType("homeassistant.util.dt")
            sys.modules["homeassistant.util.dt"] = dt_mod

        dt_mod.parse_datetime = datetime.fromisoformat
        dt_mod.as_local = lambda value: value
        util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.const import (  # noqa: E402
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
)
from custom_components.helman.automation.ownership import (  # noqa: E402
    merge_automation_result,
    strip_automation_owned_actions,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleActionError,
    ScheduleDocument,
    ScheduleDomains,
    schedule_document_to_dict,
)


def _doc(*, execution_enabled: bool = False, slots: dict | None = None) -> ScheduleDocument:
    return ScheduleDocument(
        execution_enabled=execution_enabled,
        slots={} if slots is None else slots,
    )


class StripAutomationOwnedActionsTests(unittest.TestCase):
    def test_strip_removes_automation_owned_inverter_and_preserves_user_and_unset(
        self,
    ) -> None:
        document = _doc(
            execution_enabled=True,
            slots={
                SLOT_ID: {
                    "inverter": {"kind": SCHEDULE_ACTION_STOP_CHARGING, "setBy": "automation"},
                    "appliances": {
                        "boiler": {"on": True, "setBy": "user"},
                    },
                },
                NEXT_SLOT_ID: {
                    "inverter": {"kind": SCHEDULE_ACTION_NORMAL, "setBy": "user"},
                    "appliances": {},
                },
                THIRD_SLOT_ID: {
                    "inverter": {"kind": SCHEDULE_ACTION_NORMAL},
                    "appliances": {},
                },
            },
        )

        stripped = strip_automation_owned_actions(document)

        self.assertEqual(
            schedule_document_to_dict(stripped),
            {
                "executionEnabled": True,
                "slotMinutes": 30,
                "slots": {
                    SLOT_ID: {
                        "inverter": {"kind": "empty"},
                        "appliances": {"boiler": {"on": True, "setBy": "user"}},
                    },
                    NEXT_SLOT_ID: {
                        "inverter": {"kind": SCHEDULE_ACTION_NORMAL, "setBy": "user"},
                        "appliances": {},
                    },
                    THIRD_SLOT_ID: {
                        "inverter": {"kind": SCHEDULE_ACTION_NORMAL},
                        "appliances": {},
                    },
                },
            },
        )

    def test_strip_removes_automation_owned_appliances_per_appliance_id(self) -> None:
        document = _doc(
            slots={
                SLOT_ID: {
                    "inverter": {"kind": SCHEDULE_ACTION_NORMAL, "setBy": "user"},
                    "appliances": {
                        "dishwasher": {"on": True, "setBy": "automation"},
                        "boiler": {"on": False, "setBy": "user"},
                    },
                },
            }
        )

        stripped = strip_automation_owned_actions(document)

        self.assertEqual(
            stripped.slots[SLOT_ID].appliances,
            {"boiler": {"on": False, "setBy": "user"}},
        )
        self.assertEqual(stripped.slots[SLOT_ID].inverter.set_by, "user")

    def test_strip_drops_slot_when_everything_becomes_default(self) -> None:
        document = _doc(
            slots={
                SLOT_ID: {
                    "inverter": {"kind": SCHEDULE_ACTION_STOP_CHARGING, "setBy": "automation"},
                    "appliances": {
                        "dishwasher": {"on": True, "setBy": "automation"},
                    },
                },
            }
        )

        stripped = strip_automation_owned_actions(document)

        self.assertEqual(stripped.slots, {})


class MergeAutomationResultTests(unittest.TestCase):
    def test_merge_writes_new_automation_owned_inverter_action_into_empty_slot(
        self,
    ) -> None:
        merged = merge_automation_result(
            baseline=_doc(execution_enabled=False),
            automation_result=_doc(
                execution_enabled=True,
                slots={
                    SLOT_ID: {
                        "inverter": {
                            "kind": SCHEDULE_ACTION_STOP_CHARGING,
                            "setBy": "user",
                        },
                        "appliances": {},
                    }
                },
            ),
        )

        self.assertFalse(merged.execution_enabled)
        self.assertEqual(merged.slots[SLOT_ID].inverter.kind, SCHEDULE_ACTION_STOP_CHARGING)
        self.assertEqual(merged.slots[SLOT_ID].inverter.set_by, "automation")

    def test_merge_writes_new_automation_owned_appliance_action_beside_user_inverter(
        self,
    ) -> None:
        baseline = _doc(
            slots={
                SLOT_ID: {
                    "inverter": {"kind": SCHEDULE_ACTION_NORMAL, "setBy": "user"},
                    "appliances": {},
                },
            }
        )

        merged = merge_automation_result(
            baseline=baseline,
            automation_result=_doc(
                slots={
                    SLOT_ID: {
                        "inverter": {"kind": SCHEDULE_ACTION_NORMAL, "setBy": "user"},
                        "appliances": {"boiler": {"on": True, "setBy": "user"}},
                    }
                }
            ),
        )

        self.assertEqual(merged.slots[SLOT_ID].inverter.set_by, "user")
        self.assertEqual(
            merged.slots[SLOT_ID].appliances["boiler"],
            {"on": True, "setBy": "automation"},
        )

    def test_merge_refuses_to_overwrite_user_owned_inverter_action(self) -> None:
        with self.assertRaisesRegex(
            Exception,
            "Automation cannot overwrite user-owned inverter action",
        ):
            merge_automation_result(
                baseline=_doc(
                    slots={
                        SLOT_ID: {
                            "inverter": {"kind": SCHEDULE_ACTION_NORMAL, "setBy": "user"},
                            "appliances": {},
                        },
                    }
                ),
                automation_result=_doc(
                    slots={
                        SLOT_ID: {
                            "inverter": {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                            "appliances": {},
                        }
                    }
                ),
            )

    def test_merge_refuses_to_overwrite_user_owned_appliance_action(self) -> None:
        with self.assertRaisesRegex(
            Exception,
            "Automation cannot overwrite user-owned appliance action",
        ):
            merge_automation_result(
                baseline=_doc(
                    slots={
                        SLOT_ID: {
                            "inverter": {"kind": SCHEDULE_ACTION_NORMAL},
                            "appliances": {"boiler": {"on": False, "setBy": "user"}},
                        },
                    }
                ),
                automation_result=_doc(
                    slots={
                        SLOT_ID: {
                            "inverter": {"kind": SCHEDULE_ACTION_NORMAL},
                            "appliances": {"boiler": {"on": True}},
                        }
                    }
                ),
            )

    def test_merge_refuses_to_overwrite_explicit_authored_action_without_set_by(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            Exception,
            "Automation cannot overwrite user-owned inverter action",
        ):
            merge_automation_result(
                baseline=_doc(
                    slots={
                        SLOT_ID: {
                            "inverter": {"kind": SCHEDULE_ACTION_NORMAL},
                            "appliances": {},
                        },
                    }
                ),
                automation_result=_doc(
                    slots={
                        SLOT_ID: {
                            "inverter": {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                            "appliances": {},
                        }
                    }
                ),
            )


if __name__ == "__main__":
    unittest.main()
