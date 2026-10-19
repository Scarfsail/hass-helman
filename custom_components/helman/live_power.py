"""The live power tick: rolling history buffers and every value derived per tick."""

from __future__ import annotations

import logging
from collections import deque
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_interval

from .battery_state import (
    read_battery_entities,
    read_battery_entity_config,
    read_battery_live_state,
)
from .config_path import get as config_value
from .config_read import read_mapping
from .const import (
    BATTERY_TIME_TO_EMPTY_ENTITY_ID,
    BATTERY_TIME_TO_FULL_ENTITY_ID,
    CONSUMPTION_TOTAL_ENTITY_ID,
    HOUSE_CONSUMPTION_ENTITY_ID,
    PRODUCTION_TOTAL_ENTITY_ID,
    SIGNAL_LIVE_TICK,
    entry_signal,
    house_consumption_phase_entity_id,
)
from .controllables.config import (
    is_active_state,
    read_shared_meters,
    running_active_states,
)
from .node_details.inverter import run_mode_condition
from .power_polarity import is_power_inverted, watts_for_value_type
from .power_reading import power_unit_factor
from .shared_meter_split import split_own_power
from .tree_builder import TreeIndex
from .vendors import INVERTER_TELEMETRY_KEY, DeviceTelemetry, resolve_vendor_telemetry
from .visualization import read_visualization

_LOGGER = logging.getLogger(__name__)
# How far back the unmeasured remainder looks when smoothing away meter skew.
# See _smooth_unmeasured for why the raw remainder cannot be published as-is.
_UNMEASURED_SMOOTHING_WINDOW_S = 15.0


