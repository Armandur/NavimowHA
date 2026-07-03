"""Device tracker platform for Navimow (fork addition).

Puts the mower on Home Assistant's map by transforming its local meter
coordinates to GPS through a 2-point calibration configured in the
integration's options (see geo.py). Without a complete calibration no
tracker entity is created.
"""
from __future__ import annotations

import logging

from homeassistant.components.device_tracker import SourceType
from homeassistant.components.device_tracker.config_entry import TrackerEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    CONF_GPS_REF1_LAT,
    CONF_GPS_REF1_LON,
    CONF_GPS_REF1_X,
    CONF_GPS_REF1_Y,
    CONF_GPS_REF2_LAT,
    CONF_GPS_REF2_LON,
    CONF_GPS_REF2_X,
    CONF_GPS_REF2_Y,
    DOMAIN,
    GPS_CALIBRATION_KEYS,
)
from .coordinator import NavimowCoordinator
from .geo import local_to_gps, solve_gps_calibration

_LOGGER = logging.getLogger(__name__)


def _calibration_from_options(options: dict) -> dict[str, float] | None:
    """Solve the GPS calibration from entry options, or None if incomplete."""
    if any(options.get(key) is None for key in GPS_CALIBRATION_KEYS):
        return None
    try:
        ref1 = tuple(
            float(options[key])
            for key in (
                CONF_GPS_REF1_X,
                CONF_GPS_REF1_Y,
                CONF_GPS_REF1_LAT,
                CONF_GPS_REF1_LON,
            )
        )
        ref2 = tuple(
            float(options[key])
            for key in (
                CONF_GPS_REF2_X,
                CONF_GPS_REF2_Y,
                CONF_GPS_REF2_LAT,
                CONF_GPS_REF2_LON,
            )
        )
    except (TypeError, ValueError):
        return None
    return solve_gps_calibration(ref1, ref2)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Navimow device trackers from a config entry."""
    calibration = _calibration_from_options(dict(config_entry.options))
    if calibration is None:
        _LOGGER.debug(
            "GPS calibration not configured; skipping device tracker setup"
        )
        return
    # Both frames are meters, so the solved scale should be ~1. A large
    # deviation almost always means swapped lat/lon or mixed-up references.
    if not 0.5 <= calibration["scale"] <= 2.0:
        _LOGGER.warning(
            "GPS calibration scale is %.2f (expected ~1.0) - check that the "
            "reference points pair the right local coordinates with the "
            "right latitude/longitude. Tracker not created.",
            calibration["scale"],
        )
        return

    data = hass.data[DOMAIN][config_entry.entry_id]
    devices = data["devices"]
    coordinators: dict[str, NavimowCoordinator] = data["coordinators"]

    async_add_entities(
        NavimowDeviceTracker(coordinators[device.id], calibration)
        for device in devices
    )


class NavimowDeviceTracker(CoordinatorEntity[NavimowCoordinator], TrackerEntity):
    """GPS position of a Navimow mower via calibrated local coordinates."""

    _attr_has_entity_name = True
    _attr_name = "Location"

    def __init__(
        self, coordinator: NavimowCoordinator, calibration: dict[str, float]
    ) -> None:
        super().__init__(coordinator)
        self._calibration = calibration

        device = coordinator.device
        self._attr_unique_id = f"{DOMAIN}_{device.id}_tracker"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, device.id)},
            name=device.name,
            manufacturer="Navimow",
            model=device.model or "Unknown",
            sw_version=device.firmware_version or None,
            serial_number=device.serial_number or device.id,
        )

    def _gps(self) -> tuple[float, float] | None:
        loc = self.coordinator.get_device_location()
        if not loc:
            return None
        x, y = loc.get("x"), loc.get("y")
        if x is None or y is None:
            return None
        return local_to_gps(self._calibration, x, y)

    @property
    def source_type(self) -> SourceType:
        return SourceType.GPS

    @property
    def latitude(self) -> float | None:
        gps = self._gps()
        return gps[0] if gps else None

    @property
    def longitude(self) -> float | None:
        gps = self._gps()
        return gps[1] if gps else None

    @property
    def extra_state_attributes(self) -> dict | None:
        loc = self.coordinator.get_device_location()
        if not loc or loc.get("x") is None:
            return None
        return {"local_x": loc.get("x"), "local_y": loc.get("y")}
