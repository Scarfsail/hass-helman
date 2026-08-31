from __future__ import annotations

import time

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    DOMAIN,
    GRID_EXPORT_PRICE_ENTITY_ID,
    GRID_IMPORT_PRICE_ENTITY_ID,
    SOLAR_REMAINING_TODAY_ENERGY_ENTITY_ID,
)

_HYSTERESIS_W: float = 5.0
_HYSTERESIS_MAX_GAP_S: float = 30.0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = hass.data[DOMAIN]["coordinator"]

    tree = await coordinator.get_device_tree()
    qualifying_nodes = coordinator.collect_qualifying_nodes(tree)

    battery_entities = (
        coordinator.config.get("power_devices", {})
        .get("battery", {})
        .get("entities", {})
    )
    required_battery_ids = [
        v for k, v in battery_entities.items()
        if k in {"remaining_energy", "capacity", "min_soc", "max_soc"} and v
    ]

    battery_time_to_full = HelmanBatteryTimeSensor(coordinator, entry, required_battery_ids, "charging")
    battery_time_to_empty = HelmanBatteryTimeSensor(coordinator, entry, required_battery_ids, "discharging")
    unmeasured_sensors: dict[str, HelmanUnmeasuredPowerSensor] = {
        node_id: HelmanUnmeasuredPowerSensor(coordinator, entry, node_id, parent_sensor_id)
        for node_id, parent_sensor_id in qualifying_nodes.items()
    }
    total_power = HelmanConsumptionTotalSensor(coordinator, entry)
    production_total = HelmanProductionTotalSensor(coordinator, entry)
    forecast_entities = [
        HelmanSolarForecastEnergySensor(coordinator, entry, "today", day_offset=0),
        HelmanSolarForecastEnergySensor(coordinator, entry, "tomorrow", day_offset=1),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d2", day_offset=2),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d3", day_offset=3),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d4", day_offset=4),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d5", day_offset=5),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d6", day_offset=6),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d7", day_offset=7),
        HelmanSolarForecastRemainingSensor(coordinator, entry),
    ]

    source_ratio_sensors: dict[str, HelmanSourceRatioSensor] = {
        node["powerSensorId"]: HelmanSourceRatioSensor(coordinator, entry, node["sourceType"])
        for node in tree.get("sources", [])
        if node.get("ratioSensorId") and node.get("powerSensorId") and node.get("sourceType")
    }

    coordinator.set_sensors(
        battery_time_to_full=battery_time_to_full,
        battery_time_to_empty=battery_time_to_empty,
        unmeasured_sensors=unmeasured_sensors,
        total_power=total_power,
        production_total=production_total,
        source_ratio_sensors=source_ratio_sensors,
        forecast_sensors=forecast_entities,
    )
    coordinator.set_entity_factory(
        entry,
        async_add_entities,
        lambda node_id, parent_id: HelmanUnmeasuredPowerSensor(
            coordinator, entry, node_id, parent_id
        ),
    )

    async_add_entities(
        [battery_time_to_full, battery_time_to_empty]
        + list(unmeasured_sensors.values())
        + [total_power, production_total]
        + list(source_ratio_sensors.values())
        + forecast_entities
    )

    house_consumption_forecast_current_sensor = HelmanHouseConsumptionForecastCurrentSensor(
        coordinator, entry,
    )
    async_add_entities([house_consumption_forecast_current_sensor])
    coordinator.register_house_consumption_forecast_current_sensor(
        house_consumption_forecast_current_sensor,
    )

    solar_forecast_current_sensors = [
        HelmanSolarForecastCurrentSensor(coordinator, entry),
        HelmanSolarForecastCurrentCorrectedSensor(coordinator, entry),
    ]
    async_add_entities(solar_forecast_current_sensors)
    coordinator.register_solar_forecast_current_sensors(solar_forecast_current_sensors)

    battery_forecast_current_sensors = [
        HelmanBatteryForecastSocCurrentSensor(coordinator, entry),
        HelmanBatteryForecastGridNetCurrentSensor(coordinator, entry),
        HelmanBatteryForecastGridImportCurrentSensor(coordinator, entry),
        HelmanBatteryForecastGridExportCurrentSensor(coordinator, entry),
        HelmanBatteryForecastBatteryNetCurrentSensor(coordinator, entry),
    ]
    async_add_entities(battery_forecast_current_sensors)
    coordinator.register_battery_forecast_current_sensors(
        battery_forecast_current_sensors
    )

    grid_import_price_sensor = HelmanGridImportPriceSensor(coordinator, entry)
    async_add_entities([grid_import_price_sensor])
    coordinator.register_grid_import_price_sensor(grid_import_price_sensor)

    grid_export_price_sensor = HelmanGridExportPriceSensor(coordinator, entry)
    async_add_entities([grid_export_price_sensor])
    coordinator.register_grid_export_price_sensor(grid_export_price_sensor)


class HelmanBatteryTimeSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES
    _unrecorded_attributes = frozenset({"target_time", "target_soc"})

    def __init__(
        self,
        coordinator,
        entry: ConfigEntry,
        required_entity_ids: list[str],
        direction: str,
    ) -> None:
        self._coordinator = coordinator
        self._required_entity_ids = required_entity_ids
        suffix = "to_full" if direction == "charging" else "to_empty"
        label = "Full" if direction == "charging" else "Empty"
        self._attr_unique_id = f"{entry.entry_id}_battery_{suffix}"
        self._attr_name = f"Helman Battery Time to {label}"
        self._minutes: float | None = None
        self._target_time_iso: str = ""
        self._target_soc: int | None = None

    @property
    def available(self) -> bool:
        if not self.hass:
            return False
        if not self._required_entity_ids:
            # No battery configured — sensor is present but will always show None/idle
            return True
        for entity_id in self._required_entity_ids:
            state = self.hass.states.get(entity_id)
            if state is None or state.state in ("unavailable", "unknown", "none"):
                return False
        return True

    @property
    def native_value(self) -> float | None:
        return round(self._minutes, 1) if self._minutes is not None else None

    @property
    def extra_state_attributes(self) -> dict:
        return {
            "target_time": self._target_time_iso,
            "target_soc": self._target_soc,
        }

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(
        self,
        minutes: float | None,
        target_time: str,
        target_soc: int | None,
    ) -> None:
        self._minutes = minutes
        self._target_time_iso = target_time
        self._target_soc = target_soc
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanUnmeasuredPowerSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"

    def __init__(
        self,
        coordinator,
        entry: ConfigEntry,
        node_id: str,
        parent_sensor_id: str | None,
    ) -> None:
        self._coordinator = coordinator
        self._parent_sensor_id = parent_sensor_id
        self._attr_unique_id = f"{entry.entry_id}_{node_id}_unmeasured_power"
        self._attr_name = f"Helman {node_id.replace('_', ' ').title()} Unmeasured Power"
        self._value: float | None = None

    @property
    def available(self) -> bool:
        if not self.hass or not self._parent_sensor_id:
            return False
        state = self.hass.states.get(self._parent_sensor_id)
        if state is None or state.state in ("unavailable", "unknown", "none"):
            return False
        try:
            float(state.state)
        except ValueError:
            return False
        return True

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def _should_emit(self, watts: float) -> bool:
        last = getattr(self, "_last_emit_value", None)
        last_ts = getattr(self, "_last_emit_ts", 0.0)
        now = time.monotonic()
        if last is None:
            return True
        if abs(watts - last) >= _HYSTERESIS_W:
            return True
        if now - last_ts >= _HYSTERESIS_MAX_GAP_S:
            return True
        return False

    def update_value(self, watts: float) -> None:
        if not self._should_emit(watts):
            return
        self._value = watts
        self._last_emit_value = watts
        self._last_emit_ts = time.monotonic()
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanConsumptionTotalSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_consumption_total"
        self._attr_name = "Helman Consumption Total"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def _should_emit(self, watts: float) -> bool:
        last = getattr(self, "_last_emit_value", None)
        last_ts = getattr(self, "_last_emit_ts", 0.0)
        now = time.monotonic()
        if last is None:
            return True
        if abs(watts - last) >= _HYSTERESIS_W:
            return True
        if now - last_ts >= _HYSTERESIS_MAX_GAP_S:
            return True
        return False

    def update_value(self, watts: float) -> None:
        if not self._should_emit(watts):
            return
        self._value = watts
        self._last_emit_value = watts
        self._last_emit_ts = time.monotonic()
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanProductionTotalSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_production_total"
        self._attr_name = "Helman Production Total"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def _should_emit(self, watts: float) -> bool:
        last = getattr(self, "_last_emit_value", None)
        last_ts = getattr(self, "_last_emit_ts", 0.0)
        now = time.monotonic()
        if last is None:
            return True
        if abs(watts - last) >= _HYSTERESIS_W:
            return True
        if now - last_ts >= _HYSTERESIS_MAX_GAP_S:
            return True
        return False

    def update_value(self, watts: float) -> None:
        if not self._should_emit(watts):
            return
        self._value = watts
        self._last_emit_value = watts
        self._last_emit_ts = time.monotonic()
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanSourceRatioSensor(SensorEntity):
    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "%"

    def __init__(self, coordinator, entry: ConfigEntry, source_type: str) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_{source_type}_source_ratio"
        self._attr_name = f"Helman {source_type.title()} Source Ratio"
        self.entity_id = f"sensor.helman_{source_type}_source_ratio"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return self._value

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(self, pct: float) -> None:
        self._value = round(pct, 1)
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanSolarForecastEnergySensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_native_unit_of_measurement = "kWh"
    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator,
        entry: ConfigEntry,
        key: str,
        *,
        day_offset: int,
    ) -> None:
        self._coordinator = coordinator
        self._day_offset = day_offset
        self.entity_id = f"sensor.helman_energy_production_{key}"
        self._attr_unique_id = f"{entry.entry_id}_energy_production_{key}"
        self._attr_translation_key = f"energy_production_{key}"

    @property
    def available(self) -> bool:
        return self._coordinator.get_solar_forecast_day_total(self._day_offset) is not None

    @property
    def native_value(self) -> float | None:
        return self._coordinator.get_solar_forecast_day_total(self._day_offset)


class HelmanSolarForecastRemainingSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_native_unit_of_measurement = "kWh"
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self.entity_id = SOLAR_REMAINING_TODAY_ENERGY_ENTITY_ID
        self._attr_unique_id = f"{entry.entry_id}_energy_production_today_remaining"
        self._attr_translation_key = "energy_production_today_remaining"

    @property
    def available(self) -> bool:
        return self._coordinator.get_solar_forecast_today_remaining() is not None

    @property
    def native_value(self) -> float | None:
        return self._coordinator.get_solar_forecast_today_remaining()


class HelmanHouseConsumptionForecastCurrentSensor(SensorEntity):
    """Publishes the forecasted house consumption for the *current* 15-min slot.

    The state value is the slot's energy expressed in Wh-per-hour (i.e. W).
    A slot forecast of 250 Wh is published as `1000` because 250 Wh / 0.25 h = 1000 Wh/h.
    Reading the recorder history of this entity over a past day yields a stair-step
    series of past forecast values, one step per slot.
    """

    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self.entity_id = "sensor.helman_house_consumption_forecast_current"
        self._attr_unique_id = f"{entry.entry_id}_house_consumption_forecast_current"
        self._attr_translation_key = "house_consumption_forecast_current"

    @property
    def available(self) -> bool:
        return self._coordinator.get_house_consumption_forecast_current_w() is not None

    @property
    def native_value(self) -> float | None:
        value = self._coordinator.get_house_consumption_forecast_current_w()
        if value is None:
            return None
        return round(value, 1)


class _HelmanSolarForecastCurrentSensorBase(SensorEntity):
    """The solar forecast for the *current* 15-minute slot, as energy.

    The number is the slot's own Wh — the same quantity, and the same figure,
    the inspector draws for that slot. It deliberately carries **no device
    class**, which looks like an omission and is not: Home Assistant permits
    ``SensorDeviceClass.ENERGY`` only alongside ``TOTAL`` or
    ``TOTAL_INCREASING`` (``sensor/const.py``), both of which describe a
    cumulative meter. This value rises and falls with the sun, so declaring one
    would have the recorder read every decrease as a meter reset and every
    increase as consumption.

    Nothing is lost by leaving it off. Statistics are gated on ``state_class``,
    and the recorder's ``_get_unit_class`` falls back to the *unit* when there
    is no device class, so ``Wh`` still resolves to the energy unit class and
    the series still converts.

    The alternative was to publish average power instead — a slot's 250 Wh is
    1000 W held for a quarter hour — which is what
    ``HelmanHouseConsumptionForecastCurrentSensor`` does and what this did
    first. It buys an overlay against live inverter
    power and costs the thing that matters more here: a reader comparing this
    against the inspector, or against the forecast attribute it comes from,
    would find neither number anywhere.

    The value is written on the slot-aligned refresh, so the recorded history is
    a stair-step of what the provider said about each slot *while that slot had
    not yet begun* — the same measurement the bias trainer is fitted to, and the
    reason this entity can replace a Helman-owned archive of it.
    """

    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "Wh"
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry: ConfigEntry, key: str) -> None:
        self._coordinator = coordinator
        self.entity_id = f"sensor.helman_solar_forecast_{key}"
        self._attr_unique_id = f"{entry.entry_id}_solar_forecast_{key}"
        self._attr_translation_key = f"solar_forecast_{key}"

    def _read(self) -> float | None:
        raise NotImplementedError

    @property
    def available(self) -> bool:
        return self._read() is not None

    @property
    def native_value(self) -> float | None:
        value = self._read()
        # Two decimals, not one: the source publishes slot energies like
        # 1244.25 Wh, and this entity is what the trainer reads its own past
        # from. Rounding harder here would quietly move the numbers the fit is
        # built on -- which publishing as power did not, a watt being a quarter
        # the size of a watt-hour per slot and so one decimal further along.
        return None if value is None else round(value, 2)


