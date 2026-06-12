/*
 * Navimow Map Card  (v3 — satellite overlay + recorder-backed session trail)
 *
 * A self-contained Lovelace custom card. Plots the mower's local (x,y) meter
 * coordinates with a heading arrow and the path of the CURRENT mowing session,
 * optionally over a calibrated aerial/satellite image. The session path is
 * rebuilt from Home Assistant's recorder history on load, so it survives page
 * reloads and navigation, and resets automatically when a new session starts
 * (docked -> mowing). Auto-learns the dock position via the integration's dock
 * sensors (fork v1.1.0+position.4) with a local-learning fallback for older
 * forks. No external dependencies.
 *
 * Install:
 *   1. Put this file at /config/www/navimow-map-card.js
 *   2. Add a Lovelace resource: URL /local/navimow-map-card.js?v=N, type
 *      "JavaScript Module" (bump ?v=N when you update the file)
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
 *   trail_length: 2000        # max trail points kept (older points are thinned,
 *                             #   not dropped, so the whole path keeps its shape)
 *   history_hours: 24         # how far back to look for the session start
 *   dock_x_entity:            # integration dock sensors (auto-derived from
 *   dock_y_entity:            #   x_entity/y_entity names if not set)
 *   dock_x:                   # manual dock override (meters); disables auto-learn
 *   dock_y:                   #   (both must be set)
 *   dock_samples: 25          # rolling samples averaged while docked (fallback)
 *
 * Satellite / aerial overlay (optional):
 *   overlay_image: /local/yard.png    # your property image under /config/www
 *   overlay_opacity: 0.9
 *   calibration:                      # EXACTLY 2 reference points that map
 *     - m: [0.0, 0.0]                 #   mower meter coords [x, y] ...
 *       px: [512, 800]                #   ... to image pixel coords [x, y]
 *     - m: [12.4, -3.1]               # tip: point 1 = the dock (read the
 *       px: [220, 410]                #   dock_x/dock_y sensors); point 2 = any
 *                                     #   landmark you can park the mower at
 *
 * Dock marker priority: dock_x/dock_y config > integration dock sensors >
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
      trail_length: 2000,
      history_hours: 24,
      dock_x_entity: null,
      dock_y_entity: null,
      dock_x: null,
      dock_y: null,
      dock_samples: 25,
      overlay_image: null,
      overlay_opacity: 0.9,
      calibration: null,
    }, config || {});
    // derive dock sensor names from the position sensors if not configured
    if (!this._config.dock_x_entity && /position_x/.test(this._config.x_entity))
      this._config.dock_x_entity = this._config.x_entity.replace('position_x', 'dock_x');
    if (!this._config.dock_y_entity && /position_y/.test(this._config.y_entity))
      this._config.dock_y_entity = this._config.y_entity.replace('position_y', 'dock_y');
    this._trail = [];
    this._lastKey = null;
    this._prevState = null;
    this._histLoaded = false;
    this._imgMeta = null;       // {w, h} once the overlay image loads
    this._imgLoading = false;
    this._cal = this._solveCalibration(this._config.calibration);
    this._dock = null;          // learned [x, y], meters (localStorage fallback)
    this._dockBuf = [];         // rolling samples while docked
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

  set hass(hass) {
    this._hass = hass;
    if (!this._histLoaded && hass) {
      this._histLoaded = true;
      this._loadSessionHistory();
    }
    this._update();
  }

  // Solve a 2-point similarity transform (scale+rotation+translation) from
  // image pixels (y down) to mower meters (y up), via complex arithmetic.
  // Returns {ar, ai, br, bi} such that:
  //   mx = ar*px + ai*py + br ;  my = ai*px - ar*py + bi
  _solveCalibration(cal) {
    if (!Array.isArray(cal) || cal.length !== 2) return null;
    const ok = p => p && Array.isArray(p.m) && Array.isArray(p.px) &&
      p.m.length === 2 && p.px.length === 2 && p.m.concat(p.px).every(isFinite);
    if (!ok(cal[0]) || !ok(cal[1])) return null;
    // q = pixel with y flipped (image y-down -> math y-up)
    const q1 = { r: cal[0].px[0], i: -cal[0].px[1] };
    const q2 = { r: cal[1].px[0], i: -cal[1].px[1] };
    const m1 = { r: cal[0].m[0], i: cal[0].m[1] };
    const m2 = { r: cal[1].m[0], i: cal[1].m[1] };
    const dq = { r: q2.r - q1.r, i: q2.i - q1.i };
    const dm = { r: m2.r - m1.r, i: m2.i - m1.i };
    const den = dq.r * dq.r + dq.i * dq.i;
    if (den < 1e-9) return null; // identical pixel points
    // a = dm / dq  (complex division)
    const ar = (dm.r * dq.r + dm.i * dq.i) / den;
    const ai = (dm.i * dq.r - dm.r * dq.i) / den;
    // b = m1 - a*q1
    const br = m1.r - (ar * q1.r - ai * q1.i);
    const bi = m1.i - (ai * q1.r + ar * q1.i);
    return { ar, ai, br, bi };
  }

  // image pixel -> meters using the solved calibration
  _pxToM(px, py) {
    const c = this._cal;
    return [c.ar * px + c.ai * py + c.br, c.ai * px - c.ar * py + c.bi];
  }

  _num(entity) {
    if (!entity || !this._hass) return null;
    const s = this._hass.states[entity];
    if (!s) return null;
    const v = parseFloat(s.state);
    return isNaN(v) ? null : v;
  }

  // Evenly thin the trail to the cap so long sessions keep their full shape
  // (always keeps the final point).
  _decimate(pts, cap) {
    let out = pts;
    while (out.length > cap) {
      const last = out[out.length - 1];
      out = out.filter((_, i) => i % 2 === 0);
      if (out[out.length - 1] !== last) out.push(last);
    }
    return out;
  }

  // Rebuild the current session's path from HA's recorder: find the latest
  // docked -> mowing transition and replay position history since then.
  async _loadSessionHistory() {
    const c = this._config, hass = this._hass;
    try {
      const end = new Date();
      const start = new Date(Date.now() - c.history_hours * 3600e3);
      const r = await hass.callWS({
        type: 'history/history_during_period',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [c.status_entity, c.x_entity, c.y_entity],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      const st = (r && r[c.status_entity]) || [];
      const xs = (r && r[c.x_entity]) || [];
      const ys = (r && r[c.y_entity]) || [];
      let t0 = null; // session start (epoch seconds)
      for (let i = 1; i < st.length; i++)
        if (st[i].s === 'mowing' && st[i - 1].s === 'docked') t0 = st[i].lu;
      if (t0 === null) return; // no session start in window -> live-only
      // merge x/y series: for each x sample, pair with the latest y at that time
      const pts = [];
      let yi = 0, lastY = null;
      for (const ex of xs) {
        const x = parseFloat(ex.s);
        while (yi < ys.length && ys[yi].lu <= ex.lu) {
          const v = parseFloat(ys[yi].s);
          if (!isNaN(v)) lastY = v;
          yi++;
        }
        if (!isNaN(x) && ex.lu >= t0 && lastY !== null) pts.push([x, lastY]);
      }
      if (pts.length) {
        // history first, then any live points that arrived while fetching
        this._trail = this._decimate(pts.concat(this._trail), c.trail_length);
        this._lastKey = null;
        this._update();
      }
    } catch (e) {
      // recorder disabled or entities excluded -> live-only trail
    }
  }

  _update() {
    if (!this._hass || !this._config) return;
    const c = this._config;
    const x = this._num(c.x_entity);
    const y = this._num(c.y_entity);
    const headingDeg = this._num(c.heading_entity);
    const zone = this._hass.states[c.zone_entity] ? this._hass.states[c.zone_entity].state : '—';
    const stObj = this._hass.states[c.status_entity];
    const status = stObj ? stObj.state : '—';
    // Raw mower status for dock learning. The lawn_mower entity STATE maps
    // 'idle' to 'docked' (activity), so a mower stopped mid-lawn would look
    // docked and poison the dock estimate — prefer the raw 'status' attribute.
    const rawStatus = stObj ? ((stObj.attributes && stObj.attributes.status) || stObj.state) : '';
    const batt = c.battery_entity ? this._num(c.battery_entity) : null;

    // new mowing session (docked -> mowing) -> reset the path
    if (this._prevState === 'docked' && status === 'mowing') {
      this._trail = [];
      this._lastKey = null;
    }
    this._prevState = status;

    if (x !== null && y !== null) {
      const key = x.toFixed(3) + ',' + y.toFixed(3);
      if (key !== this._lastKey) {
        this._trail.push([x, y]);
        this._lastKey = key;
        if (this._trail.length > c.trail_length)
          this._trail = this._decimate(this._trail, c.trail_length);
      }
    }

    // integration dock sensors (server-side learned, persisted in HA)
    const sensorDockX = this._num(c.dock_x_entity);
    const sensorDockY = this._num(c.dock_y_entity);
    const haveSensorDock = sensorDockX !== null && sensorDockY !== null;

    // local auto-learn fallback: average position while docked/charging
    // (skipped when the integration provides dock sensors)
    if (!haveSensorDock && (c.dock_x === null || c.dock_y === null)) {
      const docked = /^(docked|charging)$/i.test(rawStatus);
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
    const c = this._config;
    const pts = this._trail;
    const V = 1000;

    // lazy-load the overlay image to learn its pixel size
    if (c.overlay_image && this._cal && !this._imgMeta && !this._imgLoading) {
      this._imgLoading = true;
      const im = new Image();
      im.onload = () => {
        this._imgMeta = { w: im.naturalWidth, h: im.naturalHeight };
        this._update();
      };
      im.onerror = () => { this._imgLoading = false; };
      im.src = c.overlay_image;
    }
    const overlayReady = !!(this._imgMeta && this._cal);

    if (!overlayReady && pts.length === 0 && (x === null || y === null)) {
      svg.setAttribute('viewBox', `0 0 ${V} ${V}`);
      svg.innerHTML = `<text x="${V/2}" y="${V/2}" fill="var(--secondary-text-color)" font-size="34" text-anchor="middle">Waiting for position…</text>`;
      return;
    }

    // view extents: trail + dock + live pos (+ image corners when present)
    const xs = pts.map(p => p[0]).concat([dock[0]]);
    const ys = pts.map(p => p[1]).concat([dock[1]]);
    if (x !== null) xs.push(x);
    if (y !== null) ys.push(y);
    if (overlayReady) {
      const { w, h } = this._imgMeta;
      for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
        const m = this._pxToM(px, py);
        xs.push(m[0]); ys.push(m[1]);
      }
    }
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let size = Math.max(maxX - minX, maxY - minY, 2);
    size += size * (overlayReady ? 0.04 : 0.24); // padding
    const x0 = cx - size / 2, y0 = cy - size / 2;
    const k = V / size;
    const tx = mx => (mx - x0) * k;
    const ty = my => V - (my - y0) * k; // flip Y (math up -> screen down)
    svg.setAttribute('viewBox', `0 0 ${V} ${V}`);

    let s = '';
    if (overlayReady) {
      // compose pixel->meter (calibration) with meter->screen (view):
      //   sx = k*(ar*px + ai*py + br - x0)
      //   sy = V - k*(ai*px - ar*py + bi - y0)
      const { ar, ai, br, bi } = this._cal;
      const A = k * ar, B = -k * ai, C = k * ai, D = k * ar;
      const E = k * (br - x0), F = V - k * (bi - y0);
      s += `<image href="${c.overlay_image}" width="${this._imgMeta.w}" height="${this._imgMeta.h}"
              transform="matrix(${A} ${B} ${C} ${D} ${E} ${F})"
              opacity="${c.overlay_opacity}" preserveAspectRatio="none"/>`;
    }
    if (pts.length > 1) {
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${tx(p[0]).toFixed(1)} ${ty(p[1]).toFixed(1)}`).join(' ');
      s += `<path d="${d}" fill="none" stroke="var(--primary-color)" stroke-width="4" stroke-opacity="0.55" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    // dock marker (configured > auto-learned > origin fallback)
    s += `<g transform="translate(${tx(dock[0]).toFixed(1)},${ty(dock[1]).toFixed(1)})">
            <circle r="10" fill="none" stroke="${overlayReady ? 'white' : 'var(--secondary-text-color)'}" stroke-width="3"/>
            <text y="-16" font-size="26" text-anchor="middle" fill="${overlayReady ? 'white' : 'var(--secondary-text-color)'}"${overlayReady ? ' style="paint-order:stroke" stroke="rgba(0,0,0,0.6)" stroke-width="4"' : ''}>dock</text>
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
  description: 'Live Navimow position + session path, optional satellite overlay.',
});
