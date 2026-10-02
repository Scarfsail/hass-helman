"""The device dataset every report is built on, from one span read and the device tree.

Pure: no Home Assistant imports. The coordinator does the reading
(:func:`~..span_history.read_span_history`) and hands the result over with the
device tree, the local time zone and the moment of the read; everything a
report needs is derived here, so a report never touches the recorder, a price
or a period itself.

Three things are derived, each documented where it is built and in
``docs/device-reports.md``:

* **Nodes.** The ``house`` subtree as the power card shows it, every node with
  its hourly kWh and hourly coverage, and a synthesised ``unmeasured`` child
  under every metered parent.
* **The hourly source mix.** The house's own solar/battery/grid split per hour,
  fixed by the measured grid meters, with the two splits hourly totals cannot
  settle decided by a stated rule and reported as ``ambiguous_kwh``.
* **Money.** ``paid`` and ``forgone`` per kWh of any node, under one accounting
  rule: priced plus unpriced kWh is the node's kWh, on each side.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, tzinfo
import math
from typing import Any

from ..span_history_model import RATE_RECORDED, RATE_TARIFF, SpanHistory, period_hours

HOUSE_NODE_ID = "house"

_HOUR = timedelta(hours=1)
#: Below this an amount of energy is nothing: what a float sum leaves behind.
_EPSILON_KWH = 1e-9


def find_house_node(tree: Any) -> dict[str, Any] | None:
    """The ``house`` consumer node of a device tree, or ``None``.

    The tree builds it only with a house power sensor configured, which is why
    a report without it is ``unavailable`` rather than empty.
    """
    if not isinstance(tree, Mapping):
        return None
    for node in tree.get("consumers") or []:
        if isinstance(node, Mapping) and node.get("id") == HOUSE_NODE_ID:
            return dict(node)
    return None


def dataset_statistic_ids(tree: Any) -> list[str]:
    """Every statistic id the house subtree reads, beyond the six meters.

    A metered node's meter and a meterless child's share sensor. External
    statistic ids (``source:stat``) are kept: long-term statistics hold them,
    which is all a span read asks of an id.
    """
    house = find_house_node(tree)
    ids: list[str] = []

    def _walk(node: Mapping[str, Any]) -> None:
        for child in node.get("children") or []:
            if not isinstance(child, Mapping) or child.get("isUnmeasured"):
                continue
            statistic_id = _statistic_id(child)
            if statistic_id is None:
                continue
            ids.append(statistic_id)
            _walk(child)

    if house is not None:
        _walk(house)
    return list(dict.fromkeys(ids))


def _statistic_id(node: Mapping[str, Any]) -> str | None:
    """What a tree node is read from: its meter, or for an estimate its share sensor."""
    key = "powerSensorId" if node.get("isEstimated") else "energyEntityId"
    value = node.get(key)
    return value if isinstance(value, str) and value else None


@dataclass
class DatasetNode:
    """One row of the house subtree: what it is, and its energy hour by hour."""

    id: str
    parent_id: str | None
    depth: int
    label: str
    icon: str | None
    #: A meterless child's share of its parent's own energy, not a reading.
    estimated: bool
    #: The synthesised remainder: the parent's meter minus its children.
    unmeasured: bool
    children: list[str]
    #: ``{utc_hour: kWh}``. A node's figure includes its children's.
    kwh: dict[datetime, float]
    #: ``{utc_hour: covered fraction}``: 1 for an hour its source has a value
    #: for, the elapsed fraction for the hour in progress.
    coverage: dict[datetime, float]
    #: ``{utc_hour: max(0, Σ children − node)}`` over the hours this node's own
    #: meter measured: what the children measure beyond it, which the
    #: remainder's floor would otherwise hide. Only hours with an excess.
    overallocated: dict[datetime, float] = field(default_factory=dict)

    @property
    def total_kwh(self) -> float:
        return sum(self.kwh.values())

    @property
    def overallocated_kwh(self) -> float:
        return sum(self.overallocated.values())

    @property
    def first_hour(self) -> datetime | None:
        covered = [hour for hour, share in self.coverage.items() if share > 0]
        return min(covered) if covered else None


@dataclass(frozen=True)
class HourMix:
    """The house's source fractions for one hour, and what they could not settle.

    ``solar + battery + grid + unattributed == 1``.
    """

    solar: float
    battery: float
    grid: float
    #: The part of the house meter no measured source explains.
    unattributed: float
    #: Energy whose source changed only because of the solar-first rule.
    ambiguous_kwh: float
    #: Measured flows to the house beyond the house meter.
    mismatch_kwh: float


#: What an hour without a mix -- no meter read for it at all -- splits into.
_UNATTRIBUTED_HOUR = HourMix(
    solar=0.0, battery=0.0, grid=0.0, unattributed=1.0, ambiguous_kwh=0.0, mismatch_kwh=0.0
)


@dataclass(frozen=True)
class ChargeOrigin:
    """What charged the battery over the period, per kWh charged.

    The fractions sum to 1: ``grid_recorded + grid_tariff + grid_unpriced`` is
    the grid share ``g``, ``solar_priced + solar_unpriced`` the solar share
    ``s``, and ``unknown`` the charge no measured source explains.
    """

    charged_kwh: float = 0.0
    grid_recorded: float = 0.0
    grid_tariff: float = 0.0
    grid_unpriced: float = 0.0
    solar_priced: float = 0.0
    solar_unpriced: float = 0.0
    unknown: float = 1.0
    #: Energy-weighted import rate over the rated grid charge, or None.
    paid_rate: float | None = None
    #: Energy-weighted export rate over the rated solar charge, or None.
    forgone_rate: float | None = None

    @property
    def grid(self) -> float:
        return self.grid_recorded + self.grid_tariff + self.grid_unpriced

    @property
    def solar(self) -> float:
        return self.solar_priced + self.solar_unpriced


@dataclass(frozen=True)
class DeviceDataset:
    """Everything a report reads, and nothing it would have to read itself."""

    local_start: datetime
    local_end: datetime
    local_tz: tzinfo
    now: datetime
    #: Every hour of the period, as UTC instants, in order.
    hours: list[datetime]
    #: The period's hours up to now, the hour in progress by its elapsed part.
    elapsed_hours: float
    #: The house subtree, pre-order; ``nodes[0]`` is the house.
    nodes: list[DatasetNode]
    mix: dict[datetime, HourMix]
    charge_origin: ChargeOrigin
    import_rate: dict[datetime, float]
    import_rate_source: dict[datetime, str]
    export_rate: dict[datetime, float]
    #: ``{grid, solar, battery, house}``: which meters are configured.
    meters: dict[str, bool]
    #: Whether the recorder had compiled the house meter to the period's end.
    complete: bool

    @property
    def house(self) -> DatasetNode:
        return self.nodes[0]

    @property
    def ambiguous_kwh(self) -> float:
        return sum(mix.ambiguous_kwh for mix in self.mix.values())

    @property
    def mismatch_kwh(self) -> float:
        return sum(mix.mismatch_kwh for mix in self.mix.values())


def build_device_dataset(
    tree: Any,
    history: SpanHistory,
    *,
    local_tz: tzinfo,
    now: datetime,
) -> DeviceDataset:
    """The dataset for one period. ``tree`` must have a house node."""
    house = find_house_node(tree)
    if house is None:
        raise ValueError("The device tree has no house node")

    meters = history.meters
    hours = period_hours(history.local_start, history.local_end)
    elapsed = {hour: _elapsed_fraction(hour, now) for hour in hours}

    nodes: list[DatasetNode] = []
    house_kwh = dict(history.energy_for(meters.house))
    _add_node(
        nodes,
        house,
        parent_id=None,
        depth=0,
        kwh=house_kwh,
        coverage=_meter_coverage(house_kwh, elapsed),
        estimated=False,
        history=history,
        elapsed=elapsed,
        now=now,
    )

    mix, flows = _hourly_mix(history, hours)
    configured = {
        "grid": bool(meters.grid_import and meters.grid_export),
        "solar": bool(meters.solar),
        "battery": bool(meters.battery_charge and meters.battery_discharge),
        "house": bool(meters.house),
    }
    compiled = history.compiled_until.get(meters.house) if meters.house else None
    return DeviceDataset(
        local_start=history.local_start,
        local_end=history.local_end,
        local_tz=local_tz,
        now=now,
        hours=hours,
        elapsed_hours=sum(elapsed.values()),
        nodes=nodes,
        mix=mix,
        charge_origin=_charge_origin(flows, history),
        import_rate=history.import_rate,
        import_rate_source=history.import_rate_source,
        export_rate=history.export_rate,
        meters=configured,
        complete=compiled is not None
        and compiled >= history.local_end.astimezone(timezone.utc),
    )


# --- Nodes --------------------------------------------------------------------


def _add_node(
    nodes: list[DatasetNode],
    tree_node: Mapping[str, Any],
    *,
    parent_id: str | None,
    depth: int,
    kwh: dict[datetime, float],
    coverage: dict[datetime, float],
    estimated: bool,
    history: SpanHistory,
    elapsed: dict[datetime, float],
    now: datetime,
) -> DatasetNode:
    """Append ``tree_node`` and its subtree, pre-order, remainder last."""
    node = DatasetNode(
        id=str(tree_node.get("id")),
        parent_id=parent_id,
        depth=depth,
        label=str(tree_node.get("displayName") or ""),
        icon=tree_node.get("icon"),
        estimated=estimated,
        unmeasured=False,
        children=[],
        kwh=kwh,
        coverage=coverage,
    )
    nodes.append(node)

    children: list[DatasetNode] = []
    for child in tree_node.get("children") or []:
        # The tree's own remainders are skipped: it adds them only under a
        # parent with a power sensor, which an energy report cannot rely on.
        if not isinstance(child, Mapping) or child.get("isUnmeasured"):
            continue
        statistic_id = _statistic_id(child)
        if statistic_id is None:
            continue
        if child.get("isEstimated"):
            child_kwh, child_coverage = _estimated_energy(
                history.rows_for(statistic_id), elapsed, now
            )
        else:
            child_kwh = dict(history.energy_for(statistic_id))
            child_coverage = _meter_coverage(child_kwh, elapsed)
        children.append(
            _add_node(
                nodes,
                child,
                parent_id=node.id,
                depth=depth + 1,
                kwh=child_kwh,
                coverage=child_coverage,
                estimated=bool(child.get("isEstimated")),
                history=history,
                elapsed=elapsed,
                now=now,
            )
        )
    node.children = [child.id for child in children]

    if children:
        remainder, node.overallocated = _remainder(node, children)
        unmeasured = DatasetNode(
            # The tree's own convention for a remainder's id.
            id=f"{node.id.replace('.', '_')}_unmeasured",
            parent_id=node.id,
            depth=depth + 1,
            label="",
            icon=None,
            estimated=False,
            unmeasured=True,
            children=[],
            kwh=remainder,
            # Covered wherever its parent is: it is the parent's figure.
            coverage=dict(node.coverage),
        )
        nodes.append(unmeasured)
        node.children.append(unmeasured.id)
    return node


def _remainder(
    node: DatasetNode, children: list[DatasetNode]
) -> tuple[dict[datetime, float], dict[datetime, float]]:
    """The parent's meter minus its children, floored at 0, and what the floor hid.

    The live remainder sensors' definition, per hour. Only hours the parent's
    meter measured are compared: a child's energy in an hour the parent has no
    reading for (before its meter existed, or a gap) is not the children
    measuring more than the parent, so it is not over-allocation. Children keep
    their measured values, so ``Σ children + unmeasured − overallocated = node``
    holds exactly over the hours the parent measured.
    """
    remainder: dict[datetime, float] = {}
    overallocated: dict[datetime, float] = {}
    for hour, own in node.kwh.items():
        measured = sum(child.kwh.get(hour, 0.0) for child in children)
        remainder[hour] = max(0.0, own - measured)
        if measured > own:
            overallocated[hour] = measured - own
    return remainder, overallocated


def _elapsed_fraction(hour: datetime, now: datetime) -> float:
    """How much of ``hour`` has happened by ``now``: 1, a part, or 0."""
    seconds = (now - hour).total_seconds()
    return min(1.0, max(0.0, seconds / _HOUR.total_seconds()))


def _meter_coverage(
    kwh: dict[datetime, float], elapsed: dict[datetime, float]
) -> dict[datetime, float]:
    """A meter covers each hour it has a statistics value for."""
    return {hour: elapsed.get(hour, 0.0) for hour in kwh}


def _estimated_energy(
    rows: dict[datetime, dict[str, Any]],
    elapsed: dict[datetime, float],
    now: datetime,
) -> tuple[dict[datetime, float], dict[datetime, float]]:
    """A share sensor's hourly ``mean`` W, read as Wh.

    The hour in progress counts only its elapsed part: the tail folds the
    five-minute means of the minutes so far into a plain average, so taking it
    for a whole hour would overstate the hour.
    """
    kwh: dict[datetime, float] = {}
    coverage: dict[datetime, float] = {}
    for hour, row in rows.items():
        mean = row.get("mean") if isinstance(row, Mapping) else None
        if not isinstance(mean, (int, float)) or not math.isfinite(mean):
            continue
        share = elapsed.get(hour, 0.0)
        kwh[hour] = max(0.0, float(mean)) / 1000.0 * share
        coverage[hour] = share
    return kwh, coverage


# --- The hourly source mix ------------------------------------------------------


@dataclass(frozen=True)
class _HourFlows:
    charged: float
    grid_to_battery: float
    solar_to_battery: float


def _hourly_mix(
    history: SpanHistory, hours: list[datetime]
) -> tuple[dict[datetime, HourMix], dict[datetime, _HourFlows]]:
    """The house's source fractions per hour, constrained by the measured meters.

    The power cards' live house-first formula is not used: on hourly totals it
    erases real grid use (an hour of H = 1, I = 0.5, S = 1, E = 0.5 would read
    as all solar). Measured import and export fix the grid side, and only the
    two splits hourly totals cannot tell apart are settled by a rule, solar
    first: whether charge came from solar or the grid, and whether export came
    from solar or the battery.
    """
    meters = history.meters
    series = {
        "I": history.energy_for(meters.grid_import),
        "E": history.energy_for(meters.grid_export),
        "S": history.energy_for(meters.solar),
        "C": history.energy_for(meters.battery_charge),
        "D": history.energy_for(meters.battery_discharge),
        "H": history.energy_for(meters.house),
    }
    measured_hours = set().union(*series.values())
    # A configured source meter with no row for an hour (before it existed, or
    # a recorder gap) is not a measured zero: solving the flows with it read as
    # one would hand its share to whichever source did report. Such an hour is
    # left unattributed and its charge unexplained. Without an import meter at
    # all, nothing says how much of the house the grid carried, so no hour is
    # attributable.
    source_series = [
        series[key]
        for key, meter in (
            ("I", meters.grid_import),
            ("E", meters.grid_export),
            ("S", meters.solar),
            ("C", meters.battery_charge),
            ("D", meters.battery_discharge),
        )
        if meter
    ]

    mix: dict[datetime, HourMix] = {}
    flows: dict[datetime, _HourFlows] = {}
    for hour in hours:
        if hour not in measured_hours:
            continue
        I, E, S, C, D, H = (max(0.0, series[key].get(hour, 0.0)) for key in "IESCDH")
        attributable = bool(meters.grid_import) and all(hour in samples for samples in source_series)
        if not attributable:
            flows[hour] = _HourFlows(charged=C, grid_to_battery=0.0, solar_to_battery=0.0)
            mix[hour] = _UNATTRIBUTED_HOUR
            continue

        solar_to_grid = min(S, E)
        battery_to_grid = min(D, E - solar_to_grid)
        solar_to_battery = min(S - solar_to_grid, C)
        grid_to_battery = min(I, C - solar_to_battery)
        grid_to_house = I - grid_to_battery
        battery_to_house = D - battery_to_grid
        solar_to_house = min(
            max(H - grid_to_house - battery_to_house, 0.0),
            S - solar_to_grid - solar_to_battery,
        )

        supplied = grid_to_house + battery_to_house + solar_to_house
        demand = max(H, supplied)
        ambiguous = min(C, I, S - solar_to_grid) + min(E, D, S)
        mismatch = max(0.0, supplied - H)
        flows[hour] = _HourFlows(
            charged=C,
            grid_to_battery=grid_to_battery,
            solar_to_battery=solar_to_battery,
        )
        if demand <= _EPSILON_KWH:
            mix[hour] = HourMix(
                solar=0.0,
                battery=0.0,
                grid=0.0,
                unattributed=1.0,
                ambiguous_kwh=ambiguous,
                mismatch_kwh=mismatch,
            )
            continue
        mix[hour] = HourMix(
            solar=solar_to_house / demand,
            battery=battery_to_house / demand,
            grid=grid_to_house / demand,
            unattributed=(demand - supplied) / demand,
            ambiguous_kwh=ambiguous,
            mismatch_kwh=mismatch,
        )
    return mix, flows


def _charge_origin(flows: dict[datetime, _HourFlows], history: SpanHistory) -> ChargeOrigin:
    """What charged the battery over the whole period, energy-weighted.

    One split for every discharged kWh of the period: a per-hour ledger would
    need the battery's stored energy traced through all of history before it.
    The rates are weighted by the energy charged at them, never plain averages
    of hourly rates.
    """
    charged = sum(flow.charged for flow in flows.values())
    if charged <= _EPSILON_KWH:
        return ChargeOrigin(charged_kwh=charged)

    grid = {RATE_RECORDED: 0.0, RATE_TARIFF: 0.0, None: 0.0}
    solar_priced = solar_unpriced = 0.0
    paid_money = forgone_money = 0.0
    for hour, flow in flows.items():
        import_rate = history.import_rate.get(hour)
        grid[history.import_rate_source.get(hour) if import_rate is not None else None] += (
            flow.grid_to_battery
        )
        if import_rate is not None:
            paid_money += flow.grid_to_battery * import_rate
        export_rate = history.export_rate.get(hour)
        if export_rate is not None:
            solar_priced += flow.solar_to_battery
            forgone_money += flow.solar_to_battery * export_rate
        else:
            solar_unpriced += flow.solar_to_battery

    rated_grid = grid[RATE_RECORDED] + grid[RATE_TARIFF]
    explained = rated_grid + grid[None] + solar_priced + solar_unpriced
    return ChargeOrigin(
        charged_kwh=charged,
        grid_recorded=grid[RATE_RECORDED] / charged,
        grid_tariff=grid[RATE_TARIFF] / charged,
        grid_unpriced=grid[None] / charged,
        solar_priced=solar_priced / charged,
        solar_unpriced=solar_unpriced / charged,
        unknown=max(0.0, 1.0 - explained / charged),
        paid_rate=paid_money / rated_grid if rated_grid > _EPSILON_KWH else None,
        forgone_rate=forgone_money / solar_priced if solar_priced > _EPSILON_KWH else None,
    )


# --- Attribution: sources and money for any node --------------------------------


@dataclass
class MoneySide:
    """One money figure, with how much of the energy behind it was priced.

    ``priced_kwh + unpriced_kwh`` is the node's kWh. A known zero is priced.
    """

    amount: float = 0.0
    priced_kwh: float = 0.0
    unpriced_kwh: float = 0.0
    #: Of ``priced_kwh``, what was priced at today's configured tariff.
    tariff_kwh: float = 0.0

    def price(self, kwh: float, amount: float) -> None:
        self.priced_kwh += kwh
        self.amount += amount

    @property
    def known_amount(self) -> float | None:
        """The amount, or None when nothing at all was priced."""
        return self.amount if self.priced_kwh > _EPSILON_KWH else None


@dataclass
class Attribution:
    """A node's kWh split by source, and both money figures for it."""

    solar: float = 0.0
    battery: float = 0.0
    grid: float = 0.0
    unattributed: float = 0.0
    paid: MoneySide = field(default_factory=MoneySide)
    forgone: MoneySide = field(default_factory=MoneySide)