class HelmanSolarForecastCurrentSensor(_HelmanSolarForecastCurrentSensorBase):
    """The raw, pre-correction forecast for the current slot.

    This is the entity the bias trainer reads its own past from. It must stay
    raw: fitting a profile against an already corrected forecast folds the
    previous profile into the next one and the correction compounds run over
    run.
    """

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "current")

    def _read(self) -> float | None:
        return self._coordinator.get_solar_forecast_current_wh(corrected=False)


class HelmanSolarForecastCurrentCorrectedSensor(_HelmanSolarForecastCurrentSensorBase):
    """The same slot after the bias profile is applied.

    Exists so raw and corrected can be drawn against each other, and against
    actual production, in a plain Home Assistant history card. Deliberately not
    an input to anything Helman computes.
    """

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "current_corrected")

    def _read(self) -> float | None:
        return self._coordinator.get_solar_forecast_current_wh(corrected=True)


class _HelmanBatteryForecastCurrentSensorBase(SensorEntity):
    """One of the five battery-forecast series for the *current* 15-minute slot.

    Together these retire ``BatteryForecastHistoryStore``: the battery forecast
    snapshot only ever spans from the current slot forward, so once a slot has
    elapsed nothing else recorded what was predicted for it. Each sensor is
    written on the slot-aligned refresh, so its recorder history *is* that
    archive — exactly the move ``_HelmanSolarForecastCurrentSensorBase`` makes
    for the solar forecast.

    The four Wh members carry **no device class** for the reason that base class
    sets out in full: ``SensorDeviceClass.ENERGY`` is permitted only alongside
    ``TOTAL``/``TOTAL_INCREASING``, both of which describe a cumulative meter,
    and these values rise and fall — two of them are signed. Nothing is lost,
    because the recorder's unit fallback still resolves ``Wh`` to the energy
    unit class. The SoC member is an ordinary ``BATTERY`` percentage.

    Each subclass names the key it reads out of
    :meth:`HelmanCoordinator.get_battery_forecast_current`, which is the one
    place the snapshot-to-series derivation lives now that the store is gone.
    """

    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_has_entity_name = True

    #: The key this sensor reads out of the coordinator accessor's map.
    _snapshot_key: str

    def __init__(self, coordinator, entry: ConfigEntry, key: str) -> None:
        self._coordinator = coordinator
        self.entity_id = f"sensor.helman_battery_forecast_{key}"
        self._attr_unique_id = f"{entry.entry_id}_battery_forecast_{key}"
        self._attr_translation_key = f"battery_forecast_{key}"

    def _read(self) -> float | None:
        values = self._coordinator.get_battery_forecast_current()
        if not isinstance(values, dict):
            return None
        return values.get(self._snapshot_key)

    @property
    def available(self) -> bool:
        return self._read() is not None

    @property
    def native_value(self) -> float | None:
        value = self._read()
        # Two decimals, matching the sibling solar current-slot entity: the
        # source publishes slot energies at that precision and this is what a
        # history card draws them from.
        return None if value is None else round(value, 2)


class HelmanBatteryForecastSocCurrentSensor(_HelmanBatteryForecastCurrentSensorBase):
    """The forecast state of charge at the current slot."""

    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_native_unit_of_measurement = "%"
    _snapshot_key = "socPct"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "soc_current")


