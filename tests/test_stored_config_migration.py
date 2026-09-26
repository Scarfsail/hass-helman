"""Run every config migration against a *real* stored config, not just fixtures.

Fixtures only contain what the author remembered to put in them. A real
`.storage/helman.config` contains what the editor and every past version of it
actually wrote — including keys no reader has ever read.

That is not hypothetical: the conditions unification shipped a reader that
rejects unknown keys, and every fixture test passed while the live config
carried a `params.release` written by an old editor draft. Left unnoticed it
would have failed to read the automation block on the first restart after
upgrading. This file is the guard, so the check happens on every run instead of
when someone thinks of it.

The store is found automatically at the sibling Home Assistant checkout, or via
``HELMAN_STORED_CONFIG``. When there is none — CI, a fresh clone — the test
skips, loudly enough to say why.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from custom_components.helman.appliances.climate_appliance import (
    read_climate_appliance,
)
from custom_components.helman.appliances.config import (
    build_appliances_runtime_registry,
)
from custom_components.helman.appliances.ev_charger import read_ev_charger_appliance
from custom_components.helman.appliances.generic_appliance import (
    read_generic_appliance,
)
from custom_components.helman.automation.config import read_automation_config
from custom_components.helman.automation.migration import migrate_config_document
from custom_components.helman.config_validation import validate_config_document
from custom_components.helman.consumption_forecast_builder import (
    ConsumptionForecastBuilder,
)
from custom_components.helman.controllables.config import (
    read_carved_meters,
    read_schedulable_ids,
    read_shared_meters,
)
from custom_components.helman.training.appliance_energy import (
    ApplianceEnergyTrainingRequest,
    SharedMeter,
    SharedMeterMember,
)

REPO_ROOT = Path(__file__).resolve().parents[1]

#: Where a developer's Home Assistant instance keeps this integration's config.
#: The dev container mounts the same checkout, so the host path is the live one.
DEFAULT_STORED_CONFIG = REPO_ROOT.parent / "hass-core/config/.storage/helman.config"


def _find_stored_config() -> Path | None:
    override = os.environ.get("HELMAN_STORED_CONFIG")
    if override:
        path = Path(override)
        return path if path.is_file() else None
    return DEFAULT_STORED_CONFIG if DEFAULT_STORED_CONFIG.is_file() else None


def _read_document(path: Path) -> dict:
    """Unwrap Home Assistant's ``Store`` envelope, or take a bare document."""
    payload = json.loads(path.read_text())
    data = payload.get("data") if isinstance(payload, dict) else None
    return data if isinstance(data, dict) else payload


class StoredConfigMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        path = _find_stored_config()
        if path is None:
            self.skipTest(
                "no stored config found; set HELMAN_STORED_CONFIG to a "
                f".storage/helman.config to run this check (looked at {DEFAULT_STORED_CONFIG})"
            )
        self.path = path
        self.document = _read_document(path)

    def test_the_stored_config_migrates_and_reads_back(self) -> None:
        migrated, migrated_ids = migrate_config_document(self.document)

        # The reader is the real gate: it rejects unknown keys, so anything the
        # migration forgot to move or drop fails right here.
        automation = read_automation_config(migrated)
        if automation is not None:
            for optimizer in automation.all_optimizers:
                self.assertTrue(
                    optimizer.conditions,
                    f"{optimizer.id!r} migrated without a condition group",
                )
        self.assertIsInstance(migrated_ids, list)

    def test_the_migrated_config_passes_full_validation(self) -> None:
        migrated, _ids = migrate_config_document(self.document)

        report = validate_config_document(migrated)

        # The v20 migration creates the shared-meter parent without a power
        # sensor (it never infers one); the Energy import in v21 fills it.
        # Until then that is the only error the live config may carry.
        unexpected = [
            issue
            for issue in report.errors
            if issue.code != "power_entity_required"
        ]
        self.assertEqual(
            unexpected,
            [],
            "migrated stored config does not validate:\n"
            + "\n".join(f"  {issue.path}: {issue.message}" for issue in unexpected),
        )

    def test_migrating_an_already_migrated_config_changes_nothing(self) -> None:
        once, _ids = migrate_config_document(self.document)

        twice, migrated_ids = migrate_config_document(once)

        # Migration runs on every load. A second pass must be a no-op, or a
        # dropped `config_version` would rewrite the document under the user.
        self.assertEqual(twice, once)
        self.assertEqual(migrated_ids, [])


# --- the live shape, as a fixture ------------------------------------------

_AC_METER = "sensor.jistic_klimatizace_energy"


def _projection(strategy: str, kwh: float) -> dict:
    projection = {"strategy": strategy, "hourly_energy_kwh": kwh}
    if strategy == "history_average":
        projection["lookback_days"] = 30
    return projection


