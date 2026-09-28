from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from functools import partial
from typing import Literal

from homeassistant.core import HomeAssistant

from .const import CONSUMPTION_TOTAL_ENTITY_ID, PRODUCTION_TOTAL_ENTITY_ID
from .visualization import read_visualization
from .controllables.config import (
    Device,
    device_groups,
    entity_friendly_name,
    is_schedulable,
    iter_devices,
    own_meter,
    peek_controllable_id,
    peek_controllable_kind,
    read_carved_meters,
    read_groupings,
    read_name_cleaner_regex,
    read_shared_meters,
    share_sensor_slug,
    resolve_device_icon,
    resolve_device_name,
    running_signal,
)
from .controllables.spec import CONTROLLABLE_KIND_INVERTER
from .power_polarity import consumer_value_type, source_value_type


def share_power_entity_id(device_id: str) -> str:
    """The Helman sensor publishing a meterless child's share of its parent's power."""
    return f"sensor.helman_share_power_{share_sensor_slug(device_id)}"


@dataclass
class TreeItemDTO:
    id: str
    display_name: str
    power_sensor_id: str | None
    switch_entity_id: str | None
    is_source: bool
    is_unmeasured: bool
    is_virtual: bool
    value_type: Literal["default", "positive", "negative"]
    source_config: dict | None
    icon: str | None
    compact: bool
    show_additional_info: bool
    children_full_width: bool
    hide_children: bool
    hide_children_indicator: bool
    sort_children_by_power: bool
    children: list["TreeItemDTO"] = field(default_factory=list)
    ratio_sensor_id: str | None = None
    source_type: str | None = None
    # A house item whose load is carved out of the house baseline, so the card
    # can mark the load the optimizer is free to move in time: a carved meter's
    # device, its meterless children, or — when the carved meter also has
    # metered children — its remainder instead of its device, since only the
    # meter's own energy is carved. Sources and virtual groups are never
    # deferrable.
    deferrable: bool = False
    # The schedulable device this item is, so the card can look its schedule
    # up: a schedulable meter owner's id, or a meterless child's own. Empty for
    # every other item.
    controllable_ids: list[str] = field(default_factory=list)
    # The device's meter, for a metered house child; ``None`` for every other
    # item. The item ``id`` happens to be the same entity (it keeps the
    # unmeasured sensor ids stable), but readers of the meter read it here.
    energy_entity_id: str | None = None
    # A meterless child's share of its parent's own power: an estimate, not a
    # reading, so the card marks it ``≈`` and the own-power subtraction never
    # counts it.
    is_estimated: bool = False
    # A house device's own group per grouping (grouping id -> group id) and
    # the short names of those groups, in grouping order: what the card groups
    # by and badges with. Empty for every other item.
    groups: dict[str, str] = field(default_factory=dict)
    group_badge_texts: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "displayName": self.display_name,
            "powerSensorId": self.power_sensor_id,
            "switchEntityId": self.switch_entity_id,
            "isSource": self.is_source,
            "isUnmeasured": self.is_unmeasured,
            "isVirtual": self.is_virtual,
            "valueType": self.value_type,
            "groups": self.groups,
            "groupBadgeTexts": self.group_badge_texts,
            "sourceConfig": self.source_config,
            "icon": self.icon,
            "compact": self.compact,
            "showAdditionalInfo": self.show_additional_info,
            "childrenFullWidth": self.children_full_width,
            "hideChildren": self.hide_children,
            "hideChildrenIndicator": self.hide_children_indicator,
            "sortChildrenByPower": self.sort_children_by_power,
            "children": [c.to_dict() for c in self.children],
            "ratioSensorId": self.ratio_sensor_id,
            "sourceType": self.source_type,
            "deferrable": self.deferrable,
            "controllableIds": self.controllable_ids,
            "energyEntityId": self.energy_entity_id,
            "isEstimated": self.is_estimated,
        }


