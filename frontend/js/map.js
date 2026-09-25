/* Leaflet map with a graceful fallback.
 *
 * Leaflet comes from a CDN, so the page must still work when it is blocked or
 * the machine is offline. When the library is missing this renders a plain
 * geographic scatter in SVG instead — less useful, but never a broken panel.
 */

import { bandColor, bandGlyph, esc, num, currency } from './core.js?v=26';

let mapInstance = null;

export function renderMap(mount, segments, focusId = null) {
  const pts = segments.filter((s) => s.lat && s.lon);
  if (!pts.length) {
    mount.innerHTML = '<div class="map-fallback">No segments have coordinates yet.</div>';
    return;
  }

  if (typeof window.L === 'undefined') {
    fallbackScatter(mount, pts);
    return;
  }

  if (mapInstance) { mapInstance.remove(); mapInstance = null; }

  const lat = pts.reduce((a, s) => a + s.lat, 0) / pts.length;
  const lon = pts.reduce((a, s) => a + s.lon, 0) / pts.length;

  const map = window.L.map(mount, { scrollWheelZoom: false, attributionControl: true })
    .setView([lat, lon], 12);
  mapInstance = map;

  const tiles = window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  // Leaflet can load while the tile servers stay unreachable — on an air-gapped
  // network, or behind a proxy. The markers are still correct against a blank
  // ground, so say so rather than leaving the panel looking broken.
  let failed = 0;
  tiles.on('tileerror', () => {
    if (++failed !== 4 || mount.querySelector('.tile-note')) return;
    const note = document.createElement('div');
    note.className = 'tile-note';
    note.textContent = 'Map tiles are unreachable — marker positions are still accurate.';
    Object.assign(note.style, {
      position: 'absolute', left: '50%', bottom: '14px', transform: 'translateX(-50%)',
      zIndex: 500, padding: '5px 12px', borderRadius: '100px', pointerEvents: 'none',
      background: 'var(--surface-1)', border: '1px solid var(--border)',
      color: 'var(--text-muted)', fontSize: '12px', whiteSpace: 'nowrap',
      boxShadow: 'var(--shadow-md)',
    });
    mount.style.position = 'relative';
    mount.append(note);
  });

  let focused = null;
  pts.forEach((s) => {
    const band = s.band_code || 'P4';
    // Radius carries RPI, colour carries the band. Both encode the same
    // ordering, which is redundancy rather than double-encoding — it keeps the
    // map readable for a colour-blind viewer.
    const r = 6 + ((s.rpi || 0) / 100) * 9;
    const marker = window.L.circleMarker([s.lat, s.lon], {
      radius: r,
      color: 'var(--surface-1)',
      weight: 2,
      fillColor: bandColor(band),
      fillOpacity: 0.88,
      className: 'map-marker',
    }).addTo(map).bindPopup(`
      <div style="font-weight:650;margin-bottom:4px">${esc(s.name)}</div>
      <div style="color:var(--text-secondary);font-size:12px;margin-bottom:7px">
        ${esc(s.ward || '')} · ${esc(s.road_class)}
      </div>
      <div style="display:flex;justify-content:space-between;gap:14px">
        <span style="color:var(--text-secondary)">Priority</span>
        <strong style="color:${bandColor(band)}">${bandGlyph(band)} ${esc(band)} ${esc(s.band_label || '')}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;gap:14px">
        <span style="color:var(--text-secondary)">RPI</span><strong>${num(s.rpi, 1)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;gap:14px">
        <span style="color:var(--text-secondary)">PCI</span><strong>${num(s.pci, 0)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;gap:14px;margin-bottom:8px">
        <span style="color:var(--text-secondary)">Est. cost</span><strong>${esc(currency(s.total_cost))}</strong>
      </div>
      <a href="#/segment/${encodeURIComponent(s.id)}">Open segment →</a>`);
    if (s.id === focusId) focused = marker;
  });

  // Fit to the network, then let the tiles settle. A focused segment — one
  // just saved from the analyse page — gets zoomed to and its popup opened.
  map.fitBounds(pts.map((s) => [s.lat, s.lon]), { padding: [34, 34], maxZoom: 13 });
  setTimeout(() => {
    map.invalidateSize();
    if (focused) {
      map.setView(focused.getLatLng(), 16);
      focused.openPopup();
    }
  }, 120);
}

/* ---------- offline fallback ---------- */

function fallbackScatter(mount, pts) {
  const W = 900, H = 440, pad = 44;
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const [la0, la1] = [Math.min(...lats), Math.max(...lats)];
  const [lo0, lo1] = [Math.min(...lons), Math.max(...lons)];
  const X = (lon) => pad + ((lon - lo0) / (lo1 - lo0 || 1)) * (W - pad * 2);
  const Y = (lat) => H - pad - ((lat - la0) / (la1 - la0 || 1)) * (H - pad * 2);

  mount.innerHTML = `
    <div style="padding:12px 16px;font-size:12.5px;color:var(--text-muted);border-bottom:1px solid var(--border)">
      Map tiles are unavailable offline — showing a relative geographic plot instead.
    </div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" style="height:400px" role="img"
         aria-label="Geographic scatter of road segments by priority">
      ${pts.map((s) => {
        const r = 6 + ((s.rpi || 0) / 100) * 9;
        return `<circle cx="${X(s.lon)}" cy="${Y(s.lat)}" r="${r}"
                  fill="${bandColor(s.band_code || 'P4')}" fill-opacity="0.88"
                  stroke="var(--surface-1)" stroke-width="2">
                  <title>${esc(s.name)} — ${esc(s.band_code)} · RPI ${num(s.rpi, 1)}</title>
                </circle>`;
      }).join('')}
    </svg>`;
}
