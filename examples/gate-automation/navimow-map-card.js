/*
 * Navimow Map Card  (v1 — meter-space live position + heading + trail)
 *
 * A self-contained Lovelace custom card. Plots the mower's local (x,y) meter
 * coordinates with a heading arrow and a fading trail, auto-fitting the view to
 * wherever it has been. Auto-learns the dock position by averaging the mower's
 * coordinates while the status entity reports docked/charging (persisted in
 * localStorage per x_entity). No external dependencies.
 *
 * Install:
 *   1. Put this file at /config/www/navimow-map-card.js
 *   2. Add a Lovelace resource: URL /local/navimow-map-card.js, type "JavaScript Module"
 *   3. Add a card:  type: custom:navimow-map-card
 *
 * Config (all optional, defaults shown):
 *   type: custom:navimow-map-card
 *   title: Navimow Map
 *   x_entity: sensor.peter_griffin_position_x
 *   y_entity: sensor.peter_griffin_position_y
 *   heading_entity: sensor.peter_griffin_heading
 *   zone_entity: sensor.navimow_current_zone
 *   status_entity: lawn_mower.peter_griffin
 *   battery_entity:           # e.g. sensor.peter_griffin_battery (optional)
 *   trail_length: 800         # max trail points kept
 *   dock_x_entity:            # integration dock sensors (auto-derived from
 *   dock_y_entity:            #   x_entity/y_entity names if not set)
 *   dock_x:                   # manual dock override (meters); disables auto-learn
 *   dock_y:                   #   (both must be set)
 *   dock_samples: 25          # rolling samples averaged while docked (fallback)
 *
 * Dock position priority: dock_x/dock_y config > integration dock sensors
 * (sensor.*_dock_x/_dock_y, persisted server-side by the integration) >
 * locally learned average while docked (localStorage) > origin (0,0).
 */
