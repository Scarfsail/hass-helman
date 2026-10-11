"""``helman/get_node_detail``: the node registry, the inverter detail and ``day_stats``."""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
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

    def get_metadata(self, hass, *, statistic_ids=None, statistic_type=None, statistic_source=None):
        # Mirrors the recorder, which refuses a type/source filter with ids.
        if statistic_ids is not None and (statistic_type or statistic_source):
            raise ValueError(
                "Providing statistic_type and statistic_source is mutually exclusive of statistic_ids"
            )
        self.calls.append(("metadata",))
        return {
            sid: (1, {"unit_of_measurement": "°C", "mean_type": self.metadata_ids[sid]})
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
    # A sum-only statistic (mean_type NONE) has no mean to read, so it falls
    # back to recorded history like an entity without statistics.
    recorder = FakeRecorder({TEMPERATURE: 1, "sensor.sum_only": 0})
    now = datetime(2026, 10, 10, 0, 30, tzinfo=PRAGUE)

    result = run_day_stats(
        recorder, [TEMPERATURE, "sensor.no_stats", "sensor.sum_only", None, TEMPERATURE], now
    )

    assert result[TEMPERATURE]["source"] == "statistics"
    assert result["sensor.no_stats"]["source"] == "history"
    assert result["sensor.sum_only"]["source"] == "history"
    assert ("statistics", "5minute", [TEMPERATURE]) in recorder.calls
    assert ("history", ["sensor.no_stats", "sensor.sum_only"]) in recorder.calls
    # Half an hour elapsed: six history buckets, none after now.
    assert len(result["sensor.no_stats"]["points"]) == 6
    assert result["sensor.no_stats"]["coverage"] == pytest.approx(1.0)


def test_statistics_carry_their_stored_unit_and_history_the_live_one():
    recorder = FakeRecorder({TEMPERATURE: 1})
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


# --- The grid detail ----------------------------------------------------------------

VOLTAGES = {phase: f"sensor.solax_inverter_voltage_l{phase}" for phase in (1, 2, 3)}
GRID_TELEMETRY = {
    "run_mode": RUN_MODE,
    **{f"ac_voltage_l{phase}": entity_id for phase, entity_id in VOLTAGES.items()},
    **{f"grid_power_l{phase}": f"sensor.solax_measured_power_l{phase}" for phase in (1, 2, 3)},
    "main_breaker_limit": "number.solax_main_breaker_current_limit",
}
NOW = datetime(2026, 10, 10, 14, 0, tzinfo=PRAGUE)


def grid_config(*, profile=True):
    cfg = config(profile=profile)
    cfg["energy_nodes"]["grid"]["entities"] = {
        "today_import": "sensor.today_import",
        "today_export": "sensor.today_export",
    }
    return cfg


def grid_detail(*, cfg=None, tele=None, section=None, day_stats_result=None, states=None):
    calls = []

    async def fake_day_stats(hass, entity_ids, *, start, end, now):
        calls.append(list(entity_ids))
        return day_stats_result or {}

    with (
        patch(
            "custom_components.helman.node_details.grid.resolve_vendor_telemetry",
            return_value=telemetry(GRID_TELEMETRY) if tele is None else tele,
        ),
        patch(
            "custom_components.helman.node_details.grid.async_day_stats",
            side_effect=fake_day_stats,
        ),
    ):
        payload = asyncio.run(
            async_get_node_detail(
                fake_hass(states or {}),
                grid_config() if cfg is None else cfg,
                node="grid",
                device_id=None,
                section=section,
                now=NOW,
            )
        )
    return payload, calls


def test_the_grid_overview_carries_its_mappings_and_reads_no_history():
    payload, calls = grid_detail(states={RUN_MODE: "Off-Grid"})

    assert calls == []
    assert payload["node"] == "grid"
    assert payload["entities"]["grid_power_l2"] == "sensor.solax_measured_power_l2"
    assert payload["entities"]["ac_voltage_l1"] == VOLTAGES[1]
    # A key the profile has but the registry lacks is a typed null.
    assert payload["entities"]["grid_frequency"] is None
    assert payload["entities"]["today_import"] == "sensor.today_import"
    # Inverter-only telemetry stays with the inverter detail.
    assert "inverter_temperature" not in payload["entities"]
    assert payload["phasePowerPolarity"] == "positive_is_export"
    assert payload["maxAllowedExportPower"] == 9900
    assert payload["condition"] == {"kind": "off_grid", "runMode": "Off-Grid", "entityId": RUN_MODE}
    assert payload["sections"] == ["voltage"]


def test_a_custom_grid_has_no_telemetry_and_no_voltage_section():
    payload, _ = grid_detail(cfg=grid_config(profile=False), tele={})

    assert payload["profile"] is None
    assert payload["phasePowerPolarity"] is None
    assert payload["entities"] == {
        "today_import": "sensor.today_import",
        "today_export": "sensor.today_export",
    }
    assert payload["sections"] == []


def test_the_grid_refuses_a_section_it_does_not_answer():
    with pytest.raises(NodeDetailError) as raised:
        grid_detail(section="temperature")
    assert raised.value.code == "unknown_section"


def day(points):
    """A day_stats summary holding only what phase_spread reads.

    A point is ``(start, mean)``, fully covered, or ``(start, mean, coverage)``.
    """
    return {
        "points": [
            {"start": point[0], "mean": point[1], "coverage": point[2] if len(point) > 2 else 1.0}
            for point in points
        ]
    }


def at(hour, minute=0):
    return datetime(2026, 10, 10, hour, minute, tzinfo=PRAGUE).isoformat()


def test_the_voltage_section_reads_the_phases_and_their_aligned_spread():
    stats = {
        VOLTAGES[1]: day([(at(10), 236.0), (at(10, 5), 238.0)]),
        VOLTAGES[2]: day([(at(10), 241.0), (at(10, 5), 239.0)]),
        VOLTAGES[3]: day([(at(10), 237.0), (at(10, 5), 238.5)]),
    }
    payload, calls = grid_detail(section="voltage", day_stats_result=stats)

    assert calls == [[VOLTAGES[1], VOLTAGES[2], VOLTAGES[3]]]
    assert payload["phases"]["2"] is stats[VOLTAGES[2]]
    assert payload["spread"]["max"] == pytest.approx(5.0)
    assert payload["spread"]["maxAt"] == at(10)
    assert payload["spread"]["phases"] == [1, 2, 3]
    assert payload["period"]["start"].startswith("2026-10-10T00:00:00")


def test_a_phase_without_its_sensor_is_a_typed_null_and_is_not_compared():
    tele = telemetry({**GRID_TELEMETRY, "ac_voltage_l3": None})
    stats = {
        VOLTAGES[1]: day([(at(10), 236.0)]),
        VOLTAGES[2]: day([(at(10), 240.0)]),
    }
    payload, calls = grid_detail(section="voltage", tele=tele, day_stats_result=stats)

    assert calls == [[VOLTAGES[1], VOLTAGES[2], None]]
    assert payload["phases"]["3"] is None
    assert payload["spread"]["phases"] == [1, 2]
    assert payload["spread"]["max"] == pytest.approx(4.0)


def test_the_spread_never_subtracts_unrelated_extremes():
    from custom_components.helman.node_details.grid import phase_spread

    start = datetime(2026, 10, 10, 0, 0, tzinfo=PRAGUE)
    stop = datetime(2026, 10, 10, 1, 0, tzinfo=PRAGUE)
    # L1 peaks at 00:00 and L2 dips at 00:10: 250 - 230 would be 20 V, but at
    # no moment were they that far apart.
    spread = phase_spread(
        {
            "1": day([(at(0), 250.0), (at(0, 5), 240.0), (at(0, 10), 240.0)]),
            "2": day([(at(0), 248.0), (at(0, 5), 239.0), (at(0, 10), 230.0)]),
        },
        start=start,
        stop=stop,
    )

    assert spread["max"] == pytest.approx(10.0)
    assert spread["maxAt"] == at(0, 10)


def test_the_spread_compares_only_buckets_every_phase_knows():
    from custom_components.helman.node_details.grid import phase_spread

    start = datetime(2026, 10, 10, 0, 0, tzinfo=PRAGUE)
    stop = datetime(2026, 10, 10, 0, 20, tzinfo=PRAGUE)
    spread = phase_spread(
        {
            "1": day([(at(0), 230.0), (at(0, 5), 230.0), (at(0, 10), 230.0)]),
            # L2 has a gap at 00:05, where L1 alone would make no spread.
            "2": day([(at(0), 232.0), (at(0, 10), 231.0)]),
            "3": None,
        },
        start=start,
        stop=stop,
    )

    assert spread["phases"] == [1, 2]
    assert spread["max"] == pytest.approx(2.0)
    # Two aligned buckets of the four elapsed.
    assert spread["coverage"] == pytest.approx(0.5)


def test_spread_coverage_counts_each_bucket_at_its_least_known_phase():
    from custom_components.helman.node_details.grid import phase_spread

    start = datetime(2026, 10, 10, 0, 0, tzinfo=PRAGUE)
    stop = datetime(2026, 10, 10, 0, 10, tzinfo=PRAGUE)
    spread = phase_spread(
        {
            "1": day([(at(0), 230.0, 0.2), (at(0, 5), 230.0)]),
            "2": day([(at(0), 232.0), (at(0, 5), 231.0, 0.6)]),
        },
        start=start,
        stop=stop,
    )

    # 0.2 of the first bucket and 0.6 of the second, of two elapsed.
    assert spread["coverage"] == pytest.approx(0.4)


def test_a_null_grid_config_still_builds_an_overview():
    for broken in ({"energy_nodes": None}, {"energy_nodes": {"grid": None}}):
        payload, _ = grid_detail(cfg=broken)
        assert payload["maxAllowedExportPower"] is None


def test_one_known_phase_has_no_spread():
    from custom_components.helman.node_details.grid import phase_spread

    start = datetime(2026, 10, 10, 0, 0, tzinfo=PRAGUE)
    spread = phase_spread(
        {"1": day([(at(0), 230.0)]), "2": day([]), "3": None},
        start=start,
        stop=start + timedelta(minutes=5),
    )

    assert spread == {"phases": [1], "max": None, "maxAt": None, "coverage": 0.0}


def test_voltage_extrema_are_bucket_extrema_and_the_mean_is_duration_weighted():
    voltage = VOLTAGES[1]
    # Recorded states: 236 V for 4 minutes then a 1-minute dip to 221 V, then a
    # 5-minute gap (unavailable), then 240 V.
    states = [
        state("236", T0),
        state("221", T0 + timedelta(minutes=4)),
        state("unavailable", T0 + timedelta(minutes=5)),
        state("240", T0 + timedelta(minutes=10)),
    ]
    stop = T0 + timedelta(minutes=15)
    summary = day_stats.summarize(
        day_stats.buckets_from_states(states, T0, stop),
        start=T0, stop=stop, source="history", unit="V", entity_id=voltage,
    )

    # The dip is the day's minimum though no bucket mean comes near it.
    assert summary["min"] == 221
    assert min(point["mean"] for point in summary["points"]) == pytest.approx((236 * 4 + 221) / 5)
    assert summary["max"] == 240
    # The gap is neither a zero nor integrated into the mean.
    assert len(summary["points"]) == 2
    assert summary["mean"] == pytest.approx((236 * 240 + 221 * 60 + 240 * 300) / 600)
    assert summary["coverage"] == pytest.approx(600 / 900)


# --- The battery detail --------------------------------------------------------

BATTERY_TELEMETRY = {
    "battery_voltage": "sensor.solax_battery_voltage_charge",
    "input_energy_total": "sensor.solax_battery_input_energy_total",
    "output_energy_total": "sensor.solax_battery_output_energy_total",
    "bms_connect_state": "sensor.solax_bms_connect_state",
    "run_mode": RUN_MODE,
}


def battery_config(*, profile=True, forecast=None):
    cfg = config(profile=profile)
    cfg["energy_nodes"]["battery"] = {
        "entities": {
            "capacity": "sensor.soc",
            "remaining_energy": "sensor.remaining",
            "min_soc": "number.min_soc",
            "max_soc": "number.max_soc",
            "today_charge_energy": "sensor.battery_in_today",
        },
        "forecast": forecast or {"max_charge_power_w": 5000, "max_discharge_power_w": 6000},
    }
    return cfg


def battery_states(**overrides):
    """A 20 kWh battery at 50 %, lifetime counters 3000 kWh in and 2600 kWh out."""
    states = {
        "sensor.soc": ("50", "%"),
        "sensor.remaining": ("10000", "Wh"),
        "number.min_soc": ("10", "%"),
        "number.max_soc": ("100", "%"),
        "sensor.solax_battery_input_energy_total": ("3000", "kWh"),
        "sensor.solax_battery_output_energy_total": ("2600", "kWh"),
        "sensor.solax_bms_connect_state": ("Connected", None),
        RUN_MODE: ("Normal Mode", None),
    }
    states.update(overrides)
    return NS(
        get=lambda entity_id: (
            NS(state=states[entity_id][0], attributes={"unit_of_measurement": states[entity_id][1]})
            if entity_id in states and states[entity_id] is not None
            else None
        )
    )


def battery_detail(*, cfg=None, tele=None, states=None, section=None, report=None):
    reports = []

    async def device_report(name, query):
        reports.append((name, query))
        return report

    hass = NS(
        states=states or battery_states(),
        data={"helman": {"coordinator": NS(async_device_report=device_report)}},
    )
    with patch(
        "custom_components.helman.node_details.battery.resolve_vendor_telemetry",
        return_value=telemetry(BATTERY_TELEMETRY) if tele is None else tele,
    ):
        payload = asyncio.run(
            async_get_node_detail(
                hass,
                battery_config() if cfg is None else cfg,
                node="battery",
                device_id=None,
                section=section,
                now=NOW,
            )
        )
    return payload, reports


def test_the_battery_overview_carries_its_mappings_ceilings_and_cycles():
    payload, reports = battery_detail()

    assert reports == []
    assert payload["node"] == "battery"
    assert payload["entities"]["soc"] == "sensor.soc"
    assert payload["entities"]["today_charge"] == "sensor.battery_in_today"
    # Not configured: a typed null, never a guess.
    assert payload["entities"]["today_discharge"] is None
    assert payload["entities"]["time_to_full"] == "sensor.helman_battery_time_to_full"
    assert payload["entities"]["battery_voltage"] == "sensor.solax_battery_voltage_charge"
    # A key the profile has but the registry lacks is a typed null.
    assert payload["entities"]["cell_voltage_high"] is None
    # Grid-only and inverter-only telemetry stays with their details.
    assert "grid_power_l1" not in payload["entities"]
    assert "inverter_temperature" not in payload["entities"]
    assert payload["configured"] == {"maxChargePowerW": 5000.0, "maxDischargePowerW": 6000.0}
    # (3000 + 2600) / (2 × 20 kWh), the forecast's nominal capacity.
    assert payload["cycles"]["cycles"] == pytest.approx(140.0)
    assert payload["cycles"]["capacityKwh"] == pytest.approx(20.0)
    assert payload["cycles"]["reason"] is None
    assert payload["condition"] is None
    assert payload["sections"] == ["charge"]


@pytest.mark.parametrize(
    ("overrides", "tele", "reason"),
    [
        # The lifetime counters disabled on the hardware: not mapped.
        ({}, {**BATTERY_TELEMETRY, "input_energy_total": None}, "no_counters"),
        ({"sensor.solax_battery_output_energy_total": ("unavailable", "kWh")}, None, "invalid_counters"),
        ({"sensor.solax_battery_output_energy_total": ("-5", "kWh")}, None, "invalid_counters"),
        # A counter in no energy unit is not comparable with the capacity.
        ({"sensor.solax_battery_input_energy_total": ("3000", None)}, None, "invalid_counters"),
        ({"sensor.remaining": ("unknown", "Wh")}, None, "no_capacity"),
        ({"sensor.soc": ("0", "%")}, None, "no_capacity"),
        # A remaining energy with no unit is not guessed at.
        ({"sensor.remaining": ("10000", None)}, None, "no_capacity"),
    ],
)
def test_cycles_need_valid_comparable_counters_and_capacity(overrides, tele, reason):
    payload, _ = battery_detail(
        states=battery_states(**overrides),
        tele=None if tele is None else telemetry(tele),
    )

    assert payload["cycles"]["cycles"] is None
    assert payload["cycles"]["reason"] == reason


def test_renamed_eta_sensors_are_found_by_unique_id():
    from custom_components.helman.node_details.battery import TIME_SENSORS, helman_sensor_ids

    registered = {("sensor", "helman", "entry1_battery_time_to_full"): "sensor.my_battery_full_in"}
    registry = NS(async_get_entity_id=lambda domain, platform, uid: registered.get((domain, platform, uid)))
    hass = NS(config_entries=NS(async_entries=lambda domain: [NS(entry_id="entry1")]))
    with patch("homeassistant.helpers.entity_registry.async_get", return_value=registry):
        ids = helman_sensor_ids(hass, TIME_SENSORS)

    assert ids["time_to_full"] == "sensor.my_battery_full_in"
    # Not registered yet: the id sensor.py creates it under.
    assert ids["time_to_empty"] == "sensor.helman_battery_time_to_empty"


def test_cycles_need_no_planning_bounds_for_the_capacity():
    # 50 % sits above a 40 % planning ceiling; remaining ÷ SoC is still 20 kWh.
    payload, _ = battery_detail(states=battery_states(**{"number.max_soc": ("40", "%")}))

    assert payload["cycles"]["capacityKwh"] == pytest.approx(20.0)
    assert payload["cycles"]["cycles"] == pytest.approx(140.0)


def test_cycles_normalize_the_counters_units():
    from custom_components.helman.node_details.battery import equivalent_full_cycles

    payload, _ = battery_detail(
        states=battery_states(**{"sensor.solax_battery_input_energy_total": ("3", "MWh")})
    )

    assert payload["cycles"]["inputKwh"] == pytest.approx(3000.0)
    assert payload["cycles"]["cycles"] == pytest.approx(140.0)
    assert equivalent_full_cycles(10.0, 10.0, 0.0)["reason"] == "no_capacity"


def test_a_custom_battery_has_no_telemetry_and_no_cycles():
    payload, _ = battery_detail(cfg=battery_config(profile=False), tele={})

    assert payload["profile"] is None
    assert "battery_voltage" not in payload["entities"]
    assert payload["cycles"]["reason"] == "no_counters"
    assert payload["condition"] is None


def test_only_an_explicit_bms_report_is_promoted_before_the_run_mode():
    payload, _ = battery_detail(
        states=battery_states(
            **{"sensor.solax_bms_connect_state": ("Disconnected", None), RUN_MODE: ("Off-Grid", None)}
        )
    )
    assert payload["condition"] == {
        "kind": "bms_disconnected",
        "state": "Disconnected",
        "entityId": "sensor.solax_bms_connect_state",
    }

    payload, _ = battery_detail(states=battery_states(**{RUN_MODE: ("Off-Grid", None)}))
    assert payload["condition"] == {"kind": "off_grid", "state": "Off-Grid", "entityId": RUN_MODE}


def origin(charged, **fractions):
    base = {
        "charged_kwh": charged,
        "grid": 0.0,
        "grid_recorded": 0.0,
        "grid_tariff": 0.0,
        "grid_unpriced": 0.0,
        "solar": 0.0,
        "solar_priced": 0.0,
        "solar_unpriced": 0.0,
        "unknown": 1.0,
        "paid_rate": None,
        "forgone_rate": None,
    }
    base.update(fractions)
    base["grid"] = base["grid_recorded"] + base["grid_tariff"] + base["grid_unpriced"]
    base["solar"] = base["solar_priced"] + base["solar_unpriced"]
    return base


def test_charge_fractions_become_kwh_keeping_unknown_and_unpriced_shares():
    from custom_components.helman.node_details.battery import charge_origin_kwh

    charge = charge_origin_kwh(
        origin(
            10.0,
            grid_recorded=0.2,
            grid_unpriced=0.1,
            solar_priced=0.4,
            solar_unpriced=0.2,
            unknown=0.1,
            paid_rate=4.0,
            forgone_rate=1.5,
        )
    )

    assert charge["chargedKwh"] == pytest.approx(10.0)
    assert charge["gridKwh"] == pytest.approx(3.0)
    assert charge["solarKwh"] == pytest.approx(6.0)
    # Nothing is forced into a source: the unexplained kWh stay unknown.
    assert charge["unknownKwh"] == pytest.approx(1.0)
    assert charge["gridKwh"] + charge["solarKwh"] + charge["unknownKwh"] == pytest.approx(10.0)
    # Only the rated grid share is paid for; the unrated one stays unpriced.
    assert charge["gridPricedKwh"] == pytest.approx(2.0)
    assert charge["gridUnpricedKwh"] == pytest.approx(1.0)
    assert charge["paidCost"] == pytest.approx(8.0)
    assert charge["solarPricedKwh"] == pytest.approx(4.0)
    assert charge["solarUnpricedKwh"] == pytest.approx(2.0)
    assert charge["forgoneValue"] == pytest.approx(6.0)


def test_a_side_without_kwh_costs_zero_and_one_without_a_rate_is_unknown():
    from custom_components.helman.node_details.battery import charge_origin_kwh

    solar_only = charge_origin_kwh(origin(4.0, solar_unpriced=1.0, unknown=0.0))
    assert solar_only["paidCost"] == 0.0
    assert solar_only["forgoneValue"] is None

    unrated_grid = charge_origin_kwh(origin(4.0, grid_unpriced=1.0, unknown=0.0))
    assert unrated_grid["paidCost"] is None


def test_a_period_without_charge_is_no_charge_not_unknown_storage():
    from custom_components.helman.node_details.battery import charge_origin_kwh

    charge = charge_origin_kwh(origin(0.0))

    assert charge["chargedKwh"] == 0.0
    assert charge["unknownKwh"] == 0.0
    assert charge["gridKwh"] == 0.0 and charge["solarKwh"] == 0.0
    assert charge["paidCost"] == 0.0
    assert charge["forgoneValue"] == 0.0


def test_the_charge_section_reuses_todays_ranking_report():
    report = {"currency": "CZK/kWh", "complete": False, "charge_origin": origin(5.0, solar_priced=1.0, unknown=0.0, forgone_rate=1.2)}

    payload, reports = battery_detail(section="charge", report=report)

    assert len(reports) == 1
    name, query = reports[0]
    assert name == "ranking"
    assert query.start_date == query.end_date == NOW.date()
    assert payload["currency"] == "CZK/kWh"
    assert payload["charge"]["solarKwh"] == pytest.approx(5.0)
    assert payload["period"]["start"].startswith("2026-10-10T00:00:00")
    assert payload["unavailable"] is None


def test_the_charge_section_says_why_without_reports():
    payload, _ = battery_detail(section="charge", report={"unavailable": "no_house_meter"})

    assert payload["charge"] is None
    assert payload["unavailable"] == "no_house_meter"


# --- The solar detail ---------------------------------------------------------

PV_POWER = {string: f"sensor.solax_pv_power_{string}" for string in (1, 2)}
SOLAR_TELEMETRY = {
    "run_mode": RUN_MODE,
    **{f"pv_power_{string}": entity_id for string, entity_id in PV_POWER.items()},
    "pv_voltage_1": "sensor.solax_pv_voltage_1",
    "rated_power": "sensor.solax_inverter_power_type",
    "export_limit": EXPORT_LIMIT,
    "shade_fix_pv1": "select.solax_shadow_fix_function_level_pv1_gmppt",
}


def solar_config(*, profile=True, max_power=11600, polarity=None):
    cfg = config(profile=profile)
    entities = {"power": "sensor.solar_power", "today_energy": "sensor.solar_today"}
    if polarity:
        entities["power_polarity"] = polarity
    cfg["energy_nodes"]["solar"] = {"entities": entities, "max_power": max_power}
    cfg["energy_nodes"]["grid"]["entities"] = {"today_export": "sensor.today_export"}
    cfg["training"] = {"solar_bias": {"total_energy_entity_id": "sensor.solar_total"}}
    return cfg


def solar_detail(*, cfg=None, tele=None, section=None, day_stats_result=None, states=None, report=None):
    calls = []
    reports = []

    async def fake_day_stats(hass, entity_ids, *, start, end, now):
        calls.append(list(entity_ids))
        return day_stats_result or {}

    async def device_report(name, query):
        reports.append((name, query))
        return report

    hass = fake_hass(states or {})
    hass.data = {"helman": {"coordinator": NS(async_device_report=device_report)}}
    with (
        patch(
            "custom_components.helman.node_details.solar.resolve_vendor_telemetry",
            return_value=telemetry(SOLAR_TELEMETRY) if tele is None else tele,
        ),
        patch(
            "custom_components.helman.node_details.solar.async_day_stats",
            side_effect=fake_day_stats,
        ),
    ):
        payload = asyncio.run(
            async_get_node_detail(
                hass,
                solar_config() if cfg is None else cfg,
                node="solar",
                device_id=None,
                section=section,
                now=NOW,
            )
        )
    return payload, calls, reports


def power_day(points, *, unit="W", maximum=None, minimum=None):
    """A day_stats summary of power: a point is ``(start, mean)`` or ``(start, mean, coverage)``."""
    rows = [
        {
            "start": point[0],
            "mean": point[1],
            "min": point[1],
            "max": point[1],
            "coverage": point[2] if len(point) > 2 else 1.0,
        }
        for point in points
    ]
    high = max(rows, key=lambda row: row["max"], default=None)
    low = min(rows, key=lambda row: row["min"], default=None)
    return {
        "entityId": "sensor.x",
        "unit": unit,
        "source": "statistics",
        "extrema": "bucket_statistics",
        "bucketMinutes": 5,
        "points": rows,
        "mean": None,
        "min": minimum if minimum is not None else (low and low["min"]),
        "minAt": low and low["start"],
        "max": maximum if maximum is not None else (high and high["max"]),
        "maxAt": high and high["start"],
        "coverage": 1.0,
    }


def test_the_solar_overview_carries_its_mappings_and_reads_no_history():
    payload, calls, reports = solar_detail(states={RUN_MODE: "Normal Mode"})

    assert calls == [] and reports == []
    assert payload["node"] == "solar"
    assert payload["entities"]["power"] == "sensor.solar_power"
    assert payload["entities"]["today_energy"] == "sensor.solar_today"
    assert payload["entities"]["today_export"] == "sensor.today_export"
    assert payload["entities"]["lifetime_energy"] == "sensor.solar_total"
    assert payload["entities"]["pv_power_2"] == PV_POWER[2]
    # A key the profile has but the registry lacks is a typed null.
    assert payload["entities"]["pv_current_1"] is None
    # Grid- and battery-only telemetry stays with their details.
    assert "grid_power_l1" not in payload["entities"]
    assert "battery_voltage" not in payload["entities"]
    assert payload["strings"] == [1, 2]
    assert payload["configuredMaxPowerW"] == 11600.0
    assert payload["maxAllowedExportPower"] == 9900
    assert payload["condition"] is None
    assert payload["sections"] == ["production", "strings", "destinations"]


def test_one_mapped_string_has_no_string_comparison():
    payload, _, _ = solar_detail(tele=telemetry({**SOLAR_TELEMETRY, "pv_power_2": None}))

    assert payload["strings"] == [1]
    assert "strings" not in payload["sections"]


def test_a_custom_solar_node_has_no_telemetry_and_no_strings():
    payload, _, _ = solar_detail(cfg=solar_config(profile=False), tele={})

    assert payload["profile"] is None
    assert "pv_power_1" not in payload["entities"]
    assert payload["strings"] == []
    assert payload["sections"] == ["production", "destinations"]


@pytest.mark.parametrize("max_power", [0, -5, "abc", None, True, float("nan")])
def test_a_configured_capacity_that_divides_nothing_is_none(max_power):
    payload, _, _ = solar_detail(cfg=solar_config(max_power=max_power))

    assert payload["configuredMaxPowerW"] is None


def test_the_production_section_reports_the_peak_in_watts():
    stats = {"sensor.solar_power": power_day([(at(12), 7.5), (at(12, 5), 9.8)], unit="kW")}

    payload, calls, _ = solar_detail(section="production", day_stats_result=stats)

    assert calls == [["sensor.solar_power"]]
    assert payload["unit"] == "kW"
    power = payload["power"]
    assert power["unit"] == "W"
    assert power["max"] == pytest.approx(9800.0)
    assert power["maxAt"] == at(12, 5)
    assert power["points"][0]["mean"] == pytest.approx(7500.0)


def test_an_inverted_solar_sensor_peaks_at_its_lowest_reading():
    stats = {"sensor.solar_power": power_day([(at(12), -7500.0), (at(13), -9800.0)])}

    payload, _, _ = solar_detail(
        cfg=solar_config(polarity="negative_is_production"),
        section="production",
        day_stats_result=stats,
    )

    assert payload["power"]["max"] == pytest.approx(9800.0)
    assert payload["power"]["maxAt"] == at(13)
    assert payload["power"]["min"] == pytest.approx(7500.0)


def test_power_in_an_unknown_unit_is_not_guessed_at():
    stats = {"sensor.solar_power": power_day([(at(12), 7.5)], unit="hp")}

    payload, _, _ = solar_detail(section="production", day_stats_result=stats)

    assert payload["power"] is None
    assert payload["unit"] == "hp"


def test_string_energy_integrates_covered_time_and_keeps_gaps_missing():
    from custom_components.helman.node_details.solar import string_energy

    start = datetime(2026, 10, 10, 0, 0, tzinfo=PRAGUE)
    stop = datetime(2026, 10, 10, 12, 0, tzinfo=PRAGUE)
    days = {
        # 6000 W for two full buckets and a half-known third: 12.5 min of 6 kW.
        "1": power_day([(at(10), 6000.0), (at(10, 5), 6000.0), (at(10, 10), 6000.0, 0.5)]),
        # Known only in the first bucket; its later gap is not a zero.
        "2": power_day([(at(10), 3000.0)]),
    }

    energy = string_energy(days, start=start, stop=stop)

    assert energy["strings"]["1"]["kwh"] == pytest.approx(1.25)
    assert energy["strings"]["2"]["kwh"] == pytest.approx(0.25)
    # Compared only over the bucket both know: 0.5 kWh against 0.25 kWh.
    assert energy["common"]["strings"] == [1, 2]
    assert energy["common"]["kwh"] == {"1": pytest.approx(0.5), "2": pytest.approx(0.25)}
    assert energy["common"]["coverage"] == pytest.approx(300 / (12 * 3600))


def test_string_shares_compare_each_bucket_at_its_least_known_string():
    from custom_components.helman.node_details.solar import string_energy

    start = datetime(2026, 10, 10, 0, 0, tzinfo=PRAGUE)
    stop = datetime(2026, 10, 10, 12, 0, tzinfo=PRAGUE)
    days = {
        "1": power_day([(at(10), 6000.0, 1.0)]),
        "2": power_day([(at(10), 6000.0, 0.5)]),
    }

    energy = string_energy(days, start=start, stop=stop)

    assert energy["strings"]["1"]["kwh"] == pytest.approx(0.5)
    assert energy["strings"]["2"]["kwh"] == pytest.approx(0.25)
    # Equal power over the same known time is an equal share.
    assert energy["common"]["kwh"]["1"] == pytest.approx(energy["common"]["kwh"]["2"])


def test_a_lone_string_compares_nothing_and_negative_power_is_zero():
    from custom_components.helman.node_details.solar import string_energy

    start = datetime(2026, 10, 10, 0, 0, tzinfo=PRAGUE)
    stop = datetime(2026, 10, 10, 12, 0, tzinfo=PRAGUE)

    energy = string_energy(
        {"1": power_day([(at(10), -40.0)]), "2": None}, start=start, stop=stop
    )

    assert energy["strings"]["1"]["kwh"] == 0.0
    assert energy["strings"]["2"] == {"kwh": None, "coverage": 0.0}
    assert energy["common"] == {"strings": [1], "coverage": 0.0, "kwh": None}


def test_the_strings_section_reads_each_string_in_watts():
    stats = {
        PV_POWER[1]: power_day([(at(10), 2.0)], unit="kW"),
        PV_POWER[2]: power_day([(at(10), 1500.0)]),
    }

    payload, calls, _ = solar_detail(section="strings", day_stats_result=stats)

    assert calls == [[PV_POWER[1], PV_POWER[2]]]
    assert payload["strings"]["1"]["unit"] == "kW"
    assert payload["strings"]["1"]["day"]["points"][0]["mean"] == pytest.approx(2000.0)
    assert payload["energy"]["common"]["kwh"] == {
        "1": pytest.approx(2000 * 300 / 3_600_000, abs=1e-3),
        "2": pytest.approx(1500 * 300 / 3_600_000, abs=1e-3),
    }


def ranking(*, attributed=10.0, unattributed=0.0, house=3.0, battery=3.0, export=4.0, measured_export=None, charged=5.0, solar_fraction=0.6, **origin_fractions):
    return {
        "currency": "CZK/kWh",
        "complete": False,
        "meters": {"grid": True, "solar": True, "battery": True, "house": True},
        "nodes": [{"id": "house", "sources": {"solar": house, "battery": 1.0, "grid": 2.0, "unattributed": 0.0}}],
        "charge_origin": origin(
            charged,
            solar_priced=solar_fraction,
            unknown=1.0 - solar_fraction,
            forgone_rate=1.2,
            **origin_fractions,
        ),
        "solar_totals": {
            "attributed_kwh": attributed,
            "unattributed_kwh": unattributed,
            "house_kwh": house,
            "battery_kwh": battery,
            "export_kwh": export,
            "measured_export_kwh": export if measured_export is None else measured_export,
        },
    }


def balanced(destinations):
    return (
        destinations["houseKwh"]
        + destinations["batteryKwh"]
        + destinations["exportKwh"]
        + destinations["unresolvedKwh"]
    )


def test_solar_destinations_read_the_summed_hourly_flows():
    from custom_components.helman.node_details.solar import solar_destinations

    destinations = solar_destinations(ranking())

    assert destinations["houseKwh"] == pytest.approx(3.0)
    assert destinations["batteryKwh"] == pytest.approx(3.0)
    assert destinations["exportKwh"] == pytest.approx(4.0)
    assert destinations["unresolvedKwh"] == pytest.approx(0.0)
    assert destinations["otherExportKwh"] == pytest.approx(0.0)
    assert balanced(destinations) == pytest.approx(destinations["producedKwh"])


def test_solar_the_meters_do_not_explain_stays_unresolved():
    from custom_components.helman.node_details.solar import solar_destinations

    # 10 kWh produced, 3 + 3 used and charged, only 1.5 exported.
    destinations = solar_destinations(ranking(export=1.5))

    assert destinations["exportKwh"] == pytest.approx(1.5)
    assert destinations["unresolvedKwh"] == pytest.approx(2.5)
    assert balanced(destinations) == pytest.approx(10.0)


def test_export_the_solar_does_not_explain_is_left_to_other_sources():
    from custom_components.helman.node_details.solar import solar_destinations

    destinations = solar_destinations(ranking(measured_export=6.0))

    assert destinations["exportKwh"] == pytest.approx(4.0)
    assert destinations["otherExportKwh"] == pytest.approx(2.0)
def test_solar_in_hours_without_a_source_mix_is_unresolved():
    from custom_components.helman.node_details.solar import solar_destinations

    destinations = solar_destinations(ranking(unattributed=2.0))

    assert destinations["producedKwh"] == pytest.approx(12.0)
    assert destinations["unattributedKwh"] == pytest.approx(2.0)
    assert destinations["unresolvedKwh"] == pytest.approx(2.0)
    assert balanced(destinations) == pytest.approx(12.0)


def test_the_destinations_section_reuses_todays_ranking_report():
    payload, calls, reports = solar_detail(section="destinations", report=ranking())

    assert calls == []
    assert len(reports) == 1
    name, query = reports[0]
    assert name == "ranking"
    assert query.start_date == query.end_date == NOW.date()
    assert payload["unavailable"] is None
    assert payload["currency"] == "CZK/kWh"
    assert payload["destinations"]["batteryKwh"] == pytest.approx(3.0)
    # The solar charge's forgone export value, from the same charge origin.
    assert payload["charge"]["solarKwh"] == pytest.approx(3.0)
    assert payload["charge"]["forgoneValue"] == pytest.approx(3.6)
    assert payload["period"]["start"].startswith("2026-10-10T00:00:00")


@pytest.mark.parametrize(
    ("report", "reason"),
    [
        ({"unavailable": "no_house_meter"}, "no_house_meter"),
        ({**ranking(), "meters": {"solar": False}}, "no_solar_meter"),
    ],
)
def test_the_destinations_section_says_why_it_has_none(report, reason):
    payload, _, _ = solar_detail(section="destinations", report=report)

    assert payload["destinations"] is None
    assert payload["unavailable"] == reason


# --- The house detail ----------------------------------------------------------

HOUSE_POWER = "sensor.house_power"
HOUSE_ENERGY = "sensor.house_energy_total"
EPS = {phase: f"sensor.solax_eps_power_active_l{phase}" for phase in (1, 2, 3)}


def house_config(*, profile=True, power=True, energy=True, polarity=None):
    cfg = config(profile=profile)
    entities = {"power": HOUSE_POWER} if power else {}
    if polarity:
        entities["power_polarity"] = polarity
    house = {"entities": entities}
    if energy:
        house["forecast"] = {"total_energy_entity_id": HOUSE_ENERGY}
    cfg["energy_nodes"]["house"] = house
    return cfg


def house_detail(
    *,
    cfg=None,
    tele=None,
    section=None,
    report=None,
    day_stats_result=None,
    windows_result=None,
    now=NOW,
    coordinator=None,
):
    calls = {"day_stats": [], "windows": [], "reports": []}

    async def fake_day_stats(hass, entity_ids, *, start, end, now):
        calls["day_stats"].append((list(entity_ids), start, end))
        return day_stats_result or {}

    async def fake_windows(hass, entity_id, windows):
        calls["windows"].append((entity_id, list(windows), 60))
        return windows_result or [{} for _ in windows]

    async def device_report(name, query):
        calls["reports"].append((name, query))
        return report

    hass = fake_hass({})
    hass.data = {
        "helman": {
            "coordinator": coordinator
            or NS(async_device_report=device_report, house_profile=(None, None))
        }
    }
    with (
        patch(
            "custom_components.helman.node_details.house.resolve_vendor_telemetry",
            return_value=telemetry({"run_mode": RUN_MODE, **{f"eps_power_l{p}": e for p, e in EPS.items()}})
            if tele is None
            else tele,
        ),
        patch("custom_components.helman.node_details.house.async_day_stats", side_effect=fake_day_stats),
        patch(
            "custom_components.helman.node_details.house._hourly_energy",
            side_effect=fake_windows,
        ),
    ):
        payload = asyncio.run(
            async_get_node_detail(
                hass,
                house_config() if cfg is None else cfg,
                node="house",
                device_id=None,
                section=section,
                now=now,
            )
        )
    return payload, calls


def test_the_house_overview_carries_its_mappings_and_reads_no_history():
    payload, calls = house_detail()

    assert calls == {"day_stats": [], "windows": [], "reports": []}
    assert payload["node"] == "house"
    assert payload["sections"] == ["today", "pattern"]
    entities = payload["entities"]
    assert entities["power"] == HOUSE_POWER
    assert entities["solar_ratio"] == "sensor.helman_solar_source_ratio"
    assert entities["grid_ratio"] == "sensor.helman_grid_source_ratio"
    assert entities["time_to_empty"] == "sensor.helman_battery_time_to_empty"
    assert entities["eps_power_l2"] == EPS[2]
    # The measured phase formula's other inputs: present, null when unresolved.
    assert "ac_power_l1" in entities and entities["ac_power_l1"] is None
    assert "grid_power_l3" in entities and entities["grid_power_l3"] is None
    assert entities["phase_power_l1"] == "sensor.helman_house_consumption_power_l1"
    assert entities["phase_power_l3"] == "sensor.helman_house_consumption_power_l3"
    assert entities["phase_power_total"] == "sensor.helman_house_consumption_power"
    assert payload["phasePowerPolarity"] == "positive_is_export"
    assert payload["condition"] is None


def test_a_custom_house_has_no_eps_readings_and_without_meters_no_pattern():
    payload, _ = house_detail(cfg=house_config(profile=False, power=False, energy=False), tele={})

    assert payload["profile"] is None
    assert not any(
        key.startswith(("eps_power", "ac_power", "grid_power")) for key in payload["entities"]
    )
    # Helman's measured sensors always exist; without a profile they are unavailable.
    assert payload["entities"]["phase_power_total"] == "sensor.helman_house_consumption_power"
    assert payload["phasePowerPolarity"] is None
    assert payload["entities"]["power"] is None
    assert payload["sections"] == ["today"]


def test_grid_independence_keeps_the_unknown_share_apart():
    from custom_components.helman.node_details.house import grid_independence

    result = grid_independence(10.0, {"solar": 4.0, "battery": 2.0, "grid": 3.0, "unattributed": 1.0})

    # Unattributed energy is unknown, never counted as self-supplied.
    assert result == {"share": 0.6, "gridShare": 0.3, "unknownShare": 0.1}
    assert grid_independence(0.0, {"grid": 0.0}) is None


def test_solar_self_consumption_divides_by_matched_solar_production():
    from custom_components.helman.node_details.house import solar_self_consumption

    # 10 kWh of matched solar: 3 to the house, 3 into the battery, 4 exported.
    # 2 kWh more in hours without a source mix are not in the denominator, and
    # neither is the house's consumption.
    result = solar_self_consumption(ranking(unattributed=2.0))

    assert result["share"] == pytest.approx(0.6)
    assert result["destinations"]["attributedKwh"] == pytest.approx(10.0)
    assert result["reason"] is None


@pytest.mark.parametrize(
    ("report", "reason"),
    [
        ({**ranking(), "meters": {"solar": False}}, "no_solar_meter"),
        (ranking(attributed=0.0, unattributed=1.5, house=0.0, battery=0.0, export=0.0), "no_matched_solar"),
    ],
)
def test_without_matched_solar_self_consumption_is_unavailable_not_zero(report, reason):
    from custom_components.helman.node_details.house import solar_self_consumption

    result = solar_self_consumption(report)

    assert result["share"] is None
    assert result["reason"] == reason


def ranking_node(node_id, kwh, *, children=(), parent=None, unmeasured=False, label=None, paid=None):
    return {
        "id": node_id,
        "label": label if label is not None else node_id.title(),
        "parent_id": parent,
        "estimated": False,
        "unmeasured": unmeasured,
        "kwh": kwh,
        "coverage": 1.0,
        "children": list(children),
        "sources": {"solar": kwh / 2, "battery": 0.0, "grid": kwh / 2, "unattributed": 0.0},
        "money": {
            "paid": {"amount": paid, "priced_kwh": kwh if paid is not None else 0.0, "unpriced_kwh": 0.0, "tariff_kwh": 0.0},
            "forgone": {"amount": None, "priced_kwh": 0.0, "unpriced_kwh": kwh},
        },
        "overallocated_kwh": 0.0,
    }


#: The house 20 kWh: a 9 kWh kitchen meter holding a 5 kWh oven and its own
#: 4 kWh, a 6 kWh EV, a 1 kWh lamp and 0.5 kWh fridge; 3.5 kWh unmeasured.
HOUSE_NODES = [
    ranking_node("house", 20.0, children=["kitchen", "ev", "lamp", "fridge", "house_unmeasured"]),
    ranking_node("kitchen", 9.0, children=["oven", "kitchen_unmeasured"], parent="house"),
    ranking_node("oven", 5.0, parent="kitchen", paid=10.0),
    ranking_node("kitchen_unmeasured", 4.0, parent="kitchen", unmeasured=True, label=""),
    ranking_node("ev", 6.0, parent="house", paid=12.0),
    ranking_node("lamp", 1.0, parent="house"),
    ranking_node("fridge", 0.5, parent="house"),
    ranking_node("house_unmeasured", 3.5, parent="house", unmeasured=True, label=""),
]


def test_top_consumers_count_every_load_once():
    from custom_components.helman.node_details.house import top_consumers

    result = top_consumers(HOUSE_NODES)

    # The kitchen meter is never a load beside the oven it contains: its own
    # share is its remainder, named after it.
    assert [(item["id"], item["label"], item["ownOf"]) for item in result["top"]] == [
        ("ev", "Ev", None),
        ("oven", "Oven", None),
        ("kitchen_unmeasured", "Kitchen", "kitchen"),
    ]
    assert result["others"] == {"count": 2, "kwh": 1.5}
    assert result["unmeasuredKwh"] == 3.5
    total = sum(item["kwh"] for item in result["top"]) + result["others"]["kwh"] + result["unmeasuredKwh"]
    assert total == pytest.approx(20.0)
    assert result["top"][0]["money"]["paid"] == 12.0
    assert result["top"][2]["money"]["paid"] is None


def test_a_parent_whose_children_left_the_report_is_a_load_itself():
    from custom_components.helman.node_details.house import top_consumers

    # The ranking dropped the kitchen's children: its whole kWh is the load.
    nodes = [node for node in HOUSE_NODES if node["id"] not in ("oven", "kitchen_unmeasured")]

    result = top_consumers(nodes)

    assert ("kitchen", None) in [(item["id"], item["ownOf"]) for item in result["top"]]
    total = sum(item["kwh"] for item in result["top"]) + result["others"]["kwh"] + result["unmeasuredKwh"]
    assert total == pytest.approx(20.0)


def test_the_today_section_reuses_todays_ranking_report():
    house = {**HOUSE_NODES[0], "sources": {"solar": 8.0, "battery": 4.0, "grid": 6.0, "unattributed": 2.0}}
    report = {
        **ranking(),
        "nodes": [house, *HOUSE_NODES[1:]],
        "ambiguous_kwh": 0.2,
        "mismatch_kwh": 0.0,
        "as_of": "2026-10-10T13:55:00+02:00",
    }
    payload, calls = house_detail(section="today", report=report)

    assert calls["day_stats"] == [] and calls["windows"] == []
    (name, query), = calls["reports"]
    assert name == "ranking"
    assert query.start_date == query.end_date == NOW.date()
    assert payload["asOf"] == "2026-10-10T13:55:00+02:00"
    assert payload["house"]["kwh"] == 20.0
    assert payload["independence"] == {"share": 0.6, "gridShare": 0.3, "unknownShare": 0.1}
    assert payload["selfConsumption"]["share"] == pytest.approx(0.6)
    assert payload["consumers"]["top"][0]["id"] == "ev"


def test_the_today_section_says_why_without_reports():
    payload, _ = house_detail(section="today", report={"unavailable": "no_house_meter"})

    assert payload["unavailable"] == "no_house_meter"
    assert payload["house"] is None and payload["consumers"] is None


def hour(day, hour_of_day):
    return datetime.combine(day, datetime.min.time(), tzinfo=PRAGUE).replace(hour=hour_of_day).astimezone(UTC)


def test_same_weekdays_are_compared_over_the_hours_today_knows():
    from custom_components.helman.node_details.house import compare_same_weekdays

    today = NOW.date()
    weeks = [today - timedelta(days=7 * week) for week in range(5)]
    days = [
        # Today knows hours 0..12 except 3: a gap, compared over 12 hours.
        (weeks[0], {hour(weeks[0], h): 0.5 for h in range(13) if h != 3}),
        # A full earlier day, and one with more energy outside today's hours.
        (weeks[1], {hour(weeks[1], h): 0.4 for h in range(24)}),
        (weeks[2], {hour(weeks[2], h): 0.6 if h < 13 else 5.0 for h in range(14)}),
        # Missing hour 5, which today has: a partial day is not compared.
        (weeks[3], {hour(weeks[3], h): 0.1 for h in range(13) if h != 5}),
        # No history at all.
        (weeks[4], {}),
    ]

    result = compare_same_weekdays(days, elapsed_hours=14)

    assert result["elapsedHours"] == 14
    assert result["comparedHours"] == 12
    assert result["todayKwh"] == pytest.approx(6.0)
    assert [day["kwh"] for day in result["days"]] == [pytest.approx(4.8), pytest.approx(7.2), None, None]
    assert [day["knownHours"] for day in result["days"]] == [12, 12, 11, 0]
    assert result["used"] == 2
    assert result["averageKwh"] == pytest.approx(6.0)
    assert result["ratio"] == pytest.approx(1.0)


def test_the_repeated_fall_back_hour_is_left_out_not_summed():
    from custom_components.helman.node_details.house import compare_same_weekdays

    # 2026-10-25 is Prague's fall-back Sunday: 02:00 local occurs twice.
    today = date(2026, 10, 25)
    earlier = today - timedelta(days=7)
    start = datetime(2026, 10, 25, 0, 0, tzinfo=PRAGUE).astimezone(UTC)
    today_hours = {start + timedelta(hours=offset): 1.0 for offset in range(5)}
    days = [(today, today_hours), (earlier, {hour(earlier, h): 1.0 for h in range(4)})]
    assert len({dt_util.as_local(at).hour for at in today_hours}) == 4

    result = compare_same_weekdays(days, elapsed_hours=5)

    # Hours 0, 1 and 3 on both days; neither day's 02:00 is compared.
    assert result["comparedHours"] == 3
    assert result["todayKwh"] == pytest.approx(3.0)
    assert result["averageKwh"] == pytest.approx(3.0)
    assert result["ratio"] == pytest.approx(1.0)


def test_without_an_earlier_day_or_any_usage_nothing_is_divided():
    from custom_components.helman.node_details.house import compare_same_weekdays

    today = NOW.date()
    earlier = today - timedelta(days=7)
    days = [(today, {hour(today, 0): 0.2}), (earlier, {hour(earlier, 0): 0.0})]

    result = compare_same_weekdays(days, elapsed_hours=1)
    assert result["averageKwh"] == 0.0 and result["ratio"] is None

    result = compare_same_weekdays(days[:1], elapsed_hours=1)
    assert result["used"] == 0 and result["averageKwh"] is None and result["ratio"] is None


def test_the_pattern_section_reads_the_same_completed_hours_of_earlier_weekdays():
    now = datetime(2026, 10, 10, 14, 25, tzinfo=PRAGUE)
    payload, calls = house_detail(section="pattern", now=now)

    (entity_id, windows, interval), = calls["windows"]
    assert entity_id == HOUSE_ENERGY and interval == 60
    assert len(windows) == 5
    for weeks, (start, end) in enumerate(windows):
        day = now.date() - timedelta(days=7 * weeks)
        assert (start.date(), start.hour, start.minute) == (day, 0, 0)
        # Completed hours only: 00:00 to 14:00, the hour in progress left out.
        assert (end.date(), end.hour, end.minute) == (day, 14, 0)
    assert payload["comparison"]["elapsedHours"] == 14
    assert payload["comparison"]["unavailable"] is None


@pytest.mark.parametrize(
    ("cfg", "now", "reason"),
    [
        (house_config(energy=False), NOW, "no_energy_meter"),
        (None, datetime(2026, 10, 10, 0, 40, tzinfo=PRAGUE), "no_elapsed_hour"),
    ],
)
def test_a_comparison_without_a_meter_or_a_completed_hour_says_why(cfg, now, reason):
    payload, calls = house_detail(cfg=cfg, section="pattern", now=now)

    assert calls["windows"] == []
    assert payload["comparison"]["unavailable"] == reason
    assert payload["comparison"]["todayKwh"] is None


def test_the_overnight_minimum_is_the_lowest_covered_mean_and_partial_before_five():
    now = datetime(2026, 10, 10, 3, 0, tzinfo=PRAGUE)
    stats = {HOUSE_POWER: {**power_day([(at(0), 420.0), (at(1, 5), 180.0, 0.4), (at(2), 260.0)]), "coverage": 0.35}}
    payload, calls = house_detail(section="pattern", now=now, day_stats_result=stats)

    (ids, start, end), = calls["day_stats"]
    assert ids == [HOUSE_POWER]
    assert (start.hour, end.hour) == (0, 5)
    overnight = payload["overnight"]
    # Before 05:00 the window is not complete; the gaps stay in the coverage.
    assert overnight["complete"] is False
    assert overnight["coverage"] == 0.35
    assert overnight["minimum"] == {"watts": 180.0, "at": at(1, 5), "coverage": 0.4}


def test_an_inverted_house_meter_reads_its_load_positive():
    now = datetime(2026, 10, 10, 6, 0, tzinfo=PRAGUE)
    stats = {HOUSE_POWER: power_day([(at(0), -420.0), (at(1), -180.0)])}
    payload, _ = house_detail(
        cfg=house_config(polarity="negative_is_consumption"), section="pattern", now=now, day_stats_result=stats
    )

    assert payload["overnight"]["complete"] is True
    assert payload["overnight"]["minimum"]["watts"] == 180.0


def test_an_overnight_without_readings_is_no_minimum_not_zero():
    stats = {HOUSE_POWER: {**power_day([]), "coverage": 0.0}}
    payload, _ = house_detail(section="pattern", day_stats_result=stats)

    assert payload["overnight"]["minimum"] is None
    assert payload["overnight"]["coverage"] == 0.0
    assert payload["overnight"]["unavailable"] is None

    payload, _ = house_detail(cfg=house_config(power=False), section="pattern")
    assert payload["overnight"]["unavailable"] == "no_power_sensor"


def test_a_unit_less_house_sensor_reads_as_watts():
    now = datetime(2026, 10, 10, 6, 0, tzinfo=PRAGUE)
    stats = {HOUSE_POWER: {**power_day([(at(0), 420.0), (at(1), 180.0)]), "unit": None}}
    payload, _ = house_detail(section="pattern", now=now, day_stats_result=stats)

    assert payload["overnight"]["unavailable"] is None
    assert payload["overnight"]["minimum"]["watts"] == 180.0


def test_the_learned_profile_is_the_forecasts_base_load_monday_first():
    from custom_components.helman.consumption_forecast_profiles import ZERO_BAND
    from custom_components.helman.consumption_forecast_statistics import ForecastBand

    bands = [ZERO_BAND] * 168
    bands[1 * 24 + 18] = ForecastBand(1.25, 1.0, 1.5)
    profile = NS(history_days=42, non_deferrable=bands)
    coordinator = NS(house_profile=(profile, "2026-10-10T03:00:00+02:00"))
    payload, _ = house_detail(section="pattern", coordinator=coordinator)

    learned = payload["profile"]
    assert learned["historyDays"] == 42
    assert learned["trainedAt"] == "2026-10-10T03:00:00+02:00"
    assert len(learned["kwh"]) == 7 and all(len(row) == 24 for row in learned["kwh"])
    assert learned["kwh"][1][18] == 1.25

    payload, _ = house_detail(section="pattern")
    assert payload["profile"] is None
