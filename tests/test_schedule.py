from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


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

from custom_components.helman.battery_state import BatterySocBounds
from custom_components.helman.const import (
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
)
from custom_components.helman.scheduling.schedule import (
    ScheduleAction,
    ScheduleActionError,
    ScheduleDocument,
    ScheduleNotConfiguredError,
    ScheduleSlot,
    ScheduleSlotsError,
    apply_slot_patches,
    iter_horizon_slot_ids,
    materialize_schedule_slots,
    prune_expired_slots,
    schedule_document_from_dict,
    schedule_document_to_dict,
    validate_slot_patch_request,
)


REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")


class ScheduleHelperTests(unittest.TestCase):
    def test_iter_horizon_slot_ids_returns_full_48_hour_grid(self) -> None:
        slot_ids = iter_horizon_slot_ids(REFERENCE_TIME)

        self.assertEqual(len(slot_ids), 192)
        self.assertEqual(slot_ids[0], "2026-03-20T21:00:00+01:00")
        self.assertEqual(slot_ids[-1], "2026-03-22T20:45:00+01:00")

    def test_materialize_schedule_slots_fills_missing_slots_as_normal(self) -> None:
        slot_ids = iter_horizon_slot_ids(REFERENCE_TIME)
        slots = materialize_schedule_slots(
            stored_slots={
                slot_ids[1]: ScheduleAction(
                    kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                    target_soc=80,
                )
            },
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(slots[0].action.kind, SCHEDULE_ACTION_NORMAL)
        self.assertEqual(slots[1].action.kind, SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC)
        self.assertEqual(slots[1].action.target_soc, 80)

    def test_apply_slot_patches_removes_explicit_normal(self) -> None:
        slot_ids = iter_horizon_slot_ids(REFERENCE_TIME)
        patched = apply_slot_patches(
            stored_slots={
                slot_ids[1]: ScheduleAction(
                    kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                    target_soc=80,
                )
            },
            slot_patches=[
                ScheduleSlot(
                    id=slot_ids[1],
                    action=ScheduleAction(kind=SCHEDULE_ACTION_NORMAL),
                )
            ],
        )

        self.assertNotIn(slot_ids[1], patched)

    def test_prune_expired_slots_keeps_only_future_or_active_slots(self) -> None:
        slot_ids = iter_horizon_slot_ids(REFERENCE_TIME)
        pruned = prune_expired_slots(
            stored_slots={
                slot_ids[0]: ScheduleAction(
                    kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                    target_soc=80,
                ),
                slot_ids[1]: ScheduleAction(
                    kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                    target_soc=80,
                ),
            },
            reference_time=datetime.fromisoformat("2026-03-20T21:16:00+01:00"),
        )

        self.assertNotIn(slot_ids[0], pruned)
        self.assertIn(slot_ids[1], pruned)

    def test_validate_slot_patch_request_rejects_duplicate_slot_ids(self) -> None:
        slot_ids = iter_horizon_slot_ids(REFERENCE_TIME)
        slot = ScheduleSlot(
            id=slot_ids[2],
            action=ScheduleAction(kind=SCHEDULE_ACTION_NORMAL),
        )

        with self.assertRaises(ScheduleSlotsError):
            validate_slot_patch_request(
                slots=[slot, slot],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
            )

    def test_validate_slot_patch_request_requires_soc_bounds_for_target_actions(
        self,
    ) -> None:
        slot_ids = iter_horizon_slot_ids(REFERENCE_TIME)

        with self.assertRaises(ScheduleNotConfiguredError):
            validate_slot_patch_request(
                slots=[
                    ScheduleSlot(
                        id=slot_ids[3],
                        action=ScheduleAction(
                            kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                            target_soc=80,
                        ),
                    )
                ],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
            )

    def test_validate_slot_patch_request_rejects_target_soc_outside_bounds(
        self,
    ) -> None:
        slot_ids = iter_horizon_slot_ids(REFERENCE_TIME)

        with self.assertRaises(ScheduleActionError):
            validate_slot_patch_request(
                slots=[
                    ScheduleSlot(
                        id=slot_ids[3],
                        action=ScheduleAction(
                            kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                            target_soc=95,
                        ),
                    )
                ],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=BatterySocBounds(min_soc=10, max_soc=90),
            )

    def test_schedule_document_round_trip_strips_implicit_normal(self) -> None:
        doc = schedule_document_from_dict(
            {
                "executionEnabled": True,
                "slots": {
                    "2026-03-20T21:15:00+01:00": {
                        "kind": SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                        "targetSoc": 80,
                    },
                    "2026-03-20T21:30:00+01:00": {"kind": SCHEDULE_ACTION_NORMAL},
                },
            }
        )

        self.assertEqual(
            doc,
            ScheduleDocument(
                execution_enabled=True,
                slots={
                    "2026-03-20T21:15:00+01:00": ScheduleAction(
                        kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                        target_soc=80,
                    )
                },
            ),
        )
        self.assertEqual(
            schedule_document_to_dict(doc),
            {
                "executionEnabled": True,
                "slots": {
                    "2026-03-20T21:15:00+01:00": {
                        "kind": SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                        "targetSoc": 80,
                    }
                },
            },
        )

    def test_schedule_document_from_dict_rejects_misaligned_slot_ids(self) -> None:
        with self.assertRaises(ScheduleSlotsError):
            schedule_document_from_dict(
                {
                    "executionEnabled": False,
                    "slots": {
                        "2026-03-20T21:07:00+01:00": {
                            "kind": SCHEDULE_ACTION_STOP_CHARGING
                        }
                    },
                }
            )


if __name__ == "__main__":
    unittest.main()
