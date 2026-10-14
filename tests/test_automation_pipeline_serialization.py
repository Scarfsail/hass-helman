from __future__ import annotations

from automation_pipeline_support import *


class SnapshotSerializationTests(unittest.TestCase):
    def test_snapshot_to_dict_returns_stable_shape(self) -> None:
        payload = snapshot_to_dict(_make_snapshot())

        self.assertTrue(payload["scheduleDocument"]["executionEnabled"])
        self.assertGreater(len(payload["scheduleSlots"]), 0)
        self.assertEqual(payload["adjustedHouseForecast"]["status"], "available")
        self.assertEqual(payload["batteryForecast"]["status"], "available")
        self.assertEqual(payload["gridForecast"]["currentImportPrice"], 7.0)
        self.assertEqual(payload["context"]["now"], REFERENCE_TIME.isoformat())
        self.assertEqual(payload["context"]["batteryState"]["currentSoc"], 50.0)
        self.assertEqual(
            payload["context"]["whenActiveHourlyEnergyKwhByApplianceId"],
            {"boiler": 1.25},
        )

    def test_snapshot_to_dict_carries_both_halves_of_the_battery_params(self) -> None:
        # Only the charge side used to be surfaced; an optimizer re-simulating
        # the battery needs the discharge side too.
        context = _make_snapshot().context
        payload = snapshot_to_dict(
            replace(
                _make_snapshot(),
                context=replace(
                    context,
                    battery_max_discharge_power_kw=4.0,
                    battery_discharge_efficiency=0.93,
                ),
            )
        )

        self.assertEqual(payload["context"]["batteryMaxDischargePowerKw"], 4.0)
        self.assertEqual(payload["context"]["batteryDischargeEfficiency"], 0.93)

    def test_snapshot_to_dict_omits_the_simulation_overlay(self) -> None:
        # It is a simulation input, not a view: serialising it would restate
        # `scheduleDocument` at canonical resolution for a consumer that has it.
        payload = snapshot_to_dict(_make_snapshot())

        self.assertNotIn("scheduleOverlay", payload)
        self.assertNotIn("scheduleOverlay", payload["context"])

    def test_snapshot_to_dict_hides_internal_battery_available_surplus_field(self) -> None:
        snapshot = _make_snapshot()
        snapshot.battery_forecast["series"][0]["availableSurplusKwh"] = 0.2
        snapshot.battery_forecast["baselineSeries"] = [
            {
                "timestamp": CURRENT_SLOT_ID,
                "durationHours": 0.25,
                "availableSurplusKwh": 0.3,
                "importedFromGridKwh": 1.0,
                "exportedToGridKwh": 0.0,
            }
        ]

        payload = snapshot_to_dict(snapshot)

        self.assertNotIn("availableSurplusKwh", payload["batteryForecast"]["series"][0])
        self.assertNotIn(
            "availableSurplusKwh",
            payload["batteryForecast"]["baselineSeries"][0],
        )
        self.assertEqual(payload["context"]["applianceRegistry"], {"appliances": []})


class AutomationRunResultSerializationTests(unittest.TestCase):
    def test_to_dict_preserves_envelope_while_adding_observability_fields(self) -> None:
        payload = AutomationRunResult.completed(
            snapshot=_make_snapshot(),
            optimizers=(
                OptimizerRunSummary(
                    id="avoid-negative-export",
                    kind="export_price",
                    status="ok",
                    slots_written=2,
                    duration_ms=17,
                ),
            ),
            duration_ms=41,
        ).to_dict()

        self.assertTrue(payload["ranAutomation"])
        self.assertIn("scheduleSlots", payload["snapshot"])
        self.assertEqual(
            payload["optimizers"],
            [
                {
                    "id": "avoid-negative-export",
                    "kind": "export_price",
                    "status": "ok",
                    "slotsWritten": 2,
                    "durationMs": 17,
                }
            ],
        )
        self.assertEqual(payload["durationMs"], 41)

    def test_to_dict_includes_failure_payload(self) -> None:
        payload = AutomationRunResult.failed(
            reason="runner_failed",
            failure=AutomationRunFailure(
                stage="final_persist",
                message="disk full",
            ),
        ).to_dict()

        self.assertFalse(payload["ranAutomation"])
        self.assertEqual(payload["reason"], "runner_failed")
        self.assertEqual(payload["message"], "disk full")
        self.assertEqual(
            payload["failure"],
            {
                "stage": "final_persist",
                "message": "disk full",
                "unexpected": True,
            },
        )


