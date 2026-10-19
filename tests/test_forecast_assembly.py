from __future__ import annotations

import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

from custom_components.helman.appliances.state import AppliancesRuntimeRegistry
from custom_components.helman.automation.compute_inputs import ComputeInputs
from custom_components.helman.automation.config import AutomationConfig
from custom_components.helman.automation.input_bundle import AutomationInputBundle
from custom_components.helman.forecast import assembly
from custom_components.helman.scheduling.schedule import (
    ScheduleAction,
    ScheduleControlConfig,
    ScheduleDocument,
    SlotAction,
    build_controllable_actions,
)

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"
LATER_SLOT_ID = "2026-03-20T21:30:00+01:00"


def _inverter(kind: str, target_soc: int | None = None) -> dict:
    """One slot's flat, id-keyed action map holding just the inverter's."""
    return build_controllable_actions(
        inverter=ScheduleAction(kind=kind, target_soc=target_soc)
    )


def _document(slots: dict, *, execution_enabled: bool = True) -> ScheduleDocument:
    return ScheduleDocument(execution_enabled=execution_enabled, slots=dict(slots))


def _control_config(*without: str) -> ScheduleControlConfig:
    options = {
        "normal": "normal",
        "stop_charging": "stop_charging",
        "stop_discharging": "stop_discharging",
        "charge_to_target_soc": "charge_target",
        "discharge_to_target_soc": "discharge_target",
        "stop_export": "stop_export",
    }
    return ScheduleControlConfig(
        mode_entity_id="select.inverter_mode",
        options={kind: option for kind, option in options.items() if kind not in without},
    )


class BatteryForecastScheduleDocumentTests(unittest.TestCase):
    def test_filters_target_actions_the_inverter_cannot_execute(self) -> None:
        document = _document(
            {
                CURRENT_SLOT_ID: _inverter("charge_to_target_soc", 60),
                LATER_SLOT_ID: _inverter("stop_charging"),
            }
        )

        forecast_document = assembly.build_battery_forecast_schedule_document(
            document, _control_config("charge_to_target_soc")
        )

        self.assertTrue(forecast_document.execution_enabled)
        self.assertEqual(
            forecast_document.slots, {LATER_SLOT_ID: document.slots[LATER_SLOT_ID]}
        )

    def test_keeps_an_unconfigured_stop_export(self) -> None:
        document = _document(
            {
                CURRENT_SLOT_ID: _inverter("stop_export"),
                LATER_SLOT_ID: _inverter("stop_charging"),
            }
        )

        forecast_document = assembly.build_battery_forecast_schedule_document(
            document, _control_config("stop_export")
        )

        self.assertEqual(forecast_document.slots, document.slots)

    def test_keeps_every_slot_without_a_control_config(self) -> None:
        document = _document(
            {
                CURRENT_SLOT_ID: _inverter("stop_export"),
                LATER_SLOT_ID: _inverter("discharge_to_target_soc", 20),
            }
        )

        self.assertEqual(
            assembly.build_battery_forecast_schedule_document(document, None),
            document,
        )


