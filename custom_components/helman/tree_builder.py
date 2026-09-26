from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import label_registry as lr

from .const import CONSUMPTION_TOTAL_ENTITY_ID, PRODUCTION_TOTAL_ENTITY_ID
from .visualization import read_visualization
from .controllables.config import (
    Device,
    iter_devices,
    own_meter,
    peek_controllable_kind,
    read_carved_meters,
    resolve_device_name,
)
from .controllables.spec import CONTROLLABLE_KIND_INVERTER
from .power_polarity import consumer_value_type, source_value_type

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
    # A house child whose meter is carved out of the house baseline, so the
    # card can mark the load the optimizer is free to move in time. Every other
    # node — sources, unmeasured remainders, virtual groups — is never deferrable.
    deferrable: bool = False
    # The devices a carved meter stands for, as ``read_carved_meters`` names
    # them, so the card can look the node's schedule up. Several when the meter
    # is split by meterless children — the node stays one, and its badge covers
    # all of them. Empty for every node that is not a carved house child.
    controllable_ids: list[str] = field(default_factory=list)
    # The device's meter, for a house child; ``None`` for every other node. The
    # node ``id`` happens to be the same entity (it keeps the unmeasured sensor
    # ids stable), but readers of the meter read it here.
    energy_entity_id: str | None = None

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
            self._add_unmeasured_nodes(house_node, unmeasured_title)
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
        """One node per metered device, nested as the ``devices`` tree nests them.

        Everything is read from the device, never inferred: a selected entity
        that is missing keeps its row, and the entity inspection reports it.
        Meterless children have no node of their own yet; their ids stay on
        the parent's ``controllable_ids``.
        """
        carved: dict[str, list[str]] = {
            c["energy_entity_id"]: c["ids"] for c in read_carved_meters(self._config)
        }
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
            meter = own_meter(device)
            if meter is None:
                continue
            power_sensor_id = _consumption_entity(device, "power_entity_id")
            power_state = self._hass.states.get(power_sensor_id) if power_sensor_id else None
            icon = device.get("icon")
            if not isinstance(icon, str) or not icon.strip():
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
                deferrable=meter in carved,
                controllable_ids=list(carved.get(meter, ())),
                energy_entity_id=meter,
            )
            nodes[id(device)] = node
            parent_node = nodes.get(id(parent)) if parent is not None else None
            (parent_node.children if parent_node is not None else tree).append(node)

        return tree

    def _friendly_name(self, entity_id: str) -> str | None:
        state = self._hass.states.get(entity_id)
        return state.attributes.get("friendly_name") if state else None

    def _add_unmeasured_nodes(self, node: DeviceNodeDTO, unmeasured_title: str) -> None:
        if not node.children:
            return
        if not node.is_virtual:
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
            )
            node.children.append(unmeasured)
        for child in node.children:
            self._add_unmeasured_nodes(child, unmeasured_title)

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