class NavimowMapCard extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({
      title: 'Navimow Map',
      x_entity: 'sensor.peter_griffin_position_x',
      y_entity: 'sensor.peter_griffin_position_y',
      heading_entity: 'sensor.peter_griffin_heading',
      zone_entity: 'sensor.navimow_current_zone',
      status_entity: 'lawn_mower.peter_griffin',
      battery_entity: null,
      trail_length: 800,
      dock_x_entity: null,
      dock_y_entity: null,
      dock_x: null,
      dock_y: null,
      dock_samples: 25,
    }, config || {});
    // derive dock sensor names from the position sensors if not configured
    if (!this._config.dock_x_entity && /position_x/.test(this._config.x_entity))
      this._config.dock_x_entity = this._config.x_entity.replace('position_x', 'dock_x');
    if (!this._config.dock_y_entity && /position_y/.test(this._config.y_entity))
      this._config.dock_y_entity = this._config.y_entity.replace('position_y', 'dock_y');
    this._trail = [];
    this._lastKey = null;
    this._dock = null;       // learned [x, y], meters
    this._dockBuf = [];      // rolling samples while docked
    this._dockKey = 'navimow-map-card-dock:' + this._config.x_entity;
    try {
      const v = JSON.parse(localStorage.getItem(this._dockKey));
      if (Array.isArray(v) && isFinite(v[0]) && isFinite(v[1])) this._dock = v;
    } catch (e) { /* storage unavailable — auto-learn still works per-session */ }
    this.innerHTML = `
      <ha-card>
        <div class="nm-hdr"></div>
        <div class="nm-wrap"><svg class="nm-map" preserveAspectRatio="xMidYMid meet"></svg></div>
        <div class="nm-ftr"></div>
      </ha-card>
      <style>
        ha-card { padding: 12px; }
        .nm-hdr { font-weight: 600; margin-bottom: 6px; }
        .nm-wrap { position: relative; width: 100%; aspect-ratio: 1 / 1;
          background: var(--secondary-background-color); border-radius: 8px; overflow: hidden; }
        svg.nm-map { width: 100%; height: 100%; display: block; }
        .nm-ftr { margin-top: 8px; font-size: 0.9em; color: var(--secondary-text-color);
          display: flex; gap: 14px; flex-wrap: wrap; }
        .nm-ftr b { color: var(--primary-text-color); }
      </style>`;
  }

  set hass(hass) { this._hass = hass; this._update(); }

  _num(entity) {
    if (!entity || !this._hass) return null;
    const s = this._hass.states[entity];
    if (!s) return null;
    const v = parseFloat(s.state);
    return isNaN(v) ? null : v;
  }

  _update() {
    if (!this._hass || !this._config) return;
    const c = this._config;
    const x = this._num(c.x_entity);
    const y = this._num(c.y_entity);
    const headingDeg = this._num(c.heading_entity);
    const zone = this._hass.states[c.zone_entity] ? this._hass.states[c.zone_entity].state : '—';
    const status = this._hass.states[c.status_entity] ? this._hass.states[c.status_entity].state : '—';
    const batt = c.battery_entity ? this._num(c.battery_entity) : null;

    if (x !== null && y !== null) {
      const key = x.toFixed(3) + ',' + y.toFixed(3);
      if (key !== this._lastKey) {
        this._trail.push([x, y]);
        this._lastKey = key;
        if (this._trail.length > c.trail_length) this._trail.shift();
      }
    }

    // integration dock sensors (server-side learned, persisted in HA)
    const sensorDockX = this._num(c.dock_x_entity);
    const sensorDockY = this._num(c.dock_y_entity);
    const haveSensorDock = sensorDockX !== null && sensorDockY !== null;

    // local auto-learn fallback: average position while docked/charging
    // (skipped when the integration provides dock sensors)
    if (!haveSensorDock && (c.dock_x === null || c.dock_y === null)) {
      const docked = /dock|charg/i.test(status);
      if (docked && x !== null && y !== null) {
        this._dockBuf.push([x, y]);
        if (this._dockBuf.length > c.dock_samples) this._dockBuf.shift();
        const n = this._dockBuf.length;
        this._dock = [
          this._dockBuf.reduce((a, p) => a + p[0], 0) / n,
          this._dockBuf.reduce((a, p) => a + p[1], 0) / n,
        ];
        try { localStorage.setItem(this._dockKey, JSON.stringify(this._dock)); } catch (e) {}
      } else if (!docked && this._dockBuf.length) {
        this._dockBuf = [];
      }
    }

    this.querySelector('.nm-hdr').textContent = c.title;
    const parts = [
      `Zone: <b>${zone}</b>`,
      `Status: <b>${status}</b>`,
      (x !== null && y !== null) ? `Pos: <b>${x.toFixed(1)}, ${y.toFixed(1)} m</b>` : `Pos: <b>—</b>`,
    ];
    if (batt !== null) parts.push(`Battery: <b>${batt}%</b>`);
    this.querySelector('.nm-ftr').innerHTML = parts.join('');

    const dock = (c.dock_x !== null && c.dock_y !== null)
      ? [c.dock_x, c.dock_y]
      : haveSensorDock
        ? [sensorDockX, sensorDockY]
        : (this._dock || [0, 0]);
    this._draw(x, y, headingDeg, dock);
  }

  _draw(x, y, headingDeg, dock) {
    const svg = this.querySelector('svg.nm-map');
    const pts = this._trail;
    const V = 1000;

    if (pts.length === 0 && (x === null || y === null)) {
      svg.setAttribute('viewBox', `0 0 ${V} ${V}`);
      svg.innerHTML = `<text x="${V/2}" y="${V/2}" fill="var(--secondary-text-color)" font-size="34" text-anchor="middle">Waiting for position…</text>`;
      return;
    }

    const xs = pts.map(p => p[0]).concat([dock[0]]);
    const ys = pts.map(p => p[1]).concat([dock[1]]);
    if (x !== null) xs.push(x);
    if (y !== null) ys.push(y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let size = Math.max(maxX - minX, maxY - minY, 2);
    size += size * 0.24; // padding
    const x0 = cx - size / 2, y0 = cy - size / 2;
    const tx = mx => ((mx - x0) / size) * V;
    const ty = my => (1 - (my - y0) / size) * V; // flip Y (math up -> screen down)
    svg.setAttribute('viewBox', `0 0 ${V} ${V}`);

    let s = '';
    if (pts.length > 1) {
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${tx(p[0]).toFixed(1)} ${ty(p[1]).toFixed(1)}`).join(' ');
      s += `<path d="${d}" fill="none" stroke="var(--primary-color)" stroke-width="4" stroke-opacity="0.55" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    // dock marker (configured > auto-learned > origin fallback)
    s += `<g transform="translate(${tx(dock[0]).toFixed(1)},${ty(dock[1]).toFixed(1)})">
            <circle r="10" fill="none" stroke="var(--secondary-text-color)" stroke-width="3"/>
            <text y="-16" font-size="26" text-anchor="middle" fill="var(--secondary-text-color)">dock</text>
          </g>`;
    // mower marker + heading arrow
    if (x !== null && y !== null) {
      const px = tx(x), py = ty(y);
      if (headingDeg !== null) {
        const rad = headingDeg * Math.PI / 180;
        const ax = px + Math.cos(rad) * 34, ay = py - Math.sin(rad) * 34;
        s += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="var(--accent-color, #ff9800)" stroke-width="7" stroke-linecap="round"/>`;
      }
      s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="15" fill="var(--accent-color, #ff9800)" stroke="white" stroke-width="3"/>`;
    }
    svg.innerHTML = s;
  }

  getCardSize() { return 6; }
}

customElements.define('navimow-map-card', NavimowMapCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'navimow-map-card',
  name: 'Navimow Map',
  description: 'Live Navimow position, heading, and trail (meter-space).',
});
