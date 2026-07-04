"""DataUpdateCoordinator for Navimow integration."""
import asyncio
import logging
import time
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers import config_entry_oauth2_flow
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from mower_sdk.api import MowerAPI
from mower_sdk.models import (
    Device,
    DeviceAttributesMessage,
    DeviceEventMessage,
    DeviceStateMessage,
    DeviceStatus,
)
from mower_sdk.sdk import NavimowSDK

from .const import (
    DEFAULT_BATTERY_REFRESH_SECONDS,
    DEFAULT_HTTP_FALLBACK_SECONDS,
    DEFAULT_MQTT_STALE_SECONDS,
    DOMAIN,
    EVENT_NAVIMOW,
    UPDATE_INTERVAL,
)
from .location import DOCKED_STATES, update_dock_estimate

_LOGGER = logging.getLogger(__name__)

# Coordinators poll on their own schedules; fetches landing within this many
# seconds of each other share one batched getVehicleStatus request.
FETCH_DEDUP_WINDOW = 10


class NavimowStatusFetcher:
    """Batched HTTP status fetch shared by all coordinators of an entry.

    Every device's status comes back from one getVehicleStatus call, so with
    multiple mowers the periodic battery refresh costs a single request
    instead of one per device.
    """

    def __init__(self, api: MowerAPI, device_ids: list[str]) -> None:
        self._api = api
        self._device_ids = device_ids
        self._lock = asyncio.Lock()
        self._statuses: dict[str, DeviceStatus] = {}
        self._fetched_at: float | None = None

    async def async_get(self, device_id: str) -> DeviceStatus | None:
        """Status for one device, fetching all at most once per dedup window."""
        async with self._lock:
            now = time.monotonic()
            if self._fetched_at is None or now - self._fetched_at > FETCH_DEDUP_WINDOW:
                self._statuses = await self._api.async_get_device_statuses(
                    self._device_ids
                )
                self._fetched_at = time.monotonic()
            return self._statuses.get(device_id)


class NavimowCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator for Navimow data updates."""

    def __init__(
        self,
        hass: HomeAssistant,
        sdk: NavimowSDK,
        api: MowerAPI,
        device: Device,
        oauth_session: config_entry_oauth2_flow.OAuth2Session | None = None,
        battery_refresh_seconds: int = DEFAULT_BATTERY_REFRESH_SECONDS,
        status_fetcher: NavimowStatusFetcher | None = None,
        mqtt_stale_seconds: int = DEFAULT_MQTT_STALE_SECONDS,
        http_fallback_seconds: int = DEFAULT_HTTP_FALLBACK_SECONDS,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.sdk = sdk
        self.api = api
        self.device = device
        self.oauth_session = oauth_session
        self.battery_refresh_seconds = battery_refresh_seconds
        self.mqtt_stale_seconds = mqtt_stale_seconds
        self.http_fallback_seconds = http_fallback_seconds
        self._status_fetcher = status_fetcher
        self._last_http_status: DeviceStatus | None = None
        self._last_command_result: dict[str, Any] | None = None
        self.data: dict[str, Any] = {}
        self._last_state: DeviceStateMessage | None = None
        self._last_attributes: DeviceAttributesMessage | None = None
        self._last_event: DeviceEventMessage | None = None
        self._last_location: dict[str, Any] | None = None
        self._dock: dict[str, Any] | None = None  # learned {"x","y","n"}
        self._last_mqtt_update: float | None = None
        # State freshness tracked separately from general MQTT activity: while
        # docked/charging the server sends only attribute packets, which must
        # NOT keep the state timer alive or the HTTP fallback never fires and
        # activity/battery freeze (upstream PR #60).
        self._last_mqtt_state_update: float | None = None
        self._last_http_fetch: float | None = None
        self._last_data_source: str | None = None

    async def async_setup(self) -> None:
        """Register callbacks from SDK."""
        self.sdk.on_state(self._handle_state)
        self.sdk.on_attributes(self._handle_attributes)
        self.sdk.on_event(self._handle_event)

    def _build_data(self) -> dict[str, Any]:
        return {
            "device": self.device,
            "state": self._last_state,
            "attributes": self._last_attributes,
            "location": self._last_location,
            "meta": {
                "last_data_source": self._last_data_source,
                "last_mqtt_update_monotonic": self._last_mqtt_update,
                "last_mqtt_state_update_monotonic": self._last_mqtt_state_update,
                "last_http_fetch_monotonic": self._last_http_fetch,
            },
        }

    def _device_status_to_state(self, status: DeviceStatus) -> DeviceStateMessage:
        error: dict[str, Any] | None = None
        if status.error_code and status.error_code.value != "none":
            error = {
                "code": status.error_code.value,
                "message": status.error_message,
            }
        return DeviceStateMessage(
            device_id=status.device_id,
            timestamp=status.timestamp,
            state=status.status.value,
            battery=status.battery,
            signal_strength=status.signal_strength,
            position=status.position,
            error=error,
            metrics=None,
        )

    async def _async_ensure_valid_token(self) -> str | None:
        if not self.oauth_session:
            return None
        try:
            token: dict[str, Any] | None
            if hasattr(self.oauth_session, "async_ensure_token_valid"):
                await self.oauth_session.async_ensure_token_valid()
                token = self.oauth_session.token
            elif hasattr(self.oauth_session, "async_get_valid_token"):
                token = await self.oauth_session.async_get_valid_token()
            else:
                token = self.oauth_session.token
        except ConfigEntryAuthFailed:
            # 确定性认证失败（refresh_token 缺失或被服务端拒绝）→ 直接上报，让 HA 引导用户重新认证
            raise
        except Exception as err:
            # 瞬态错误（网络超时、DNS 等）→ 不立即触发重新认证流程。
            # 尝试沿用缓存中的 access_token；若缓存也不可用才升级为认证失败。
            _LOGGER.warning(
                "Token refresh failed (likely transient), falling back to cached token: %s", err
            )
            cached = getattr(self.oauth_session, "token", None)
            if cached and cached.get("access_token"):
                token = cached
            else:
                raise ConfigEntryAuthFailed(
                    f"Token refresh failed and no cached token available: {err}"
                ) from err
        if not token or not token.get("access_token"):
            raise ConfigEntryAuthFailed("No access token after refresh")
        access_token = token["access_token"]
        self.api.set_token(access_token)
        return access_token

    async def _async_update_data(self) -> dict[str, Any]:
        # 每次 update 都主动刷新 token，确保 api._token 与 oauth_session 保持同步。
        # 若仅在 HTTP fallback 时刷新，MQTT 正常推数据期间 token 长期不更新，
        # 过期后用户下发指令会立即收到 CODE_OAUTH_INFO_ILLEGAL。
        try:
            await self._async_ensure_valid_token()
        except ConfigEntryAuthFailed:
            raise

        cached_state = self.sdk.get_cached_state(self.device.id)
        if cached_state is not None:
            self._last_state = cached_state
            self._last_data_source = "mqtt_cache"

        cached_attrs = self.sdk.get_cached_attributes(self.device.id)
        if cached_attrs is not None:
            self._last_attributes = cached_attrs

        now = time.monotonic()
        # Drive the fallback off STATE freshness, not general MQTT activity:
        # while docked/charging only attribute packets arrive, and counting
        # those would keep the timer alive and suppress the fallback (PR #60).
        is_state_stale = (
            self._last_mqtt_state_update is None
            or now - self._last_mqtt_state_update > self.mqtt_stale_seconds
        )
        can_http_fetch = (
            self._last_http_fetch is None
            or now - self._last_http_fetch > self.http_fallback_seconds
        )
        # Even while state is fresh (mowing), the battery reading can lag; poll
        # the HTTP status endpoint at battery_refresh_seconds (0 = off) to top
        # up just the battery.
        battery_due = self.battery_refresh_seconds > 0 and (
            self._last_http_fetch is None
            or now - self._last_http_fetch > self.battery_refresh_seconds
        )
        if (is_state_stale and can_http_fetch) or battery_due:
            try:
                if self._status_fetcher is not None:
                    status = await self._status_fetcher.async_get(self.device.id)
                else:
                    status = await self.api.async_get_device_status(self.device.id)
                self._last_http_fetch = now
                if status is None:
                    _LOGGER.warning(
                        "No status for device %s in batched response", self.device.id
                    )
                else:
                    self._last_http_status = status
                    http_state = self._device_status_to_state(status)
                    if is_state_stale or self._last_state is None:
                        self._last_state = http_state
                        self._last_data_source = "http_fallback"
                    elif http_state.battery is not None:
                        # MQTT state is fresh — only refresh the slow-moving
                        # battery reading, keep the live state/activity intact
                        self._last_state.battery = http_state.battery
            except ConfigEntryAuthFailed:
                raise
            except Exception as err:
                _LOGGER.warning(
                    "HTTP fallback failed for device %s: %s", self.device.id, err
                )

        _LOGGER.debug(
            "Coordinator update: device=%s source=%s mqtt_ts=%s http_ts=%s",
            self.device.id,
            self._last_data_source,
            self._last_mqtt_update,
            self._last_http_fetch,
        )
        self.data = self._build_data()
        return self.data

    def _handle_state(self, state: DeviceStateMessage) -> None:
        if state.device_id != self.device.id:
            return
        _LOGGER.debug(
            "MQTT state received: device=%s state=%s battery=%s",
            state.device_id,
            state.state,
            state.battery,
        )
        now = time.monotonic()
        self._last_mqtt_update = now
        self._last_mqtt_state_update = now
        self._last_data_source = "mqtt_push"
        self.hass.loop.call_soon_threadsafe(self._update_from_state, state)

    def _handle_attributes(self, attrs: DeviceAttributesMessage) -> None:
        if attrs.device_id != self.device.id:
            return
        _LOGGER.debug(
            "MQTT attributes received: device=%s keys=%d",
            attrs.device_id,
            len(getattr(attrs, "__dict__", {}) or {}),
        )
        self._last_mqtt_update = time.monotonic()
        self.hass.loop.call_soon_threadsafe(self._update_from_attributes, attrs)

    def _update_from_state(self, state: DeviceStateMessage) -> None:
        self._last_state = state
        self._last_data_source = "mqtt_push"
        self.async_set_updated_data(self._build_data())

    def _update_from_attributes(self, attrs: DeviceAttributesMessage) -> None:
        self._last_attributes = attrs
        self.async_set_updated_data(self._build_data())

    def _handle_event(self, event: DeviceEventMessage) -> None:
        if event.device_id != self.device.id:
            return
        _LOGGER.debug(
            "MQTT event received: device=%s event=%s level=%s",
            event.device_id,
            event.event,
            event.level,
        )
        self._last_mqtt_update = time.monotonic()
        self.hass.loop.call_soon_threadsafe(self._update_from_event, event)

    def _update_from_event(self, event: DeviceEventMessage) -> None:
        """Store the event, notify entities, and fire it on the HA bus."""
        self._last_event = event
        self.hass.bus.async_fire(
            EVENT_NAVIMOW,
            {
                "device_id": self.device.id,
                "device_name": self.device.name,
                "type": event.type,
                "event": event.event,
                "level": event.level,
                "message": event.message,
                "params": event.params,
                "timestamp": event.timestamp,
            },
        )
        self.async_set_updated_data(self._build_data())

    def ingest_location(self, location: dict) -> None:
        if not isinstance(location, dict):
            return
        if location.get("device_id") not in (None, self.device.id):
            return
        self._last_location = location
        self._maybe_learn_dock(location)
        self.async_set_updated_data(self._build_data())

    def _maybe_learn_dock(self, location: dict) -> None:
        """Average pose samples into the dock estimate while docked/charging."""
        state = self._last_state
        status = (state.state or "").lower() if state else ""
        x, y = location.get("x"), location.get("y")
        if status in DOCKED_STATES and x is not None and y is not None:
            self._dock = update_dock_estimate(self._dock, x, y)

    def get_dock_position(self) -> dict | None:
        """Learned dock position {"x","y","n"}, or None if never seen docked."""
        return self._dock

    def get_last_http_status(self) -> DeviceStatus | None:
        """Full DeviceStatus from the latest HTTP poll (extra fields intact)."""
        return self._last_http_status

    def get_last_event(self) -> DeviceEventMessage | None:
        """Most recent MQTT device event (not persisted across restarts)."""
        return self._last_event

    def is_mqtt_fresh(self) -> bool:
        """True while MQTT state pushes are arriving within the stale window."""
        return (
            self._last_mqtt_state_update is not None
            and time.monotonic() - self._last_mqtt_state_update
            <= self.mqtt_stale_seconds
        )

    def set_last_command_result(self, result: dict[str, Any] | None) -> None:
        """Store the responseCommands entry for the most recent command."""
        self._last_command_result = result

    def get_last_command_result(self) -> dict[str, Any] | None:
        return self._last_command_result

    def get_device_location(self) -> dict | None:
        return self.data.get("location")

    def get_device_state(self) -> DeviceStateMessage | None:
        return self.data.get("state")

    def get_device_attributes(self) -> DeviceAttributesMessage | None:
        return self.data.get("attributes")

    def get_device_info(self) -> Any | None:
        return self.data.get("device")
