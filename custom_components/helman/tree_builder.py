from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from homeassistant.components.energy import data as energy_data
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import label_registry as lr

from .const import TOTAL_POWER_ENTITY_ID


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
    color: str | None
    icon: str | None
    compact: bool
    show_additional_info: bool
    children_full_width: bool
    hide_children: bool
    hide_children_indicator: bool
    sort_children_by_power: bool
    children: list["DeviceNodeDTO"] = field(default_factory=list)

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
            "color": self.color,
            "icon": self.icon,
            "compact": self.compact,
            "showAdditionalInfo": self.show_additional_info,
            "childrenFullWidth": self.children_full_width,
            "hideChildren": self.hide_children,
            "hideChildrenIndicator": self.hide_children_indicator,
            "sortChildrenByPower": self.sort_children_by_power,
            "children": [c.to_dict() for c in self.children],
        }


class HelmanTreeBuilder:
    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self._hass = hass
        self._config = config

    async def build(self) -> dict:
        """Build and return the full device tree as a serializable dict."""
        power_devices = self._config.get("power_devices", {})
        device_label_text = self._config.get("device_label_text", {})

        solar_config = power_devices.get("solar")
        battery_config = power_devices.get("battery")
        grid_config = power_devices.get("grid")
        house_config = power_devices.get("house")

        ent_reg = er.async_get(self._hass)
        dev_reg = dr.async_get(self._hass)
        lbl_reg = lr.async_get(self._hass)

        manager = await energy_data.async_get_manager(self._hass)
        prefs = manager.data

        # --- Sources ---
        sources: list[DeviceNodeDTO] = []

        if solar_config and solar_config.get("entities", {}).get("power"):
            sources.append(self._make_source_node(
                solar_config["entities"]["power"],
                solar_config,
                value_type="default",
                color="#FDD83560",
                icon="mdi:solar-power",
            ))

        if battery_config and battery_config.get("entities", {}).get("power"):
            sources.append(self._make_source_node(
                battery_config["entities"]["power"],
                battery_config,
                value_type="negative",
                color="#66BB6A60",
                icon="mdi:battery",
            ))

        if grid_config and grid_config.get("entities", {}).get("power"):
            sources.append(self._make_source_node(
                grid_config["entities"]["power"],
                grid_config,
                value_type="negative",
                color="#42A5F560",
                icon="mdi:transmission-tower-export",
            ))

        # --- Consumers ---
        consumers: list[DeviceNodeDTO] = []

        if house_config and house_config.get("entities", {}).get("power"):
            house_children = self._build_house_children(
                prefs, ent_reg, dev_reg, lbl_reg, house_config, device_label_text
            ) if prefs else []
            unmeasured_title = house_config.get("unmeasured_power_title", "Unmeasured power")
            house_node = DeviceNodeDTO(
                id="house",
                display_name="",
                power_sensor_id=house_config["entities"]["power"],
                switch_entity_id=None,
                is_source=False,
                is_unmeasured=False,
                is_virtual=False,
                value_type="default",
                labels=[],
                label_badge_texts=[],
                source_config=house_config,
                color="#FFAB9160",
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
                value_type="positive",
                color="#66BB6A60",
                icon="mdi:battery",
            ))

        if grid_config and grid_config.get("entities", {}).get("power"):
            consumers.append(self._make_consumer_node(
                grid_config["entities"]["power"],
                grid_config,
                value_type="positive",
                color="#42A5F560",
                icon="mdi:transmission-tower-import",
            ))

        return {
            "sources": [s.to_dict() for s in sources],
            "consumers": [c.to_dict() for c in consumers],
            "totalPowerSensorId": TOTAL_POWER_ENTITY_ID,
            "uiConfig": {
                "sources_title": self._config.get("sources_title", "Energy Sources"),
                "consumers_title": self._config.get("consumers_title", "Energy Consumers"),
                "groups_title": self._config.get("groups_title", "Group by:"),
                "others_group_label": self._config.get("others_group_label", "Others"),
                "show_empty_groups": self._config.get("show_empty_groups", False),
                "show_others_group": self._config.get("show_others_group", True),
                "device_label_text": self._config.get("device_label_text", {}),
                "history_buckets": self._config.get("history_buckets", 60),
                "history_bucket_duration": self._config.get("history_bucket_duration", 1),
            },
        }

    def _make_source_node(
        self,
        entity_id: str,
        config: dict,
        value_type: Literal["default", "positive", "negative"],
        color: str,
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
            color=color,
            icon=icon,
            compact=True,
            show_additional_info=True,
            children_full_width=False,
            hide_children=False,
            hide_children_indicator=False,
            sort_children_by_power=False,
        )

    def _make_consumer_node(
        self,
        entity_id: str,
        config: dict,
        value_type: Literal["default", "positive", "negative"],
        color: str,
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
            color=color,
            icon=icon,
            compact=True,
            show_additional_info=True,
            children_full_width=False,
            hide_children=False,
            hide_children_indicator=False,
            sort_children_by_power=False,
        )

    def _build_house_children(
        self,
        prefs: dict,
        ent_reg: er.EntityRegistry,
        dev_reg: dr.DeviceRegistry,
        lbl_reg: lr.LabelRegistry,
        house_config: dict,
        device_label_text: dict,
    ) -> list[DeviceNodeDTO]:
        power_sensor_label: str | None = house_config.get("power_sensor_label")
        power_switch_label: str | None = house_config.get("power_switch_label")
        unmeasured_title: str = house_config.get("unmeasured_power_title", "Unmeasured power")

        device_consumption = prefs.get("device_consumption", [])

        ps_label_id = self._find_label_id(lbl_reg, power_sensor_label) if power_sensor_label else None
        sw_label_id = self._find_label_id(lbl_reg, power_switch_label) if power_switch_label else None

        # Pre-group entities by device_id for efficient lookup
        entities_by_device: dict[str, list] = {}
        for entity in ent_reg.entities.values():
            if entity.device_id:
                entities_by_device.setdefault(entity.device_id, []).append(entity)

        device_map: dict[str, DeviceNodeDTO] = {}

        for dc in device_consumption:
            stat_entity_id = dc.get("stat_consumption") if isinstance(dc, dict) else dc.stat_consumption
            if not stat_entity_id:
                continue

            # stat_rate is the power sensor — use it directly when available
            stat_rate = dc.get("stat_rate") if isinstance(dc, dict) else getattr(dc, "stat_rate", None)
            power_sensor_id: str | None = stat_rate or None
            switch_entity_id: str | None = None
            labels: list[str] = []
            label_badge_texts: list[str] = []

            # Device lookup: needed for switch, labels, and power fallback
            ent_entry = ent_reg.async_get(stat_entity_id)
            if ent_entry and ent_entry.device_id:
                device = dev_reg.async_get(ent_entry.device_id)
                if device:
                    device_entities = entities_by_device.get(ent_entry.device_id, [])

                    # Fallback: find power entity via device_class if stat_rate absent
                    if not power_sensor_id:
                        power_entities = [
                            e for e in device_entities
                            if (state := self._hass.states.get(e.entity_id))
                            and state.attributes.get("device_class") == "power"
                        ]
                        power_entity = None
                        if len(power_entities) > 1 and ps_label_id:
                            power_entity = next(
                                (e for e in power_entities if ps_label_id in e.labels), None
                            )
                        if not power_entity and power_entities:
                            power_entity = power_entities[0]
                        if power_entity:
                            power_sensor_id = power_entity.entity_id

                    # Find switch entity
                    switch_entities = [e for e in device_entities if e.entity_id.startswith("switch.")]
                    switch_entity = None
                    if switch_entities and sw_label_id:
                        switch_entity = next(
                            (e for e in switch_entities if sw_label_id in e.labels), None
                        )
                    if not switch_entity and switch_entities:
                        dev_name = device.name_by_user or device.name or ""
                        switch_entity = next(
                            (
                                e for e in switch_entities
                                if (s := self._hass.states.get(e.entity_id))
                                and s.attributes.get("friendly_name") == dev_name
                            ),
                            None,
                        )
                    switch_entity_id = switch_entity.entity_id if switch_entity else None

                    # Collect labels from all entities on this device
                    label_ids: set[str] = set()
                    for entity in device_entities:
                        label_ids.update(entity.labels)
                    for label_id in label_ids:
                        label_entry = lbl_reg.async_get_label(label_id)
                        if label_entry:
                            labels.append(label_entry.name)
                    label_badge_texts = self._apply_label_badge_texts(labels, device_label_text)

            if not power_sensor_id:
                continue

            # Display name from power sensor state
            power_state = self._hass.states.get(power_sensor_id)
            raw_name = (
                power_state.attributes.get("friendly_name") or power_sensor_id
                if power_state
                else power_sensor_id
            )
            display_name = self._clean_name(raw_name)
            icon = power_state.attributes.get("icon") if power_state else None

            node = DeviceNodeDTO(
                id=stat_entity_id,
                display_name=display_name,
                power_sensor_id=power_sensor_id,
                switch_entity_id=switch_entity_id,
                is_source=False,
                is_unmeasured=False,
                is_virtual=False,
                value_type="default",
                labels=labels,
                label_badge_texts=label_badge_texts,
                source_config=None,
                color=None,
                icon=icon,
                compact=False,
                show_additional_info=False,
                children_full_width=True,
                hide_children=False,
                hide_children_indicator=False,
                sort_children_by_power=False,
            )
            device_map[stat_entity_id] = node

        # Assemble tree (parent-child from included_in_stat)
        tree: list[DeviceNodeDTO] = []
        for dc in device_consumption:
            stat_entity_id = dc.get("stat_consumption") if isinstance(dc, dict) else dc.stat_consumption
            node = device_map.get(stat_entity_id)
            if not node:
                continue
            included_in = dc.get("included_in_stat") if isinstance(dc, dict) else getattr(dc, "included_in_stat", None)
            if included_in and included_in in device_map:
                device_map[included_in].children.append(node)
            else:
                tree.append(node)

        return tree

    def _add_unmeasured_nodes(self, node: DeviceNodeDTO, unmeasured_title: str) -> None:
        if not node.children:
            return
        if not node.is_virtual:
            slug = node.id.replace(".", "_")
            unmeasured = DeviceNodeDTO(
                id=f"{slug}_unmeasured",
                display_name=unmeasured_title,
                power_sensor_id=f"sensor.helman_{slug}_unmeasured_power",
                switch_entity_id=None,
                is_source=False,
                is_unmeasured=True,
                is_virtual=False,
                value_type="default",
                labels=[],
                label_badge_texts=[],
                source_config=None,
                color=None,
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

    def _find_label_id(self, lbl_reg: lr.LabelRegistry, label_name: str) -> str | None:
        """Find a label ID by its display name."""
        label = lbl_reg.async_get_label_by_name(label_name)
        return label.label_id if label else None

    def _clean_name(self, name: str) -> str:
        pattern = self._config.get("power_sensor_name_cleaner_regex", "")
        if pattern:
            try:
                return re.sub(pattern, "", name).strip()
            except re.error:
                pass
        return name

    def _apply_label_badge_texts(self, labels: list[str], device_label_text: dict) -> list[str]:
        result = []
        for category_map in device_label_text.values():
            for label_name, badge_text in category_map.items():
                if label_name in labels:
                    result.append(badge_text)
        return result