class ForecastScheduleDocumentsTests(unittest.TestCase):
    def test_execution_disabled_empties_both_domains(self) -> None:
        # With execution off Helman actuates nothing, so the forecast projects
        # the unmanaged house: no inverter action *and* no appliance run. Both
        # documents have to be emptied together — emptying only the inverter
        # side would forecast a battery that ignores appliance runs the same
        # forecast still believes in.
        slot = _inverter("stop_charging")
        slot["boiler"] = SlotAction(payload={"kind": "run"})

        documents = assembly.build_forecast_schedule_documents(
            _document({CURRENT_SLOT_ID: slot}, execution_enabled=False),
            _control_config(),
        )

        self.assertEqual(documents.forecast_schedule_document.slots, {})
        self.assertEqual(documents.projection_schedule_document.slots, {})

    def test_execution_enabled_follows_the_plan(self) -> None:
        slot = _inverter("stop_charging")

        documents = assembly.build_forecast_schedule_documents(
            _document({CURRENT_SLOT_ID: slot}), _control_config()
        )

        self.assertEqual(documents.forecast_schedule_document.slots, {CURRENT_SLOT_ID: slot})
        self.assertEqual(
            documents.projection_schedule_document.slots, {CURRENT_SLOT_ID: slot}
        )

    def test_signatures_ignore_slot_changes_while_execution_disabled(self) -> None:
        # Both signatures are derived from the gated documents, which are empty
        # while execution is off. Editing the plan then cannot change the
        # forecast, so it must not miss the cache either.
        first, second = (
            assembly.build_forecast_schedule_documents(
                _document({slot_id: _inverter("stop_charging")}, execution_enabled=False),
                _control_config(),
            )
            for slot_id in (CURRENT_SLOT_ID, LATER_SLOT_ID)
        )

        self.assertEqual(
            assembly.build_battery_forecast_schedule_signature(
                first.forecast_schedule_document
            ),
            assembly.build_battery_forecast_schedule_signature(
                second.forecast_schedule_document
            ),
        )
        self.assertEqual(
            assembly.build_appliance_projection_schedule_signature(
                first.projection_schedule_document
            ),
            assembly.build_appliance_projection_schedule_signature(
                second.projection_schedule_document
            ),
        )


class ScheduleSignatureTests(unittest.TestCase):
    def test_battery_signature_is_every_slots_inverter_action(self) -> None:
        document = _document(
            {
                LATER_SLOT_ID: _inverter("stop_charging"),
                CURRENT_SLOT_ID: _inverter("charge_to_target_soc", 60),
            }
        )

        self.assertEqual(
            assembly.build_battery_forecast_schedule_signature(document),
            (
                (CURRENT_SLOT_ID, "charge_to_target_soc", 60),
                (LATER_SLOT_ID, "stop_charging", None),
            ),
        )

    def test_effective_signature_is_none_without_an_active_target_action(self) -> None:
        document = _document({CURRENT_SLOT_ID: _inverter("stop_charging")})

        self.assertIsNone(
            assembly.build_battery_forecast_schedule_effective_signature(
                document,
                reference_time=REFERENCE_TIME,
                battery_entity_config=object(),
                live_state=SimpleNamespace(current_soc=40.0),
            )
        )

    def test_effective_signature_resolves_the_active_target_against_the_battery(
        self,
    ) -> None:
        document = _document({CURRENT_SLOT_ID: _inverter("charge_to_target_soc", 50)})

        def signature(battery_entity_config, live_state):
            return assembly.build_battery_forecast_schedule_effective_signature(
                document,
                reference_time=REFERENCE_TIME,
                battery_entity_config=battery_entity_config,
                live_state=live_state,
            )

        prefix = (CURRENT_SLOT_ID, "charge_to_target_soc", 50)
        self.assertEqual(
            signature(None, None), (*prefix, "not_configured", "not_configured")
        )
        self.assertEqual(
            signature(object(), None), (*prefix, "unavailable", "execution_unavailable")
        )
        self.assertEqual(
            signature(object(), SimpleNamespace(current_soc=40.0)),
            (*prefix, "charge_to_target_soc", "scheduled"),
        )
        self.assertEqual(
            signature(object(), SimpleNamespace(current_soc=50.0)),
            (*prefix, "stop_discharging", "target_soc_reached"),
        )


class SolarSignatureTests(unittest.TestCase):
    def test_reads_the_most_adjusted_points_and_normalises_them(self) -> None:
        solar_forecast = {
            "status": "available",
            "points": [{"timestamp": CURRENT_SLOT_ID, "value": 1.0}],
            "correctedPoints": [
                {"timestamp": CURRENT_SLOT_ID, "value": 2.123456},
                {"timestamp": LATER_SLOT_ID, "value": True},
                {"timestamp": None, "value": 3.0},
                "not a point",
            ],
        }

        self.assertEqual(
            assembly.build_battery_forecast_solar_signature(solar_forecast),
            ("available", ((CURRENT_SLOT_ID, 2.1235),)),
        )
        solar_forecast["adjustedPoints"] = []
        self.assertEqual(
            assembly.build_battery_forecast_solar_signature(solar_forecast),
            ("available", ()),
        )


