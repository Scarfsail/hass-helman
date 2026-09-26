from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from typing import Literal

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import label_registry as lr

from .const import CONSUMPTION_TOTAL_ENTITY_ID, PRODUCTION_TOTAL_ENTITY_ID
from .visualization import read_visualization
from .controllables.config import (
    Device,
    is_schedulable,
    iter_devices,
    own_meter,
    peek_controllable_id,
    peek_controllable_kind,
    read_carved_meters,
    read_shared_meters,
    share_sensor_slug,
    resolve_device_name,
    running_signal,
)
from .controllables.spec import CONTROLLABLE_KIND_INVERTER
from .power_polarity import consumer_value_type, source_value_type


def share_power_entity_id(device_id: str) -> str:
    """The Helman sensor publishing a meterless child's share of its parent's power."""
    return f"sensor.helman_share_power_{share_sensor_slug(device_id)}"


@dataclass
class DeviceNodeDTO:
    id: str
    display_name: str
    power_sensor_id: str | None
    switch_entity_id: str | None
    is_source: bool
    is_unmeasured: bool
    is_virtual: bool
    value_type: Literal["default", "positive", "negative"]
    labels: list[str]
    label_badge_texts: list[str]
    source_config: dict | None
    icon: str | None
    compact: bool
    show_additional_info: bool
    children_full_width: bool
    hide_children: bool
    hide_children_indicator: bool
    sort_children_by_power: bool
    children: list["DeviceNodeDTO"] = field(default_factory=list)
    ratio_sensor_id: str | None = None
    source_type: str | None = None
    # A house node whose load is carved out of the house baseline, so the card
    # can mark the load the optimizer is free to move in time: a carved meter's
    # node, its meterless children, or — when the carved meter also has metered
    # children — its remainder instead of its node, since only the meter's own
    # energy is carved. Sources and virtual groups are never deferrable.
    deferrable: bool = False
    # The schedulable device this node is, so the card can look its schedule
    # up: a schedulable meter owner's id, or a meterless child's own. Empty for
    # every other node.
    controllable_ids: list[str] = field(default_factory=list)
    # The device's meter, for a metered house child; ``None`` for every other
    # node. The node ``id`` happens to be the same entity (it keeps the
    # unmeasured sensor ids stable), but readers of the meter read it here.
    energy_entity_id: str | None = None
    # A meterless child's share of its parent's own power: an estimate, not a
    # reading, so the card marks it ``≈`` and the own-power subtraction never
    # counts it.
    is_estimated: bool = False

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
            "labels": self.labels,
            "labelBadgeTexts": self.label_badge_texts,
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
        self._config = config

    def _visualization(self) -> dict:
        return read_visualization(self._config)

    async def build(self) -> dict:
        """Build and return the full device tree as a serializable dict."""
        power_devices = self._config.get("power_devices", {})
        visualization = self._visualization()
        device_label_text = visualization["device_label_text"]

        solar_config = power_devices.get("solar")
        battery_config = power_devices.get("battery")
        grid_config = power_devices.get("grid")
        house_config = power_devices.get("house")

        ent_reg = er.async_get(self._hass)
        lbl_reg = lr.async_get(self._hass)

        # --- Sources ---
        sources: list[DeviceNodeDTO] = []

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
        consumers: list[DeviceNodeDTO] = []

        if house_config and house_config.get("entities", {}).get("power"):
            house_children = self._build_house_children(
                ent_reg, lbl_reg, device_label_text
            )
            unmeasured_title = house_config.get("unmeasured_power_title", "Unmeasured power")
            own_carved = {
                carve["energy_entity_id"]
                for carve in read_carved_meters(self._config)
                if carve["metered_children"]
            }
            house_node = DeviceNodeDTO(
                id="house",
                display_name="",
                power_sensor_id=house_config["entities"]["power"],
                switch_entity_id=None,
                is_source=False,
                is_unmeasured=False,
                is_virtual=False,
                value_type=consumer_value_type(house_config, "house"),
                labels=[],
                label_badge_texts=[],
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
            self._add_unmeasured_nodes(house_node, unmeasured_title, own_carved)
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
                "sources_title": visualization["sources_title"],
                "consumers_title": visualization["consumers_title"],
                "groups_title": visualization["groups_title"],
                "others_group_label": visualization["others_group_label"],
                "show_empty_groups": visualization["show_empty_groups"],
                "show_others_group": visualization["show_others_group"],
                "device_label_text": device_label_text,
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
    ) -> DeviceNodeDTO:
        return DeviceNodeDTO(
            id=entity_id,
            display_name="",
            power_sensor_id=entity_id,
            switch_entity_id=None,
            is_source=True,
            is_unmeasured=False,
            is_virtual=False,
            value_type=value_type,
            labels=[],
            label_badge_texts=[],
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
    ) -> DeviceNodeDTO:
        return DeviceNodeDTO(
            id=entity_id,
            display_name="",
            power_sensor_id=entity_id,
            switch_entity_id=None,
            is_source=False,
            is_unmeasured=False,
            is_virtual=False,
            value_type=value_type,
            labels=[],
            label_badge_texts=[],
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
        ent_reg: er.EntityRegistry,
        lbl_reg: lr.LabelRegistry,
        device_label_text: dict,
    ) -> list[DeviceNodeDTO]:
        """One node per device, nested as the ``devices`` tree nests them.

        Everything is read from the device, never inferred: a selected entity
        that is missing keeps its row, and the entity inspection reports it.
        A meterless child is an estimated node under its parent, reading its
        share sensor — for exactly the children ``read_shared_meters`` splits
        the meter among, which is what the coordinator publishes shares for.
        """
        carved: dict[str, dict] = {
            carve["energy_entity_id"]: carve for carve in read_carved_meters(self._config)
        }
        shared = read_shared_meters(self._config)
        cleaner_regex = self._visualization().get("power_sensor_name_cleaner_regex", "")

        # Pre-group entities by device_id for efficient lookup
        entities_by_device: dict[str, list] = {}
        for entity in ent_reg.entities.values():
            if entity.device_id:
                entities_by_device.setdefault(entity.device_id, []).append(entity)

        tree: list[DeviceNodeDTO] = []
        nodes: dict[int, DeviceNodeDTO] = {}
        for device, parent in iter_devices(self._config):
            if peek_controllable_kind(device) == CONTROLLABLE_KIND_INVERTER:
                continue
            parent_node = nodes.get(id(parent)) if parent is not None else None
            meter = own_meter(device)
            if meter is None:
                if parent_node is not None:
                    share_node = self._make_share_node(
                        device, parent_node, shared, carved, cleaner_regex
                    )
                    if share_node is not None:
                        parent_node.children.append(share_node)
                continue
            power_sensor_id = _consumption_entity(device, "power_entity_id")
            power_state = self._hass.states.get(power_sensor_id) if power_sensor_id else None
            icon = _configured_icon(device)
            if icon is None:
                icon = power_state.attributes.get("icon") if power_state else None

            # Labels from every entity on the meter's HA device
            labels: list[str] = []
            ent_entry = ent_reg.async_get(meter)
            if ent_entry and ent_entry.device_id:
                label_ids: set[str] = set()
                for entity in entities_by_device.get(ent_entry.device_id, []):
                    label_ids.update(entity.labels)
                for label_id in label_ids:
                    label_entry = lbl_reg.async_get_label(label_id)
                    if label_entry:
                        labels.append(label_entry.name)

            node = DeviceNodeDTO(
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
                labels=labels,
                label_badge_texts=self._apply_label_badge_texts(labels, device_label_text),
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
            nodes[id(device)] = node
            (parent_node.children if parent_node is not None else tree).append(node)

        return tree

    def _make_share_node(
        self,
        device: Device,
        parent_node: DeviceNodeDTO,
        shared: dict[str, dict],
        carved: dict[str, dict],
        cleaner_regex: str,
    ) -> DeviceNodeDTO | None:
        """A meterless child's row: its share of the parent's own power.

        ``None`` for a child the meter is not split among (no id, no running
        signal — validation reports both).
        """
        parent_meter = parent_node.energy_entity_id
        device_id = peek_controllable_id(device)
        members = shared.get(parent_meter, {}).get("members", ())
        if device_id is None or device_id not in {member[0] for member in members}:
            return None
        return DeviceNodeDTO(
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
            labels=[],
            label_badge_texts=[],
            source_config=None,
            icon=_configured_icon(device),
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

    def _friendly_name(self, entity_id: str) -> str | None:
        state = self._hass.states.get(entity_id)
        return state.attributes.get("friendly_name") if state else None

    def _add_unmeasured_nodes(
        self,
        node: DeviceNodeDTO,
        unmeasured_title: str,
        own_carved: Collection[str] = frozenset(),
    ) -> None:
        """Add a remainder under every measured node with children.

        ``own_carved`` are the carved meters with metered children: only their
        own energy is carved, and their remainder is where it shows, so it is
        the remainder the card marks deferrable.
        """
        if not node.children:
            return
        # A remainder is the parent's power minus its children's: a metered
        # device without a power sensor (an energy-only Energy row) has none,
        # but its children may still have remainders of their own.
        if not node.is_virtual and node.power_sensor_id:
            slug = node.id.replace(".", "_")
            # The tree node's own ``id`` keeps the historical dot-to-underscore
            # slug -- it is only a frontend list key. ``power_sensor_id`` is the
            # actual Helman entity id, which ``HelmanUnmeasuredPowerSensor``
            # builds by stripping a leading "sensor." rather than underscoring
            # it, so it is computed separately here to match.
            entity_slug = node.id.removeprefix("sensor.")
            unmeasured = DeviceNodeDTO(
                id=f"{slug}_unmeasured",
                display_name=unmeasured_title,
                power_sensor_id=f"sensor.helman_unmeasured_power_{entity_slug}",
                switch_entity_id=None,
                is_source=False,
                is_unmeasured=True,
                is_virtual=False,
                value_type="default",
                labels=[],
                label_badge_texts=[],
                source_config=None,
                icon=None,
                compact=False,
                show_additional_info=False,
                children_full_width=False,
                hide_children=False,
                hide_children_indicator=False,
                sort_children_by_power=False,
                deferrable=node.energy_entity_id in own_carved,
            )
            node.children.append(unmeasured)
        for child in node.children:
            self._add_unmeasured_nodes(child, unmeasured_title, own_carved)

    def _apply_label_badge_texts(self, labels: list[str], device_label_text: dict) -> list[str]:
        result = []
        for category_map in device_label_text.values():
            for label_name, badge_text in category_map.items():
                if label_name in labels:
                    result.append(badge_text)
        return result


def _consumption_entity(device: Device, key: str) -> str | None:
    consumption = device.get("consumption")
    value = consumption.get(key) if isinstance(consumption, Mapping) else None
    return value.strip() if isinstance(value, str) and value.strip() else None


def _configured_icon(device: Device) -> str | None:
    icon = device.get("icon")
    return icon if isinstance(icon, str) and icon.strip() else None


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