class HelmanTreeBuilder:
    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self._hass = hass
        self._friendly_name = partial(entity_friendly_name, hass)
        self._config = config

    def _visualization(self) -> dict:
        return read_visualization(self._config)

    async def build(self) -> dict:
        """Build and return the full device tree as a serializable dict."""
        energy_nodes = self._config.get("energy_nodes", {})
        visualization = self._visualization()
        groupings = read_groupings(self._config)
        groupings = groupings if isinstance(groupings, list) else []

        solar_config = energy_nodes.get("solar")
        battery_config = energy_nodes.get("battery")
        grid_config = energy_nodes.get("grid")
        house_config = energy_nodes.get("house")

        # --- Sources ---
        sources: list[TreeItemDTO] = []

        if solar_config and solar_config.get("entities", {}).get("power"):
            sources.append(self._make_source_node(
                solar_config["entities"]["power"],
                solar_config,
                source_type="solar",
                value_type=source_value_type(solar_config, "solar"),
                icon="mdi:solar-power",
            ))

        if battery_config and battery_config.get("entities", {}).get("power"):
            sources.append(self._make_source_node(
                battery_config["entities"]["power"],
                battery_config,
                source_type="battery",
                value_type=source_value_type(battery_config, "battery"),
                icon="mdi:battery",
            ))

        if grid_config and grid_config.get("entities", {}).get("power"):
            sources.append(self._make_source_node(
                grid_config["entities"]["power"],
                grid_config,
                source_type="grid",
                value_type=source_value_type(grid_config, "grid"),
                icon="mdi:transmission-tower-export",
            ))

        # --- Consumers ---
        consumers: list[TreeItemDTO] = []

        if house_config and house_config.get("entities", {}).get("power"):
            house_children = self._build_house_children(groupings)
            own_carved = {
                carve["energy_entity_id"]
                for carve in read_carved_meters(self._config)
                if carve["metered_children"]
            }
            house_node = TreeItemDTO(
                id="house",
                display_name="",
                power_sensor_id=house_config["entities"]["power"],
                switch_entity_id=None,
                is_source=False,
                is_unmeasured=False,
                is_virtual=False,
                value_type=consumer_value_type(house_config, "house"),
                source_config=house_config,
                source_type="house",
                icon="mdi:home",
                compact=True,
                show_additional_info=True,
                children_full_width=True,
                hide_children=True,
                hide_children_indicator=True,
                sort_children_by_power=True,
                children=house_children,
            )
            self._add_unmeasured_items(house_node, own_carved)
            consumers.append(house_node)

        if battery_config and battery_config.get("entities", {}).get("power"):
            consumers.append(self._make_consumer_node(
                battery_config["entities"]["power"],
                battery_config,
                source_type="battery",
                value_type=consumer_value_type(battery_config, "battery"),
                icon="mdi:battery",
            ))

        if grid_config and grid_config.get("entities", {}).get("power"):
            consumers.append(self._make_consumer_node(
                grid_config["entities"]["power"],
                grid_config,
                source_type="grid",
                value_type=consumer_value_type(grid_config, "grid"),
                icon="mdi:transmission-tower-import",
            ))

        return {
            "sources": [s.to_dict() for s in sources],
            "consumers": [c.to_dict() for c in consumers],
            "consumptionTotalSensorId": CONSUMPTION_TOTAL_ENTITY_ID,
            "productionTotalSensorId": PRODUCTION_TOTAL_ENTITY_ID,
            "uiConfig": {
                "show_empty_groups": visualization["show_empty_groups"],
                "show_others_group": visualization["show_others_group"],
                "device_groupings": groupings,
                "history_buckets": visualization["history_buckets"],
                "history_bucket_duration": visualization["history_bucket_duration"],
            },
        }

    def _make_source_node(
        self,
        entity_id: str,
        config: dict,
        source_type: str,
        value_type: Literal["default", "positive", "negative"],
        icon: str,
    ) -> TreeItemDTO:
        return TreeItemDTO(
            id=entity_id,
            display_name="",
            power_sensor_id=entity_id,
            switch_entity_id=None,
            is_source=True,
            is_unmeasured=False,
            is_virtual=False,
            value_type=value_type,
            source_config=config,
            icon=icon,
            compact=True,
            show_additional_info=True,
            children_full_width=False,
            hide_children=False,
            hide_children_indicator=False,
            sort_children_by_power=False,
            ratio_sensor_id=f"sensor.helman_{source_type}_source_ratio",
            source_type=source_type,
        )

    def _make_consumer_node(
        self,
        entity_id: str,
        config: dict,
        source_type: str,
        value_type: Literal["default", "positive", "negative"],
        icon: str,
    ) -> TreeItemDTO:
        return TreeItemDTO(
            id=entity_id,
            display_name="",
            power_sensor_id=entity_id,
            switch_entity_id=None,
            is_source=False,
            is_unmeasured=False,
            is_virtual=False,
            value_type=value_type,
            source_config=config,
            icon=icon,
            compact=True,
            show_additional_info=True,
            children_full_width=False,
            hide_children=False,
            hide_children_indicator=False,
            sort_children_by_power=False,
            source_type=source_type,
        )

    def _build_house_children(
        self,
        groupings: list,
    ) -> list[TreeItemDTO]:
        """One item per device, nested as the ``devices`` tree nests them.

        Everything is read from the device, never inferred: a selected entity
        that is missing keeps its row, and the entity inspection reports it.
        A meterless child is an estimated item under its parent, reading its
        share sensor — for exactly the children ``read_shared_meters`` splits
        the meter among, which is what the coordinator publishes shares for.
        """
        carved: dict[str, dict] = {
            carve["energy_entity_id"]: carve for carve in read_carved_meters(self._config)
        }
        shared = read_shared_meters(self._config)
        cleaner_regex = read_name_cleaner_regex(self._config)
        # grouping id -> group id -> short name, in grouping order.
        short_names: dict[str, dict[str, str]] = {
            grouping["id"]: {group["id"]: group["short_name"] for group in grouping["groups"]}
            for grouping in groupings
        }

        def apply_groups(item: TreeItemDTO, device: Device) -> None:
            item.groups = device_groups(device)
            item.group_badge_texts = [
                names[group_id]
                for grouping_id, names in short_names.items()
                if (group_id := item.groups.get(grouping_id)) in names
            ]

        tree: list[TreeItemDTO] = []
        devices: dict[int, TreeItemDTO] = {}
        for device, parent in iter_devices(self._config):
            if peek_controllable_kind(device) == CONTROLLABLE_KIND_INVERTER:
                continue
            parent_device = devices.get(id(parent)) if parent is not None else None
            meter = own_meter(device)
            if meter is None:
                if parent_device is not None:
                    share_device = self._make_share_device(
                        device, parent_device, shared, carved, cleaner_regex
                    )
                    if share_device is not None:
                        apply_groups(share_device, device)
                        parent_device.children.append(share_device)
                continue
            power_sensor_id = _consumption_entity(device, "power_entity_id")
            icon = resolve_device_icon(device, entity_icon=self._entity_icon)

            item = TreeItemDTO(
                id=meter,
                display_name=resolve_device_name(
                    device,
                    friendly_name=self._friendly_name,
                    cleaner_regex=cleaner_regex,
                ),
                power_sensor_id=power_sensor_id,
                switch_entity_id=_switch_entity(device),
                is_source=False,
                is_unmeasured=False,
                is_virtual=False,
                value_type="default",
                source_config=None,
                icon=icon,
                compact=False,
                show_additional_info=False,
                children_full_width=True,
                hide_children=False,
                hide_children_indicator=False,
                sort_children_by_power=False,
                # A carved meter with metered children carves only its own
                # energy, which its remainder shows, not this aggregate.
                deferrable=meter in carved and not carved[meter]["metered_children"],
                controllable_ids=(
                    list(carved[meter]["ids"])
                    if meter in carved and is_schedulable(device)
                    else []
                ),
                energy_entity_id=meter,
            )
            apply_groups(item, device)
            devices[id(device)] = item
            (parent_device.children if parent_device is not None else tree).append(item)

        return tree

    def _make_share_device(
        self,
        device: Device,
        parent_device: TreeItemDTO,
        shared: dict[str, dict],
        carved: dict[str, dict],
        cleaner_regex: str | None,
    ) -> TreeItemDTO | None:
        """A meterless child's row: its share of the parent's own power.

        ``None`` for a child the meter is not split among (no id, no running
        signal — validation reports both).
        """
        parent_meter = parent_device.energy_entity_id
        device_id = peek_controllable_id(device)
        members = shared.get(parent_meter, {}).get("members", ())
        if device_id is None or device_id not in {member[0] for member in members}:
            return None
        return TreeItemDTO(
            id=device_id,
            display_name=resolve_device_name(
                device,
                friendly_name=self._friendly_name,
                cleaner_regex=cleaner_regex,
            ),
            power_sensor_id=share_power_entity_id(device_id),
            # The running signal is the control the row offers: a switch, or
            # the climate entity of an air conditioner.
            switch_entity_id=running_signal(device)[0],
            is_source=False,
            is_unmeasured=False,
            is_virtual=False,
            value_type="default",
            source_config=None,
            icon=resolve_device_icon(device, entity_icon=self._entity_icon),
            compact=False,
            show_additional_info=False,
            children_full_width=True,
            hide_children=False,
            hide_children_indicator=False,
            sort_children_by_power=False,
            # The carve covers the meter's own energy, which these children split.
            deferrable=parent_meter in carved,
            controllable_ids=[device_id] if is_schedulable(device) else [],
            is_estimated=True,
        )

    def _entity_icon(self, entity_id: str) -> str | None:
        state = self._hass.states.get(entity_id)
        return state.attributes.get("icon") if state else None

    def _add_unmeasured_items(
        self,
        item: TreeItemDTO,
        own_carved: Collection[str] = frozenset(),
    ) -> None:
        """Add a remainder under every measured item with children.

        A remainder's ``display_name`` is empty: the card names every one with
        its own localized label.

        ``own_carved`` are the carved meters with metered children: only their
        own energy is carved, and their remainder is where it shows, so it is
        the remainder the card marks deferrable.
        """
        if not item.children:
            return
        # A remainder is the parent's power minus its children's: a metered
        # device without a power sensor (an energy-only Energy row) has none,
        # but its children may still have remainders of their own.
        if not item.is_virtual and item.power_sensor_id:
            slug = item.id.replace(".", "_")
            # The tree item's own ``id`` keeps the historical dot-to-underscore
            # slug -- it is only a frontend list key. ``power_sensor_id`` is the
            # actual Helman entity id, which ``HelmanUnmeasuredPowerSensor``
            # builds by stripping a leading "sensor." rather than underscoring
            # it, so it is computed separately here to match.
            entity_slug = item.id.removeprefix("sensor.")
            unmeasured = TreeItemDTO(
                id=f"{slug}_unmeasured",
                display_name="",
                power_sensor_id=f"sensor.helman_unmeasured_power_{entity_slug}",
                switch_entity_id=None,
                is_source=False,
                is_unmeasured=True,
                is_virtual=False,
                value_type="default",
                source_config=None,
                icon=None,
                compact=False,
                show_additional_info=False,
                children_full_width=False,
                hide_children=False,
                hide_children_indicator=False,
                sort_children_by_power=False,
                deferrable=item.energy_entity_id in own_carved,
            )
            item.children.append(unmeasured)
        for child in item.children:
            self._add_unmeasured_items(child, own_carved)


def _consumption_entity(device: Device, key: str) -> str | None:
    consumption = device.get("consumption")
    value = consumption.get(key) if isinstance(consumption, Mapping) else None
    return value.strip() if isinstance(value, str) and value.strip() else None


def _switch_entity(device: Device) -> str | None:
    """The switch the card offers: ``controls.switch``, else ``controls.charge``."""
    controls = device.get("controls")
    if not isinstance(controls, Mapping):
        return None
    for control_key in ("switch", "charge"):
        control = controls.get(control_key)
        entity_id = control.get("entity_id") if isinstance(control, Mapping) else None
        if isinstance(entity_id, str) and entity_id.strip():
            return entity_id.strip()
    return None
