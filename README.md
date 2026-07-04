# Navimow for Home Assistant — position & zone fork

<p align="center">
  <img src="https://fra-navimow-prod.s3.eu-central-1.amazonaws.com/img/navimowhomeassistant.png" width="600">
</p>

Monitor and control Navimow robotic mowers in Home Assistant.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Armandur&repository=NavimowHA&category=Integration)

> **This is a fork of [pgoutsos/NavimowHA](https://github.com/pgoutsos/NavimowHA),
> itself a fork of [segwaynavimow/NavimowHA](https://github.com/segwaynavimow/NavimowHA).**
> See [Credits](#credits-) for the full lineage. On top of the position/zone
> sensors it adds a multi-session map card with mow controls and a
> configurable battery refresh. See
> [What this fork adds](#what-this-fork-adds-) below.

## What this fork adds ✨

The official integration exposes a `lawn_mower` entity and a battery sensor. The
mower also continuously publishes its **live pose and current map partition**
over MQTT (topic `/downlink/vehicle/{id}/realtimeDate/location`), but the bundled
`navimow-sdk` neither subscribes to that topic nor parses it, so none of it
reaches Home Assistant.

This fork makes the integration subscribe to that topic and turn it into
entities, giving you these **additional sensors** per mower (populated while the
mower is active):

| Entity | Meaning |
| --- | --- |
| `sensor.<mower>_zone` | Target partition id — the zone the current task is headed for (set at task start; empty for "mow all") |
| `sensor.<mower>_position_x` | X position in meters (local grid; origin = the RTK/mapping reference, usually *near* the dock) |
| `sensor.<mower>_position_y` | Y position in meters |
| `sensor.<mower>_heading` | Mower orientation in degrees (0–360) |
| `sensor.<mower>_mowing_zone` | Partition id the mower is *physically* mowing right now (works for "mow all" too) |
| `sensor.<mower>_mow_progress` | Planned-route progress for the current zone, 0–10000 (10000 = zone complete; not the app's coverage %) |
| `sensor.<mower>_dock_x` / `_dock_y` | Dock position in meters — auto-learned by averaging the mower's pose while docked/charging; survives restarts. `unknown` until the mower has docked once. Used by the example map card to place the dock marker (the coordinate origin is **not** reliably the dock) |

These unlock zone-aware and position-aware automations — for example opening a
gate when the mower crosses between zones, geofencing, or live mapping. The
coordinates are a **local Cartesian grid in meters**, not latitude/longitude.

### Added in this fork (Armandur)

**Configurable battery refresh.** MQTT state messages arrive rarely (mostly on
state transitions), so the battery sensor could lag by hours. The integration
now polls the HTTP status endpoint to refresh the battery reading —
default every **120 seconds**, configurable in Settings → Devices & Services →
Navimow → Configure (`battery_refresh_seconds`, `0` disables polling).
The poll is **batched**: all mowers of an account share one
`getVehicleStatus` request per refresh.

**Freshness/fallback timing (configurable).** While docked or charging the
server stops sending MQTT *state* messages (only attribute packets keep
arriving), which used to freeze the activity/battery for hours. State
freshness is now tracked separately from attribute traffic (upstream
[PR #60](https://github.com/segwaynavimow/NavimowHA/pull/60)), and three
timings are exposed in the options (defaults lowered so entities recover
within a minute):

| Option | Default | Meaning |
| --- | --- | --- |
| `mqtt_stale_seconds` | `90` | How long since the last MQTT *state* push before the HTTP fallback engages. |
| `http_fallback_seconds` | `60` | Minimum interval between HTTP status polls. |
| `mqtt_keepalive_seconds` | `120` | MQTT PINGREQ interval (faster half-open TCP detection). |

**Extra status attributes.** The battery sensor exposes whatever extra fields
the status endpoint returns, as attributes (only when present):
`descriptive_level` (FULL/HIGH/…), `capacity_remaining`, `vehicle_state`,
`mowing_time`, `total_mowing_time`.

**Command verification.** After every start/pause/dock command the integration
queries the cloud's `responseCommands` endpoint (best effort) and exposes the
result as the `lawn_mower` entity's `last_command_result` attribute — useful
for automations that want to know a command was actually accepted.

**Device events on the HA bus.** Every MQTT device event (stuck, lifted,
rain delay, …) is fired as a `navimow_event` on the event bus with
`device_id`, `device_name`, `type`, `event`, `level`, `message`, `params`
and `timestamp` — use it as an automation trigger:

```yaml
trigger:
  - platform: event
    event_type: navimow_event
```

A `Last event` sensor shows the most recent event with details as attributes.

**Binary sensors.** Per mower: `charging` (raw status, which the
`lawn_mower` activity hides by mapping charging → docked), `problem` (device
reports an error), `task_delayed` (rain/schedule delay from the location
stream) and a diagnostic `live_data` (MQTT push data currently arriving).

**Diagnostics.** Settings → Devices & Services → Navimow → Download
diagnostics gives a redacted dump of state, location, dock estimate, last
event/command result and coordinator metadata for issue reports.

**Device tracker (GPS).** Configure a 2-point calibration in the
integration options (Settings → Devices & Services → Navimow → Configure)
to put the mower on Home Assistant's map. Each reference point pairs local
mower coordinates with the same spot's latitude/longitude:

1. **Reference 1 — the dock**: local X/Y from the `dock_x`/`dock_y` sensors,
   lat/lon read from Google Maps (right-click the dock → copy coordinates).
2. **Reference 2 — any landmark** as far away as practical: park the mower
   there and read `position_x`/`position_y`, then the spot's lat/lon.

The `device_tracker.<name>_location` entity is created once all eight
fields are set (a warning is logged and the tracker skipped if the
calibration looks wrong, e.g. swapped lat/lon). This enables zone/geofence
automations without the custom map card.

**Map card v4** ([`map-card/`](map-card/)) — new options, all
backward-compatible:

```yaml
type: custom:navimow-map-card
# ... entities as before ...
session_count: 6        # default 5 — completed sessions drawn in grey behind
                        #   the current one; 0 = pre-v4 current-session-only
show_controls: true     # default true — Mow / Pause / Dock buttons that call
                        #   lawn_mower.start_mowing / pause / dock
zone_names:             # map partition ids to friendly names in the footer;
  "3": Left street      #   unmapped ids show as the raw id
  "5": Right street
  "13": Yard
marker_image: /local/mower.png  # v4.1: photo marker instead of the dot; the
                                #   image must point UP and rotates with the
                                #   mower's heading
marker_size: 60                 # marker size in map units (viewBox is 1000)
```

See [`map-card/README.md`](map-card/README.md) for the full card
documentation (including ready-made marker images under
[`map-card/markers/`](map-card/markers/)), and [`NOTES.md`](NOTES.md) for
research notes on zone-specific mow commands, edge mowing, and
`mowStartType`.

### How it works

No changes to `navimow-sdk` are required — this fork is self-contained and works
against the stock SDK from PyPI:

* On MQTT connect, the integration subscribes to the `…/realtimeDate/location`
  topic for each device.
* Incoming location messages (a JSON array of objects keyed by `type`:
  `1` = pose, `3` = partition/zone, `4` = task-delay) are decoded in
  `location.py` and merged into a per-device record, so a pose update never
  wipes the last-known zone.
* The record is pushed to the coordinator and exposed via the four sensors above.

Because the location stream is delivered through Segway's cloud, these sensors
update only while the mower is active and depend on internet connectivity. Build
any safety-critical automation (e.g. a gate) with a fallback on the mower
`status` and a physical sensor.

## Examples 📦

[`examples/gate-automation/`](examples/gate-automation/) contains a complete,
parameterized package that uses the zone/position sensors to **automatically open
a gate** so the mower can reach zones on the far side of the gate from its dock,
and close it again once docked. See
[`examples/gate-automation/SETUP.md`](examples/gate-automation/SETUP.md) for the
full walkthrough. The live position **map card** lives separately in
[`map-card/`](map-card/).

## Prerequisites 📋

- **Home Assistant** minimum version **2026.1.0**
- A **Navimow account** that can sign in to the official app (used for authorization)

## Installation 🛠️

This integration is not in the default HACS store; add this fork as a custom
repository:

1. HACS → top-right menu → **Custom repositories**
2. Repository: `https://github.com/Armandur/NavimowHA`
3. Category: **Integration**
4. Search for `Navimow` in HACS and download it
5. Restart Home Assistant
6. Settings → Devices & Services → Add Integration → search `Navimow`

**Switching from the official integration?** In HACS, **Remove** the existing
Navimow download first (this deletes the files but keeps your configured device
and login), then add this fork as above and download it. Do **not** delete the
Navimow integration from Settings → Devices & Services, or you'll have to
re-authenticate.

## Usage 🎮

After setup you should see:

- A `lawn_mower` entity (start / pause / dock)
- A battery `sensor`
- `zone`, `position_x`, `position_y`, `heading`, `mowing_zone`, `mow_progress`,
  `dock_x`, `dock_y`, and `last_event` sensors (this fork)
- `charging`, `problem`, `task_delayed`, and `live_data` binary sensors
  (this fork)
- A `device_tracker` once GPS calibration is configured (this fork)

The position/zone sensors show `unknown` while docked and begin updating once
the mower starts moving. The dock sensors are the opposite: they learn (and
refine) the dock position *while* the mower sits docked/charging, keep their
value across restarts, and read `unknown` only until the first docking after
install — their `samples`/`source` attributes show the learning state.

See the upstream [Getting Started](https://github.com/segwaynavimow/NavimowHA/wiki/Getting-Started)
guide for general setup.

## Troubleshooting 🔧

Check the Home Assistant logs for error messages, and:

- Ensure the mower is connected to your network and reachable from Home Assistant.
- Restart Home Assistant and check if the issue persists.
- Make sure you are not blocking network access to Segway's services.
- If you use DNS filtering/ad-blocking, try disabling it temporarily.

If the position/zone sensors never populate while mowing, enable debug logging
for `mower_sdk.mqtt` (Developer Tools → Actions → `logger.set_level`) and confirm
that `…/realtimeDate/location` messages are arriving.

## Navimow SDK Library 📚

This integration uses the `navimow-sdk` package to communicate with Navimow
mowers. This fork does **not** modify the SDK.

## Credits 🙏

| Who | What |
| --- | --- |
| [segwaynavimow](https://github.com/segwaynavimow/NavimowHA) | The original official integration — all credit for the base integration goes to the Segway Navimow team |
| [pgoutsos](https://github.com/pgoutsos/NavimowHA) | The position/zone fork: real-time position, zone, heading, dock sensors, the gate-automation example, and map card v1–v3 |
| toomasv (HA community forum) | Inspiration and reference implementation for the v4 card's multi-session trails, mow controls, zone names, and the faster battery refresh |
| [Armandur](https://github.com/Armandur/NavimowHA) | This fork: map card v4, configurable battery refresh interval |

## Relationship to upstream & contributing back

This fork tracks [pgoutsos/NavimowHA](https://github.com/pgoutsos/NavimowHA),
which tracks [segwaynavimow/NavimowHA](https://github.com/segwaynavimow/NavimowHA).
The position/zone functionality is a candidate for upstreaming — if/when the
official integration adds it natively, this fork can be retired in favor of the
official release. Issues and PRs specific to this fork's additions can be
filed against this repository; general integration issues belong upstream.
