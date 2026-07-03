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

**Extra status attributes.** The battery sensor exposes whatever extra fields
the status endpoint returns, as attributes (only when present):
`descriptive_level` (FULL/HIGH/…), `capacity_remaining`, `vehicle_state`,
`mowing_time`, `total_mowing_time`.

**Command verification.** After every start/pause/dock command the integration
queries the cloud's `responseCommands` endpoint (best effort) and exposes the
result as the `lawn_mower` entity's `last_command_result` attribute — useful
for automations that want to know a command was actually accepted.

**Map card v4** (`examples/gate-automation/navimow-map-card.js`) — three new
options, all backward-compatible:

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
```

See [`examples/gate-automation/SETUP.md`](examples/gate-automation/SETUP.md)
for the full card documentation, and [`NOTES.md`](NOTES.md) for research notes
on zone-specific mow commands, edge mowing, and `mowStartType`.

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
full walkthrough (it also includes a live position **map card**,
`navimow-map-card.js`).

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
  `dock_x`, and `dock_y` sensors (this fork)

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
