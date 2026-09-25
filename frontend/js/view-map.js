/* Map view — the whole network on one screen.
 *
 * The dashboard's map panel is a summary that has to share the fold with four
 * other cards. This is the same data given the room to be worked with: a
 * full-height map, a band filter, and a list beside it that stays in step with
 * what is on screen.
 */

import {
  $, $$, api, html, num, currency, bandColor, meta, icon, emptyState,
} from './core.js?v=26';
import { renderMap } from './map.js?v=26';
import { peekSegment } from './segment-peek.js?v=26';

export async function mapView(mount) {
  const [segs, m] = await Promise.all([api.segments(), meta()]);
  const all = segs.segments.filter((s) => s.lat && s.lon);
  const bandCount = (code) => all.filter((s) => s.band_code === code).length;

  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <h1>Map view</h1>
        <p class="lede">
          ${num(all.length)} of ${num(segs.count)} segments have coordinates. Marker size
          carries the priority index, colour carries the band — the same encoding
          the dashboard uses.
        </p>
      </div>
      <a class="btn primary" href="#/analyze">${icon('scan-line')} Analyse a road image</a>
    </div>

    <div class="filters" role="group" aria-label="Filter by priority band">
      <div class="map-bands">
        <button class="filter-chip band-toggle active" data-band="">All segments
          <span class="n">${num(all.length)}</span></button>
        ${m.bands.map((b) => html`
          <button class="filter-chip band-toggle" data-band="${b.code}"
                  style="--chip:${bandColor(b.code)}">
            ${b.code} ${b.label}<span class="n">${num(bandCount(b.code))}</span></button>`)}
      </div>
    </div>

    <div class="grid g-map" style="align-items:start">
      <section class="card">
        <div class="card-body flush">
          <div id="map" class="map-tall"></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Segments on the map</h2>
          <span class="hint" id="map-count"></span>
        </div>
        <div class="card-body flush">
          <div class="map-list" id="map-list"></div>
        </div>
      </section>
    </div>`;

  let band = '';
  // #/map?focus=SEG-… — set by "View on map" after saving an analysis.
  const focus = new URLSearchParams(location.hash.split('?')[1] || '').get('focus');

  const shown = () => (band ? all.filter((s) => s.band_code === band) : all);

  const draw = () => {
    const rows = shown();
    renderMap($('#map', mount), rows, focus);
    $('#map-count', mount).textContent = `${num(rows.length)} shown`;

    const list = $('#map-list', mount);
    list.innerHTML = rows.length ? rows.map((s) => html`
      <button type="button" class="map-row" data-id="${s.id}">
        <span class="dot" style="background:${bandColor(s.band_code)}"></span>
        <span class="m-main">
          <span class="m-name">${s.name}</span>
          <span class="m-sub">${s.ward || '—'} · RPI ${num(s.rpi, 1)}</span>
        </span>
        <span class="m-cost">${currency(s.total_cost)}</span>
      </button>`).join('')
      : emptyState('Nothing in this band', 'Pick another priority band.', '🗺️');

    list.querySelectorAll('.map-row[data-id]').forEach((b) => {
      b.addEventListener('click', () => peekSegment(b.dataset.id));
    });
  };

  $$('.band-toggle', mount).forEach((btn) => {
    btn.addEventListener('click', () => {
      band = btn.dataset.band;
      $$('.band-toggle', mount).forEach((x) => x.classList.toggle('active', x === btn));
      draw();
    });
  });

  draw();
}