class HelmanBatteryForecastGridNetCurrentSensor(
    _HelmanBatteryForecastCurrentSensorBase
):
    """Net grid energy forecast for the current slot, positive when exporting."""

    _attr_native_unit_of_measurement = "Wh"
    _snapshot_key = "gridNetWh"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "grid_net_current")


class HelmanBatteryForecastGridImportCurrentSensor(
    _HelmanBatteryForecastCurrentSensorBase
):
    """Forecast grid import for the current slot, kept beside the net so a slot
    that both imports and exports — and money, which prices each side at its own
    rate — is not left to reconstruct it."""

    _attr_native_unit_of_measurement = "Wh"
    _snapshot_key = "gridImportWh"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "grid_import_current")


class HelmanBatteryForecastGridExportCurrentSensor(
    _HelmanBatteryForecastCurrentSensorBase
):
    """Forecast grid export for the current slot, the counterpart of the import
    side above."""

    _attr_native_unit_of_measurement = "Wh"
    _snapshot_key = "gridExportWh"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "grid_export_current")


class HelmanBatteryForecastBatteryNetCurrentSensor(
    _HelmanBatteryForecastCurrentSensorBase
):
    """Net battery energy forecast for the current slot, positive when charging."""

    _attr_native_unit_of_measurement = "Wh"
    _snapshot_key = "batteryNetWh"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "battery_net_current")


class HelmanGridImportPriceSensor(SensorEntity):
    """Publishes the grid import rate that applies right now.

    Helman derives this rate from the ``import_price_windows`` config table and
    is therefore its only source — no entity anywhere else holds it, so once a
    slot elapses there would be no record of what it cost. Publishing it as an
    ordinary sensor hands that job to the recorder, which is the component whose
    whole purpose is archiving sensor states; the inspector then samples this
    entity's history back at slot boundaries, the same pairing
    ``HelmanHouseConsumptionForecastCurrentSensor`` already uses.

    No device class. ``SensorDeviceClass.MONETARY`` describes an accumulating
    cost, and this is a rate — a price per kilowatt-hour, which does not add up
    over time. The unit comes from the config rather than being fixed here,
    since the tariff names its own currency.
    """

    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self.entity_id = GRID_IMPORT_PRICE_ENTITY_ID
        self._attr_unique_id = f"{entry.entry_id}_grid_import_price"
        self._attr_translation_key = "grid_import_price"

    @property
    def available(self) -> bool:
        return self._coordinator.get_grid_import_price_current() is not None

    @property
    def native_value(self) -> float | None:
        return self._coordinator.get_grid_import_price_current()

    @property
    def native_unit_of_measurement(self) -> str | None:
        return self._coordinator.get_grid_import_price_unit()


class HelmanGridExportPriceSensor(SensorEntity):
    """Mirrors the configured sell-price entity so the recorder archives the rate.

    The counterpart of :class:`HelmanGridImportPriceSensor`, and it exists for a
    neighbouring reason rather than the same one. The import rate has no entity
    at all behind it; the export rate does -- a third-party spot-price entity --
    but that entity typically declares no ``state_class``, so Home Assistant
    never compiles long-term statistics for it. The aggregate month and year
    views price history hour by hour off exactly those statistics, so an export
    could not be valued at all: every bucket reported no gain, honestly and
    uselessly.

    Publishing the same number under an entity Helman owns, with
    ``state_class = MEASUREMENT``, hands the archiving to the recorder for good.
    It also survives what the configured entity cannot promise: an upstream
    rename, or a change of ``state_class``, cannot silently empty the series
    Helman prices from.

    No device class, and the unit is taken from the mirrored entity rather than
    fixed -- both for the reasons spelled out on the import sensor.
    """

    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self.entity_id = GRID_EXPORT_PRICE_ENTITY_ID
        self._attr_unique_id = f"{entry.entry_id}_grid_export_price"
        self._attr_translation_key = "grid_export_price"

    @property
    def available(self) -> bool:
        return self._coordinator.get_grid_export_price_current() is not None

    @property
    def native_value(self) -> float | None:
        return self._coordinator.get_grid_export_price_current()

    @property
    def native_unit_of_measurement(self) -> str | None:
        return self._coordinator.get_grid_export_price_unit()