class LivePowerTracker:
    """Reads the device tree's power sensors every bucket and derives the rest.

    Keeps the rolling history the card draws its sparklines from, and sends the
    derived sensors' values -- unmeasured remainders, shares, totals, house
    phases, source ratios and battery ETAs -- on ``SIGNAL_LIVE_TICK``.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        entry_id: str,
        *,
        read_config: Callable[[], Mapping[str, Any]],
        read_shared_meter_weights: Callable[[], Mapping[str, float | None]],
    ) -> None:
        self._hass = hass
        self._signal = entry_signal(SIGNAL_LIVE_TICK, entry_id)
        self._read_config = read_config
        self._read_shared_meter_weights = read_shared_meter_weights
        self._unloaded = False
        # The device tree the buffers were built for.
        self._tree: dict | None = None
        self._unsub_tick: Callable[[], None] | None = None
        self._unmeasured_raw_history: dict[str, deque] = {}
        # The inverter's telemetry the measured house phases compute from,
        # resolved per tree rebuild in _init_buffers.
        self._inverter_telemetry: Any = None
        self._vendor_telemetry: dict[str, DeviceTelemetry] = {}
        self._power_sensor_ids: list[str] = []
        self._source_sensor_ids: list[str] = []
        self._source_value_types: dict[str, str] = {}
        # In-memory rolling buffers (oldest first)
        self._power_history: dict[str, deque[float]] = {}
        # Map: source_power_sensor_id → ratio_sensor_entity_id (derived from the tree in
        # _init_buffers, independent of when the sensor platform registers the ratio entities).
        self._source_ratio_entity_ids: dict[str, str] = {}
        # Mapping: parent_node_id → unmeasured_entity_id (e.g. "house" → "sensor.helman_house_unmeasured_power")
        self._unmeasured_entity_id_map: dict[str, str] = {}
        # Mapping: share node id (a meterless child's device id) → its share entity id
        self._share_entity_id_map: dict[str, str] = {}
        # Mapping: meterless child id → (running-signal entity, "switch" | "climate")
        self._share_running_signals: dict[str, tuple[str, str]] = {}
        self._share_tolerances: dict[str, float | None] = {}
        # Entity IDs whose values are computed by the tick (not read from hass.states)
        self._virtual_sensor_ids: set[str] = set()

    @property
    def tree(self) -> dict | None:
        """The device tree the buffers track."""
        return self._tree

    @property
    def vendor_telemetry(self) -> Mapping[str, DeviceTelemetry]:
        return self._vendor_telemetry

    def track(self, tree: dict, index: TreeIndex) -> None:
        """Track the power sensors of ``tree`` and (re)start the tick on them."""
        if self._unloaded:
            return
        self._stop_tick()
        self._init_buffers(tree, index)
        self._start_tick()

    def unload(self) -> None:
        """Stop the tick and drop the buffers."""
        self._unloaded = True
        self._stop_tick()
        self._unmeasured_raw_history = {}
        self._source_ratio_entity_ids = {}
        self._power_history.clear()

    def get_history(self) -> dict:
        """Return a pure dict copy of the in-memory rolling buffer. Zero computation."""
        return {
            "entity_history": {eid: list(dq) for eid, dq in self._power_history.items()},
        }

    def refresh_inverter_telemetry(self) -> None:
        self._vendor_telemetry = resolve_vendor_telemetry(self._hass, self._read_config())
        self._inverter_telemetry = self._vendor_telemetry.get(INVERTER_TELEMETRY_KEY)

    def _visualization_config(self) -> dict[str, Any]:
        return read_visualization(self._read_config())

    def _init_buffers(self, tree: dict, index: TreeIndex) -> None:
        """Initialize rolling deques, retaining history for surviving sensors."""
        history_buckets: int = self._visualization_config()["history_buckets"]
        previous_history = self._power_history
        previous_unmeasured = self._unmeasured_raw_history
        previous_unmeasured_ids = self._unmeasured_entity_id_map

        self._power_sensor_ids = list(index.power_sensor_ids)
        self._source_sensor_ids = list(index.source_sensor_ids)
        self._source_value_types = dict(index.source_value_types)
        self._virtual_sensor_ids = set(index.virtual_sensor_ids)
        self._virtual_sensor_ids.add(CONSUMPTION_TOTAL_ENTITY_ID)
        self._virtual_sensor_ids.add(PRODUCTION_TOTAL_ENTITY_ID)

        self._unmeasured_entity_id_map = dict(index.unmeasured_entity_id_map)
        self._share_entity_id_map = {
            node_id: entity_id
            for node_id, (entity_id, _name) in index.share_devices.items()
        }
        # The very members the shared-meter history split reads, with the same
        # running signal each, so the live split cannot pick other devices.
        shared_meters = read_shared_meters(self._read_config()).values()
        self._share_running_signals = {
            member_id: (entity_id, activity)
            for shared in shared_meters
            for member_id, entity_id, activity in shared["members"]
        }
        # Every member of one meter carries its parent's tolerance, so a share
        # node's parent is found without walking the config again.
        self._share_tolerances = {
            member_id: shared["tolerance"]
            for shared in shared_meters
            for member_id, _entity_id, _activity in shared["members"]
        }
        # Keep smoothing windows only for unmeasured entity ids that survive.
        self._unmeasured_raw_history = {
            node_id: history
            for node_id, history in previous_unmeasured.items()
            if node_id in previous_unmeasured_ids
            and previous_unmeasured_ids.get(node_id)
            == self._unmeasured_entity_id_map.get(node_id)
        }
        self.refresh_inverter_telemetry()

        # Create deques for all power sensors (real + virtual unmeasured) plus virtual totals
        self._power_history = {
            eid: previous_history.get(eid, deque(maxlen=history_buckets))
            for eid in self._power_sensor_ids
        }
        self._power_history[CONSUMPTION_TOTAL_ENTITY_ID] = previous_history.get(
            CONSUMPTION_TOTAL_ENTITY_ID, deque(maxlen=history_buckets)
        )
        self._power_history[PRODUCTION_TOTAL_ENTITY_ID] = previous_history.get(
            PRODUCTION_TOTAL_ENTITY_ID, deque(maxlen=history_buckets)
        )
        # Add deques for source ratio sensors so their history is included in get_history().
        # Derived from the tree, which async_setup has built before the sensor platform adds
        # the ratio entities. Without this the ratio history is absent from get_history() and
        # the card paints every past consumer bucket with its fallback colour instead of the
        # source colours.
        # Mark them virtual: their values are computed by _tick Step 3, so the Step 1 real-sensor
        # read loop must not also append them (that would double-append per tick and desync them).
        self._source_ratio_entity_ids = dict(index.source_ratio_entity_ids)
        for ratio_entity_id in self._source_ratio_entity_ids.values():
            self._power_history[ratio_entity_id] = previous_history.get(
                ratio_entity_id, deque(maxlen=history_buckets)
            )
            self._virtual_sensor_ids.add(ratio_entity_id)
        self._tree = tree

    def _start_tick(self) -> None:
        """Start the periodic tick using HA's time-interval tracker."""
        if self._unloaded or self._unsub_tick is not None:
            return
        bucket_duration: int = self._visualization_config()["history_bucket_duration"]
        self._unsub_tick = async_track_time_interval(
            self._hass,
            self._tick,
            timedelta(seconds=bucket_duration),
        )

    def _stop_tick(self) -> None:
        """Stop the periodic tick."""
        if self._unsub_tick is not None:
            self._unsub_tick()
            self._unsub_tick = None

    @callback
    def _tick(self, now: datetime) -> None:
        """Periodic snapshot: read sensors, compute ratios, send derived sensor values."""
        # The derived sensors' values, keyed by each one's default entity id.
        values: dict[str, Any] = {}

        # Step 1: Read all real (non-virtual) power sensors from hass.states
        for entity_id, dq in self._power_history.items():
            if entity_id not in self._virtual_sensor_ids:
                dq.append(self._read_power(entity_id, "default"))

        # Step 2: Compute virtual sensor values and record into _power_history
        # Unmeasured powers (one per qualifying parent node) and shares (one per
        # meterless child). ``None`` is unavailable: the sensor says so, and the
        # history bucket — which only holds numbers — records 0 W, as the card
        # shows an unavailable sensor.
        unmeasured_map, share_map = self._compute_derived_powers()
        for watts_by_node, entity_ids in (
            (unmeasured_map, self._unmeasured_entity_id_map),
            (share_map, self._share_entity_id_map),
        ):
            for node_id, watts in watts_by_node.items():
                entity_id = entity_ids.get(node_id)
                if not entity_id:
                    continue
                if entity_id in self._power_history:
                    self._power_history[entity_id].append(watts if watts is not None else 0.0)
                values[entity_id] = watts

        # Total power (consumption side)
        total = self._compute_consumption_total()
        if CONSUMPTION_TOTAL_ENTITY_ID in self._power_history:
            self._power_history[CONSUMPTION_TOTAL_ENTITY_ID].append(total)
        values[CONSUMPTION_TOTAL_ENTITY_ID] = total

        # Measured house consumption, per phase and their sum
        phase_powers = self._compute_house_phase_powers()
        values[HOUSE_CONSUMPTION_ENTITY_ID] = (
            None
            if any(watts is None for watts in phase_powers.values())
            else sum(phase_powers.values())
        )
        for phase, watts in phase_powers.items():
            values[house_consumption_phase_entity_id(phase)] = watts

        # Production total (source side)
        production = self._compute_production_total()
        if PRODUCTION_TOTAL_ENTITY_ID in self._power_history:
            self._power_history[PRODUCTION_TOTAL_ENTITY_ID].append(production)
        values[PRODUCTION_TOTAL_ENTITY_ID] = production

        # Step 3: Compute global source ratios, record their history, and send ratio values.
        # Driven by the tree-derived ratio entity IDs so ratio history is recorded from the
        # first tick, even before the sensor platform has added the ratio sensor entities.
        if self._source_ratio_entity_ids:
            normalized = {
                src: max(0.0, watts_for_value_type(
                    self._power_history[src][-1] if self._power_history.get(src) else 0.0,
                    self._source_value_types.get(src, "default"),
                ))
                for src in self._source_sensor_ids
                if src in self._power_history
            }
            total_source = sum(normalized.values())
            for src_eid, ratio_entity_id in self._source_ratio_entity_ids.items():
                ratio_pct = (normalized.get(src_eid, 0.0) / total_source * 100.0) if total_source > 0 else 0.0
                if ratio_entity_id in self._power_history:
                    self._power_history[ratio_entity_id].append(ratio_pct)
                values[ratio_entity_id] = ratio_pct

        # Step 4: Battery ETAs (separate sensors for charging and discharging)
        # A failure here leaves the ETA keys out of the map; the other live
        # values are still sent.
        try:
            config = self._read_config()
            battery_cfg = read_mapping(config_value(config, "energy_nodes.battery"))
            sensor_id = read_battery_entities(config).get("power")
            hist = list(self._power_history.get(sensor_id, [])) if sensor_id else []

            # The one power reading not routed through ``value_type``: this
            # works off the raw history buffer, so it has to apply the
            # configured polarity itself. Getting it wrong is silent -- the two
            # ETAs simply report each other's value.
            if is_power_inverted(battery_cfg, "battery"):
                hist = [-v for v in hist]

            pos_values = [v for v in hist if v > 1]
            neg_values = [abs(v) for v in hist if v < -1]
            charging_avg = sum(pos_values) / len(pos_values) if pos_values else 0.0
            discharging_avg = sum(neg_values) / len(neg_values) if neg_values else 0.0

            values[BATTERY_TIME_TO_FULL_ENTITY_ID] = (
                self._compute_charging_eta(charging_avg) if charging_avg > 0
                else (None, "", None)
            )
            values[BATTERY_TIME_TO_EMPTY_ENTITY_ID] = (
                self._compute_discharging_eta(discharging_avg) if discharging_avg > 0
                else (None, "", None)
            )
        except Exception:
            _LOGGER.exception("Error computing battery ETAs")

        async_dispatcher_send(self._hass, self._signal, values)

    def _read_power(self, entity_id: str | None, value_type: str) -> float:
        """Read a power sensor's current value from hass.states; 0 W when it has none."""
        watts = self._read_power_or_none(entity_id, value_type)
        return watts if watts is not None else 0.0

    def _read_power_or_none(self, entity_id: str | None, value_type: str) -> float | None:
        """Read a power sensor's current value; ``None`` when missing or unavailable."""
        if not entity_id:
            return None
        state = self._hass.states.get(entity_id)
        if state is None or state.state in ("unavailable", "unknown", "none"):
            return None
        try:
            raw = float(state.state)
        except ValueError:
            return None
        factor = power_unit_factor(getattr(state, "attributes", {}).get("unit_of_measurement"))
        return None if factor is None else watts_for_value_type(raw * factor, value_type)

    def _read_battery_state(self):
        entity_config = read_battery_entity_config(self._read_config())
        if entity_config is None:
            return None
        return read_battery_live_state(self._hass, entity_config)

    def _compute_charging_eta(
        self, charging_avg_w: float
    ) -> tuple[float | None, str, int | None]:
        """Compute time to reach max_soc at the given average charging rate."""
        state = self._read_battery_state()
        if state is None:
            return None, "", None
        to_full_kwh = state.max_energy_kwh - state.current_remaining_energy_kwh
        if to_full_kwh <= 0:
            return None, "", None
        hours = (to_full_kwh * 1000) / charging_avg_w
        minutes = hours * 60
        target = datetime.now(tz=timezone.utc) + timedelta(hours=hours)
        return minutes, target.isoformat(), round(state.max_soc)

    def _compute_discharging_eta(
        self, discharging_avg_w: float
    ) -> tuple[float | None, str, int | None]:
        """Compute time to reach min_soc at the given average discharging rate."""
        state = self._read_battery_state()
        if state is None:
            return None, "", None
        usable_kwh = state.current_remaining_energy_kwh - state.min_energy_kwh
        if usable_kwh <= 0:
            return None, "", None
        hours = (usable_kwh * 1000) / discharging_avg_w
        minutes = hours * 60
        target = datetime.now(tz=timezone.utc) + timedelta(hours=hours)
        return minutes, target.isoformat(), round(state.min_soc)

    def _compute_consumption_total(self) -> float:
        """Sum consumer-side top-level node powers (house + battery charging + grid export)."""
        total = 0.0
        for node in self._tree.get("consumers", []):
            if node.get("isVirtual"):
                continue
            total += self._read_power(
                node.get("powerSensorId"), node.get("valueType", "default")
            )
        return total

    def _compute_house_phase_powers(self) -> dict[int, float | None]:
        """Measured house load per phase, ``{1: W, 2: W, 3: W}``; ``None`` unavailable.

        On-grid the house draws what the inverter outputs plus what the meter
        imports, plus the EPS output: ``ac − grid (export-positive) + eps``. A
        missing EPS reading counts as 0 W; a missing inverter or meter reading
        leaves the phase unknown. Off-grid the grid port is open and the EPS
        output is the whole house, so the inverter's AC reading is not counted
        twice. The inverter and the meter are polled at different moments, so a
        fast change in export can briefly read below zero; a house never
        exports, so a phase is floored at 0 W. Every phase is ``None`` without
        an inverter profile.
        """
        telemetry = self._inverter_telemetry
        if telemetry is None:
            return {phase: None for phase in (1, 2, 3)}
        entities = telemetry.entities
        condition = run_mode_condition(self._hass, telemetry)
        off_grid = condition is not None and condition["kind"] == "off_grid"
        export_sign = (
            1.0 if telemetry.profile.grid_phase_power_polarity == "positive_is_export" else -1.0
        )
        powers: dict[int, float | None] = {}
        for phase in (1, 2, 3):
            eps = self._read_power_or_none(entities.get(f"eps_power_l{phase}"), "default")
            if off_grid:
                powers[phase] = eps
                continue
            ac = self._read_power_or_none(entities.get(f"ac_power_l{phase}"), "default")
            grid = self._read_power_or_none(entities.get(f"grid_power_l{phase}"), "default")
            powers[phase] = (
                None
                if ac is None or grid is None
                else max(0.0, ac - grid * export_sign + (eps or 0.0))
            )
        return powers

    def _compute_production_total(self) -> float:
        """Sum source-side top-level node powers (solar + battery_discharging + grid_import)."""
        total = 0.0
        for node in self._tree.get("sources", []):
            if node.get("isVirtual"):
                continue
            raw = self._read_power(node.get("powerSensorId"), "default")
            total += max(0.0, watts_for_value_type(raw, node.get("valueType", "default")))
        return total

    def _compute_derived_powers(
        self,
    ) -> tuple[dict[str, float | None], dict[str, float | None]]:
        """``({parent node id: remainder W}, {share node id: share W})`` for this tick.

        Both come from each parent's own power, one way: the remainder is own
        power minus the shares, so the two always add up to it. ``None`` is
        unavailable.
        """
        unmeasured: dict[str, float | None] = {}
        shares: dict[str, float | None] = {}
        self._traverse_for_unmeasured(
            self._tree.get("consumers", []), unmeasured, shares
        )
        return unmeasured, shares

    def _traverse_for_unmeasured(self, nodes: list, unmeasured: dict, shares: dict) -> None:
        for node in nodes:
            children = node.get("children", [])
            if children and not node.get("isVirtual"):
                has_unmeasured = any(c.get("isUnmeasured") for c in children)
                share_nodes = [c for c in children if c.get("isEstimated")]
                # Shares without a remainder: a parent with no power sensor. Its
                # own power cannot be read, so its shares publish unavailable.
                if has_unmeasured or share_nodes:
                    own = self._own_power(node, children, strict=bool(share_nodes))
                    node_shares = self._split_own_power(own, share_nodes)
                    shares.update(node_shares)
                    if has_unmeasured:
                        unmeasured[node["id"]] = (
                            None
                            if own is None
                            else max(0.0, own - sum(node_shares.values()))
                        )
            self._traverse_for_unmeasured(children, unmeasured, shares)

    def _own_power(self, node: dict, children: list, *, strict: bool) -> float | None:
        """A node's reading minus its metered children's, smoothed and floored at zero.

        Only metered children are subtracted: the remainder and the estimated
        share nodes are derived from this value, so subtracting them would feed
        it back into itself.

        ``strict`` for a parent its meterless children split: every input must
        read, else own power is ``None`` — never a figure computed with the
        missing input as 0 W. Otherwise (the house, a breaker with only
        sub-meters) an unreadable input counts 0 W and a child without a power
        sensor is skipped, as the remainder always did.
        """
        metered = [
            c
            for c in children
            if not c.get("isVirtual")
            and not c.get("isUnmeasured")
            and not c.get("isEstimated")
        ]
        if strict:
            readings = [
                self._read_power_or_none(n.get("powerSensorId"), n.get("valueType", "default"))
                for n in (node, *metered)
            ]
            if any(reading is None for reading in readings):
                return None
            raw = readings[0] - sum(readings[1:])
        else:
            raw = self._read_power(
                node.get("powerSensorId"), node.get("valueType", "default")
            ) - sum(
                self._read_power(c.get("powerSensorId"), c.get("valueType", "default"))
                for c in metered
                if c.get("powerSensorId")
            )
        return self._smooth_unmeasured(node["id"], raw)

    def _split_own_power(
        self, own: float | None, share_nodes: list
    ) -> dict[str, float | None]:
        """Own power split among the running meterless children; 0 W for the rest.

        In the ratio of their learned power and in the parent's tolerance mode,
        by the very function the training estimate splits history with -- see
        :func:`.shared_meter_split.split_own_power`. What a capped split does
        not hand out stays in the parent's remainder.
        """
        if own is None:
            return {n["id"]: None for n in share_nodes}
        running = [n["id"] for n in share_nodes if self._is_share_running(n["id"])]
        shares = (
            split_own_power(
                own,
                running,
                self._read_shared_meter_weights(),
                tolerance=self._share_tolerances.get(running[0]),
            )
            if running
            else {}
        )
        return {n["id"]: shares.get(n["id"], 0.0) for n in share_nodes}

    def _is_share_running(self, device_id: str) -> bool:
        """Whether a meterless child runs now, by the predicate its history split uses."""
        signal = self._share_running_signals.get(device_id)
        if signal is None:
            return False
        entity_id, activity = signal
        state = self._hass.states.get(entity_id)
        return is_active_state(
            getattr(state, "state", None), running_active_states(activity)
        )

    def _smooth_unmeasured(self, node_id: str, raw_watts: float) -> float:
        """Median of the last few raw own-power readings, floored at zero.

        Own power is a difference between readings taken at different
        moments: the house meter reports several times a second, each circuit
        meter only every 7-18 s. Its jitter is therefore of the same order as
        the remainder itself once the circuits cover most of the house, and
        flooring the raw difference pinned the published value to a hard 0 for
        a large share of the time — the card then dropped the row entirely.
        Taking the median first lets the symmetric skew cancel out; a house
        whose circuits genuinely account for everything still settles on 0.
        """
        bucket_duration = self._visualization_config()["history_bucket_duration"] or 1
        maxlen = max(1, round(_UNMEASURED_SMOOTHING_WINDOW_S / bucket_duration))
        window = self._unmeasured_raw_history.get(node_id)
        if window is None or window.maxlen != maxlen:
            window = deque(window or (), maxlen=maxlen)
            self._unmeasured_raw_history[node_id] = window
        window.append(raw_watts)
        return max(0.0, median(window))
