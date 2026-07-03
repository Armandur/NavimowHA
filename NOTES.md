# Research notes — open questions from the community

Findings from inspecting `navimow-sdk` 0.1.2 (the exact PyPI wheel this
integration depends on), the integration code, and public community sources.
Written 2026-07-03. Three questions were raised by toomasv on the HA community
forum: zone-specific mowing, edge/perimeter mowing, and the meaning of
`mowStartType`. None could be resolved to a working, verifiable command, so no
new service was added — this file records exactly what was checked.

## How commands actually reach the mower

- The HA integration sends all commands over **REST**, not MQTT:
  `MowerAPI.async_send_command()` POSTs to `/openapi/smarthome/sendCommands`
  with Google-smart-home-style payloads. SDK 0.1.2 maps exactly five commands:

  | `MowerCommand` | smarthome command | params |
  | --- | --- | --- |
  | START | `action.devices.commands.StartStop` | `{"on": true}` |
  | STOP | `action.devices.commands.StartStop` | `{"on": false}` |
  | PAUSE | `action.devices.commands.PauseUnpause` | `{"on": false}` |
  | RESUME | `action.devices.commands.PauseUnpause` | `{"on": true}` |
  | DOCK | `action.devices.commands.Dock` | — |

- The SDK also has an MQTT command path (`NavimowSDK._publish_command` →
  topic `navimow/{device_id}/command`), but it is a **stub**: the topic does
  not match the real broker's `/downlink/vehicle/{id}/realtimeDate/…` scheme,
  the SDK's own status/event topics next to it are marked `TODO`, and neither
  the integration nor the upstream project ever calls it. Do not build on it.
- The full REST surface in SDK 0.1.2: `/openapi/smarthome/authList`,
  `/openapi/smarthome/getVehicleStatus`, `/openapi/smarthome/sendCommands`,
  `/openapi/smarthome/responseCommands`, `/openapi/mqtt/userInfo/get/v2`.
- The cloud MQTT topics the SDK/integration subscribe to are telemetry only:
  `/downlink/vehicle/{id}/realtimeDate/state|event|attributes` (SDK) and
  `…/location` (this fork). No uplink/command topic was observed.

## (a) Mow a specific zone

**Not found** in the SDK or integration. Checked: every file in the
`navimow-sdk` 0.1.2 wheel for zone/partition/boundary parameters on the
command path (none — `partitionIds` only appears in *downlink* telemetry),
and the REST endpoint list above.

Update 2026-07-03: the integration now queries `responseCommands` after every
command (exposed as the `lawn_mower` entity's `last_command_result`
attribute), so real payload shapes from this endpoint will accumulate in a
live install — useful groundwork for testing the zone hypothesis below.

Untested hypothesis: Google's smart-home `StartStop` trait officially supports
`{"start": true, "zone": "<name>"}` / `"multipleZones"`, and the endpoint is
smarthome-shaped, so the backend *may* accept a zone or partition id there.
A loxforum thread claims the cloud API "offers everything the app can do"
including zone mowing, but publishes no payloads. Verifying requires a live
account: send `sendCommands` variations and watch `type:3 partitionIds` on the
location topic. Not done here (no credentials in this environment), which is
why no `mow_zone` service was added.

## (b) Edge / perimeter mowing on demand

**No trace.** Greps over the whole SDK for `edge`, `border`, `perimeter`,
`boundary` (case-insensitive) match only the telemetry field
`currentMowBoundary` (the partition being mowed, not edge cutting). If the
app triggers edge mowing via this API at all, it is not visible in SDK 0.1.2.

## (c) What does `mowStartType` mean?

The string `mowStartType` does **not** occur anywhere in `navimow-sdk` 0.1.2
or this integration. The only public sighting found is a loxforum post
(Loxone MQTT bridge for Navimow) showing `mowStartType = 0` in a cloud-data
dump alongside `mowingPercentage`, `mowingWeekArea` — i.e. it is a **device
attribute reported by the cloud**, most plausibly arriving on the
`…/realtimeDate/attributes` topic. This integration already exposes raw
attributes on the `lawn_mower` entity (`attributes` attribute), so the value
should be observable in Developer Tools while starting different task types
from the app (mow all vs. single zone vs. edge cut) — mapping those
observations to values is the concrete next step. Meaning of `0` unconfirmed.

Sources: [loxforum — Config Addon: Segway NaviMow](https://www.loxforum.com/forum/german/software-konfiguration-programm-und-visualisierung/485949-config-addon-segway-navimow)
