# Navimow auto-mower gate — setup guide

Automatically open a gate so a Segway Navimow can pass through to mow zones on
the far side of the gate from its dock, and close it again once the mower is
docked. Built around four pieces:

1. The **position/zone fork** of the Navimow integration (provides the zone sensor).
2. A **switch** in Home Assistant that *pulses* your gate opener (LocalTuya, ESPHome, Shelly, etc.).
3. Two **contact sensors** for the gate's fully-open and fully-closed positions.
4. This **package** (`navimow_gate.yaml`) + an optional dashboard card and live map card.

> The gate logic assumes a **single-button cyclic** opener (one pulse =
> open→stop→close→reverse) and reads the *true* gate state from the two contact
> sensors. If your opener has separate open/close inputs you can still use this,
> but the pulse-and-verify scripts are written for the single-button case.

---

## Prerequisites

- **Home Assistant 2026.1.0+** with the Navimow integration installed from the
  position/zone fork: <https://github.com/pgoutsos/NavimowHA>. After setup you'll
  have, per mower: `lawn_mower.<name>`, `sensor.<name>_zone`,
  `sensor.<name>_position_x/_y`, `sensor.<name>_heading`.
- A **gate opener controllable from HA as a switch**. Any integration works as
  long as turning the switch *on* pulses the opener. (LocalTuya, ESPHome, Shelly…)
- **Two contact sensors**, one mounted so it reads at the gate's fully-**closed**
  position and one at the fully-**open** position. Local/fast sensors (Z-Wave,
  Zigbee, ESPHome) are strongly preferred over cloud ones for timing.

---

## Step 1 — Identify your entity IDs

In Developer Tools → States, find and note:

| Purpose | Example | Yours |
| --- | --- | --- |
| Mower | `lawn_mower.peter_griffin` | |
| Zone sensor (from the fork) | `sensor.peter_griffin_zone` | |
| Gate opener switch (pulse) | `switch.garden_gate_opener_switch_1` | |
| Gate **closed** contact | `binary_sensor.garden_gate_closed_sensor` | |
| Gate **open** contact | `binary_sensor.garden_gate_open_sensor` | |

## Step 2 — Verify sensor polarity

Move the gate to each position and read the two contacts. The package assumes:

- fully **closed** → `closed_sensor == off`
- fully **open** → `open_sensor == off`
- **mid-travel** → both `on`

Contact sensors can be wired either way, so confirm this with the actual gate (not
by hand-sliding a magnet). If yours are inverted, flip the `off`/`on` checks in the
`garden_gate_status` template and the two scripts.

## Step 3 — Find your zone ids

Each mowing zone has a numeric partition id. Watch `sensor.<name>_zone` while the
mower works each area (or send a "mow this zone" command per zone) and record which
id is which. Note which zone(s) are on the **dock side** (no gate needed) — usually
just the one containing the dock.

> **"Mow all" note:** a full-property / "mow all" command reports **no zone** — the
> sensor stays `unknown` the whole time. Only per-zone commands report a specific
> id. The gate logic therefore treats anything that isn't a known dock-side zone
> (including `unknown`) as gate-required, so "mow all" opens the gate too.

## Step 4 — Configure the package

Open `navimow_gate.yaml` and:

1. **Find-and-replace** the five example entity IDs (every spot is also tagged
   `# CHANGE:`) with yours:
   - `lawn_mower.peter_griffin`
   - `sensor.peter_griffin_zone`
   - `switch.garden_gate_opener_switch_1`
   - `binary_sensor.garden_gate_closed_sensor`
   - `binary_sensor.garden_gate_open_sensor`
2. **Set your zones** in the two tables tagged `# EDIT ZONE MAP`:
   - the id → friendly-name map (display only), and
   - `no_gate_zones` — the **dock-side** zone ids that do NOT need the gate,
     e.g. `['2']`. Everything else (front zones, and "mow all" / `unknown`) is
     treated as gate-required.

## Step 5 — Install the package

> Throughout this guide `<config>` means your **Home Assistant configuration
> directory** — the folder that holds `configuration.yaml` (and `custom_components/`,
> `packages/`, `www/`). It's `/config` on HA OS/Supervised and inside a Docker
> container; on a Core/venv install it's usually `~/.homeassistant`. For Docker,
> reach it with `docker cp <file> homeassistant:/config/...`.

Put the file at `<config>/packages/navimow_gate.yaml`, and make sure
`configuration.yaml` loads packages:

```yaml
homeassistant:
  packages: !include_dir_named packages
```

Then Developer Tools → **Check Configuration**, restart Home Assistant, and turn on
`input_boolean.navimow_gate_automation`.

## Step 6 — Test

With the gate area clear (watch on a camera if you have one):

1. Developer Tools → Actions → run `script.navimow_gate_ensure_open`, then
   `script.navimow_gate_ensure_closed`. Each should pulse and the matching contact
   should confirm the endpoint.
2. Then a live mow: when the mower targets a gate-side zone, the gate opens; it
   closes once the mower docks.

`input_boolean.navimow_gate_automation` is your kill-switch — off disables all the
automations while leaving the manual scripts/switch usable.

---

## What gets created

- `input_boolean.navimow_gate_automation` — master enable
- `sensor.navimow_current_zone` — current target zone, friendly name
- `sensor.garden_gate_status` — Closed / Open / Opening / Closing
- `binary_sensor.navimow_gate_zone_required` — on when the target needs the gate
- `binary_sensor.navimow_charging`, `binary_sensor.navimow_task_delayed`
- scripts `navimow_gate_ensure_open` / `_ensure_closed`
- three automations (open on gate-side zone, ensure-open while returning, close on dock)

## Optional — dashboard card

```yaml
type: vertical-stack
cards:
  - type: entities
    title: Garden Gate
    entities:
      - { entity: sensor.garden_gate_status, name: Gate }
      - { entity: input_boolean.navimow_gate_automation, name: Automation enabled }
      - { entity: sensor.navimow_current_zone, name: Mower target zone }
      - { entity: binary_sensor.navimow_charging, name: Charging }
      - { entity: binary_sensor.navimow_task_delayed, name: Mow delayed }
  - type: horizontal-stack
    cards:
      - type: button
        name: Open Gate
        icon: mdi:gate-open
        tap_action: { action: perform-action, perform_action: script.navimow_gate_ensure_open, confirmation: { text: Open the garden gate? } }
      - type: button
        name: Close Gate
        icon: mdi:gate
        tap_action: { action: perform-action, perform_action: script.navimow_gate_ensure_closed, confirmation: { text: Close the garden gate? } }
```

## Optional — live position map card

`navimow-map-card.js` plots the mower's live position, heading, and trail.

1. Copy it to `<config>/www/navimow-map-card.js`.
2. Settings → Dashboards → ⋮ → Resources → add `/local/navimow-map-card.js?v=1`
   as a **JavaScript Module** (the `?v=N` query dodges the frontend cache — bump it
   when you update the file).
3. Add a card: `type: custom:navimow-map-card` (override `x_entity`, `y_entity`,
   `heading_entity`, `zone_entity` if your entity IDs differ from the defaults).

---

## Notes & tuning

- **Open/close timeout** is 45s in the scripts (`timeout: "00:00:45"`); raise it if
  your gate travels slowly.
- **Close is immediate** on dock. If your mower briefly docks mid-job to recharge,
  the gate closes and re-opens when it heads back out — add a `for:` to the close
  triggers if you'd rather wait.
- **Cancelled tasks** set the zone to `unknown`; the "ensure open while returning"
  automation guarantees the mower can always cross back home.