class ForecastRebuildTests(unittest.TestCase):
    def test_simulates_against_the_overlay_of_the_forecast_document(self) -> None:
        battery_forecast = {"status": "available", "series": []}
        forecast_document = _document({CURRENT_SLOT_ID: _inverter("stop_charging")})
        overlay = object()

        with (
            patch.object(
                assembly, "build_schedule_forecast_overlay", return_value=overlay
            ) as build_overlay,
            patch.object(
                assembly.BatteryCapacityForecastBuilder,
                "build_with_history",
                Mock(return_value=battery_forecast),
            ) as build_battery_forecast,
        ):
            rebuild = assembly.build_forecast_rebuild(
                config={},
                appliances_registry=AppliancesRuntimeRegistry(),
                solar_forecast={"status": "available", "points": []},
                original_house_forecast={"status": "available", "series": []},
                started_at=REFERENCE_TIME,
                forecast_schedule_document=forecast_document,
                projection_schedule_document=_document({}),
                when_active_hourly_energy_kwh_by_appliance_id={},
                compute_inputs=ComputeInputs(),
            )

        build_overlay.assert_called_once_with(
            schedule_document=forecast_document, reference_time=REFERENCE_TIME
        )
        self.assertIs(
            build_battery_forecast.call_args.kwargs["schedule_overlay"], overlay
        )
        self.assertIs(rebuild.battery_forecast, battery_forecast)
        self.assertIs(rebuild.schedule_overlay, overlay)
        # No grid price forecast, no grid flow: only automation asks for one.
        self.assertIsNone(rebuild.grid_forecast)


class AutomationSnapshotTests(unittest.TestCase):
    def test_rejects_an_unusable_battery_forecast_naming_the_house_anchor(self) -> None:
        bundle = AutomationInputBundle(
            original_house_forecast={"status": "available", "series": []},
            solar_forecast={"status": "available", "points": []},
            grid_price_forecast={"import": {}, "export": {}},
            when_active_hourly_energy_kwh_by_appliance_id={},
        )
        for status in ("unavailable", "not_configured", "insufficient_history", None):
            for anchor_field in ("currentSlot", None):
                with self.subTest(status=status, anchor_field=anchor_field):
                    house_forecast = {"status": "available"}
                    if anchor_field is not None:
                        house_forecast[anchor_field] = {"timestamp": CURRENT_SLOT_ID}
                    rebuild = assembly.ForecastRebuildSnapshot(
                        adjusted_house_forecast=house_forecast,
                        battery_forecast={"status": status},
                        projection_plan=SimpleNamespace(),
                        # Grid composition still returns a payload when the
                        # battery forecast cannot provide usable rails.
                        grid_forecast={"status": "unavailable", "series": []},
                    )

                    with (
                        patch.object(
                            assembly, "build_forecast_rebuild", return_value=rebuild
                        ),
                        self.assertRaises(RuntimeError) as raised,
                    ):
                        assembly.build_automation_snapshot(
                            config={},
                            control_config=None,
                            appliances_registry=AppliancesRuntimeRegistry(),
                            schedule_document=_document({}),
                            input_bundle=bundle,
                            reference_time=REFERENCE_TIME,
                            compute_inputs=ComputeInputs(),
                        )

                    message = str(raised.exception)
                    self.assertIn("unusable battery forecast", message)
                    self.assertIn(f"status={status!r}", message)
                    anchor = CURRENT_SLOT_ID if anchor_field is not None else None
                    self.assertIn(f"house_anchor={anchor!r}", message)


class RuntimeHistoryRequirementsTests(unittest.TestCase):
    def test_disabled_automation_needs_no_history(self) -> None:
        self.assertIsNone(
            assembly.resolve_runtime_history_requirements(
                AutomationConfig(enabled=False)
            )
        )


if __name__ == "__main__":
    unittest.main()