def _live_v19() -> dict:
    """The live installation at version 19, trimmed to what the devices step reads.

    The inverter, the EV charger, the pool devices, and four air conditioners
    naming one breaker meter -- the implicit shared meter version 20 makes a
    parent of.
    """

    def switched(device_id, name, switch, meter, kwh):
        return {
            "kind": "generic",
            "id": device_id,
            "name": name,
            "controls": {"switch": {"entity_id": switch}},
            "consumption": {
                "projection": _projection("fixed", kwh),
                "energy_entity_id": meter,
            },
        }

    def ac(device_id, name, climate):
        return {
            "kind": "climate",
            "id": device_id,
            "name": name,
            "controls": {"climate": {"entity_id": climate}},
            "icon": "mdi:air-conditioner",
            "consumption": {
                "projection": _projection("history_average", 0.25),
                "energy_entity_id": _AC_METER,
            },
        }

    return {
        "config_version": 19,
        "controllables": [
            {
                "kind": "inverter",
                "id": "inverter",
                "name": "Inverter",
                "controls": {
                    "mode": {
                        "entity_id": "input_select.rezim_fv",
                        "options": {"normal": "Standard"},
                    }
                },
            },
            {
                "kind": "ev_charger",
                "id": "garage-ev",
                "name": "EV",
                "limits": {"max_charging_power_kw": 11},
                "controls": {
                    "charge": {"entity_id": "switch.ev_nabijeni"},
                    "use_mode": {
                        "entity_id": "select.ev_use_mode",
                        "values": {"Fast": {"behavior": "fixed_max_power"}},
                    },
                    "eco_gear": {
                        "entity_id": "select.ev_eco_gear",
                        "values": {"6A": {"min_power_kw": 3.5}},
                    },
                },
                "vehicles": [
                    {
                        "id": "kona",
                        "name": "Kona",
                        "telemetry": {"soc_entity_id": "sensor.kona_soc"},
                        "limits": {
                            "battery_capacity_kwh": 64,
                            "max_charging_power_kw": 11,
                        },
                    }
                ],
                "consumption": {"energy_entity_id": "sensor.ev_charge_added_total"},
            },
            switched(
                "pool-filtration",
                "Filtration",
                "switch.jistic_bazen_filtrace",
                "sensor.jistic_bazen_filtrace_energy",
                0.75,
            ),
            {
                "kind": "climate",
                "id": "climate-pool",
                "name": "Pool heat pump",
                "controls": {"climate": {"entity_id": "climate.pool_heat_pump"}},
                "consumption": {
                    "projection": _projection("fixed", 1.6),
                    "energy_entity_id": "sensor.jistic_bazen_tepelne_cerpadlo_energy",
                    # Never set live; shows the key is dropped wherever it is.
                    "deferrable": True,
                },
            },
            switched(
                "appliance-heater-pool",
                "Pool heater",
                "switch.bazen_primotop_tc",
                "sensor.bazen_primotop_tc_energy",
                2,
            ),
            ac("klima-obyvak", "AC living room", "climate.obyvak"),
            ac("klima-bartik", "AC Bartik", "climate.bartik"),
            ac("klima-adelka", "AC Adelka", "climate.adelka"),
            ac("klima-loznice", "AC bedroom", "climate.loznice"),
        ],
        "automation": {
            "enabled": True,
            "appliance_optimizers": [
                {
                    "id": "pool-filtration",
                    "kind": "appliance_runtime",
                    "target": {"controllables": [{"controllable_id": "pool-filtration"}]},
                    "params": {"window": {"start": "08:00", "end": "18:00"}},
                    "conditions": [{"run_when": ["surplus"], "custom": []}],
                },
                {
                    "id": "home-ac-heat",
                    "kind": "appliance_runtime",
                    "target": {
                        "controllables": [
                            {"controllable_id": ac_id, "climate_mode": "heat"}
                            for ac_id in ("klima-obyvak", "klima-bartik", "klima-adelka")
                        ]
                    },
                    "params": {"window": {"start": "8:30", "end": "20:00"}},
                    "conditions": [{"run_when": ["surplus"], "custom": []}],
                },
            ],
            "system_optimizers": [
                {
                    "id": "charge-from-grid",
                    "kind": "charge_from_grid",
                    "target": {"controllable_id": "inverter"},
                    "params": {},
                    "conditions": [{"reserve_floor_soc": 30}],
                }
            ],
        },
    }


#: What the v19 readers derived from the live shape: the carved meters in
#: order, each with its label and the controllables behind it.
_V19_CARVED = [
    ("sensor.ev_charge_added_total", "EV", ["garage-ev"]),
    ("sensor.jistic_bazen_filtrace_energy", "Filtration", ["pool-filtration"]),
    ("sensor.jistic_bazen_tepelne_cerpadlo_energy", "Pool heat pump", ["climate-pool"]),
    ("sensor.bazen_primotop_tc_energy", "Pool heater", ["appliance-heater-pool"]),
    (_AC_METER, _AC_METER, ["klima-obyvak", "klima-bartik", "klima-adelka", "klima-loznice"]),
]


