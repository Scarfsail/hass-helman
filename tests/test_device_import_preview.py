"""Manual Energy imports preserve identity and expose physical overlaps."""
from copy import deepcopy
from custom_components.helman.controllables.import_preview import preview_energy_import
from custom_components.helman.config_validation import validate_config_document


def device(id, meter, **fields):
    consumption = {"energy_entity_id": meter}
    if fields.get("schedulable"):
        consumption["projection"] = {"strategy": "fixed", "hourly_energy_kwh": 1}
    return {"id": id, "consumption": consumption, **fields}


def row(meter, parent=None, power=None):
    return {"stat_consumption": meter, "included_in_stat": parent, "stat_rate": power}


def test_null_devices_section_imports_as_an_empty_draft():
    config = {"devices": None}
    result = preview_energy_import(
        config, {"device_consumption": [row("sensor.passive")]}
    )
    assert result["validation"]["valid"], result["validation"]
    assert result["devices"] == [
        {"id": "passive", "consumption": {"energy_entity_id": "sensor.passive"}}
    ]
    assert len(result["additions"]) == 1
    assert config == {"devices": None}


def test_meterless_child_with_null_consumption_keeps_valid_preview_unchanged():
    child = {
        "id": "child",
        "consumption": None,
        "controls": {"switch": {"entity_id": "switch.child"}},
    }
    parent = device("parent", "sensor.energy", children=[child])
    parent["consumption"]["power_entity_id"] = "sensor.power"
    config = {"devices": [parent]}
    assert validate_config_document(config).valid
    result = preview_energy_import(config, {"device_consumption": []})
    assert result["validation"]["valid"]
    assert result["devices"] == config["devices"]
    assert result["additions"] == result["powerEntities"] == result["nestingChanges"] == []


def test_null_children_accept_new_and_existing_nested_energy_rows():
    for existing in (False, True):
        parent = device("parent", "sensor.parent", children=None)
        child = device("child", "sensor.child")
        devices = [parent, child] if existing else [parent]
        result = preview(devices, row("sensor.child", "sensor.parent"))
        assert result["validation"]["valid"], result["validation"]
        assert len(result["devices"]) == 1
        assert result["devices"][0]["children"][0]["consumption"]["energy_entity_id"] == "sensor.child"
        assert parent["children"] is None


def preview(devices, *rows):
    return preview_energy_import(
        {"devices": devices}, {"device_consumption": list(rows)}
    )


def test_existing_device_moves_with_subtree_controls_and_targets():
    child = device(
        "plug",
        "sensor.plug",
        schedulable=True,
        controls={"switch": {"entity_id": "switch.plug"}},
    )
    old = device("old", "sensor.old", children=[child])
    parent = device("parent", "sensor.parent")
    config = {
        "devices": [old, parent],
        "automation": {
            "enabled": True,
            "appliance_optimizers": [
                {
                    "id": "target",
                    "kind": "appliance_runtime",
                    "target": {"controllables": [{"controllable_id": "plug"}]},
                    "conditions": [{"min_soc_pct": 80}],
                }
            ],
        },
    }
    saved = deepcopy(config)
    result = preview_energy_import(
        config, {"device_consumption": [row("sensor.old", "sensor.parent")]}
    )
    assert result["nestingChanges"] == [
        {"deviceId": "old", "fromParentId": None, "parentId": "parent"}
    ]
    assert result["devices"] == [{**parent, "children": [old]}]
    assert config == saved
    assert result["validation"]["valid"], result["validation"]
    assert validate_config_document({**config, "devices": result["devices"]}).valid
    assert result["devices"][0]["children"][0]["children"][0] == child


def test_preview_valid_idempotent_and_preserves_configuration():
    original = device(
        "heater",
        "sensor.heater",
        schedulable=True,
        controls={"switch": {"entity_id": "switch.heater"}},
    )
    preferences = {
        "device_consumption": [
            row("sensor.heater", power="sensor.heater_power"),
            row("sensor.passive"),
        ]
    }
    result = preview_energy_import({"devices": [original]}, preferences)
    assert result["validation"]["valid"], result["validation"]
    next_result = preview_energy_import({"devices": result["devices"]}, preferences)
    assert next_result["devices"] == result["devices"]
    assert (
        next_result["additions"]
        == next_result["powerEntities"]
        == next_result["nestingChanges"]
        == []
    )
    assert result["devices"][0]["id"] == "heater"
    assert result["devices"][0]["schedulable"] is True
    assert result["devices"][0]["controls"] == original["controls"]


def test_existing_schedulable_overlap_warns_new_overlap_skips_other_rows_apply():
    parent = device(
        "breaker",
        "sensor.breaker",
        schedulable=True,
        controls={"switch": {"entity_id": "switch.breaker"}},
    )
    child = device(
        "heater",
        "sensor.heater",
        schedulable=True,
        controls={"switch": {"entity_id": "switch.heater"}},
    )
    result = preview(
        [parent, child],
        row("sensor.heater", "sensor.breaker"),
        row("sensor.new", "sensor.breaker"),
        row("sensor.other"),
        row("external:stat"),
    )
    assert result["devices"][:2] == [parent, child]
    assert result["nestingChanges"] == []
    assert result["warnings"][0]["device_id"] == "breaker"
    assert result["warnings"][0]["energy_entity_id"] == "sensor.heater"
    assert {item["reason"] for item in result["skippedRows"]} == {
        "schedulable",
        "external_statistic",
    }
    assert result["additions"][0]["deviceId"] == "other"
    assert result["validation"]["valid"], result["validation"]


def test_existing_nested_device_can_move_without_duplicating_it():
    child = device("child", "sensor.child")
    source = device("source", "sensor.source", children=[child])
    destination = device("destination", "sensor.destination")
    result = preview([source, destination], row("sensor.child", "sensor.destination"))
    assert result["devices"] == [
        {**source, "children": []},
        {**destination, "children": [child]},
    ]
    assert result["validation"]["valid"], result["validation"]


def test_move_without_power_is_left_to_editor_if_shared_live_split_needs_it():
    parent = device(
        "parent",
        "sensor.parent",
        children=[{"id": "lamp", "controls": {"switch": {"entity_id": "switch.lamp"}}}],
    )
    parent["consumption"]["power_entity_id"] = "sensor.parent_power"
    child = device("child", "sensor.child")
    result = preview([parent, child], row("sensor.child", "sensor.parent"))
    assert result["devices"] == [parent, child]
    assert result["warnings"][0]["reason"] == "power_required"
    assert result["validation"]["valid"], result["validation"]


def test_existing_overlap_freezes_power_fills_for_both_meters():
    parent = device(
        "parent",
        "sensor.parent",
        schedulable=True,
        controls={"switch": {"entity_id": "switch.parent"}},
    )
    child = device("child", "sensor.child")
    result = preview(
        [parent, child],
        row("sensor.parent", power="sensor.parent_power"),
        row("sensor.child", "sensor.parent", "sensor.child_power"),
    )
    assert result["devices"] == [parent, child]
    assert result["powerEntities"] == []
    assert result["warnings"]


def test_existing_device_is_not_lost_when_energy_parent_is_skipped():
    parent = device(
        "parent",
        "sensor.parent",
        schedulable=True,
        controls={"switch": {"entity_id": "switch.parent"}},
    )
    child = device("child", "sensor.child")
    result = preview(
        [parent, child],
        row("sensor.middle", "sensor.parent"),
        row("sensor.child", "sensor.middle"),
    )
    assert result["devices"] == [parent, child]
    assert result["nestingChanges"] == []
    assert result["validation"]["valid"]
