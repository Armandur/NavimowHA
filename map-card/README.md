# Navimow map card

`navimow-map-card.js` (v4.1) is a self-contained Lovelace custom card that
plots the mower's live position, heading, the path of the **current mowing
session** in the accent color, and the last N **completed sessions** in muted
grey — optionally over a calibrated satellite image of your property. It can
show Mow / Pause / Dock buttons and draw a photo of your mower as the marker.
No external dependencies.

All session paths are rebuilt from Home Assistant's recorder each time the
card loads (it finds the docked → mowing(→ docked) cycles within
`history_hours` and replays the position history for each), so they survive
page reloads and show the same paths on every device. When a new session
starts, the finished path becomes a grey session and the current one resets.
Requires the recorder (on by default) to be recording the position sensors;
if it isn't, the card falls back to a live-only trail.

Requires the position/zone sensors from this fork's integration
(`position_x/_y`, `heading`, `zone`, `dock_x/_y`).

## Install

1. Copy the card to `<config>/www/`:

   ```bash
   wget -O /config/www/navimow-map-card.js \
     https://raw.githubusercontent.com/Armandur/NavimowHA/main/map-card/navimow-map-card.js
   ```

2. Settings → Dashboards → ⋮ → Resources → add `/local/navimow-map-card.js?v=1`
   as a **JavaScript Module** (bump `?v=N` whenever you update the file — it
   dodges the frontend cache).
3. Add a card: `type: custom:navimow-map-card`.

## Options

All optional; defaults shown.

| Option | Default | Meaning |
| --- | --- | --- |
| `title` | `Navimow Map` | Card header. |
| `x_entity` / `y_entity` | `sensor.peter_griffin_position_x/_y` | Position sensors (meters, local grid). |
| `heading_entity` | `sensor.peter_griffin_heading` | Heading sensor (degrees). |
| `zone_entity` | `sensor.navimow_current_zone` | Zone shown in the footer. |
| `status_entity` | `lawn_mower.peter_griffin` | Drives session detection and the control buttons. |
| `battery_entity` | — | Battery percentage in the footer. |
| `trail_length` | `2000` | Max points kept per session (older points are thinned, not dropped, so paths keep their shape). |
| `history_hours` | `24` | How far back the recorder is searched for session starts. |
| `session_count` | `5` | Completed sessions drawn in grey behind the current one. `0` = current session only. |
| `show_controls` | `true` | Mow / Pause / Dock buttons calling `lawn_mower.start_mowing` / `pause` / `dock` on `status_entity`. |
| `zone_names` | — | Map of zone/partition id → friendly name for the footer; unmapped ids show as the raw id. Also matches the states `unknown`/`unavailable` (the zone is `unknown` during a "mow all" task), so `zone_names: {unknown: Okänd}` translates those too. |
| `marker_image` | — | Image drawn as the mower marker instead of the dot, e.g. `/local/i208_awd.png`. Must depict the mower **pointing up**; it rotates smoothly with the heading. See [markers/](markers/). |
| `marker_size` | `60` | Marker image size in map units (the map viewBox is 1000 wide). |
| `labels` | — | Override any UI string (English defaults). Keys: `mow`, `pause`, `dock` (buttons); `zone`, `status`, `position`, `battery` (footer); `dock_marker` (text by the dock marker, `""` hides it). Set only the keys you want to change. |
| `status_names` | — | Map raw mower status → display text (`docked`, `mowing`, `paused`, `returning`, `charging`, `error`); unmapped statuses show raw. |
| `dock_image` | — | Image for the dock marker instead of the circle, e.g. `/local/dock.png`. |
| `dock_size` | `40` | Dock image size in map units. |
| `dock_x_entity` / `dock_y_entity` | auto | Integration dock sensors; derived from `x_entity`/`y_entity` names when unset. |
| `dock_x` / `dock_y` | — | Manual dock override in meters (both must be set; disables auto-learning). |
| `dock_samples` | `25` | Rolling samples averaged while docked (local-learning fallback). |
| `overlay_image` | — | Satellite/aerial image of your property under `/config/www`. |
| `overlay_opacity` | `0.9` | Overlay opacity. |
| `calibration` | — | Exactly 2 reference points mapping mower meters to image pixels (see below). |
| `straighten` | `true` | Draw the overlay upright and rotate the trail into it; `false` keeps the mower's frame (tilted image). |

Full example:

```yaml
type: custom:navimow-map-card
title: Navimow map
x_entity: sensor.tont_position_x
y_entity: sensor.tont_position_y
heading_entity: sensor.tont_heading
zone_entity: sensor.tont_zone
status_entity: lawn_mower.tont
battery_entity: sensor.tont_battery
dock_x_entity: sensor.tont_dock_x
dock_y_entity: sensor.tont_dock_y
trail_length: 2000
history_hours: 48
session_count: 6
show_controls: true
zone_names:
  "3": Left street
  "5": Right street
  "13": Yard
marker_image: /local/i208_awd.png
marker_size: 60
```

