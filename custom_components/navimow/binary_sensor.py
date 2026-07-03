"""Binary sensor platform for Navimow integration (fork addition)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import NavimowCoordinator


@dataclass(frozen=True, kw_only=True)
class NavimowBinarySensorEntityDescription(BinarySensorEntityDescription):
    """Describes Navimow binary sensor entity."""

    value_fn: Callable[[NavimowCoordinator], bool | None]


def _charging(c: NavimowCoordinator) -> bool | None:
    state = c.get_device_state()
    return state.state == "charging" if state else None


def _problem(c: NavimowCoordinator) -> bool | None:
    state = c.get_device_state()
    return bool(state.error) if state else None


def _task_delayed(c: NavimowCoordinator) -> bool | None:
    loc = c.get_device_location()
    if not loc or loc.get("task_delay") is None:
        return None
    return bool(loc["task_delay"])


BINARY_SENSOR_DESCRIPTIONS: tuple[NavimowBinarySensorEntityDescription, ...] = (
    NavimowBinarySensorEntityDescription(
        key="charging",
        name="Charging",
        device_class=BinarySensorDeviceClass.BATTERY_CHARGING,
        value_fn=_charging,
    ),
    NavimowBinarySensorEntityDescription(
        key="problem",
        name="Problem",
        device_class=BinarySensorDeviceClass.PROBLEM,
        value_fn=_problem,
    ),
    NavimowBinarySensorEntityDescription(
        key="task_delayed",
        name="Task delayed",
        icon="mdi:weather-rainy",
        value_fn=_task_delayed,
    ),
    NavimowBinarySensorEntityDescription(
        key="mqtt_connected",
        name="Live data",
        device_class=BinarySensorDeviceClass.CONNECTIVITY,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda c: c.is_mqtt_fresh(),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Navimow binary sensors from a config entry."""
    data = hass.data[DOMAIN][config_entry.entry_id]
    devices = data["devices"]
    coordinators: dict[str, NavimowCoordinator] = data["coordinators"]

    entities = [
        NavimowBinarySensor(
            coordinator=coordinators[device.id],
            entity_description=description,
        )
        for device in devices
        for description in BINARY_SENSOR_DESCRIPTIONS
    ]
    async_add_entities(entities)


class NavimowBinarySensor(
    CoordinatorEntity[NavimowCoordinator], BinarySensorEntity
):
    """Representation of a Navimow binary sensor."""

    entity_description: NavimowBinarySensorEntityDescription
    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: NavimowCoordinator,
        entity_description: NavimowBinarySensorEntityDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = entity_description

        device = coordinator.device
        self._attr_unique_id = f"{DOMAIN}_{device.id}_{entity_description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, device.id)},
            name=device.name,
            manufacturer="Navimow",
            model=device.model or "Unknown",
            sw_version=device.firmware_version or None,
            serial_number=device.serial_number or device.id,
        )

    @property
    def available(self) -> bool:
        if self.coordinator.get_device_state() is not None:
            return True
        return super().available

    @property
    def is_on(self) -> bool | None:
        """Return binary state from coordinator."""
        return self.entity_description.value_fn(self.coordinator)