def _v19_runtimes(document: dict) -> list:
    """The appliance runtimes the v19 registry built, one per entry, in order."""
    readers = {
        "climate": read_climate_appliance,
        "ev_charger": read_ev_charger_appliance,
        "generic": read_generic_appliance,
    }
    return [
        readers[entry["kind"]](entry, path=f"controllables[{index}]")
        for index, entry in enumerate(document["controllables"])
        if entry["kind"] != "inverter"
    ]


def _house_fingerprint(consumers: list[dict]) -> str:
    return ConsumptionForecastBuilder._build_config_fingerprint(
        total_energy_entity_id="sensor.house_total",
        training_window_days=56,
        min_history_days=14,
        consumers_config=consumers,
    )


class LiveShapedMigrationTests(unittest.TestCase):
    """The live shape, migrated -- always run, stored config or not."""

    def setUp(self) -> None:
        self.before = _live_v19()
        self.migrated, _ids = migrate_config_document(self.before)

    def test_it_migrates_to_the_expected_tree(self) -> None:
        devices = self.migrated["devices"]
        old = self.before["controllables"]

        self.assertNotIn("controllables", self.migrated)
        # The inverter moves unchanged and carries no flag.
        self.assertEqual(devices[0], old[0])
        self.assertEqual(
            [device.get("id") for device in devices],
            [
                "inverter",
                "garage-ev",
                "pool-filtration",
                "climate-pool",
                "appliance-heater-pool",
                "jistic_klimatizace_energy",
            ],
        )
        breaker = devices[5]
        self.assertEqual(breaker["consumption"], {"energy_entity_id": _AC_METER})
        self.assertNotIn("kind", breaker)
        self.assertNotIn("schedulable", breaker)
        self.assertEqual(
            breaker["children"],
            [
                {
                    **{key: value for key, value in entry.items() if key != "consumption"},
                    "consumption": {"projection": entry["consumption"]["projection"]},
                    "schedulable": True,
                }
                for entry in old[5:]
            ],
        )

    def test_ids_projections_and_the_flag_are_preserved(self) -> None:
        for old, new in zip(self.before["controllables"][1:5], self.migrated["devices"][1:5]):
            with self.subTest(device=old["id"]):
                self.assertEqual(new["id"], old["id"])
                self.assertIs(new["schedulable"], True)
                self.assertEqual(
                    new["consumption"],
                    {
                        key: value
                        for key, value in old["consumption"].items()
                        if key != "deferrable"
                    },
                )

    def test_every_optimizer_target_still_names_a_schedulable_device(self) -> None:
        self.assertEqual(self.migrated["automation"], self.before["automation"])
        schedulable = read_schedulable_ids(self.migrated)
        automation = read_automation_config(self.migrated)
        for optimizer in automation.all_optimizers:
            for controllable_id in optimizer.controllable_ids:
                self.assertIn(controllable_id, schedulable)

    def test_migration_is_idempotent(self) -> None:
        twice, ids = migrate_config_document(self.migrated)

        self.assertEqual(twice, self.migrated)
        self.assertEqual(ids, [])

    def test_the_carved_set_and_the_house_baseline_are_unchanged(self) -> None:
        carved = read_carved_meters(self.migrated)

        self.assertEqual(
            [(c["energy_entity_id"], c["label"], c["ids"]) for c in carved],
            _V19_CARVED,
        )
        self.assertTrue(all(c["metered_children"] == [] for c in carved))
        # Same fingerprint, so the stored house profile is adopted, not refit.
        self.assertEqual(
            _house_fingerprint(carved),
            _house_fingerprint(
                [
                    {"energy_entity_id": meter, "label": label}
                    for meter, label, _ids in _V19_CARVED
                ]
            ),
        )

    def test_the_per_appliance_estimates_are_unchanged(self) -> None:
        before = _v19_runtimes(self.before)
        after = build_appliances_runtime_registry(self.migrated).appliances

        # The same runtimes: the four air conditioners still read the breaker.
        self.assertEqual(list(after), before)

        def request(appliances, shared_meters) -> ApplianceEnergyTrainingRequest:
            return ApplianceEnergyTrainingRequest(
                appliances=tuple(
                    a for a in appliances if getattr(a, "uses_history_average", False)
                ),
                shared_meters=shared_meters,
            )

        v19_request = request(
            before,
            {
                _AC_METER: SharedMeter(
                    tuple(
                        SharedMeterMember.for_signal(a.id, a.climate_entity_id, "climate")
                        for a in before
                        if a.id.startswith("klima-")
                    )
                )
            },
        )
        v20_request = request(
            after,
            {
                meter: SharedMeter(
                    tuple(SharedMeterMember.for_signal(*m) for m in shared["members"]),
                    tuple(shared["metered_children"]),
                )
                for meter, shared in read_shared_meters(self.migrated).items()
            },
        )
        self.assertEqual(v20_request.fingerprint, v19_request.fingerprint)


if __name__ == "__main__":
    unittest.main()
