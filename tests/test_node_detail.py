"""``helman/get_node_detail``: the node registry, the inverter detail and ``day_stats``."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from custom_components.helman import websockets as websockets_module
from custom_components.helman.node_details import (
    NodeDetailError,
    async_get_node_detail,
)
from custom_components.helman.node_details import day_stats
from custom_components.helman.vendors import PROFILES, DeviceTelemetry

PRAGUE = ZoneInfo("Europe/Prague")
UTC = timezone.utc

USE_MODE = "select.solax_charger_use_mode"
MANUAL_MODE = "select.solax_manual_mode_select"
EXPORT_LIMIT = "number.solax_export_control_user_limit"
TEMPERATURE = "sensor.solax_inverter_temperature"
RUN_MODE = "sensor.solax_run_mode"
MODE_SELECT = "select.helman_inverter_mode"

ENTRY = NS(entry_id="solax-entry", title="SolaX", options={}, data={})
CONTROLS = {
    "SolaX_charger_use_mode": USE_MODE,
    "SolaX_manual_mode_select": MANUAL_MODE,
    "SolaX_export_control_user_limit": EXPORT_LIMIT,
}
KINDS = list(PROFILES["solax_inverter"].modes)


@pytest.fixture(autouse=True)
def prague():
    previous = dt_util.get_default_time_zone()
    dt_util.set_default_time_zone(PRAGUE)
    yield
    dt_util.set_default_time_zone(previous)


def config(*, profile=True, export_cap=9900):
    inverter = {
        "controls": {
            "mode": {"entity_id": MODE_SELECT, "options": {kind: kind for kind in KINDS}}
        }
    }
    if profile:
        inverter["profile"] = {"id": "solax_inverter", "entry_id": ENTRY.entry_id}
    return {
        "energy_nodes": {
            "inverter": inverter,
            "grid": {"max_allowed_export_power": export_cap},
            "battery": {"entities": {"min_soc": "number.min_soc", "max_soc": "number.max_soc"}},
        }
    }


def fake_hass(states, unit="°C"):
    return NS(
        states=NS(
            get=lambda entity_id: (
                NS(state=states[entity_id], attributes={"unit_of_measurement": unit})
                if entity_id in states
                else None
            )
        )
    )


def telemetry(entities=None):
    profile = PROFILES["solax_inverter"]
    resolved = {key: None for key in profile.telemetry}
    resolved.update(
        entities
        if entities is not None
        else {"run_mode": RUN_MODE, "inverter_temperature": TEMPERATURE}
    )
    return {"inverter": DeviceTelemetry(profile=profile, entry=ENTRY, entities=resolved)}


def resolve_controls(_hass, _profile, entry, templates, **_):
    return {t: CONTROLS.get(t[1].format(name=entry.title)) for t in templates}


def overview(states, *, cfg=None, tele=None):
    cfg = config() if cfg is None else cfg
    with (
        patch(
            "custom_components.helman.node_details.inverter.resolve_vendor_telemetry",
            return_value=telemetry() if tele is None else tele,
        ),
        patch("custom_components.helman.vendors.resolve_unique_ids", side_effect=resolve_controls),
    ):
        return asyncio.run(
            async_get_node_detail(
                fake_hass(states),
                cfg,
                node="inverter",
                device_id=None,
                section=None,
                now=datetime(2026, 10, 10, 14, 0, tzinfo=PRAGUE),
            )
        )


# --- The registry ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("node", "device_id", "section", "code"),
    [
        ("toaster", None, None, "unknown_node"),
        ("inverter", "garage-ev", None, "invalid_device"),
        ("inverter", None, "voltage", "unknown_section"),
    ],
)
def test_a_refused_request_is_an_error_with_its_code(node, device_id, section, code):
    with pytest.raises(NodeDetailError) as raised:
        asyncio.run(
            async_get_node_detail(
                fake_hass({}),
                config(),
                node=node,
                device_id=device_id,
                section=section,
                now=datetime(2026, 10, 10, 14, 0, tzinfo=PRAGUE),
            )
        )
    assert raised.value.code == code


def test_the_overview_reads_no_history():
    with patch(
        "custom_components.helman.node_details.inverter.async_day_stats",
        side_effect=AssertionError("read"),
    ):
        payload = overview({MODE_SELECT: "normal"})

    assert payload["node"] == "inverter"
    assert payload["configured"] is True
    assert payload["sections"] == ["temperature"]
    assert payload["entities"]["inverter_temperature"] == TEMPERATURE
    assert payload["entities"]["battery_min_soc"] == "number.min_soc"
    assert payload["mode"] == {
        "entityId": MODE_SELECT,
        "actionOptions": {kind: kind for kind in KINDS},
    }
    assert payload["profile"] == {"id": "solax_inverter", "label": "SolaX inverter"}
    assert payload["maxAllowedExportPower"] == 9900


def test_a_section_reads_only_its_history():
    calls = []

    async def fake_day_stats(hass, entity_ids, *, start, end, now):
        calls.append((list(entity_ids), start, end))
        return {TEMPERATURE: {"entityId": TEMPERATURE, "points": []}}

    with (
        patch(
            "custom_components.helman.node_details.inverter.resolve_vendor_telemetry",
            return_value=telemetry(),
        ),
        patch(
            "custom_components.helman.node_details.inverter.async_day_stats",
            side_effect=fake_day_stats,
        ),
    ):
        payload = asyncio.run(
            async_get_node_detail(
                fake_hass({}),
                config(),
                node="inverter",
                device_id=None,
                section="temperature",
                now=datetime(2026, 10, 10, 14, 0, tzinfo=PRAGUE),
            )
        )

    [(ids, start, end)] = calls
    assert ids == [TEMPERATURE]
    assert start == datetime(2026, 10, 9, 22, 0, tzinfo=UTC)
    assert end == datetime(2026, 10, 10, 22, 0, tzinfo=UTC)
    assert payload["temperature"]["entityId"] == TEMPERATURE
    assert "agreement" not in payload
    assert payload["period"]["start"].startswith("2026-10-10T00:00:00")


def test_a_section_without_its_sensor_is_a_typed_null():
    with patch(
        "custom_components.helman.node_details.inverter.resolve_vendor_telemetry",
        return_value=telemetry({"inverter_temperature": None}),
    ):
        payload = asyncio.run(
            async_get_node_detail(
                fake_hass({}),
                config(),
                node="inverter",
                device_id=None,
                section="temperature",
                now=datetime(2026, 10, 10, 14, 0, tzinfo=PRAGUE),
            )
        )

    assert payload["temperature"] is None


# --- The configuration agreement -------------------------------------------------


def test_registers_holding_the_command_match():
    payload = overview(
        {MODE_SELECT: "charge_to_target_soc", USE_MODE: "Manual Mode",
         MANUAL_MODE: "Force Charge", EXPORT_LIMIT: "9900.0"}
    )

    agreement = payload["agreement"]
    assert (agreement["status"], agreement["commanded"]) == ("match", "charge_to_target_soc")
    assert agreement["observedOption"] == "charge_to_target_soc"
    assert [r["entityId"] for r in agreement["registers"]] == [USE_MODE, MANUAL_MODE, EXPORT_LIMIT]


def test_a_fully_observed_different_configuration_is_a_mismatch():
    payload = overview(
        {MODE_SELECT: "normal", USE_MODE: "Back Up Mode", EXPORT_LIMIT: "9900"}
    )

    agreement = payload["agreement"]
    assert agreement["status"] == "mismatch"
    assert agreement["observedOption"] is None
    assert agreement["registers"][0] == {
        "entityId": USE_MODE, "expected": "Self Use Mode", "actual": "Back Up Mode", "matches": False,
    }


def test_an_unreadable_register_is_unknown_not_a_mismatch():
    # The use mode differs, but the export limit cannot be read: no alert.
    payload = overview(
        {MODE_SELECT: "normal", USE_MODE: "Back Up Mode", EXPORT_LIMIT: "unavailable"}
    )

    assert (payload["agreement"]["status"], payload["agreement"]["reason"]) == (
        "unknown", "unavailable",
    )


@pytest.mark.parametrize(
    ("states", "cfg", "reason"),
    [
        ({}, None, "no_command"),
        ({MODE_SELECT: "unavailable"}, None, "no_command"),
        ({MODE_SELECT: "normal"}, config(export_cap=None), "not_bound"),
    ],
)
def test_without_a_comparable_command_the_agreement_is_unknown(states, cfg, reason):
    payload = overview(states, cfg=cfg)

    assert (payload["agreement"]["status"], payload["agreement"]["reason"]) == ("unknown", reason)


def test_a_custom_inverter_has_no_agreement_and_no_telemetry():
    cfg = config(profile=False)
    payload = overview({MODE_SELECT: "normal"}, cfg=cfg, tele={})

    assert payload["profile"] is None
    assert payload["agreement"]["status"] == "unknown"
    assert payload["agreement"]["reason"] == "no_profile"
    assert payload["agreement"]["commanded"] == "normal"
    assert set(payload["entities"]) == {"battery_min_soc", "battery_max_soc"}
    assert payload["sections"] == []
    assert payload["condition"] is None


def test_no_mode_control_and_no_profile_is_not_configured():
    payload = overview({}, cfg={"energy_nodes": {}}, tele={})

    assert payload["configured"] is False
    assert payload["mode"] is None


@pytest.mark.parametrize(
    ("run_mode", "kind"),
    [("Off-Grid", "off_grid"), ("Fault", "fault"), ("Permanent Fault Mode", "fault"), ("Normal Mode", None)],
)
def test_an_off_grid_or_fault_run_mode_is_promoted(run_mode, kind):
    payload = overview({MODE_SELECT: "normal", RUN_MODE: run_mode})

    condition = payload["condition"]
    assert (condition and condition["kind"]) == (kind or None)


# --- day_stats --------------------------------------------------------------------


def state(value, at):
    return NS(state=value, last_changed=at)


T0 = datetime(2026, 10, 10, 10, 0, tzinfo=UTC)


def test_states_are_weighted_by_how_long_each_was_held():
    states = [state("40", T0), state("46", T0 + timedelta(minutes=4))]

    [bucket] = day_stats.buckets_from_states(states, T0, T0 + timedelta(minutes=5))

    assert bucket.weighted_sum / bucket.covered_seconds == pytest.approx((40 * 4 + 46) / 5)
    assert (bucket.minimum, bucket.maximum) == (40, 46)


def test_an_unavailable_stretch_is_a_gap_not_a_zero():
    states = [
        state("40", T0),
        state("unavailable", T0 + timedelta(minutes=2)),
        state("42", T0 + timedelta(minutes=10)),
    ]

    buckets = day_stats.buckets_from_states(states, T0, T0 + timedelta(minutes=15))
    summary = day_stats.summarize(
        buckets, start=T0, stop=T0 + timedelta(minutes=15), source="history",
        unit="°C", entity_id=TEMPERATURE,
    )

    # 00-05 partly known (2 min), 05-10 unknown, 10-15 known.
    assert [point["coverage"] for point in summary["points"]] == pytest.approx([0.4, 1.0])
    assert summary["mean"] == pytest.approx((40 * 120 + 42 * 300) / 420)
    assert summary["min"] == 40
    assert summary["coverage"] == pytest.approx(420 / 900)
    assert summary["extrema"] == "recorded"


def test_a_state_from_before_the_window_holds_into_it():
    states = [state("30", T0 - timedelta(hours=3))]

    buckets = day_stats.buckets_from_states(states, T0, T0 + timedelta(minutes=10))

    assert len(buckets) == 2
    assert all(bucket.covered_seconds == 300 for bucket in buckets)


def test_statistics_rows_keep_their_own_extrema():
    rows = [
        {"start": T0.timestamp(), "mean": 41.0, "min": 39.5, "max": 44.0},
        {"start": (T0 + timedelta(minutes=10)).timestamp(), "mean": None},
    ]

    buckets = day_stats.buckets_from_statistics(rows, T0, T0 + timedelta(minutes=15))
    summary = day_stats.summarize(
        buckets, start=T0, stop=T0 + timedelta(minutes=15), source="statistics",
        unit="°C", entity_id=TEMPERATURE,
    )

    assert summary["points"][0]["min"] == 39.5
    assert summary["max"] == 44.0
    assert summary["extrema"] == "bucket_statistics"
    assert summary["coverage"] == pytest.approx(1 / 3)


@pytest.mark.parametrize(
    ("day", "hours"),
    [(datetime(2026, 3, 29, 12, tzinfo=PRAGUE), 23), (datetime(2026, 10, 25, 12, tzinfo=PRAGUE), 25)],
)
def test_a_dst_day_is_its_actual_elapsed_time(day, hours):
    start, end = day_stats.day_window(day)

    assert end - start == timedelta(hours=hours)
    states = [state("40", start)]
    buckets = day_stats.buckets_from_states(states, start, end)
    assert len(buckets) == hours * 12


class FakeRecorder:
    def __init__(self, metadata_ids):
        self.metadata_ids = metadata_ids
        self.calls = []

    def get_metadata(self, hass, *, statistic_ids, statistic_type):
        self.calls.append(("metadata", statistic_type))
        return {
            sid: (1, {"unit_of_measurement": "°C"})
            for sid in statistic_ids
            if sid in self.metadata_ids
        }

    def statistics_during_period(self, hass, start, end, ids, period, units, types):
        self.calls.append(("statistics", period, sorted(ids)))
        return {sid: [{"start": start.timestamp(), "mean": 41.0, "min": 40.0, "max": 43.0}] for sid in ids}

    def get_significant_states(self, hass, start, end, entity_ids, **kwargs):
        self.calls.append(("history", sorted(entity_ids)))
        return {eid: [NS(state="35", last_changed=start)] for eid in entity_ids}


async def _executor(func, *args):
    return func(*args)


def run_day_stats(recorder, entity_ids, now, hass=None):
    start, end = day_stats.day_window(now)
    hass = hass or fake_hass({})
    with (
        patch("homeassistant.components.recorder.get_instance",
              return_value=NS(async_add_executor_job=_executor)),
        patch("homeassistant.components.recorder.statistics.get_metadata", recorder.get_metadata),
        patch("homeassistant.components.recorder.statistics.statistics_during_period",
              recorder.statistics_during_period),
        patch("homeassistant.components.recorder.history.get_significant_states",
              recorder.get_significant_states),
    ):
        return asyncio.run(day_stats.async_day_stats(hass, entity_ids, start=start, end=end, now=now))


def test_statistics_are_used_where_present_and_history_elsewhere():
    recorder = FakeRecorder({TEMPERATURE})
    now = datetime(2026, 10, 10, 0, 30, tzinfo=PRAGUE)

    result = run_day_stats(recorder, [TEMPERATURE, "sensor.no_stats", None, TEMPERATURE], now)

    assert result[TEMPERATURE]["source"] == "statistics"
    assert result["sensor.no_stats"]["source"] == "history"
    assert ("statistics", "5minute", [TEMPERATURE]) in recorder.calls
    assert ("history", ["sensor.no_stats"]) in recorder.calls
    # Half an hour elapsed: six history buckets, none after now.
    assert len(result["sensor.no_stats"]["points"]) == 6
    assert result["sensor.no_stats"]["coverage"] == pytest.approx(1.0)


def test_statistics_carry_their_stored_unit_and_history_the_live_one():
    recorder = FakeRecorder({TEMPERATURE})
    now = datetime(2026, 10, 10, 0, 30, tzinfo=PRAGUE)
    # The display unit changed to °F; the statistics are still stored in °C.
    hass = fake_hass({TEMPERATURE: "105", "sensor.no_stats": "95"}, unit="°F")

    result = run_day_stats(recorder, [TEMPERATURE, "sensor.no_stats"], now, hass)

    assert result[TEMPERATURE]["unit"] == "°C"
    assert result["sensor.no_stats"]["unit"] == "°F"


def test_websocket_errors_carry_the_registry_code():
    sent = []
    connection = NS(
        send_result=lambda *args: sent.append(("result", args)),
        send_error=lambda msg_id, code, message: sent.append(("error", code)),
    )
    hass = NS(data={"helman": {"coordinator": NS(config=config())}})

    asyncio.run(
        websockets_module.ws_get_node_detail.__wrapped__(
            hass, connection, {"id": 1, "type": "helman/get_node_detail", "node": "toaster"}
        )
    )

    assert sent == [("error", "unknown_node")]