### Localizing the labels

The card is English by default. Translate any subset via `labels` and
`status_names` — for example, in Swedish:

```yaml
labels:
  mow: Klipp
  pause: Pausa
  dock: Ladda
  zone: Zon
  battery: Batteri
  dock_marker: Laddstation
status_names:
  mowing: Klipper
  docked: Dockad
  paused: Pausad
  returning: Återvänder
  charging: Laddar
  error: Fel
```

## Marker images

[`markers/`](markers/) holds top-view images of Navimow models, oriented
**front up** as the card expects, for use with `marker_image`:

| File | Model |
| --- | --- |
| `i208_awd.png` | Navimow i208 AWD |

```bash
wget -O /config/www/i208_awd.png \
  https://raw.githubusercontent.com/Armandur/NavimowHA/main/map-card/markers/i208_awd.png
```

Contributions of more models are welcome — PNG with transparent background,
front pointing up, ~512 px tall.

## Satellite / aerial overlay

The card can draw the mower on top of an image of your property. You need the
image plus **two calibration points** (spots whose mower-meter coordinates AND
image-pixel coordinates you know — they determine scale, rotation, and offset,
so the image doesn't need to be north-up):

1. Take a satellite screenshot of your property (Google Maps, county GIS, or a
   drone photo), crop it, and save it to `<config>/www/yard.png`.
2. **Point 1 — the dock.** Its meter coordinates are the `dock_x`/`dock_y`
   sensors; find the dock in the image and note its pixel x/y (most image
   viewers show pixel coordinates; macOS Preview: Tools → Show Inspector).
3. **Point 2 — any landmark** as far from the dock as practical. Park the mower
   on it (or watch live during a mow) and read `position_x`/`position_y`, then
   note the same spot's pixel coordinates in the image.
4. Configure the card:

   ```yaml
   type: custom:navimow-map-card
   overlay_image: /local/yard.png
   overlay_opacity: 0.9
   calibration:
     - m: [0.0, 0.0]        # dock: [dock_x, dock_y] in meters
       px: [512, 800]       # dock: pixel [x, y] in the image
     - m: [12.4, -3.1]      # landmark: [position_x, position_y]
       px: [220, 410]       # landmark: pixel [x, y]
   ```

You do **not** need to rotate or north-align the image first — the two
reference points encode scale, rotation and offset. The view auto-fits to the
whole image, which is drawn upright; the mower's trail and heading are rotated
into the image's frame (the mower's RTK coordinate frame is usually not
north-aligned). Set `straighten: false` to draw in the mower's frame instead
(tilted image). If the overlay looks mirrored or rotated wrong, a pixel
coordinate was probably read y-up — pixel y counts DOWN from the image's
top-left.

> **Calibration helper.** Reading pixel coordinates by hand is fiddly.
> [`calibrate.html`](calibrate.html) is a self-contained offline tool
> (open it directly in a browser — nothing is uploaded): load the same image
> you'll put in `/config/www`, click your two reference points (a loupe
> magnifies for pixel precision), type each point's mower-meter coordinates,
> and it generates the ready-to-paste `calibration:` block. It also shows the
> image's ground size and rotation as a sanity check and lets you plot a third
> known point to verify the fit. Calibrate against the exact file you deploy —
> pixel coordinates are tied to that image's resolution.

## Dock marker

The mower's coordinate origin is its RTK/mapping anchor, which is *near* but
not always *at* the dock — so the card does not assume dock = (0,0). The dock
marker position is resolved in this order:

1. **Manual override** — set `dock_x:` / `dock_y:` (meters) in the card config.
2. **Integration dock sensors** (fork v1.1.0+position.4+) —
   `sensor.<name>_dock_x/_dock_y`, learned server-side by averaging the mower's
   pose while it reports docked/charging, persisted across HA restarts. The card
   derives these entity names from `x_entity`/`y_entity` automatically; set
   `dock_x_entity:` / `dock_y_entity:` if yours differ.
3. **Local fallback** (older fork versions) — the card learns the same average
   in the browser and keeps it in localStorage (per browser, so each device
   learns separately).
4. **Origin (0,0)** until the mower has docked once.

The sensors read `unknown` until the first docked/charging pose sample after
upgrading; the marker corrects itself the next time the mower docks. The
sensors' `samples` / `source` attributes show whether live learning is working —
if `samples` stays 0 while docked, your mower stops streaming pose at the dock
(please report this).
