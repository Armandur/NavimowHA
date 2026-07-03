"""Diagnostics support for Navimow (fork addition)."""
from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN

TO_REDACT = {
    "token",
    "access_token",
    "refresh_token",
    "mqtt_username",
    "mqtt_password",
    "serial_number",
    "mac_address",
}


def _to_dict(obj: Any) -> Any:
    """Serialize SDK dataclasses defensively."""
    if obj is None:
        return None
    to_dict = getattr(obj, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return repr(obj)


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    data = hass.data[DOMAIN][entry.entry_id]
    coordinators = data["coordinators"]

    devices: list[dict[str, Any]] = []
    for device in data["devices"]:
        coordinator = coordinators.get(device.id)
        if coordinator is None:
            continue
        devices.append(
            {
                "device": _to_dict(device),
                "state": _to_dict(coordinator.get_device_state()),
                "attributes": _to_dict(coordinator.get_device_attributes()),
                "location": coordinator.get_device_location(),
                "dock": coordinator.get_dock_position(),
                "last_event": _to_dict(coordinator.get_last_event()),
                "last_http_status": _to_dict(coordinator.get_last_http_status()),
                "last_command_result": coordinator.get_last_command_result(),
                "meta": (coordinator.data or {}).get("meta"),
                "mqtt_fresh": coordinator.is_mqtt_fresh(),
                "battery_refresh_seconds": coordinator.battery_refresh_seconds,
            }
        )

    return async_redact_data(
        {
            "entry_data": dict(entry.data),
            "options": dict(entry.options),
            "devices": devices,
        },
        TO_REDACT,
    )