def attribute_energy(dataset: DeviceDataset, kwh: dict[datetime, float]) -> Attribution:
    """Split ``kwh`` hour by hour in the house's mix, and price both sides.

    Per source share ``x`` of an hour:

    * grid: ``paid`` at the hour's import rate (unpriced without one), and a
      known zero on ``forgone``;
    * solar: a known zero on ``paid``, and ``forgone`` at the hour's export rate
      (unpriced without one);
    * battery: by the period's charge origin -- the rated grid share at the
      energy-weighted import rate, the solar share free on ``paid`` and at the
      energy-weighted export rate on ``forgone``, and everything the origin
      cannot price (unrated grid, unrated solar, unexplained charge) unpriced;
    * unattributed: unpriced on both sides.
    """
    origin = dataset.charge_origin
    rated_grid = origin.grid_recorded + origin.grid_tariff
    result = Attribution()
    paid, forgone = result.paid, result.forgone
    for hour, x in kwh.items():
        if x <= 0:
            continue
        mix = dataset.mix.get(hour, _UNATTRIBUTED_HOUR)
        grid, solar, battery = x * mix.grid, x * mix.solar, x * mix.battery
        unattributed = x * mix.unattributed
        result.grid += grid
        result.solar += solar
        result.battery += battery
        result.unattributed += unattributed

        import_rate = dataset.import_rate.get(hour)
        if import_rate is not None:
            paid.price(grid, grid * import_rate)
            if dataset.import_rate_source.get(hour) == RATE_TARIFF:
                paid.tariff_kwh += grid
        else:
            paid.unpriced_kwh += grid
        forgone.price(grid, 0.0)

        paid.price(solar, 0.0)
        export_rate = dataset.export_rate.get(hour)
        if export_rate is not None:
            forgone.price(solar, solar * export_rate)
        else:
            forgone.unpriced_kwh += solar

        paid.price(battery * rated_grid, battery * rated_grid * (origin.paid_rate or 0.0))
        paid.tariff_kwh += battery * origin.grid_tariff
        paid.price(battery * origin.solar, 0.0)
        paid.unpriced_kwh += battery * (origin.grid_unpriced + origin.unknown)
        forgone.price(
            battery * origin.solar_priced,
            battery * origin.solar_priced * (origin.forgone_rate or 0.0),
        )
        forgone.price(battery * origin.grid, 0.0)
        forgone.unpriced_kwh += battery * (origin.solar_unpriced + origin.unknown)

        paid.unpriced_kwh += unattributed
        forgone.unpriced_kwh += unattributed
    return result
