from custom_components.helman.config_read import (
    read_entity_id,
    read_float,
    read_mapping,
    parse_timestamp,
)
from custom_components.helman.config_path import get


def test_lenient_config_readers():
    assert read_mapping(None) == {}
    assert read_entity_id(" sensor.energy ") == "sensor.energy"
    assert read_entity_id(False) is None
    for value in (None, True, "unknown", " Unavailable ", "none", "", "bad"):
        assert read_float(value) is None
    assert read_float(" 1.5 ") == 1.5
    assert parse_timestamp(None) is None
    assert parse_timestamp("2026-01-01T00:00:00+00:00").year == 2026


def test_config_path_supports_dotted_paths_and_list_indices():
    document = {"nodes": [{"entity": "sensor.energy"}]}
    assert get(document, ("nodes", 0, "entity")) == "sensor.energy"
    assert get(document, "nodes.0.entity") == "sensor.energy"
    assert get({"0": "zero"}, "0") == "zero"
    assert get(document, ("nodes", -1)) is None
    assert get(document, ("nodes", 2)) is None
    assert get(document, "nodes.missing") is None
    assert get({"value": "string"}, ("value", 0)) is None


def test_house_forecast_request_defaults_and_fingerprint():
    from custom_components.helman.consumption_forecast_builder import (
        read_house_forecast_request,
    )

    empty = read_house_forecast_request({"energy_nodes": None})
    configured = read_house_forecast_request(
        {
            "energy_nodes": {
                "house": {"forecast": {"total_energy_entity_id": " sensor.house "}}
            }
        }
    )
    assert empty.total_energy_entity_id is None
    assert configured.total_energy_entity_id == "sensor.house"
    assert empty.training_window_days >= empty.min_history_days > 0
    assert empty.config_fingerprint != configured.config_fingerprint


def test_span_meters_normalizes_roles_and_solar_fallback():
    from custom_components.helman.span_history_model import read_span_meters, SpanMeters

    assert read_span_meters({"energy_nodes": None}) == SpanMeters(
        None, None, None, None, None, None
    )
    config = {
        "energy_nodes": {
            "solar": {"forecast": {"total_energy_entity_id": " sensor.solar "}},
            "house": {"forecast": {"total_energy_entity_id": "sensor.house"}},
            "grid": {
                "entities": {
                    "today_import": "sensor.import",
                    "today_export": "sensor.export",
                }
            },
            "battery": {
                "entities": {
                    "today_charge_energy": "sensor.charge",
                    "today_discharge_energy": "sensor.discharge",
                }
            },
        }
    }
    assert read_span_meters(config) == SpanMeters(
        "sensor.solar",
        "sensor.import",
        "sensor.export",
        "sensor.house",
        "sensor.charge",
        "sensor.discharge",
    )
    config["training"] = {"solar_bias": {"total_energy_entity_id": "sensor.bias"}}
    assert read_span_meters(config).solar == "sensor.bias"
